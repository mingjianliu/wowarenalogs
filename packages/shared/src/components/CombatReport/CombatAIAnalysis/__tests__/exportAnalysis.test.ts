import { AtomicArenaCombat, CombatResult } from '@wowarenalogs/parser';

import { AIFinding } from '../aiFindings';
import { buildAnalysisMarkdown, buildExportFilename } from '../exportAnalysis';
import { VerifiedComparison } from '../verifiedComparison';

const combat = {
  id: 'm1',
  startTime: Date.UTC(2026, 6, 7, 12, 0, 0),
  endTime: Date.UTC(2026, 6, 7, 12, 3, 20),
  result: CombatResult.Win,
  startInfo: { bracket: '3v3', zoneId: '0' },
  units: {},
} as unknown as AtomicArenaCombat;

const finding: AIFinding = {
  rank: 1,
  title: 'Late trinket on the opener',
  severity: 'High',
  confidence: 'High',
  confidenceNote: 'direct log evidence',
  atSeconds: 42,
  impactDelta: '+140k effective HP',
  summary: 'Trinket came 4s after the stun landed.',
  whatHappened: 'Stun at 0:38, trinket at 0:42.',
  alternative: 'Trinket the opener stun immediately.',
  impact: 'Healer free 4s earlier.',
  counterfactual: 'Kill window likely survived at full HP.',
};

const vc = {
  player: 'Me',
  spec: 'Holy Paladin',
  bracket: '3v3',
  cohort: { n: 42, uniquePlayers: 17, leaderboardSelection: '2700+ backfill', perMetric: {} },
  notes: [],
} as unknown as VerifiedComparison;

describe('buildAnalysisMarkdown', () => {
  it('renders findings with timestamps and passes the cohort label through verbatim', () => {
    const md = buildAnalysisMarkdown({
      combat,
      findings: [finding],
      raw: '',
      verified: { vc, userCrises: ['0:40 you dropped to 18%'], proCrises: ['0:35 pro trinketed instantly'] },
    });

    expect(md).toContain('## 1. [High] Late trinket on the opener (at 0:42)');
    expect(md).toContain('Trinket came 4s after the stun landed.');
    // cohort label verbatim — never re-summarized (B156/9188eee2 honesty rule)
    expect(md).toContain('2700+ backfill');
    expect(md).toContain('n=42');
    expect(md).not.toContain('2300+'); // must not invent the old hardcoded label
  });

  it('falls back to raw prose when there are no structured findings', () => {
    const md = buildAnalysisMarkdown({ combat, findings: [], raw: 'freeform analysis text' });
    expect(md).toContain('freeform analysis text');
  });

  it('omits the comparison section when verified is absent', () => {
    const md = buildAnalysisMarkdown({ combat, findings: [finding], raw: '' });
    expect(md).not.toContain('## Comparison');
  });
});

describe('buildExportFilename', () => {
  it('builds a date+bracket name', () => {
    expect(buildExportFilename(combat)).toBe('wal-analysis-2026-07-07-3v3.md');
  });
});
