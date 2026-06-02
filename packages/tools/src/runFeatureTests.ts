import fs from 'fs-extra';
import path from 'path';
import { execSync } from 'child_process';
import { CombatUnitType, CombatUnitReaction, ICombatUnit } from '@wowarenalogs/parser';
import { parseLogText, ParsedCombat } from './printMatchPrompts';
import { isHealerSpec, specToString } from '../../shared/src/utils/cooldowns';

const COMPARE_DIR = path.join(__dirname, '../local-batch/compare');
const RAW_LOGS_DIR = path.join(COMPARE_DIR, 'raw-logs');
const TESTLOGS_DIR = path.join(__dirname, '../../parser/test/testlogs');
const FEATURES_MAP_FILE = path.join(COMPARE_DIR, 'features_map.json');
const STATE_FILE = path.join(COMPARE_DIR, 'state.json');
const FEATURE_FLAGS_FILE = path.join(__dirname, '../../shared/src/utils/dispelFeatureFlags.ts');

function getHealerSpec(combat: ParsedCombat): string | null {
  const friends = (Object.values(combat.units) as ICombatUnit[]).filter(
    (u) => u.type === CombatUnitType.Player && u.reaction === CombatUnitReaction.Friendly,
  );
  const owner = friends.find((p) => p.id === combat.playerId) || friends.find((p) => isHealerSpec(p.spec));
  if (!owner || !isHealerSpec(owner.spec)) return null;
  return specToString(owner.spec);
}

async function findLogPath(matchId: string): Promise<string> {
  const checkPaths = [
    path.join(RAW_LOGS_DIR, `${matchId}.log`),
    path.join(RAW_LOGS_DIR, `${matchId}.txt`),
    path.join(TESTLOGS_DIR, `${matchId}.log`),
    path.join(TESTLOGS_DIR, `${matchId}.txt`),
  ];
  for (const p of checkPaths) {
    if (await fs.pathExists(p)) {
      return p;
    }
  }
  throw new Error(`Log not found for matchId: ${matchId}`);
}

async function writeStateFile(matchIds: string[]) {
  const specDistribution: Record<string, string> = {};
  for (const matchId of matchIds) {
    const logPath = await findLogPath(matchId);
    const destPath = path.join(RAW_LOGS_DIR, `${matchId}.log`);
    if (!(await fs.pathExists(destPath))) {
      await fs.copy(logPath, destPath);
      console.log(`Copied ${matchId} log to ${destPath}`);
    }
    const text = await fs.readFile(destPath, 'utf8');
    const combats = await parseLogText(text);
    const combat = combats.find(c => getHealerSpec(c) !== null) ?? combats[0];
    if (combat) {
      specDistribution[matchId] = getHealerSpec(combat) ?? 'Holy Priest';
    } else {
      specDistribution[matchId] = 'Holy Priest';
    }
  }
  const state = {
    matchIds,
    specDistribution,
    createdAt: new Date().toISOString(),
  };
  await fs.writeJson(STATE_FILE, state, { spaces: 2 });
  console.log(`Wrote state.json for ${matchIds.length} matches.`);
}

async function setFeatureFlags(flags: Record<string, boolean>) {
  const content = `export const DISPEL_FEATURE_FLAGS = {
  F18_FATAL_DISPEL: ${flags.F18_FATAL_DISPEL ?? false},
  F124_ENHANCED_CC_ANNOTATIONS: ${flags.F124_ENHANCED_CC_ANNOTATIONS ?? false},
  F131_F132_CLEANSE_COOLDOWNS: ${flags.F131_F132_CLEANSE_COOLDOWNS ?? false},
  F142_OFFENSIVE_DISPEL_SUMMARY: ${flags.F142_OFFENSIVE_DISPEL_SUMMARY ?? false},
  F152_MISSED_PURGES_TIMELINE: ${flags.F152_MISSED_PURGES_TIMELINE ?? false},
};
`;
  await fs.writeFile(FEATURE_FLAGS_FILE, content, 'utf8');
}

async function clearCache(phase: 'control' | 'treatment') {
  const dir = path.join(COMPARE_DIR, phase);
  if (await fs.pathExists(dir)) {
    await fs.remove(path.join(dir, 'responses'));
    await fs.remove(path.join(dir, 'judgments'));
    console.log(`Cleared cached ${phase} responses and judgments.`);
  }
}

async function runFeatureTest(featureName: string, flagKey: string, matchIds: string[]) {
  console.log(`\n======================================================================`);
  console.log(`STARTING A/B TEST FOR: ${featureName}`);
  console.log(`======================================================================`);

  // 1. Write state.json for this feature's games
  await writeStateFile(matchIds);

  // 2. Control Phase: all flags false (nothing new)
  console.log('\n--- 2.1 Running Control Phase (all flags = false) ---');
  await setFeatureFlags({
    F18_FATAL_DISPEL: false,
    F124_ENHANCED_CC_ANNOTATIONS: false,
    F131_F132_CLEANSE_COOLDOWNS: false,
    F142_OFFENSIVE_DISPEL_SUMMARY: false,
    F152_MISSED_PURGES_TIMELINE: false,
  });
  await clearCache('control');
  execSync('npx ts-node packages/tools/src/evalPromptCompare.ts --phase control --reuse-state', {
    cwd: path.join(__dirname, '../../..'),
    stdio: 'inherit',
  });

  // 3. Treatment Phase: only this flag true
  console.log(`\n--- 2.2 Running Treatment Phase (only ${flagKey} = true) ---`);
  const treatmentFlags: Record<string, boolean> = {
    F18_FATAL_DISPEL: false,
    F124_ENHANCED_CC_ANNOTATIONS: false,
    F131_F132_CLEANSE_COOLDOWNS: false,
    F142_OFFENSIVE_DISPEL_SUMMARY: false,
    F152_MISSED_PURGES_TIMELINE: false,
  };
  treatmentFlags[flagKey] = true;
  await setFeatureFlags(treatmentFlags);
  await clearCache('treatment');
  execSync('npx ts-node packages/tools/src/evalPromptCompare.ts --phase treatment', {
    cwd: path.join(__dirname, '../../..'),
    stdio: 'inherit',
  });

  // 4. Save comparison report
  const reportPath = path.join(COMPARE_DIR, 'comparison-report.md');
  const savedReportPath = path.join(COMPARE_DIR, `report_${featureName}.md`);
  if (await fs.pathExists(reportPath)) {
    await fs.copy(reportPath, savedReportPath);
    console.log(`Saved comparison report for ${featureName} to ${savedReportPath}`);
  }
}

async function main() {
  if (!(await fs.pathExists(FEATURES_MAP_FILE))) {
    console.error('features_map.json not found! Run checkFeatures.ts first.');
    process.exit(1);
  }

  const featuresMap = await fs.readJson(FEATURES_MAP_FILE);

  // Run each test sequentially
  await runFeatureTest('F18', 'F18_FATAL_DISPEL', featuresMap.F18);
  await runFeatureTest('F124', 'F124_ENHANCED_CC_ANNOTATIONS', featuresMap.F124);
  await runFeatureTest('F131_F132', 'F131_F132_CLEANSE_COOLDOWNS', featuresMap.F131_F132);
  await runFeatureTest('F142', 'F142_OFFENSIVE_DISPEL_SUMMARY', featuresMap.F142);
  await runFeatureTest('F152', 'F152_MISSED_PURGES_TIMELINE', featuresMap.F152);

  // Reset flags to all true at the end
  await setFeatureFlags({
    F18_FATAL_DISPEL: true,
    F124_ENHANCED_CC_ANNOTATIONS: true,
    F131_F132_CLEANSE_COOLDOWNS: true,
    F142_OFFENSIVE_DISPEL_SUMMARY: true,
    F152_MISSED_PURGES_TIMELINE: true,
  });
  console.log('\nFeature flags reset to true.');

  // Print final summary table
  console.log(`\n======================================================================`);
  console.log(`FINAL VERDICTS SUMMARY`);
  console.log(`======================================================================`);
  
  const reportFiles = ['F18', 'F124', 'F131_F132', 'F142', 'F152'];
  for (const feat of reportFiles) {
    const reportPath = path.join(COMPARE_DIR, `report_${feat}.md`);
    if (await fs.pathExists(reportPath)) {
      const content = await fs.readFile(reportPath, 'utf8');
      const lines = content.split('\n');
      const verdictHeaderIndex = lines.findIndex(l => l.includes('## 3. Judge Verdicts'));
      if (verdictHeaderIndex !== -1) {
        console.log(`\nFeature ${feat}:`);
        for (let i = verdictHeaderIndex + 1; i < lines.length && lines[i].trim().startsWith('-'); i++) {
          console.log(lines[i]);
        }
      }
    }
  }
}

main().catch(console.error);
