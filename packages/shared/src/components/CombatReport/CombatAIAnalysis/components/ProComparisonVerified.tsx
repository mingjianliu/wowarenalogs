// ProComparisonVerified.tsx
//
// Rebuilt "Pro comparison" view — renders the honest, server-computed VerifiedComparison
// (full-cohort percentile *standing* + disclosed nReal + notes) and the winning exemplar-led
// crisis view (your responses vs real diversified pro sequences). Replaces the nearest-neighbour
// "pro average" model in ProComparison.tsx. Pure presentation — transforms live in
// ../verifiedComparisonView. Visual language matches the existing Decision-review UI.

import { ReactNode } from 'react';

import { CoachingReport, parseCoachingReport, ParsedCrisis } from '../proComparisonData';
import { VerifiedComparison } from '../verifiedComparison';
import {
  buildCrisisView,
  buildVerifiedMetricRows,
  deriveHeadline,
  sampleDisclosure,
  Standing,
  VerifiedMetricRow,
} from '../verifiedComparisonView';
import { SparkleIcon } from './icons';

const AMBER = '#f9b13a';
const GREEN = '#7ee0a0';
const RED = '#ff5a4a';

const STANDING_COLOR: Record<Standing, string> = { ahead: GREEN, behind: RED, even: '#a1a1aa', na: '#52525b' };
const STANDING_LABEL: Record<Standing, string> = { ahead: 'ahead', behind: 'behind', even: 'on-cohort', na: 'n/a' };

function SectionLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <h3 className="text-[12px] uppercase tracking-[0.14em] text-zinc-500 font-semibold">{children}</h3>
      {right}
    </div>
  );
}

// ── Percentile standing bar — user's position in the cohort (not a fabricated average) ──────────
function PercentileBar({ row }: { row: VerifiedMetricRow }) {
  const color = STANDING_COLOR[row.standing];
  const pct = row.userPercentile;
  // For a lower=better metric, invert the fill so "further right" always reads as "better".
  const goodFill = pct === null ? null : row.valence === 'lower' ? 1 - pct : pct;
  return (
    <div className="py-[11px]">
      <div className="flex items-baseline justify-between mb-[7px]">
        <div className="flex items-baseline gap-2 min-w-0 flex-1 mr-3">
          <span className="text-[13px] font-semibold text-zinc-200 whitespace-nowrap">{row.label}</span>
          <span className="text-[10.5px] text-zinc-600 truncate">{row.definition}</span>
        </div>
        <div className="flex items-center gap-2.5 font-mono tabular-nums shrink-0">
          <span className="text-[11px] text-zinc-500">
            cohort med {row.cohortMedian.toFixed(2)}
            {row.unit} · n={row.nReal}
          </span>
          <span
            className="text-[10.5px] px-1.5 py-px rounded text-center"
            style={{ color, minWidth: 62, background: `${color}1a`, border: `1px solid ${color}44` }}
          >
            {pct === null ? 'n/a' : `${Math.round(pct * 100)}th · ${STANDING_LABEL[row.standing]}`}
          </span>
        </div>
      </div>
      <div
        className="relative h-3 rounded-[3px]"
        style={{ background: 'rgba(255,255,255,0.05)', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.04)' }}
      >
        {goodFill !== null && (
          <>
            <div
              className="absolute left-0 top-0 bottom-0 rounded-[3px]"
              style={{
                width: `${Math.max(3, goodFill * 100)}%`,
                background: `linear-gradient(90deg, ${color}aa, ${color})`,
              }}
            />
            {/* cohort-median reference at the 50th percentile */}
            <div className="absolute -top-[3px] -bottom-[3px] w-px" style={{ left: '50%', background: '#71717a' }} />
          </>
        )}
      </div>
    </div>
  );
}

// ── Crisis sequence chips ─────────────────────────────────────────────────────
function SeqChips({ sequence, tone }: { sequence: string[]; tone?: 'pro' }) {
  const c =
    tone === 'pro'
      ? { bg: 'rgba(126,224,160,0.06)', bd: 'rgba(126,224,160,0.25)', fg: '#dfe7e2' }
      : { bg: '#0e0e10', bd: '#27272a', fg: '#d4d4d8' };
  if (sequence.length === 0) return <span className="text-[11.5px] text-zinc-600">No response recorded.</span>;
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {sequence.map((s, j) => (
        <span key={j} className="flex items-center gap-1">
          {j > 0 && <span className="text-zinc-700 text-[10px]">›</span>}
          <span
            className="text-[11px] px-1.5 py-0.5 rounded"
            style={{ color: c.fg, background: c.bg, border: `1px solid ${c.bd}` }}
          >
            {s}
          </span>
        </span>
      ))}
    </div>
  );
}

function fmtTimeShort(secs: number | null): string {
  if (secs == null) return '—';
  return `${Math.floor(secs / 60)}:${String(Math.round(secs % 60)).padStart(2, '0')}`;
}

function CrisisRow({ c, tone }: { c: ParsedCrisis; tone?: 'pro' }) {
  return (
    <div className="px-3.5 py-2.5" style={{ borderTop: '1px solid #18181b' }}>
      <div className="flex items-center gap-2 mb-1.5">
        <span className="font-mono tabular-nums text-[10.5px] text-zinc-300">{fmtTimeShort(c.atSeconds)}</span>
        {c.who && tone !== 'pro' && <span className="text-[11.5px] text-zinc-300">{c.who}</span>}
        {c.hpPct != null && (
          <span className="font-mono text-[11px] font-bold" style={{ color: c.hpPct <= 33 ? RED : '#fbbf6b' }}>
            {c.hpPct}%
          </span>
        )}
      </div>
      <SeqChips sequence={c.sequence} tone={tone} />
    </div>
  );
}

function Summary({ report, headlineGist }: { report: CoachingReport; headlineGist: string }) {
  const hasReport = Boolean(report.globalPacing || report.crisisManagement);
  const Para = ({ title, accent, body }: { title: string; accent: string; body: string }) =>
    body ? (
      <div>
        <div className="flex items-center gap-2 mb-[7px]">
          <span className="w-[7px] h-[7px] rounded-full" style={{ background: accent }} />
          <span className="text-[12px] font-bold text-zinc-50" style={{ fontFamily: 'var(--ai-font-display)' }}>
            {title}
          </span>
        </div>
        <p className="text-[12.5px] text-zinc-400 leading-relaxed whitespace-pre-line">{body}</p>
      </div>
    ) : null;
  return (
    <div
      className="rounded-xl p-[16px_18px]"
      style={{
        border: ' 1px solid rgba(242,140,24,0.22)',
        background: 'linear-gradient(135deg, rgba(242,140,24,0.05), rgba(242,140,24,0.01))',
      }}
    >
      <div className="flex items-center gap-2 mb-3" style={{ color: AMBER }}>
        <SparkleIcon size={14} />
        <span className="text-[11px] font-bold uppercase tracking-[0.12em]">Summary</span>
      </div>
      <p className="text-[14.5px] text-zinc-100 leading-snug mb-3.5" style={{ fontFamily: 'var(--ai-font-display)' }}>
        {headlineGist}
      </p>
      {hasReport && (
        <div className="grid gap-4" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <Para title="Global Pacing" accent={AMBER} body={report.globalPacing} />
          <Para title="Crisis Management" accent={GREEN} body={report.crisisManagement} />
        </div>
      )}
    </div>
  );
}

export interface ProComparisonVerifiedProps {
  vc: VerifiedComparison;
  /** The player's own <40%-HP crisis sequences (fresh extraction). */
  userCrises: string[];
  /** Diversified real pro crisis sequences from the cohort (exemplar-led). */
  proCrises: string[];
  /** Claude's coaching markdown ("Global Pacing" / "Crisis Management"). Optional. */
  report?: string;
}

export function ProComparisonVerified({ vc, userCrises, proCrises, report }: ProComparisonVerifiedProps) {
  const rows = buildVerifiedMetricRows(vc);
  const headline = deriveHeadline(vc);
  const coaching = parseCoachingReport(report ?? '');
  const crises = buildCrisisView(userCrises, proCrises);
  const sample = sampleDisclosure(vc);

  return (
    <div className="flex flex-col gap-[22px]">
      {/* headline verdict */}
      <div
        className="inline-flex items-center gap-2 rounded-md self-start"
        style={{ padding: '5px 10px', background: 'rgba(242,140,24,0.08)', border: '1px solid rgba(242,140,24,0.25)' }}
      >
        <span className="text-[11px] uppercase tracking-[0.1em] font-semibold text-zinc-500">Biggest lever</span>
        <span className="text-[12.5px] font-bold" style={{ color: AMBER, fontFamily: 'var(--ai-font-display)' }}>
          {headline.label}
        </span>
        <span className="text-[11px] text-zinc-500">
          vs {sample.uniquePlayers} pros · n={sample.n}
        </span>
      </div>

      <Summary report={coaching} headlineGist={headline.gist} />

      {/* percentile standing bars */}
      <div>
        <SectionLabel
          right={
            <span className="text-[10.5px] text-zinc-500">
              percentile vs {sample.uniquePlayers} 2300+ players · median at ▏50th
            </span>
          }
        >
          Your standing vs the cohort
        </SectionLabel>
        <div className="rounded-lg border border-zinc-900 bg-[#0c0c0e] px-[18px] pt-1.5 pb-2.5">
          {rows.length === 0 && <div className="py-3 text-[11.5px] text-zinc-600">No cohort metrics available.</div>}
          {rows.map((row, i) => (
            <div key={row.key} style={{ borderTop: i ? '1px solid #18181b' : 'none' }}>
              <PercentileBar row={row} />
            </div>
          ))}
        </div>
      </div>

      {/* crisis management — you vs real pro exemplars */}
      <div>
        <SectionLabel>Crisis management · your responses vs real pros</SectionLabel>
        <div className="grid gap-3.5" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <div className="rounded-lg border border-zinc-900 bg-[#0c0c0e] overflow-hidden">
            <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-zinc-900">
              <span className="text-[12px] font-bold" style={{ color: AMBER }}>
                You · {vc.player.split('-')[0]}
              </span>
              <span className="text-[10.5px] text-zinc-600 ml-auto">{crises.user.length} crisis responses</span>
            </div>
            {crises.user.length === 0 && (
              <div className="px-3.5 py-3 text-[11.5px] text-zinc-600">No &lt;40% HP crisis events recorded.</div>
            )}
            {crises.user.map((c, i) => (
              <CrisisRow key={i} c={c} />
            ))}
          </div>

          <div
            className="rounded-lg overflow-hidden"
            style={{ background: 'rgba(126,224,160,0.03)', border: '1px solid rgba(126,224,160,0.2)' }}
          >
            <div
              className="flex items-center gap-2 px-3.5 py-2.5"
              style={{ borderBottom: '1px solid rgba(126,224,160,0.15)' }}
            >
              <span className="text-[12px] font-bold" style={{ color: GREEN }}>
                Real pros · {crises.pros.length} examples
              </span>
              <span className="text-[10.5px] text-zinc-600 ml-auto">diversified across players</span>
            </div>
            {crises.pros.length === 0 && (
              <div className="px-3.5 py-3 text-[11.5px] text-zinc-600">No comparable pro crisis data.</div>
            )}
            {crises.pros.map((c, i) => (
              <CrisisRow key={i} c={c} tone="pro" />
            ))}
          </div>
        </div>
      </div>

      {/* provenance + disclosure */}
      <div className="rounded-lg border border-zinc-900 bg-[#0c0c0e] p-[12px_14px] text-[11.5px] text-zinc-500 leading-relaxed">
        <span className="text-zinc-300 font-medium">How this is computed:</span> every figure is measured server-side
        over your full same-spec, same-bracket cohort of {sample.uniquePlayers} 2300+ players (n={sample.n}) — no
        fabricated pro averages. Pro examples are real, diversified crisis responses.
        {sample.notes.length > 0 && <span className="text-amber-400/80"> · {sample.notes.join(' · ')}</span>}
      </div>
    </div>
  );
}
