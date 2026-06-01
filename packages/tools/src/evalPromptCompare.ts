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
  const reqId = 'claude_' + Math.random().toString(36).substring(7);
  const reqFile = path.join(OUTPUT_DIR, `req_${reqId}.json`);
  const respFile = path.join(OUTPUT_DIR, `resp_${reqId}.json`);

  await fs.writeJson(reqFile, { systemPrompt, userPrompt });
  console.log(`[IPC_REQUEST] ${reqId}`);

  while (!(await fs.pathExists(respFile))) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  const resp = await fs.readJson(respFile);
  await fs.remove(reqFile);
  await fs.remove(respFile);

  return {
    text: resp.text,
    inputTokens: calculateEstimatedCoreTokens(systemPrompt + userPrompt),
    outputTokens: calculateEstimatedCoreTokens(resp.text),
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
  let clean = fullResponse;
  const reflectionMatch = clean.match(/<meta_eval_reflection>[\s\S]*?<\/meta_eval_reflection>/);
  if (reflectionMatch) {
    clean = clean.replace(reflectionMatch[0], '');
  }
  return clean.replace(/<[^>]*>/g, '').trim();
}


export function extractReflection(fullResponse: string): string {
  const match = fullResponse.match(/<meta_eval_reflection>([\s\S]*?)<\/meta_eval_reflection>/);
  return match ? match[1].trim() : '';
}

export function calculateEstimatedCoreTokens(text: string): number {
  return Math.ceil(text.length / 3.8);
}

export function extractVerdict(judgment: string): string {
  const match = judgment.match(/(?:[*-]?\s*(?:\*\*)?Verdict(?:\*\*)?:\s*|Verdict:\s*)([^\r\n]+)/i);
  if (match) {
    let verdict = match[1].trim();
    if (verdict.startsWith('[') && verdict.endsWith(']')) {
      verdict = verdict.slice(1, -1).trim();
    }
    // Remove trailing period or asterisks
    verdict = verdict.replace(/[.*]+$/, '').trim();
    
    // Normalize to standard options if they are contained in the text
    const lower = verdict.toLowerCase();
    if (lower.includes('version a winner') || lower.includes('winner: version a') || lower.includes('winner: a')) {
      return 'Version A Winner';
    }
    if (lower.includes('version b winner') || lower.includes('winner: version b') || lower.includes('winner: b')) {
      return 'Version B Winner';
    }
    if (lower.includes('tie') || lower.includes('equal')) {
      return 'Tie';
    }
    return verdict;
  }
  return 'Unknown';
}

async function callMetaEvalJudge(
  apiKey: string,
  controlResponse: string,
  treatmentResponse: string,
): Promise<string> {
  const judgeSystem = `You are a prompt engineer evaluating two AI-generated WoW arena match analyses. Your job is to give a blunt, objective verdict on which prompt design produced better coaching feedback.`;

  const userMessage = `Evaluate the following two coaching analyses for the same WoW arena match:

CONTROL RESPONSE (Version A):
---
${controlResponse}
---

TREATMENT RESPONSE (Version B):
---
${treatmentResponse}
---

Rate Version B compared to Version A on:
1. **Feature Usefulness** (Scale 1-5): Did the new/modified prompt information in Version B lead to more concrete, actionable, and correct coaching advice?
2. **Response Bias** (Scale 1-5): Did the new information steer the AI into introducing incorrect assumptions, unearned praise, or unfair blame for mistakes?
3. **Noise & Confusion** (Scale 1-5): Did the new data cause the model to write redundant comments or contradict itself?

Finally, state:
- **Verdict**: [Version A Winner / Version B Winner / Tie]
- **Reasoning**: One sentence explanation.`;

  const reqId = 'judge_' + Math.random().toString(36).substring(7);
  const reqFile = path.join(OUTPUT_DIR, `req_${reqId}.json`);
  const respFile = path.join(OUTPUT_DIR, `resp_${reqId}.json`);

  await fs.writeJson(reqFile, { systemPrompt: judgeSystem, userPrompt: userMessage });
  console.log(`[IPC_REQUEST] ${reqId}`);

  while (!(await fs.pathExists(respFile))) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  const resp = await fs.readJson(respFile);
  await fs.remove(reqFile);
  await fs.remove(respFile);

  return resp.text;
}

async function main() {
  const args = process.argv.slice(2);
  let phase: string | undefined;
  const phaseIndex = args.indexOf('--phase');
  if (phaseIndex !== -1 && args[phaseIndex + 1]) {
    phase = args[phaseIndex + 1];
  } else {
    const phaseArg = args.find(a => a.startsWith('--phase='));
    if (phaseArg) {
      phase = phaseArg.split('=')[1];
    }
  }

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

    const dryRun = args.includes('--dry-run');
    const apiKey = 'roleplayer';

    const controlDir = path.join(OUTPUT_DIR, 'control');
    await fs.ensureDir(path.join(controlDir, 'prompts'));
    await fs.ensureDir(path.join(controlDir, 'responses'));

    const tokenUsage: Record<string, { input: number; output: number }> = {};

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

      const responsePath = path.join(controlDir, 'responses', `${matchId}.txt`);
      let res: { text: string; inputTokens: number; outputTokens: number };
      if (await fs.pathExists(responsePath)) {
        console.log(`Reusing existing Control response for ${matchId}...`);
        const text = await fs.readFile(responsePath, 'utf8');
        res = {
          text,
          inputTokens: calculateEstimatedCoreTokens(SYSTEM_PROMPT + prompt),
          outputTokens: calculateEstimatedCoreTokens(text),
        };
      } else if (dryRun) {
        console.log(`[DRY RUN] Skipping Claude API call for ${matchId}`);
        res = {
          text: `Mock response text for ${matchId}`,
          inputTokens: 100,
          outputTokens: 50,
        };
      } else {
        try {
          console.log(`Running Claude evaluation on Control for ${matchId}...`);
          res = await callClaudeAPI(apiKey, SYSTEM_PROMPT, prompt);
        } catch (e) {
          console.error(`Error calling Claude API for match ${matchId} in Control:`, e);
          continue;
        }
      }

      await fs.writeFile(responsePath, res.text, 'utf8');
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
    const dryRun = args.includes('--dry-run');
    const apiKey = 'roleplayer';

    const treatmentDir = path.join(OUTPUT_DIR, 'treatment');
    await fs.ensureDir(path.join(treatmentDir, 'prompts'));
    await fs.ensureDir(path.join(treatmentDir, 'responses'));

    const treatmentTokens: Record<string, { input: number; output: number }> = {};
    const finalJudgments: Record<string, string> = {};

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

      const treatmentRespPath = path.join(treatmentDir, 'responses', `${matchId}.txt`);
      let res: { text: string; inputTokens: number; outputTokens: number };
      if (await fs.pathExists(treatmentRespPath)) {
        console.log(`Reusing existing Treatment response for ${matchId}...`);
        const text = await fs.readFile(treatmentRespPath, 'utf8');
        res = {
          text,
          inputTokens: calculateEstimatedCoreTokens(SYSTEM_PROMPT + wrappedPrompt),
          outputTokens: calculateEstimatedCoreTokens(text),
        };
      } else if (dryRun) {
        console.log(`[DRY RUN] Skipping Claude API call for ${matchId}`);
        res = {
          text: `<core_response>Mock treatment response text for ${matchId}</core_response>\n<meta_eval_reflection>Mock treatment reflection for ${matchId}</meta_eval_reflection>`,
          inputTokens: 120,
          outputTokens: 60,
        };
      } else {
        try {
          console.log(`Running Claude evaluation on Treatment for ${matchId}...`);
          res = await callClaudeAPI(apiKey, SYSTEM_PROMPT, wrappedPrompt);
        } catch (e) {
          console.error(`Error calling Claude API for match ${matchId} in Treatment:`, e);
          continue;
        }
      }

      await fs.writeFile(treatmentRespPath, res.text, 'utf8');
      treatmentTokens[matchId] = { input: res.inputTokens, output: res.outputTokens };

      const controlDir = path.join(OUTPUT_DIR, 'control');
      const controlRespPath = path.join(controlDir, 'responses', `${matchId}.txt`);
      if (!(await fs.pathExists(controlRespPath))) {
        console.warn(`Control response for match ${matchId} does not exist, skipping.`);
        continue;
      }
      const controlResp = await fs.readFile(controlRespPath, 'utf8');
      const treatmentCore = extractCoreResponse(res.text);

      const judgmentsDir = path.join(treatmentDir, 'judgments');
      await fs.ensureDir(judgmentsDir);

      const judgmentPath = path.join(judgmentsDir, `${matchId}.txt`);
      let judgment: string;
      if (await fs.pathExists(judgmentPath)) {
        console.log(`Reusing existing judgment for ${matchId}...`);
        judgment = await fs.readFile(judgmentPath, 'utf8');
      } else if (dryRun) {
        console.log(`[DRY RUN] Skipping Judge API call for ${matchId}`);
        judgment = `Mock judgment for ${matchId}\n- Verdict: Version B Winner\n- Reasoning: Mock judgment reasoning.`;
      } else {
        try {
          console.log(`Running Judge evaluation for ${matchId}...`);
          judgment = await callMetaEvalJudge(apiKey, controlResp, treatmentCore);
        } catch (e) {
          console.error(`Error calling Judge API for match ${matchId}:`, e);
          judgment = `Error running Judge evaluation for ${matchId}.\n- Verdict: Unknown\n- Reasoning: API call failed.`;
        }
      }

      await fs.writeFile(judgmentPath, judgment, 'utf8');
      finalJudgments[matchId] = judgment;
    }

    await fs.writeJson(path.join(treatmentDir, 'tokens.json'), treatmentTokens, { spaces: 2 });

    // Generate comparison report
    console.log('Synthesizing comparison report...');
    const controlDir = path.join(OUTPUT_DIR, 'control');
    const controlTokensPath = path.join(controlDir, 'tokens.json');
    const treatmentTokensPath = path.join(treatmentDir, 'tokens.json');

    if (!(await fs.pathExists(controlTokensPath))) {
      console.error('Error: control/tokens.json not found. Make sure control phase ran successfully.');
      process.exit(1);
    }

    const controlTokens = await fs.readJson(controlTokensPath);
    const treatmentTokensObj = await fs.readJson(treatmentTokensPath);

    let totalControlInput = 0;
    let totalTreatmentInput = 0;
    let totalControlOutput = 0;
    let totalTreatmentOutput = 0;
    const tableRows: string[] = [];
    const verdictCounts: Record<string, number> = {};

    for (const matchId of state.matchIds) {
      const cTokens = controlTokens[matchId] || { input: 0, output: 0 };
      const tTokens = treatmentTokensObj[matchId] || { input: 0, output: 0 };

      // Subtract REFLECTION_INSTRUCTIONS token overhead from treatment input
      const reflectionInstructionsTokens = calculateEstimatedCoreTokens(REFLECTION_INSTRUCTIONS);
      const treatmentInputAdjusted = Math.max(0, tTokens.input - reflectionInstructionsTokens);

      // Load raw treatment response to extract reflection output overhead
      const treatmentRespPath = path.join(treatmentDir, 'responses', `${matchId}.txt`);
      let rawTreatmentResponse = '';
      if (await fs.pathExists(treatmentRespPath)) {
        rawTreatmentResponse = await fs.readFile(treatmentRespPath, 'utf8');
      }

      const reflectionText = extractReflection(rawTreatmentResponse);
      const reflectionTokens = calculateEstimatedCoreTokens(reflectionText);
      const treatmentOutputAdjusted = Math.max(0, tTokens.output - reflectionTokens);

      totalControlInput += cTokens.input;
      totalTreatmentInput += treatmentInputAdjusted;
      totalControlOutput += cTokens.output;
      totalTreatmentOutput += treatmentOutputAdjusted;

      const judgment = finalJudgments[matchId] || '';
      const verdict = extractVerdict(judgment);
      const spec = state.specDistribution[matchId] || 'Unknown';

      verdictCounts[verdict] = (verdictCounts[verdict] || 0) + 1;

      tableRows.push(`| ${matchId} | ${spec} | ${cTokens.input} | ${treatmentInputAdjusted} | ${verdict} |`);
    }

    const numMatches = state.matchIds.length;
    const avgControlInput = numMatches > 0 ? Math.round(totalControlInput / numMatches) : 0;
    const avgTreatmentInput = numMatches > 0 ? Math.round(totalTreatmentInput / numMatches) : 0;
    const avgControlOutput = numMatches > 0 ? Math.round(totalControlOutput / numMatches) : 0;
    const avgTreatmentOutput = numMatches > 0 ? Math.round(totalTreatmentOutput / numMatches) : 0;

    const report = `# A/B Prompt Comparison Report

## 1. Executive Summary
- **Matches Evaluated**: ${numMatches}
- **Avg Input Token Delta (excl. overhead)**: ${avgTreatmentInput - avgControlInput} (${avgControlInput} -> ${avgTreatmentInput})
- **Avg Output Token Delta (excl. overhead)**: ${avgTreatmentOutput - avgControlOutput} (${avgControlOutput} -> ${avgTreatmentOutput})

## 2. Match Details
| Match ID | Spec | Control Input | Treatment Input | Verdict |
| :--- | :--- | :--- | :--- | :--- |
${tableRows.join('\n')}

## 3. Judge Verdicts
${Object.entries(verdictCounts)
  .map(([v, count]) => `- **${v}**: ${count}`)
  .join('\n')}

See full details in \`packages/tools/local-batch/compare/treatment/judgments/\`.
`;

    await fs.writeFile(path.join(OUTPUT_DIR, 'comparison-report.md'), report, 'utf8');
    console.log(`Comparison report synthesized at: ${path.join(OUTPUT_DIR, 'comparison-report.md')}`);
    console.log('Treatment phase completed successfully.');
  }
}

main().catch(console.error);
