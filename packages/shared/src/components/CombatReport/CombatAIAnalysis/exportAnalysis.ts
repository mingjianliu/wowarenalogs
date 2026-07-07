import { AtomicArenaCombat, CombatResult } from '@wowarenalogs/parser';

import { zoneMetadata } from '../../../data/zoneMetadata';
import { fmtTime } from '../../../utils/cooldowns';
import { AIFinding } from './aiFindings';
import { VerifiedComparison } from './verifiedComparison';

export interface IAnalysisExportInput {
  combat: AtomicArenaCombat;
  findings: AIFinding[];
  /** Raw prose fallback (server returned unparseable JSON) — exported verbatim when findings is empty. */
  raw: string;
  verified?: { vc: VerifiedComparison; userCrises: string[]; proCrises: string[]; report?: string };
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function buildExportFilename(combat: AtomicArenaCombat): string {
  return `wal-analysis-${isoDate(combat.startTime)}-${combat.startInfo.bracket}.md`;
}

/**
 * Serializes one match's AI findings + verified comparison to Markdown. The cohort label
 * is passed through verbatim — this function must never restate or embellish cohort claims.
 */
export function buildAnalysisMarkdown(input: IAnalysisExportInput): string {
  const { combat, findings, raw, verified } = input;
  const lines: string[] = [];

  const zone = zoneMetadata[combat.startInfo.zoneId ?? '0']?.name ?? 'Unknown arena';
  const result =
    combat.result === CombatResult.Win ? 'Win' : combat.result === CombatResult.Lose ? 'Loss' : 'Unknown result';
  const durationSeconds = (combat.endTime - combat.startTime) / 1000;

  lines.push(`# WoW Arena Logs — AI Analysis`);
  lines.push('');
  lines.push(
    `**${combat.startInfo.bracket}** at ${zone} — ${result}, ${fmtTime(durationSeconds)} (${isoDate(
      combat.startTime,
    )})`,
  );
  lines.push('');

  if (findings.length > 0) {
    for (const f of findings) {
      lines.push(`## ${f.rank}. [${f.severity}] ${f.title} (at ${fmtTime(f.atSeconds)})`);
      lines.push('');
      lines.push(f.summary);
      lines.push('');
      if (f.whatHappened) lines.push(`- **What happened:** ${f.whatHappened}`);
      if (f.alternative) lines.push(`- **Better line:** ${f.alternative}`);
      if (f.impact) lines.push(`- **Impact:** ${f.impact}${f.impactDelta ? ` (${f.impactDelta})` : ''}`);
      lines.push(`- **Confidence:** ${f.confidence}${f.confidenceNote ? ` — ${f.confidenceNote}` : ''}`);
      lines.push('');
    }
  } else if (raw.trim().length > 0) {
    lines.push(raw.trim());
    lines.push('');
  }

  if (verified) {
    const { vc, userCrises, proCrises, report } = verified;
    lines.push(
      `## Comparison — ${vc.spec} vs cohort: ${vc.cohort.leaderboardSelection} (n=${vc.cohort.n}, ${vc.cohort.uniquePlayers} players)`,
    );
    lines.push('');
    if (report && report.trim().length > 0) {
      lines.push(report.trim());
      lines.push('');
    }
    if (userCrises.length > 0) {
      lines.push('**Your crises:**');
      for (const c of userCrises) lines.push(`- ${c}`);
      lines.push('');
    }
    if (proCrises.length > 0) {
      lines.push('**Cohort reference crises:**');
      for (const c of proCrises) lines.push(`- ${c}`);
      lines.push('');
    }
    for (const note of vc.notes) lines.push(`> ${note}`);
    if (vc.notes.length > 0) lines.push('');
  }

  lines.push('---');
  lines.push('_Exported from WoW Arena Logs (local analysis — not published anywhere)._');
  return lines.join('\n');
}
