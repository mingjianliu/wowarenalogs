/* eslint-disable no-console */
/**
 * printMatchPrompts.ts
 *
 * Downloads matches from the cloud and prints the complete AI prompt string
 * that would be sent to Claude for each match — same pipeline as buildMatchContext()
 * in CombatAIAnalysis/index.tsx, without any React dependencies.
 *
 * Usage:
 *   npm run -w @wowarenalogs/tools start:printMatchPrompts
 *   npm run -w @wowarenalogs/tools start:printMatchPrompts -- --count 10
 *   npm run -w @wowarenalogs/tools start:printMatchPrompts -- --count 5 --bracket 3v3
 *   npm run -w @wowarenalogs/tools start:printMatchPrompts -- --local   (reads ~/Downloads/wow logs/)
 *   npm run -w @wowarenalogs/tools start:printMatchPrompts -- --count 3 --ai  (also calls Claude and prints responses)
 *   npm run -w @wowarenalogs/tools start:printMatchPrompts -- --count 3 --ai --test-prompt  (adds ## Prompt Feedback to each response)
 *   npm run -w @wowarenalogs/tools start:printMatchPrompts -- --count 1 --new-prompt  (uses raw timeline prompt path)
 *   npm run -w @wowarenalogs/tools start:printMatchPrompts -- --count 5 --spec Priest_Discipline --result Win --min-duration 60 --verbose
 */

import Anthropic from '@anthropic-ai/sdk';
import { CombatUnitReaction, CombatUnitType, IArenaMatch, ICombatUnit, IShuffleRound } from '@wowarenalogs/parser';
import fs from 'fs-extra';
import fetch from 'node-fetch';
import os from 'os';
import path from 'path';

import { buildMatchContext } from '../../shared/src/components/CombatReport/CombatAIAnalysis/buildMatchContext';
import { NEW_SYSTEM_PROMPT, SYSTEM_PROMPT } from '../../shared/src/prompts/analyzeSystemPrompts';
import { isHealerSpec, specToString } from '../../shared/src/utils/cooldowns';
import { callClaudeCli, resolveAnalysisBackend } from './utils/claudeCli';
import { logCache } from './utils/logCache';

const API_BASE = 'https://wowarenalogs.com';

// Test system prompt — extends SYSTEM_PROMPT with a meta-reflection section
// to help us understand how to improve the data we send and the prompts we write.
const TEST_SYSTEM_PROMPT =
  SYSTEM_PROMPT +
  `

---

PROMPT IMPROVEMENT FEEDBACK (append after your findings):

## Prompt Feedback

After your findings, add a short section titled "## Prompt Feedback" with:

1. **Most useful data**: Which sections of the input most directly supported your analysis? (e.g., CRITICAL MOMENTS, MATCH ARC, enemy CD timeline)
2. **Least useful / redundant data**: What did you barely use or find noisy? Why?
3. **Missing data**: What information was absent that would have materially changed your confidence or conclusions? Be specific — e.g., "HP% at the time of the trade", "whether X was interrupted", "exact DR timers for the CC chain".
4. **Ambiguities**: Any moments where the structured data conflicted, was self-contradictory, or left you guessing?
5. **One prompt rule change**: If you could rewrite one rule in your system instructions to produce better analysis, what would it be and why?

Keep this section under 200 words. Be blunt — this feedback is for internal use to improve the prompting pipeline, not for the player.`;

export type ParsedCombat = IArenaMatch | IShuffleRound;

// ---------------------------------------------------------------------------
// Cloud download
// ---------------------------------------------------------------------------

const STUBS_QUERY = `
  query GetLatestMatches($wowVersion: String!, $bracket: String, $offset: Int!, $count: Int!, $minRating: Float) {
    latestMatches(wowVersion: $wowVersion, bracket: $bracket, offset: $offset, count: $count, minRating: $minRating) {
      combats {
        ... on ArenaMatchDataStub  {
          id wowVersion logObjectUrl startTime endTime timezone
          playerId playerTeamId winningTeamId durationInSeconds
          units { name spec type reaction }
          startInfo { bracket }
        }
        ... on ShuffleRoundStub    {
          id wowVersion logObjectUrl startTime endTime timezone
          playerId playerTeamId winningTeamId durationInSeconds
          units { name spec type reaction }
          startInfo { bracket }
        }
      }
    }
  }
`;

export interface MatchStub {
  id: string;
  wowVersion: string;
  logObjectUrl: string;
  startTime: number;
  endTime: number;
  playerId?: string;
  playerTeamId?: string;
  winningTeamId?: string;
  durationInSeconds?: number;
  units?: {
    name: string;
    spec: string;
    type: CombatUnitType;
    reaction: CombatUnitReaction;
  }[];
  startInfo?: { bracket: string };
}

export async function fetchStubs(bracket: string, count: number, offset = 0, minRating?: number): Promise<MatchStub[]> {
  const res = await fetch(`${API_BASE}/api/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: STUBS_QUERY,
      variables: { wowVersion: 'retail', bracket, offset, count, minRating },
    }),
  });
  if (!res.ok) throw new Error(`GraphQL ${res.status}: ${res.statusText}`);
  const json = (await res.json()) as { data?: { latestMatches?: { combats?: MatchStub[] } }; errors?: unknown[] };
  if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data?.latestMatches?.combats ?? [];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export async function parseLogText(text: string): Promise<ParsedCombat[]> {
  const { WoWCombatLogParser } = await import('@wowarenalogs/parser');
  const lines = text.split('\n');
  const parser = new WoWCombatLogParser('retail');
  const combats: ParsedCombat[] = [];
  parser.on('arena_match_ended', (c: IArenaMatch) => combats.push(c));
  parser.on('solo_shuffle_ended', (m: { rounds: IShuffleRound[] }) => combats.push(...m.rounds));
  for (const line of lines) parser.parseLine(line);
  parser.flush();
  return combats;
}

// ---------------------------------------------------------------------------
// AI call
// ---------------------------------------------------------------------------

export async function callClaude(prompt: string, mode: 'standard' | 'test' | 'new' = 'standard'): Promise<string> {
  const systemPrompt = mode === 'new' ? NEW_SYSTEM_PROMPT : mode === 'test' ? TEST_SYSTEM_PROMPT : SYSTEM_PROMPT;
  const backend = resolveAnalysisBackend();
  if (backend === 'none') {
    return '[AI SKIPPED — set ANTHROPIC_API_KEY or install the claude CLI to enable]';
  }
  if (backend === 'cli') {
    return callClaudeCli({ prompt, systemPrompt });
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 6144,
    temperature: 0.3,
    system: systemPrompt,
    messages: [{ role: 'user', content: prompt }],
  });
  const content = message.content[0];
  if (content.type !== 'text') return '[AI returned non-text response]';
  return content.text;
}

// ---------------------------------------------------------------------------
// Build full prompt — thin wrappers around production buildMatchContext() so
// the eval harness never diverges from CombatAIAnalysis/buildMatchContext.ts.
// Cloud/local matches have no single "owner" field on combat itself —
// buildMatchContext falls back to friends[0] when combat.playerId doesn't
// match a friend. forceHealer overrides that fallback to a healer; it never
// overrides the primary combat.playerId-derived owner, so production
// (non-forceHealer) behavior is unchanged.
// ---------------------------------------------------------------------------
function deriveFriendsAndEnemies(combat: ParsedCombat): { friends: ICombatUnit[]; enemies: ICombatUnit[] } {
  const allUnits = Object.values(combat.units);
  const friends = allUnits.filter(
    (u) => u.type === CombatUnitType.Player && u.reaction === CombatUnitReaction.Friendly,
  ) as ICombatUnit[];
  const enemies = allUnits.filter(
    (u) => u.type === CombatUnitType.Player && u.reaction === CombatUnitReaction.Hostile,
  ) as ICombatUnit[];
  return { friends, enemies };
}

function deriveForcedOwner(
  combat: ParsedCombat,
  friends: ICombatUnit[],
  forceHealer: boolean,
): ICombatUnit | undefined {
  const byPlayerId = friends.find((p) => p.id === combat.playerId);
  if (byPlayerId || !forceHealer) return undefined;
  return friends.find((p) => isHealerSpec(p.spec)) ?? friends[0];
}

export function buildMatchPrompt(combat: ParsedCombat, forceHealer = false): string {
  const { friends, enemies } = deriveFriendsAndEnemies(combat);
  if (friends.length === 0 || enemies.length === 0) return '';
  const durationSeconds = (combat.endTime - combat.startTime) / 1000;
  if (durationSeconds < 10) return '';
  const owner = deriveForcedOwner(combat, friends, forceHealer);
  return buildMatchContext(combat, friends, enemies, { owner });
}

export function buildMatchPromptNew(combat: ParsedCombat, forceHealer = false): string {
  const { friends, enemies } = deriveFriendsAndEnemies(combat);
  if (friends.length === 0 || enemies.length === 0) return '';
  const durationSeconds = (combat.endTime - combat.startTime) / 1000;
  if (durationSeconds < 10) return '';
  const owner = deriveForcedOwner(combat, friends, forceHealer);
  return buildMatchContext(combat, friends, enemies, { useTimelinePrompt: true, owner });
}

interface PrintMatchOptions {
  testPromptMode?: boolean;
  useNewPrompt?: boolean;
  forceHealer?: boolean;
}

async function printMatch(
  matchLabel: string,
  prompt: string,
  matchIndex: number,
  aiMode: boolean,
  options: PrintMatchOptions = {},
): Promise<void> {
  const { testPromptMode = false, useNewPrompt = false } = options;
  const sep = '='.repeat(80);
  console.log(`\n${sep}`);
  console.log(`MATCH ${matchIndex} — ${matchLabel}`);
  console.log(sep);

  console.log('\n--- PROMPT ---\n');
  console.log(prompt);

  if (aiMode) {
    const modeTag = useNewPrompt ? ' [new-prompt]' : testPromptMode ? ' [test-prompt]' : '';
    const label = useNewPrompt
      ? 'AI RESPONSE (new-prompt mode — raw timeline path)'
      : testPromptMode
        ? 'AI RESPONSE (test-prompt mode — includes feedback section)'
        : 'AI RESPONSE';
    console.log(`\n--- ${label} ---\n`);
    process.stderr.write(`  Calling Claude for match ${matchIndex}${modeTag}...\n`);
    const mode = useNewPrompt ? 'new' : testPromptMode ? 'test' : 'standard';
    try {
      const response = await callClaude(prompt, mode);
      console.log(response);
    } catch (e) {
      console.log(`[AI call failed: ${e}]`);
    }
  }
}

// ---------------------------------------------------------------------------
// Cloud runner
// ---------------------------------------------------------------------------

interface RunOptions {
  testPromptMode?: boolean;
  forceHealer?: boolean;
  useNewPrompt?: boolean;
  filterSpec?: string;
  filterMinDuration?: number;
  filterMaxDuration?: number;
  filterResult?: string;
  verbose?: boolean;
}
export async function processStub(
  stub: MatchStub,
  matchIndex: number,
  count: number,
  aiMode: boolean,
  options: RunOptions,
): Promise<boolean> {
  const { forceHealer = false, verbose = false } = options;
  const date = new Date(stub.startTime).toISOString().slice(0, 10);

  let text: string;
  try {
    text = await logCache.getLogText(stub.id, stub.logObjectUrl);
  } catch (e) {
    process.stderr.write(`download/cache failed: ${e}\n`);
    return false;
  }

  let combats: ParsedCombat[];
  try {
    combats = await parseLogText(text);
  } catch (e) {
    process.stderr.write(`parse failed: ${e}\n`);
    return false;
  }

  let foundInThisStub = false;
  for (const combat of combats) {
    // Apply filters
    const durationSec = (combat.endTime - combat.startTime) / 1000;
    if (options.filterMinDuration && durationSec < options.filterMinDuration) {
      if (verbose) process.stderr.write(`too short (${Math.round(durationSec)}s)\n`);
      continue;
    }
    if (options.filterMaxDuration && durationSec > options.filterMaxDuration) {
      if (verbose) process.stderr.write(`too long (${Math.round(durationSec)}s)\n`);
      continue;
    }

    const allUnits = Object.values(combat.units);
    const friends = allUnits.filter(
      (u) => u.type === CombatUnitType.Player && u.reaction === CombatUnitReaction.Friendly,
    ) as ICombatUnit[];
    const enemies = allUnits.filter(
      (u) => u.type === CombatUnitType.Player && u.reaction === CombatUnitReaction.Hostile,
    ) as ICombatUnit[];
    if (friends.length === 0 || enemies.length === 0) continue;

    const byPlayerId = friends.find((p) => p.id === combat.playerId);
    const owner = byPlayerId
      ? byPlayerId
      : forceHealer
        ? (friends.find((p) => isHealerSpec(p.spec)) ?? friends[0])
        : (friends.find((p) => !isHealerSpec(p.spec)) ?? friends.find((p) => isHealerSpec(p.spec)) ?? friends[0]);

    if (options.filterSpec && specToString(owner.spec).toLowerCase() !== options.filterSpec.toLowerCase()) {
      if (verbose) process.stderr.write(`spec mismatch (${specToString(owner.spec)})\n`);
      continue;
    }

    const combatAny = combat as unknown as Record<string, unknown>;
    const playerWon =
      typeof combatAny['winningTeamId'] === 'string' ? combatAny['winningTeamId'] === combat.playerTeamId : null;
    const resultStr: 'Win' | 'Loss' | 'Unknown' = playerWon === true ? 'Win' : playerWon === false ? 'Loss' : 'Unknown';

    if (options.filterResult && resultStr.toLowerCase() !== options.filterResult.toLowerCase()) {
      if (verbose) process.stderr.write(`result mismatch (${resultStr})\n`);
      continue;
    }

    const forcedOwner = deriveForcedOwner(combat, friends, forceHealer);
    const prompt = options.useNewPrompt
      ? buildMatchContext(combat, friends, enemies, { useTimelinePrompt: true, owner: forcedOwner })
      : buildMatchContext(combat, friends, enemies, { owner: forcedOwner });
    if (!prompt) {
      if (verbose) process.stderr.write(`empty prompt\n`);
      continue;
    }

    foundInThisStub = true;
    process.stderr.write(`MATCH ${matchIndex} found!\n`);
    const label = `${stub.id} (${stub.startInfo?.bracket ?? 'Unknown'}, ${date}) - ${specToString(owner.spec)} ${resultStr} ${Math.round(durationSec)}s`;
    await printMatch(label, prompt, matchIndex, aiMode, options);
    break; // only take one combat per stub to match index logic
  }

  return foundInThisStub;
}

async function runCloud(count: number, bracket: string, aiMode: boolean, options: RunOptions = {}) {
  const { verbose = false } = options;
  console.log(`Fetching ${count} matches (bracket: ${bracket}) from ${API_BASE}...\n`);

  await logCache.init();

  let matchCount = 0;
  let offset = 0;
  const PAGE_SIZE = 50;

  while (matchCount < count) {
    const stubs = await fetchStubs(bracket, PAGE_SIZE, offset);
    if (stubs.length === 0) {
      console.log('No more matches returned from API.');
      break;
    }
    offset += PAGE_SIZE;

    for (const stub of stubs) {
      if (matchCount >= count) break;

      const date = new Date(stub.startTime).toISOString().slice(0, 10);

      // Pre-filter with stub metadata
      if (options.filterMinDuration && stub.durationInSeconds && stub.durationInSeconds < options.filterMinDuration) {
        if (verbose) process.stderr.write(`Skipping ${stub.id} (metadata): too short (${stub.durationInSeconds}s)\n`);
        continue;
      }
      if (options.filterMaxDuration && stub.durationInSeconds && stub.durationInSeconds > options.filterMaxDuration) {
        if (verbose) process.stderr.write(`Skipping ${stub.id} (metadata): too long (${stub.durationInSeconds}s)\n`);
        continue;
      }

      if (options.filterResult && stub.playerTeamId && stub.winningTeamId) {
        const playerWon = stub.winningTeamId === stub.playerTeamId;
        const resultStr = playerWon ? 'Win' : 'Loss';
        if (resultStr.toLowerCase() !== options.filterResult.toLowerCase()) {
          if (verbose) process.stderr.write(`Skipping ${stub.id} (metadata): result mismatch (${resultStr})\n`);
          continue;
        }
      }

      if (options.filterSpec && stub.units && stub.playerId) {
        const ownerStub = stub.units.find((u) => u.name === stub.playerId);
        if (ownerStub && ownerStub.spec) {
          const stubSpec = ownerStub.spec.toLowerCase().replace(/[^a-z0-9]/g, '');
          const filterSpec = options.filterSpec.toLowerCase().replace(/[^a-z0-9]/g, '');
          if (!stubSpec.includes(filterSpec) && !filterSpec.includes(stubSpec)) {
            if (verbose) process.stderr.write(`Skipping ${stub.id} (metadata): spec mismatch (${ownerStub.spec})\n`);
            continue;
          }
        }
      }

      process.stderr.write(`Processing ${stub.id} (${stub.startInfo?.bracket ?? bracket}, ${date})... `);

      const found = await processStub(stub, matchCount + 1, count, aiMode, options);
      if (found) {
        matchCount++;
      }
    }
  }

  console.log(`\n${'='.repeat(80)}`);
  console.log(`Total matches printed: ${matchCount}`);
}

// ---------------------------------------------------------------------------
// Local runner
// ---------------------------------------------------------------------------

async function runLocal(logDir: string, aiMode: boolean, options: RunOptions = {}) {
  const { forceHealer = false, useNewPrompt = false } = options;
  const files = (await fs.readdir(logDir))
    .filter((f) => f.endsWith('.txt') || f.endsWith('.log'))
    .map((f) => path.join(logDir, f))
    .sort();

  if (files.length === 0) {
    console.error(`No .txt or .log files found in ${logDir}`);
    process.exit(1);
  }

  console.log(`Scanning ${files.length} log file(s) in ${logDir}\n`);
  let matchCount = 0;

  for (const logPath of files) {
    const fileName = path.basename(logPath);
    let combats: ParsedCombat[];
    try {
      combats = await parseLogText(await fs.readFile(logPath, 'utf-8'));
    } catch (e) {
      console.error(`Error parsing ${fileName}: ${e}`);
      continue;
    }
    if (combats.length === 0) continue;

    for (const combat of combats) {
      // Apply filters
      const durationSec = (combat.endTime - combat.startTime) / 1000;
      if (options.filterMinDuration && durationSec < options.filterMinDuration) continue;
      if (options.filterMaxDuration && durationSec > options.filterMaxDuration) continue;

      const allUnits = Object.values(combat.units);
      const friends = allUnits.filter(
        (u) => u.type === CombatUnitType.Player && u.reaction === CombatUnitReaction.Friendly,
      ) as ICombatUnit[];
      const enemies = allUnits.filter(
        (u) => u.type === CombatUnitType.Player && u.reaction === CombatUnitReaction.Hostile,
      ) as ICombatUnit[];
      if (friends.length === 0 || enemies.length === 0) continue;

      const byPlayerId = friends.find((p) => p.id === combat.playerId);
      const owner = byPlayerId
        ? byPlayerId
        : forceHealer
          ? (friends.find((p) => isHealerSpec(p.spec)) ?? friends[0])
          : (friends.find((p) => !isHealerSpec(p.spec)) ?? friends.find((p) => isHealerSpec(p.spec)) ?? friends[0]);

      if (!owner) continue;
      if (options.filterSpec && specToString(owner.spec) !== options.filterSpec) continue;

      const combatAny = combat as unknown as Record<string, unknown>;
      const playerWon =
        typeof combatAny['winningTeamId'] === 'string' ? combatAny['winningTeamId'] === combat.playerTeamId : null;
      const resultStr = playerWon === true ? 'Win' : playerWon === false ? 'Loss' : 'Unknown';

      if (options.filterResult && resultStr.toLowerCase() !== options.filterResult.toLowerCase()) continue;

      const forcedOwner = deriveForcedOwner(combat, friends, forceHealer);
      const prompt = useNewPrompt
        ? buildMatchContext(combat, friends, enemies, { useTimelinePrompt: true, owner: forcedOwner })
        : buildMatchContext(combat, friends, enemies, { owner: forcedOwner });
      if (!prompt) continue;
      matchCount++;
      const label = `${fileName} - ${specToString(owner.spec)} ${resultStr} ${Math.round(durationSec)}s`;
      await printMatch(label, prompt, matchCount, aiMode, options);
    }
  }

  console.log(`\n${'='.repeat(80)}`);
  console.log(`Total matches printed: ${matchCount}`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const localMode = args.includes('--local');
  const aiMode = args.includes('--ai');
  const testPromptMode = args.includes('--test-prompt');
  const forceHealer = args.includes('--healer');
  const useNewPrompt = args.includes('--new-prompt');
  const verbose = args.includes('--verbose');
  const countIdx = args.indexOf('--count');
  const bracketIdx = args.indexOf('--bracket');
  const bracket = bracketIdx !== -1 ? args[bracketIdx + 1] : 'Rated Solo Shuffle';
  const count = countIdx !== -1 ? parseInt(args[countIdx + 1] ?? '10', 10) : 10;

  const specIdx = args.indexOf('--spec');
  const minDurationIdx = args.indexOf('--min-duration');
  const maxDurationIdx = args.indexOf('--max-duration');
  const resultIdx = args.indexOf('--result');

  const filterSpec = specIdx !== -1 ? args[specIdx + 1] : undefined;
  const filterMinDuration = minDurationIdx !== -1 ? parseInt(args[minDurationIdx + 1] ?? '0', 10) : undefined;
  const filterMaxDuration = maxDurationIdx !== -1 ? parseInt(args[maxDurationIdx + 1] ?? '0', 10) : undefined;
  const filterResult = resultIdx !== -1 ? args[resultIdx + 1] : undefined;

  const runOptions: RunOptions = {
    testPromptMode,
    forceHealer,
    useNewPrompt,
    filterSpec,
    filterMinDuration,
    filterMaxDuration,
    filterResult,
    verbose,
  };

  if (aiMode) {
    const backend = resolveAnalysisBackend();
    if (backend === 'none') {
      process.stderr.write(
        'Warning: --ai flag set but no backend available (no ANTHROPIC_API_KEY, no claude CLI). Responses will be skipped.\n',
      );
    } else {
      const modeLabel = useNewPrompt
        ? ' (new-prompt mode — raw timeline path)'
        : testPromptMode
          ? ' (test-prompt mode — responses include ## Prompt Feedback section)'
          : '';
      process.stderr.write(
        `AI mode enabled (${backend} backend) — will call Claude after each match prompt${modeLabel}.\n`,
      );
    }
  }

  if (localMode) {
    const logDir = (process.env.LOG_DIR ?? path.join(process.env.HOME ?? os.homedir(), 'Downloads/wow logs')).replace(
      /^~/,
      os.homedir(),
    );
    await runLocal(logDir, aiMode, runOptions);
  } else {
    await runCloud(count, bracket, aiMode, runOptions);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
