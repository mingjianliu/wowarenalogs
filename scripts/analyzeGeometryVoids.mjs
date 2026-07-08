/**
 * Zero-density void analysis for arena obstacle calibration.
 *
 * Complements validateGeometry.mjs: where the validator only counts positions
 * that fall INSIDE drawn obstacles, this tool diagnoses WHY and proposes what
 * the geometry should be, from position data alone.
 *
 * Principle (established in the 2026-07-07 recalibration of zones 617/1134/572/2563):
 *   - A real solid obstacle leaves a CONTIGUOUS ZERO-SAMPLE VOID — players can
 *     never stand inside it, so with enough samples its footprint is empty.
 *   - A drawn obstacle whose footprint carries at/above-ambient sample density
 *     is fictional or a walkable dais — it does not block ground movement and
 *     should not block 2D line of sight.
 *   - Interior void clusters that do NOT correspond to a drawn obstacle are
 *     candidate solid structures that the geometry is missing.
 *
 * Usage:
 *   node scripts/analyzeGeometryVoids.mjs <log-path> [more-log-paths...]
 *   node scripts/analyzeGeometryVoids.mjs --list <file-with-one-log-path-per-line>
 *   Optional: --zones 617,1134   (default: every zone seen in the logs)
 *
 * Reading the output:
 *   - Per-obstacle verdict hints:
 *       SOLID           void% >= 70 — obstacle is real; edges may need ±1 trim
 *       SUSPECT         void% 30–70 — partially wrong; check the void extent
 *       WALKABLE/FAKE   void% < 30 with meaningful samples inside — remove or
 *                       replace with the void cluster actually observed
 *   - Candidate clusters: contiguous interior voids >= MIN_CLUSTER_CELLS. Check
 *     each against the map before adopting: starting-pen areas and out-of-play
 *     niches can also be void (pens usually get SOME samples from pre-gate buff
 *     casts, but sparse logs may miss them). Cross-check cluster bounds against
 *     zoneMetadata and the minimap.
 *   - Sample size matters: below ~50k samples per zone, voids are unreliable.
 *     The Jul 2026 recalibration used 450k–810k samples per zone.
 */

import { createReadStream, readFileSync } from 'fs';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

// Interior test: an unsampled cell counts as interior void only when sampled
// cells exist within this many units on ALL four axis directions. Radius 8
// keeps large structures (24-unit walls) connected while excluding the area
// beyond the arena's outer walls.
const INTERIOR_RADIUS = 8;
const MIN_CLUSTER_CELLS = 5;

// ---------------------------------------------------------------------------
// Load geometry from the TS sources of truth (same approach as validateGeometry.mjs)
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
const zoneMetadata = loadExportedObject(join(repoRoot, 'packages/shared/src/data/zoneMetadata.ts'), 'zoneMetadata');

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function pointInPolygon(px, py, vertices) {
  let inside = false;
  const n = vertices.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = vertices[i];
    const [xj, yj] = vertices[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function isInsideObstacle(px, py, obs) {
  if (obs.type === 'circle') return Math.hypot(px - obs.cx, py - obs.cy) < obs.r;
  return pointInPolygon(px, py, obs.vertices);
}

// ---------------------------------------------------------------------------
// Log parsing (same event/param layout assumptions as validateGeometry.mjs)
// ---------------------------------------------------------------------------

const SPELL_EVENTS = new Set(['SPELL_CAST_SUCCESS', 'SPELL_DAMAGE', 'SPELL_HEAL', 'SPELL_PERIODIC_DAMAGE']);

function parseLine(raw) {
  const tabIdx = raw.indexOf('  ');
  if (tabIdx === -1) return null;
  const rest = raw.slice(tabIdx + 2);
  const commaIdx = rest.indexOf(',');
  if (commaIdx === -1) return null;
  return {
    event: rest.slice(0, commaIdx),
    params: rest
      .slice(commaIdx + 1)
      .split(',')
      .map((s) => s.trim()),
  };
}

async function accumulatePositions(logPath, zoneFilter, grids) {
  let zone = null;
  let guids = new Set();
  const rl = createInterface({ input: createReadStream(logPath), crlfDelay: Infinity });
  for await (const rawLine of rl) {
    const line = parseLine(rawLine.trim());
    if (!line) continue;
    const { event, params } = line;
    if (event === 'ARENA_MATCH_START') {
      zone = !zoneFilter || zoneFilter.has(params[0]) ? params[0] : null;
      guids = new Set();
    } else if (event === 'ARENA_MATCH_END') {
      zone = null;
    } else if (event === 'COMBATANT_INFO' && zone) {
      guids.add(params[0]?.replace(/"/g, ''));
    } else if (zone && SPELL_EVENTS.has(event) && params.length > 24) {
      const src = params[0]?.replace(/"/g, '');
      if (!src || !guids.has(src)) continue;
      let px, py;
      if (params.length >= 30) {
        px = parseFloat(params[25]);
        py = parseFloat(params[26]);
      } else {
        px = parseFloat(params[23]);
        py = parseFloat(params[24]);
      }
      if (!isFinite(px) || !isFinite(py)) continue;
      if (!grids.has(zone)) grids.set(zone, new Map());
      const g = grids.get(zone);
      const key = `${Math.floor(px)},${Math.floor(py)}`;
      g.set(key, (g.get(key) ?? 0) + 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

function analyzeObstacles(zone, g, ambient) {
  const obstacles = arenaObstacles[zone] ?? [];
  const lines = [];
  obstacles.forEach((o, idx) => {
    let bounds;
    if (o.type === 'circle') bounds = { x0: o.cx - o.r, x1: o.cx + o.r, y0: o.cy - o.r, y1: o.cy + o.r };
    else {
      const xs = o.vertices.map((v) => v[0]);
      const ys = o.vertices.map((v) => v[1]);
      bounds = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
    }
    let cells = 0;
    let voidCells = 0;
    let insideSamples = 0;
    let vx0 = Infinity,
      vx1 = -Infinity,
      vy0 = Infinity,
      vy1 = -Infinity;
    for (let x = Math.floor(bounds.x0); x <= Math.ceil(bounds.x1); x++) {
      for (let y = Math.floor(bounds.y0); y <= Math.ceil(bounds.y1); y++) {
        if (!isInsideObstacle(x + 0.5, y + 0.5, o)) continue;
        cells++;
        const c = g.get(`${x},${y}`) ?? 0;
        insideSamples += c;
        if (c === 0) {
          voidCells++;
          vx0 = Math.min(vx0, x);
          vx1 = Math.max(vx1, x);
          vy0 = Math.min(vy0, y);
          vy1 = Math.max(vy1, y);
        }
      }
    }
    const voidPct = cells > 0 ? (100 * voidCells) / cells : 0;
    const expected = Math.round(cells * ambient);
    const verdict = voidPct >= 70 ? 'SOLID' : voidPct >= 30 ? 'SUSPECT' : 'WALKABLE/FAKE';
    const shape = o.type === 'circle' ? `circle r=${o.r} @${o.cx},${o.cy}` : 'polygon';
    const voidStr = voidCells > 0 ? ` | void extent x[${vx0}..${vx1}] y[${vy0}..${vy1}]` : '';
    lines.push(
      `  obs#${idx} (${shape}): ${verdict}  void ${voidPct.toFixed(0)}% (${voidCells}/${cells} cells) | inside samples ${insideSamples} vs ~${expected} if open ground${voidStr}`,
    );
  });
  return lines;
}

function findVoidClusters(g) {
  const xs = [...g.keys()].map((k) => +k.split(',')[0]);
  const ys = [...g.keys()].map((k) => +k.split(',')[1]);
  const x0 = Math.min(...xs),
    x1 = Math.max(...xs),
    y0 = Math.min(...ys),
    y1 = Math.max(...ys);
  const sampled = (x, y) => g.has(`${x},${y}`);
  const offsets = Array.from({ length: INTERIOR_RADIUS }, (_, i) => i + 1);
  const isInteriorVoid = (x, y) => {
    if (sampled(x, y)) return false;
    let sides = 0;
    if (offsets.some((d) => sampled(x + d, y))) sides++;
    if (offsets.some((d) => sampled(x - d, y))) sides++;
    if (offsets.some((d) => sampled(x, y + d))) sides++;
    if (offsets.some((d) => sampled(x, y - d))) sides++;
    return sides >= 4;
  };
  const voidSet = new Set();
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) if (isInteriorVoid(x, y)) voidSet.add(`${x},${y}`);

  const seen = new Set();
  const clusters = [];
  for (const k of voidSet) {
    if (seen.has(k)) continue;
    const stack = [k];
    const cells = [];
    while (stack.length) {
      const c = stack.pop();
      if (seen.has(c) || !voidSet.has(c)) continue;
      seen.add(c);
      cells.push(c);
      const [cx, cy] = c.split(',').map(Number);
      stack.push(`${cx + 1},${cy}`, `${cx - 1},${cy}`, `${cx},${cy + 1}`, `${cx},${cy - 1}`);
    }
    if (cells.length >= MIN_CLUSTER_CELLS) {
      const cxs = cells.map((c) => +c.split(',')[0]);
      const cys = cells.map((c) => +c.split(',')[1]);
      clusters.push({
        n: cells.length,
        x0: Math.min(...cxs),
        x1: Math.max(...cxs),
        y0: Math.min(...cys),
        y1: Math.max(...cys),
      });
    }
  }
  clusters.sort((a, b) => b.n - a.n);
  return clusters;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let zoneFilter = null;
let logPaths = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--zones') zoneFilter = new Set(args[++i].split(','));
  else if (args[i] === '--list') logPaths.push(...readFileSync(args[++i], 'utf8').trim().split('\n'));
  else logPaths.push(args[i]);
}
if (logPaths.length === 0) {
  console.error('Usage: node scripts/analyzeGeometryVoids.mjs <log>... | --list <file> [--zones 617,1134]');
  process.exit(1);
}

const grids = new Map();
let processed = 0;
for (const p of logPaths) {
  await accumulatePositions(p, zoneFilter, grids);
  processed++;
  if (processed % 25 === 0) console.error(`  ...${processed}/${logPaths.length} logs`);
}

for (const [zone, g] of [...grids.entries()].sort()) {
  const total = [...g.values()].reduce((a, b) => a + b, 0);
  const ambient = total / g.size;
  const name = zoneMetadata[zone]?.name ?? 'unknown zone';
  console.log(
    `\n=== Zone ${zone} — ${name}: ${total} samples over ${g.size} occupied cells (ambient ${ambient.toFixed(1)}/cell) ===`,
  );
  if (total < 50_000) console.log(`  ⚠ LOW SAMPLE COUNT — void verdicts unreliable below ~50k samples`);

  const obsLines = analyzeObstacles(zone, g, ambient);
  if (obsLines.length > 0) {
    console.log('  Drawn obstacles:');
    obsLines.forEach((l) => console.log(`  ${l}`));
  } else {
    console.log('  No obstacles drawn for this zone.');
  }

  const clusters = findVoidClusters(g);
  console.log(`  Interior void clusters (>=${MIN_CLUSTER_CELLS} cells) — candidate solid structures:`);
  if (clusters.length === 0) console.log('    none');
  for (const c of clusters.slice(0, 15)) {
    console.log(`    ${c.n} cells  x[${c.x0}..${c.x1}] y[${c.y0}..${c.y1}]  (${c.x1 - c.x0 + 1}x${c.y1 - c.y0 + 1})`);
  }
}
