/* eslint-disable */
/* eslint-disable no-console */
import Anthropic from '@anthropic-ai/sdk';
import { CombatUnitReaction, CombatUnitType, IArenaMatch, IShuffleRound } from '@wowarenalogs/parser';
import { spawnSync } from 'child_process';
import fs from 'fs-extra';
import path from 'path';

import dotenv from 'dotenv';
import { getEnglishSpellName } from '../../shared/src/data/spellEffectData';
import { specToString } from '../../shared/src/utils/cooldowns';
import { extractRotations } from '../../shared/src/utils/matchEmbeddingRecord';
import { CD_TALENT_MODIFIERS } from '../../shared/src/utils/talentModifiers';
import { getPlayerTalentedSpellInfo } from '../../shared/src/utils/talents';

const SPEC_PLAYSTYLES_DIR = path.join(__dirname, 'data/playstyles');

dotenv.config({ path: path.join(__dirname, '../../web/.env.local') });

// Types for local database matching
interface IPlaystyleRecord {
  categoryName: string;
  associatedClusterRank: number;
  keyHealingCD: string;
  keyDefensiveOrHealAmpCD: string;
  rotationSummary: string;
  playstyleDescription: string;
  sampleCount: number;
  lastUpdated: string;
}

async function parseLogFile(logPath: string) {
  const { WoWCombatLogParser } = await import('@wowarenalogs/parser');
  const text = await fs.readFile(logPath, 'utf-8');
  const lines = text.split('\n');
  const parser = new WoWCombatLogParser('retail');
  const combats: (IArenaMatch | IShuffleRound)[] = [];
  parser.on('arena_match_ended', (c: IArenaMatch) => combats.push(c));
  parser.on('solo_shuffle_ended', (m: { rounds: IShuffleRound[] }) => combats.push(...m.rounds));
  for (const line of lines) parser.parseLine(line);
  parser.flush();
  return combats;
}

export function getPythonSpecName(specString: string): string {
  return specString.toLowerCase().replace(/_/g, '-').replace(/\s+/g, '-');
}

export function runPythonBridge(specStr: string, talents: Record<number, number>) {
  const specName = getPythonSpecName(specStr);
  const talentsStr = JSON.stringify(talents);
  try {
    const pythonExe = '/Users/mingjianliu/code/wow-talent-gear-collector/.venv/bin/python';
    const scriptPath = '/Users/mingjianliu/code/wow-talent-gear-collector/scripts/get_spec_clusters.py';

    const result = spawnSync(pythonExe, [scriptPath, '--spec', specName, '--talents', talentsStr], {
      encoding: 'utf-8',
    });

    if (result.status !== 0) {
      console.error('Python bridge script exited with non-zero code:', result.status, result.stderr);
      return null;
    }

    return JSON.parse(result.stdout);
  } catch (e) {
    console.error('Python bridge execution failed:', e);
    return null;
  }
}

export function inferCDModifiers(specId: number, talentsArray: any[]) {
  const info = getPlayerTalentedSpellInfo(specId, talentsArray);
  if (!info) return [];

  const modifiers: string[] = [];
  const activeTalents = new Set<string>();
  for (const spellId of info.keys()) {
    activeTalents.add(spellId);
  }

  for (const [baseSpellId, mods] of Object.entries(CD_TALENT_MODIFIERS)) {
    for (const mod of mods) {
      if (activeTalents.has(mod.talentSpellId)) {
        const talentName = info.get(mod.talentSpellId)?.name || `Talent ${mod.talentSpellId}`;
        const baseSpellName = getEnglishSpellName(baseSpellId);

        let effectDesc = '';
        if (mod.effect === 'extra_charge') {
          effectDesc = `grants +${mod.value} extra charge(s)`;
        } else if (mod.effect === 'reduce_cd') {
          effectDesc = `reduces cooldown by ${mod.value}s`;
        } else if (mod.effect === 'replace_spell') {
          effectDesc = `replaces spell`;
        } else {
          effectDesc = `${mod.effect} (value: ${mod.value})`;
        }

        modifiers.push(
          `Talent "${talentName}" (ID: ${mod.talentSpellId}) is active: ${effectDesc} for "${baseSpellName}" (ID: ${baseSpellId})`,
        );
      }
    }
  }
  return modifiers;
}

async function queryLLMForPlaystyle(
  specName: string,
  talentDetails: any,
  rotationDetails: any,
  cdModifiers: string[],
  existingPlaystyles: IPlaystyleRecord[],
): Promise<any> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY environment variable is not set.');
  }

  const anthropic = new Anthropic({
    apiKey,
  });

  const prompt = `You are a World of Warcraft PvP theorycrafter. Analyze the following combat log data for a player playing the spec "${specName}".

Talents & Cluster Info:
- Matched Top Cluster Rank: ${talentDetails.matched_cluster_rank} (taken by ${talentDetails.matched_cluster_pct}% of top players)
- Jaccard Distance to Cluster Medoid: ${talentDetails.jaccard_distance.toFixed(3)}
- Active talents: ${JSON.stringify(talentDetails.nodes_info)}

Cooldown Modifiers Gained from Talents:
${cdModifiers.length > 0 ? cdModifiers.map((m) => `- ${m}`).join('\n') : '- None'}

Player Rotation Signature:
- Opener Cast Sequence (First 30s): ${rotationDetails.opener.length > 0 ? rotationDetails.opener.join(' -> ') : 'None'}
- Top Core 3-spell Combos:
${rotationDetails.coreSequences.length > 0 ? rotationDetails.coreSequences.map((s: string) => `  * ${s}`).join('\n') : '  * None'}
- Crisis Cast Responses (<40% HP):
${rotationDetails.crisisEvents.length > 0 ? rotationDetails.crisisEvents.map((s: string) => `  * ${s}`).join('\n') : '  * None'}

Existing Playstyle Profiles Identified for This Spec:
${JSON.stringify(existingPlaystyles, null, 2)}

Identify the player's playstyle. If the player's behavior maps closely to one of the existing playstyle profiles listed above, choose that exact categoryName. If it represents a new variant or does not match any existing profile, formulate a new, highly descriptive categoryName (e.g. "Totemic Resto", "Fistweaver Monk - Rising Sun focus").

Output a raw JSON block matching this schema:
{
  "spec": "${specName}",
  "categoryName": "Name of playstyle category",
  "keyHealingCD": "Spells used as main healing CDs",
  "keyDefensiveOrHealAmpCD": "Spells used for damage reduction or amp",
  "rotationSummary": "1-2 sentence summary of their cast priorities",
  "playstyleDescription": "A technical description of how this playstyle operates in arena",
  "justification": "Why does their talent layout and rotation cast pattern map to this playstyle?"
}`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    system: 'Return only a raw JSON block matching the specified schema. No markdown wrappers, no preambles.',
    messages: [{ role: 'user', content: prompt }],
  });

  const content = (response.content[0] as any).text;
  const cleaned = content
    .trim()
    .replace(/^```json/, '')
    .replace(/```$/, '')
    .trim();
  return JSON.parse(cleaned);
}

async function updateLocalRecord(specName: string, category: any, clusterRank: number) {
  const slug = getPythonSpecName(specName);
  await fs.ensureDir(SPEC_PLAYSTYLES_DIR);
  const filePath = path.join(SPEC_PLAYSTYLES_DIR, `${slug}.json`);

  let playstyles: IPlaystyleRecord[] = [];
  if (await fs.pathExists(filePath)) {
    try {
      playstyles = await fs.readJson(filePath);
    } catch {
      playstyles = [];
    }
  }

  const existingIdx = playstyles.findIndex((p) => p.categoryName.toLowerCase() === category.categoryName.toLowerCase());
  if (existingIdx !== -1) {
    const existing = playstyles[existingIdx];
    existing.sampleCount += 1;
    existing.lastUpdated = new Date().toISOString();
    existing.keyHealingCD = category.keyHealingCD;
    existing.keyDefensiveOrHealAmpCD = category.keyDefensiveOrHealAmpCD;
    existing.rotationSummary = category.rotationSummary;
    existing.playstyleDescription = category.playstyleDescription;
  } else {
    playstyles.push({
      categoryName: category.categoryName,
      associatedClusterRank: clusterRank,
      keyHealingCD: category.keyHealingCD,
      keyDefensiveOrHealAmpCD: category.keyDefensiveOrHealAmpCD,
      rotationSummary: category.rotationSummary,
      playstyleDescription: category.playstyleDescription,
      sampleCount: 1,
      lastUpdated: new Date().toISOString(),
    });
  }

  await fs.writeJson(filePath, playstyles, { spaces: 2 });
  console.log(`Updated ${filePath} successfully.`);
}

async function main() {
  const args = process.argv.slice(2);
  const logIdx = args.indexOf('--log');
  const dryRun = args.includes('--dry-run');

  if (logIdx === -1) {
    console.error('Usage: npm run -w @wowarenalogs/tools start:analyzeSpecPlaystyle -- --log <log-path> [--dry-run]');
    process.exit(1);
  }

  const logPath = args[logIdx + 1];
  console.log(`Parsing log file: ${logPath}`);
  const combats = await parseLogFile(logPath);
  if (combats.length === 0) {
    console.error('No matches found in combat log.');
    process.exit(1);
  }

  const match = combats[0];
  const players = Object.values(match.units).filter((u) => u.type === CombatUnitType.Player && u.info && u.spec);

  for (const player of players) {
    const specStr = specToString(player.spec);
    const talentsMap: Record<number, number> = {};
    if (player.info && player.info.talents) {
      player.info.talents.forEach((t) => {
        if (t) talentsMap[t.id1] = t.count;
      });
    }

    console.log(`\n--------------------------------------------`);
    console.log(`Processing player: ${player.name} (${specStr})`);

    // Call Python Jaccard cluster bridge
    const pythonResult = runPythonBridge(specStr, talentsMap);
    if (!pythonResult || pythonResult.error) {
      console.log(`Skipping ${player.name}:`, pythonResult?.error || 'Failed Python matching');
      continue;
    }

    // Extract rotations
    const rotations = extractRotations(player, match);
    // Extract talent CD modifiers
    const cdModifiers = inferCDModifiers(parseInt(player.spec as any, 10), player.info?.talents || []);

    if (dryRun) {
      console.log('--- DRY RUN FEATURES ---');
      console.log('Python Cluster rank:', pythonResult.matched_cluster_rank);
      console.log('Jaccard distance:', pythonResult.jaccard_distance);
      console.log('CD Modifiers:', cdModifiers);
      console.log('Rotations (opener):', rotations.opener.slice(0, 15).join(' -> '), '...');
      console.log('Rotations (core combos):', rotations.coreSequences);
      console.log('Rotations (crisis events):', rotations.crisisEvents);
      continue;
    }

    // Load existing profiles for spec to pass to LLM
    const slug = getPythonSpecName(specStr);
    const filePath = path.join(SPEC_PLAYSTYLES_DIR, `${slug}.json`);
    let existingProfiles: IPlaystyleRecord[] = [];
    if (await fs.pathExists(filePath)) {
      try {
        existingProfiles = await fs.readJson(filePath);
      } catch {}
    }

    console.log(`Running LLM analysis for ${player.name}...`);
    try {
      const llmResult = await queryLLMForPlaystyle(specStr, pythonResult, rotations, cdModifiers, existingProfiles);
      console.log('LLM Result:', JSON.stringify(llmResult, null, 2));
      await updateLocalRecord(specStr, llmResult, pythonResult.matched_cluster_rank);
    } catch (e) {
      console.error(`LLM Analysis failed for ${player.name}:`, e);
    }
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
