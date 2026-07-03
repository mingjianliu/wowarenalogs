/**
 * Validate arena obstacle geometry against real position data from combat logs.
 *
 * For each match with advanced logging, extracts all player positions and checks:
 *  1. No position falls INSIDE an obstacle (would mean the pillar is misplaced).
 *  2. Reports minimum distance from each obstacle (sanity check that pillars are
 *     in the right area of the map).
 *
 * Usage: node scripts/validateGeometry.mjs [log-path]
 *   Defaults to all test logs in packages/parser/test/testlogs/
 */

import { createReadStream, readFileSync } from 'fs';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

// ---------------------------------------------------------------------------
// Arena geometry — loaded from the TS sources of truth so this script can
// never drift from production data:
//   packages/shared/src/data/arenaGeometry.ts  → arenaObstacles
//   packages/shared/src/data/zoneMetadata.ts   → zoneMetadata
// Both files are data-only TS: the exported object literal is plain JS once
// comments are stripped, so we extract it by balanced-brace matching and
// evaluate it. Type annotations live outside the literal.
// ---------------------------------------------------------------------------

function loadExportedObject(filePath, exportName) {
  const src = readFileSync(filePath, 'utf8');
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const marker = stripped.match(new RegExp(`export const ${exportName}[^=]*=\\s*\\{`));
  if (!marker) throw new Error(`Could not find "export const ${exportName}" in ${filePath}`);
  const start = stripped.indexOf('{', marker.index + marker[0].length - 1);
  let depth = 0;
  for (let i = start; i < stripped.length; i++) {
    if (stripped[i] === '{') depth++;
    else if (stripped[i] === '}') {
      depth--;
      if (depth === 0) return new Function(`return (${stripped.slice(start, i + 1)});`)();
    }
  }
  throw new Error(`Unbalanced braces extracting "${exportName}" from ${filePath}`);
}

const arenaObstacles = loadExportedObject(
  join(repoRoot, 'packages/shared/src/data/arenaGeometry.ts'),
  'arenaObstacles',
);

const zoneMetadata = loadExportedObject(
  join(repoRoot, 'packages/shared/src/data/zoneMetadata.ts'),
  'zoneMetadata',
);


// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function distToCircle(px, py, cx, cy) {
  return Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
}

function pointInPolygon(px, py, vertices) {
  let inside = false;
  const n = vertices.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = vertices[i];
    const [xj, yj] = vertices[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function distToPolygonCentroid(px, py, vertices) {
  const cx = vertices.reduce((s, v) => s + v[0], 0) / vertices.length;
  const cy = vertices.reduce((s, v) => s + v[1], 0) / vertices.length;
  return Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
}

function isInsideObstacle(px, py, obs) {
  if (obs.type === 'circle') {
    return distToCircle(px, py, obs.cx, obs.cy) < obs.r;
  } else {
    return pointInPolygon(px, py, obs.vertices);
  }
}

// ---------------------------------------------------------------------------
// Log parsing (minimal — extract positions and zone IDs)
// ---------------------------------------------------------------------------

function parseTimestamp(dateStr, timeStr) {
  const [month, day, year] = dateStr.split('/').map(Number);
  const timePart = timeStr.replace(/[+-]\d+$/, '');
  return new Date(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${timePart}`).getTime();
}

function parseLine(raw) {
  const tabIdx = raw.indexOf('  ');
  if (tabIdx === -1) return null;
  const datePart = raw.slice(0, tabIdx);
  const rest = raw.slice(tabIdx + 2);
  const commaIdx = rest.indexOf(',');
  if (commaIdx === -1) return null;
  const event = rest.slice(0, commaIdx);
  const paramStr = rest.slice(commaIdx + 1);
  const params = paramStr.split(',').map((s) => s.trim());
  const [date, time] = datePart.split(' ');
  const timestamp = parseTimestamp(date, time);
  return { timestamp, event, params };
}

async function parsePositionsFromLog(logPath) {
  const matches = [];
  let current = null;

  const rl = createInterface({ input: createReadStream(logPath), crlfDelay: Infinity });

  for await (const rawLine of rl) {
    const line = parseLine(rawLine.trim());
    if (!line) continue;
    const { timestamp, event, params } = line;

    if (event === 'ARENA_MATCH_START') {
      // Flush any previous unclosed match before starting new one
      if (current && current.positions.length > 0) matches.push(current);
      current = { zoneId: params[0], playerGuids: new Set(), positions: [] };
    } else if (event === 'ARENA_MATCH_END' && current) {
      matches.push(current);
      current = null;
    } else if (event === 'COMBATANT_INFO' && current) {
      // Register confirmed arena player GUIDs to filter pets/NPCs
      const guid = params[0]?.replace(/"/g, '');
      if (guid) current.playerGuids.add(guid);
    } else if (current) {
      // Only SPELL_CAST_SUCCESS / SPELL_DAMAGE / SPELL_HEAL — these have a consistent
      // 8-prefix + 3-spell-info layout, so posX is at params[23], posY at params[24].
      // (SWING_DAMAGE has no spell prefix → different offsets → skip to avoid NPC noise.)
      const spellEvents = new Set(['SPELL_CAST_SUCCESS', 'SPELL_DAMAGE', 'SPELL_HEAL', 'SPELL_PERIODIC_DAMAGE']);
      if (spellEvents.has(event) && params.length > 24) {
        const srcGuid = params[0]?.replace(/"/g, '');
        // Only track confirmed arena players
        if (srcGuid && current.playerGuids.has(srcGuid)) {
          // TWW 11.0+ (wowVersionOffset=2): posX at [25], posY at [26] — total params >= 30
          // Earlier retail format (wowVersionOffset=0): posX at [23], posY at [24] — total params ~28
          const xIdx = params.length >= 30 ? 25 : 23;
          const yIdx = xIdx + 1;
          const x = parseFloat(params[xIdx]);
          const y = parseFloat(params[yIdx]);
          if (!isNaN(x) && !isNaN(y) && x !== 0 && y !== 0) {
            current.positions.push({ x, y });
          }
        }
      }
    }
  }

  // Flush final unclosed match
  if (current && current.positions.length > 0) matches.push(current);

  return matches;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateMatch(match) {
  const { zoneId, positions } = match;
  const obstacles = arenaObstacles[zoneId];
  const meta = zoneMetadata[zoneId];

  if (!obstacles || !meta) return null;
  if (positions.length === 0) return null;

  // X/Y range
  const xs = positions.map((p) => p.x);
  const ys = positions.map((p) => p.y);
  const xMin = Math.min(...xs),
    xMax = Math.max(...xs);
  const yMin = Math.min(...ys),
    yMax = Math.max(...ys);

  const outOfBounds = positions.filter(
    (p) => p.x < meta.minX || p.x > meta.maxX || p.y < meta.minY || p.y > meta.maxY,
  ).length;

  // Per-obstacle: violations (positions inside) and closest approach
  const obsStats = obstacles.map((obs, i) => {
    const violations = positions.filter((p) => isInsideObstacle(p.x, p.y, obs));
    let minDist = Infinity;
    for (const p of positions) {
      const d =
        obs.type === 'circle' ? distToCircle(p.x, p.y, obs.cx, obs.cy) : distToPolygonCentroid(p.x, p.y, obs.vertices);
      if (d < minDist) minDist = d;
    }
    return { index: i, violations: violations.length, minDist: Math.round(minDist * 10) / 10 };
  });

  return { zoneId, zoneName: meta.name, posCount: positions.length, xMin, xMax, yMin, yMax, outOfBounds, obsStats };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const testLogDir = join(repoRoot, 'packages/parser/test/testlogs');
const logFiles = process.argv[2]
  ? [process.argv[2]]
  : [
      join(testLogDir, 'ad6c60db729c858668343bdc7d92260b_round0_reduced.txt'),
      join(testLogDir, 'one_solo_shuffle.txt'),
      join(testLogDir, 'shuffle_early_leaver.txt'),
      join(testLogDir, 'shuffle_reloads.txt'),
    ];

let totalViolations = 0;
let totalMatches = 0;

for (const logPath of logFiles) {
  console.log(`\n=== ${logPath.split('/').pop()} ===`);
  const matches = await parsePositionsFromLog(logPath);

  for (const match of matches) {
    const result = validateMatch(match);
    if (!result) continue;
    totalMatches++;

    console.log(`\n  Zone ${result.zoneId} — ${result.zoneName} (${result.posCount} position samples)`);
    console.log(
      `    Position range X: [${result.xMin.toFixed(1)}, ${result.xMax.toFixed(1)}]  Y: [${result.yMin.toFixed(1)}, ${result.yMax.toFixed(1)}]`,
    );
    if (result.outOfBounds > 0) {
      console.log(`    ⚠ ${result.outOfBounds} positions outside zone bounds`);
    }

    for (const obs of result.obsStats) {
      const label = obs.violations > 0 ? `❌ VIOLATIONS: ${obs.violations}` : '✓ clean';
      console.log(`    Obstacle #${obs.index}: ${label}  |  closest approach: ${obs.minDist} units`);
      totalViolations += obs.violations;
    }
  }
}

console.log(`\n===== Summary =====`);
console.log(`Matches validated: ${totalMatches}`);
console.log(`Total geometry violations (positions inside obstacles): ${totalViolations}`);
if (totalViolations === 0) {
  console.log('✓ All positions clear of all obstacles — geometry looks good.');
} else {
  console.log('❌ Some positions are inside obstacles — geometry needs adjustment.');
}
