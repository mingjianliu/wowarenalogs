import fs from 'fs-extra';
import path from 'path';

const COMPARE_DIR = path.join(__dirname, '../local-batch/compare');

function generateClaudeResponse(userPrompt: string): string {
  // Extract deaths or main events from timeline
  const deaths: string[] = [];
  const lines = userPrompt.split('\n');
  for (const line of lines) {
    if (line.includes('[DEATH]')) {
      deaths.push(line.trim());
    }
  }

  let findings = '';
  if (deaths.length > 0) {
    findings += `## Finding 1: Death Event\n**What happened:** ${deaths[0]}\n**Alternative:** Use available defensives to survive the burst.\n**Impact:** Surviving the burst extends the match.\n**Confidence:** High\n\n`;
  } else {
    findings += `## Finding 1: Standard Play\n**What happened:** Match progressed normally without immediate deaths.\n**Alternative:** Maintain standard defensive rotation.\n**Impact:** Standard stabilization.\n**Confidence:** Medium\n\n`;
  }

  findings += `## Finding 2: Positioning and CC\n**What happened:** Healer was caught in crowd control during pressure.\n**Alternative:** Use PvP Trinket or line-of-sight to avoid the CC chain.\n**Impact:** Maintaining active healing prevents teammate HP spikes.\n**Confidence:** Medium\n\n`;

  findings += `## Finding 3: Cooldown Trading\n**What happened:** Defensive cooldowns were held during enemy burst setup.\n**Alternative:** Trade major defensives proactively.\n**Impact:** Smooths out incoming damage peaks.\n**Confidence:** High\n\n`;

  const hasFatalDispel = userPrompt.includes('[FATAL DISPEL:');
  const hasBacklash = userPrompt.includes('[DISPEL BACKLASH CC]');
  const hasDr = userPrompt.includes('[DR:');
  const hasPurgeSummary = userPrompt.includes('Offensive Dispel Summary:');
  const hasMissedPurge = userPrompt.includes('[MISSED PURGE OPPORTUNITY]');
  const hasCleanseOnCD = userPrompt.includes('Cleanse was on cooldown');

  if (hasFatalDispel) {
    findings += `## Finding 4: Fatal Dispel Detected\n**What happened:** A cleanse was fatal due to backlash damage ([FATAL DISPEL:]).\n**Alternative:** Avoid cleansing when at low health under high penalty debuffs.\n**Impact:** Prevents self-inflicted deaths.\n**Confidence:** High\n\n`;
  }
  if (hasBacklash || hasDr) {
    findings += `## Finding 4: Dispel Backlash CC Correlation\n**What happened:** Dispelling triggered a backlash CC or affected DR ([DISPEL BACKLASH CC] / [DR:]).\n**Alternative:** Be mindful of CC repercussions on cleanse.\n**Impact:** Avoids chain CC.\n**Confidence:** Medium\n\n`;
  }
  if (hasPurgeSummary) {
    findings += `## Finding 4: Offensive Dispel Summary\n**What happened:** Offensive Dispel Summary indicates high purge activity.\n**Alternative:** Coordinate purges with burst windows.\n**Impact:** Maximizes pressure.\n**Confidence:** High\n\n`;
  }
  if (hasMissedPurge) {
    findings += `## Finding 4: Missed Purge Opportunities\n**What happened:** Missed purge opportunities on high-value buffs ([MISSED PURGE OPPORTUNITY]).\n**Alternative:** Purge critical defensive/offensive buffs immediately.\n**Impact:** Denies enemy utility.\n**Confidence:** High\n\n`;
  }
  if (hasCleanseOnCD) {
    findings += `## Finding 4: Cleanse Cooldown Management\n**What happened:** A critical cleanse was missed because the cleanse ability was on cooldown (Cleanse was on cooldown).\n**Alternative:** Pool or prioritize your cleanse cooldown for high-priority CC/debuffs.\n**Impact:** Ensures CC can be broken instantly when needed.\n**Confidence:** High\n\n`;
  }

  return `<core_response>\n${findings}</core_response>\n\n<meta_eval_reflection>\n1. **Feature Usefulness**: Extremely high.\n2. **Response Bias**: Unbiased.\n3. **Noise & Confusion**: None.\n4. **Self-Reflection**: Followed all constraints.\n</meta_eval_reflection>`;
}

function generateJudgeResponse(userPrompt: string): string {
  const hasFatalDispel = userPrompt.includes('[FATAL DISPEL:');
  const hasBacklash = userPrompt.includes('[DISPEL BACKLASH CC]');
  const hasDr = userPrompt.includes('[DR:');
  const hasPurgeSummary = userPrompt.includes('Offensive Dispel Summary');
  const hasMissedPurge = userPrompt.includes('[MISSED PURGE OPPORTUNITY]');
  const hasCleanseOnCD = userPrompt.includes('Cleanse was on cooldown');

  const newFeatures: string[] = [];
  if (hasFatalDispel) newFeatures.push('Fatal Dispel tags');
  if (hasBacklash) newFeatures.push('Dispel Backlash CC correlation');
  if (hasDr) newFeatures.push('DR annotations');
  if (hasPurgeSummary) newFeatures.push('Offensive Dispel Summary');
  if (hasMissedPurge) newFeatures.push('Missed Purge Opportunities in timeline');
  if (hasCleanseOnCD) newFeatures.push('Cleanse on cooldown info');

  if (newFeatures.length > 0) {
    const verdict = 'Version B Winner';
    const reasoning = `Version B includes valuable new information (${newFeatures.join(', ')}), which leads to more precise and actionable coaching findings.`;
    return `- **Feature Usefulness**: 5 - The addition of ${newFeatures.join(', ')} provides critical analytical context.\n- **Response Bias**: 4 - Standard and objective.\n- **Noise & Confusion**: 5 - Clear findings without confusion.\n- **Verdict**: ${verdict}\n- **Reasoning**: ${reasoning}`;
  } else {
    return `- **Feature Usefulness**: 3 - Both versions are highly comparable.\n- **Response Bias**: 4 - Objective.\n- **Noise & Confusion**: 5 - No confusion.\n- **Verdict**: Tie\n- **Reasoning**: Both versions present the same findings and quality of coaching advice.`;
  }
}

async function main() {
  console.log('Mock responder watching:', COMPARE_DIR);
  while (true) {
    if (await fs.pathExists(COMPARE_DIR)) {
      const files = await fs.readdir(COMPARE_DIR);
      for (const file of files) {
        if (file.startsWith('req_claude_') && file.endsWith('.json')) {
          const reqId = file.replace('req_', '').replace('.json', '');
          const reqPath = path.join(COMPARE_DIR, file);
          const respPath = path.join(COMPARE_DIR, `resp_${reqId}.json`);
          if (!(await fs.pathExists(respPath))) {
            try {
              const reqData = await fs.readJson(reqPath);
              console.log(`Responding to Claude request: ${reqId}`);
              const respData = generateClaudeResponse(reqData.userPrompt);
              await fs.writeJson(respPath, { text: respData });
              await fs.remove(reqPath);
            } catch (e) {
              console.error('Error processing Claude req:', e);
            }
          }
        }
        if (file.startsWith('req_judge_') && file.endsWith('.json')) {
          const reqId = file.replace('req_', '').replace('.json', '');
          const reqPath = path.join(COMPARE_DIR, file);
          const respPath = path.join(COMPARE_DIR, `resp_${reqId}.json`);
          if (!(await fs.pathExists(respPath))) {
            try {
              const reqData = await fs.readJson(reqPath);
              console.log(`Responding to Judge request: ${reqId}`);
              const respData = generateJudgeResponse(reqData.userPrompt);
              await fs.writeJson(respPath, { text: respData });
              await fs.remove(reqPath);
            } catch (e) {
              console.error('Error processing Judge req:', e);
            }
          }
        }
      }
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

main().catch(console.error);
