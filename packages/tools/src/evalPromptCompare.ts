/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable simple-import-sort/imports */
/* eslint-disable prettier/prettier */
import Anthropic from '@anthropic-ai/sdk';
import { CombatUnitReaction, CombatUnitType, ICombatUnit } from '@wowarenalogs/parser';
import fs from 'fs-extra';
import path from 'path';
import fetch from 'node-fetch';
import { isHealerSpec, specToString } from '../../shared/src/utils/cooldowns';
import { buildMatchPromptNew, fetchStubs, ParsedCombat, parseLogText, MatchStub } from './printMatchPrompts';
import { SYSTEM_PROMPT } from '../../shared/src/prompts/analyzeSystemPrompts';

const OUTPUT_DIR = path.join(__dirname, '../local-batch/compare');
const RAW_LOGS_DIR = path.join(OUTPUT_DIR, 'raw-logs');
const STATE_FILE = path.join(OUTPUT_DIR, 'state.json');

interface State {
  matchIds: string[];
  specDistribution: Record<string, string>;
  createdAt: string;
}

async function findCachedLogs(): Promise<string[]> {
  const dirs = [
    path.join(__dirname, '../local-batch/healer-eval/raw-logs'),
    path.join(__dirname, '../../parser/test/testlogs'),
  ];
  const files: string[] = [];
  for (const dir of dirs) {
    if (await fs.pathExists(dir)) {
      const dirFiles = await fs.readdir(dir);
      for (const file of dirFiles) {
        if (file.endsWith('.log') || file.endsWith('.txt')) {
          files.push(path.join(dir, file));
        }
      }
    }
  }
  return files;
}

function getHealerSpec(combat: ParsedCombat): string | null {
  const friends = (Object.values(combat.units) as ICombatUnit[]).filter(
    (u) => u.type === CombatUnitType.Player && u.reaction === CombatUnitReaction.Friendly,
  );
  const owner = friends.find((p) => p.id === combat.playerId) || friends.find((p) => isHealerSpec(p.spec));
  if (!owner || !isHealerSpec(owner.spec)) return null;
  return specToString(owner.spec);
}

async function callClaudeAPI(
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const client = new Anthropic({ apiKey });
  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    temperature: 0.3,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });
  const textContent = message.content[0].type === 'text' ? message.content[0].text : '';
  return {
    text: textContent,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
  };
}

const REFLECTION_INSTRUCTIONS = `You are evaluating an experimental modification to the coaching instructions.
Please read the combat log prompt below, which is wrapped in a <core_prompt> tag.

When generating your analysis, format your output as follows:
1. Wrap your normal, customer-facing coaching feedback in a <core_response> tag. This must contain the complete coaching feedback formatted according to the instructions in the prompt.
2. After the <core_response> tag, wrap a meta-evaluation of your own response in a <meta_eval_reflection> tag.

Inside the <meta_eval_reflection> tag, answer:
1. **Feature Usefulness**: How directly did the new prompt data help analyze the outcome?
2. **Response Bias**: Did the injection bias your analysis towards certain players or classes?
3. **Noise & Confusion**: Did any of the new information cause distraction, timing contradictions, or logic errors?
4. **Self-Reflection**: How well did you follow the instructions? What elements of the analysis were most and least helpful? Any self-criticism or suggestions for improvement of the prompt structure or system instructions.`;

function wrapPrompt(corePrompt: string): string {
  return `<core_prompt>\n${corePrompt}\n</core_prompt>\n\n<meta_eval_instructions>\n${REFLECTION_INSTRUCTIONS}\n</meta_eval_instructions>`;
}

export function extractCoreResponse(fullResponse: string): string {
  const match = fullResponse.match(/<core_response>([\s\S]*?)<\/core_response>/);
  if (match) {
    return match[1].trim();
  }
  return fullResponse.replace(/<[^>]*>/g, '').trim();
}

export function extractReflection(fullResponse: string): string {
  const match = fullResponse.match(/<meta_eval_reflection>([\s\S]*?)<\/meta_eval_reflection>/);
  return match ? match[1].trim() : '';
}

export function calculateEstimatedCoreTokens(text: string): number {
  return Math.ceil(text.length / 3.8);
}

async function main() {
  const args = process.argv.slice(2);
  const phaseArg = args.find(a => a.startsWith('--phase='));
  const phase = phaseArg ? phaseArg.split('=')[1] : args[args.indexOf('--phase') + 1];

  if (phase !== 'control' && phase !== 'treatment') {
    console.error('Error: Must specify --phase control or --phase treatment');
    process.exit(1);
  }

  await fs.ensureDir(OUTPUT_DIR);
  await fs.ensureDir(RAW_LOGS_DIR);

  if (phase === 'control') {
    console.log('Starting Control Phase...');

    let count = 10;
    const countIndex = args.indexOf('--count');
    if (countIndex !== -1 && args[countIndex + 1]) {
      count = parseInt(args[countIndex + 1], 10);
    } else {
      const countArg = args.find(a => a.startsWith('--count='));
      if (countArg) {
        count = parseInt(countArg.split('=')[1], 10);
      }
    }

    console.log(`Corpus target count: ${count}`);

    const cachedFiles = await findCachedLogs();
    const matchIds: string[] = [];
    const specDistribution: Record<string, string> = {};

    for (const filePath of cachedFiles) {
      if (matchIds.length >= count) break;

      try {
        const text = await fs.readFile(filePath, 'utf8');
        const combats = await parseLogText(text);

        let healerSpec: string | null = null;
        for (const combat of combats) {
          healerSpec = getHealerSpec(combat);
          if (healerSpec) break;
        }

        if (healerSpec) {
          const matchId = path.basename(filePath, path.extname(filePath));
          if (matchIds.includes(matchId)) continue;

          const destPath = path.join(RAW_LOGS_DIR, `${matchId}.log`);
          await fs.copy(filePath, destPath);

          matchIds.push(matchId);
          specDistribution[matchId] = healerSpec;
          console.log(`Reused cached log: ${matchId} (${healerSpec})`);
        }
      } catch (e) {
        console.error(`Error processing cached file ${filePath}:`, e);
      }
    }

    let offset = 0;
    while (matchIds.length < count) {
      console.log(`Fetching stubs for remaining quota (offset=${offset})...`);
      let stubs: MatchStub[] = [];
      try {
        stubs = await fetchStubs('3v3', 50, offset, 1800);
      } catch (e) {
        console.error('Failed to fetch stubs:', e);
        break;
      }

      if (stubs.length === 0) {
        console.log('No more stubs returned from API.');
        break;
      }

      for (const stub of stubs) {
        if (matchIds.length >= count) break;
        if (matchIds.includes(stub.id)) continue;

        try {
          const res = await fetch(stub.logObjectUrl);
          if (!res.ok) {
            console.warn(`Failed to download log for stub ${stub.id}: ${res.statusText}`);
            continue;
          }
          const text = await res.text();
          const combats = await parseLogText(text);

          let healerSpec: string | null = null;
          for (const combat of combats) {
            healerSpec = getHealerSpec(combat);
            if (healerSpec) break;
          }

          if (healerSpec) {
            const destPath = path.join(RAW_LOGS_DIR, `${stub.id}.log`);
            await fs.writeFile(destPath, text, 'utf8');

            matchIds.push(stub.id);
            specDistribution[stub.id] = healerSpec;
            console.log(`Downloaded stub: ${stub.id} (${healerSpec})`);
          }
        } catch (e) {
          console.error(`Error processing stub ${stub.id}:`, e);
        }
      }

      offset += 50;
    }

    const state: State = {
      matchIds,
      specDistribution,
      createdAt: new Date().toISOString(),
    };
    await fs.writeJson(STATE_FILE, state, { spaces: 2 });
    console.log(`Saved state to ${STATE_FILE}`);

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error('ANTHROPIC_API_KEY env variable missing.');
      process.exit(1);
    }

    const controlDir = path.join(OUTPUT_DIR, 'control');
    await fs.ensureDir(path.join(controlDir, 'prompts'));
    await fs.ensureDir(path.join(controlDir, 'responses'));

    const tokenUsage: Record<string, { input: number; output: number }> = {};
    const dryRun = args.includes('--dry-run') || apiKey === 'mock_key';

    for (const matchId of matchIds) {
      const logPath = path.join(RAW_LOGS_DIR, `${matchId}.log`);
      const text = await fs.readFile(logPath, 'utf8');
      const combats = await parseLogText(text);
      const combat = combats.find(c => getHealerSpec(c) !== null) ?? combats[0];

      if (!combat) {
        console.warn(`No valid combat found in log for match ${matchId}`);
        continue;
      }

      const prompt = buildMatchPromptNew(combat, true);
      await fs.writeFile(path.join(controlDir, 'prompts', `${matchId}.txt`), prompt, 'utf8');

      let res: { text: string; inputTokens: number; outputTokens: number };
      if (dryRun) {
        console.log(`[DRY RUN] Skipping Claude API call for ${matchId}`);
        res = {
          text: `Mock response text for ${matchId}`,
          inputTokens: 100,
          outputTokens: 50,
        };
      } else {
        console.log(`Running Claude evaluation on Control for ${matchId}...`);
        res = await callClaudeAPI(apiKey, SYSTEM_PROMPT, prompt);
      }

      await fs.writeFile(path.join(controlDir, 'responses', `${matchId}.txt`), res.text, 'utf8');
      tokenUsage[matchId] = { input: res.inputTokens, output: res.outputTokens };
    }

    await fs.writeJson(path.join(controlDir, 'tokens.json'), tokenUsage, { spaces: 2 });
    console.log('Control phase completed successfully.');
  } else {
    console.log('Starting Treatment Phase...');

    if (!(await fs.pathExists(STATE_FILE))) {
      console.error('No state.json found. Run control phase first.');
      process.exit(1);
    }
    const state = (await fs.readJson(STATE_FILE)) as State;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error('ANTHROPIC_API_KEY env variable missing.');
      process.exit(1);
    }

    const treatmentDir = path.join(OUTPUT_DIR, 'treatment');
    await fs.ensureDir(path.join(treatmentDir, 'prompts'));
    await fs.ensureDir(path.join(treatmentDir, 'responses'));

    const treatmentTokens: Record<string, { input: number; output: number }> = {};
    const dryRun = args.includes('--dry-run') || apiKey === 'mock_key';

    for (const matchId of state.matchIds) {
      const logPath = path.join(RAW_LOGS_DIR, `${matchId}.log`);
      const text = await fs.readFile(logPath, 'utf8');
      const combats = await parseLogText(text);
      const combat = combats.find(c => getHealerSpec(c) !== null) ?? combats[0];

      if (!combat) {
        console.warn(`No valid combat found in log for match ${matchId}`);
        continue;
      }

      const corePrompt = buildMatchPromptNew(combat, true);
      const wrappedPrompt = wrapPrompt(corePrompt);
      await fs.writeFile(path.join(treatmentDir, 'prompts', `${matchId}.txt`), wrappedPrompt, 'utf8');

      let res: { text: string; inputTokens: number; outputTokens: number };
      if (dryRun) {
        console.log(`[DRY RUN] Skipping Claude API call for ${matchId}`);
        res = {
          text: `<core_response>Mock treatment response text for ${matchId}</core_response>\n<meta_eval_reflection>Mock treatment reflection for ${matchId}</meta_eval_reflection>`,
          inputTokens: 120,
          outputTokens: 60,
        };
      } else {
        console.log(`Running Claude evaluation on Treatment for ${matchId}...`);
        res = await callClaudeAPI(apiKey, SYSTEM_PROMPT, wrappedPrompt);
      }

      await fs.writeFile(path.join(treatmentDir, 'responses', `${matchId}.txt`), res.text, 'utf8');
      treatmentTokens[matchId] = { input: res.inputTokens, output: res.outputTokens };
    }

    await fs.writeJson(path.join(treatmentDir, 'tokens.json'), treatmentTokens, { spaces: 2 });
    console.log('Treatment phase completed successfully.');
  }
}

main().catch(console.error);
