// packages/shared/src/components/CombatReport/CombatAIAnalysis/components/ProComparison.tsx
//
// "Pro comparison" — Part II of the AI match review. Renders the dynamic-
// archetyping (vector) result: a playstyle verdict, a coaching summary
// (Global Pacing / Crisis Management), per-metric gap bars vs the nearest
// pro cohort, and a you-vs-pros crisis-response comparison.
//
// Visual language matches the existing Decision-review UI (near-black + amber,
// var(--ai-font-*), Blizzard class palette). Pure presentation — all data
// transforms live in ../proComparisonData.

import { ReactNode } from 'react';

import { ComparativeAnalysisData } from '../comparativePrompt';
import {
  buildMetricRows,
  CoachingReport,
  deriveArchetype,
  formatMetric,
  MetricRow,
  parseCoachingReport,
  parseCrisisEvent,
} from '../proComparisonData';
import { ArrowRight, SparkleIcon } from './icons';

// Local glyph — the vector/nearest-neighbour mark used for the Pro-comparison section.
function VectorIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <circle cx="3.5" cy="12.5" r="1.6" fill="currentColor" />
      <circle cx="12.5" cy="3.5" r="1.6" fill="currentColor" />
      <circle cx="12" cy="11.5" r="1.2" fill="currentColor" opacity="0.6" />
      <circle cx="6.5" cy="5" r="1.2" fill="currentColor" opacity="0.6" />
      <path d="M4.6 11.4L11.4 4.6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}

function SectionLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <h3 className="text-[12px] uppercase tracking-[0.14em] text-zinc-500 font-semibold">{children}</h3>
      {right}
    </div>
  );
}

// ── Diverging metric bar — user fill + cohort-average marker ──────────────────
function DivergeBar({ row }: { row: MetricRow }) {
  const { spec, you, pro, behind, delta } = row;
  const youPct = Math.max(0.05, Math.min(1, you / spec.max));
  const proPct = Math.max(0.05, Math.min(1, pro / spec.max));
  const deltaColor = behind ? '#ff5a4a' : '#7ee0a0';
  return (
    <div className="py-[11px]">
      <div className="flex items-baseline justify-between mb-[7px]">
        <div className="flex items-baseline gap-2 min-w-0 flex-1 mr-3">
          <span className="text-[13px] font-semibold text-zinc-200 whitespace-nowrap">{spec.label}</span>
          <span className="text-[10.5px] text-zinc-600 truncate">{spec.hint}</span>
        </div>
        <div className="flex items-center gap-2.5 font-mono tabular-nums shrink-0">
          <span className="text-[12.5px] font-semibold" style={{ color: '#f9b13a' }}>
            {formatMetric(spec, you)}
          </span>
          <span className="text-zinc-600">
            <ArrowRight size={11} />
          </span>
          <span className="text-[12.5px]" style={{ color: '#7ee0a0' }}>
            {formatMetric(spec, pro)}
          </span>
          <span
            className="text-[10.5px] px-1.5 py-px rounded text-center"
            style={{
              color: deltaColor,
              minWidth: 46,
              background: behind ? 'rgba(255,90,74,0.1)' : 'rgba(126,224,160,0.1)',
              border: `1px solid ${deltaColor}44`,
            }}
          >
            {delta > 0 ? '+' : ''}
            {formatMetric(spec, delta)}
          </span>
        </div>
      </div>
      <div
        className="relative h-3 rounded-[3px]"
        style={{ background: 'rgba(255,255,255,0.05)', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.04)' }}
      >
        <div
          className="absolute left-0 top-0 bottom-0 rounded-[3px]"
          style={{
            width: `${youPct * 100}%`,
            background: 'linear-gradient(90deg, #f28c18cc, #f9b13a)',
            boxShadow: '0 0 8px #f28c1866',
          }}
        />
        <div
          className="absolute -top-[3px] -bottom-[3px] w-0.5"
          style={{ left: `${proPct * 100}%`, background: '#7ee0a0', boxShadow: '0 0 6px #7ee0a0' }}
        />
        <div
          className="absolute -top-[5px] w-2 h-2 rounded-full"
          style={{ left: `calc(${proPct * 100}% - 3px)`, background: '#7ee0a0', border: '1.5px solid #08080a' }}
        />
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
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ── Summary (LLM coaching report) ─────────────────────────────────────────────
function Summary({ report, label, gist }: { report: CoachingReport; label: string; gist: string }) {
  const hasReport = Boolean(report.globalPacing || report.crisisManagement);
  const Para = ({ title, accent, body }: { title: string; accent: string; body: string }) => (
    <div>
      <div className="flex items-center gap-2 mb-[7px]">
        <span className="w-[7px] h-[7px] rounded-full" style={{ background: accent }} />
        <span
          className="text-[12px] font-bold text-zinc-50 whitespace-nowrap"
          style={{ fontFamily: 'var(--ai-font-display)' }}
        >
          {title}
        </span>
      </div>
      <p className="text-[12.5px] text-zinc-400 leading-relaxed whitespace-pre-line">{body}</p>
    </div>
  );
  return (
    <div
      className="rounded-xl p-[16px_18px]"
      style={{
        border: '1px solid rgba(242,140,24,0.22)',
        background: 'linear-gradient(135deg, rgba(242,140,24,0.05), rgba(242,140,24,0.01))',
      }}
    >
      <div className="flex items-center gap-2 mb-3" style={{ color: '#f9b13a' }}>
        <SparkleIcon size={14} />
        <span className="text-[11px] font-bold uppercase tracking-[0.12em]">Summary</span>
      </div>
      <p className="text-[14.5px] text-zinc-100 leading-snug mb-3.5" style={{ fontFamily: 'var(--ai-font-display)' }}>
        You land as a{' '}
        <span className="font-semibold" style={{ color: '#f9b13a' }}>
          {label}
        </span>{' '}
        against this cohort — {gist}
      </p>
      {hasReport && (
        <div className="grid gap-4" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <Para title="Global Pacing" accent="#f9b13a" body={report.globalPacing} />
          <Para title="Crisis Management" accent="#7ee0a0" body={report.crisisManagement} />
        </div>
      )}
    </div>
  );
}

export interface ProComparisonProps {
  /** Computed comparison data — metrics, neighbours, crisis events. */
  data: ComparativeAnalysisData;
  /** Claude's coaching markdown (headers "Global Pacing" / "Crisis Management"). Optional. */
  report?: string;
}

export function ProComparison({ data, report }: ProComparisonProps) {
  const rows = buildMetricRows(data);
  const archetype = deriveArchetype(data);
  const coaching = parseCoachingReport(report ?? '');
  const userCrisis = data.userCrisisEvents.map(parseCrisisEvent);
  const proCrisis = data.nearestNeighbors
    .flatMap((n) => n.crisisEvents)
    .map(parseCrisisEvent)
    .slice(0, 6);
  const neighborCount = data.nearestNeighbors.length;

  return (
    <div className="flex flex-col gap-[22px]">
      {/* archetype verdict */}
      <div
        className="inline-flex items-center gap-2 rounded-md self-start"
        style={{ padding: '5px 10px', background: 'rgba(242,140,24,0.08)', border: '1px solid rgba(242,140,24,0.25)' }}
      >
        <span style={{ color: '#f9b13a' }}>
          <VectorIcon size={13} />
        </span>
        <span className="text-[11px] uppercase tracking-[0.1em] font-semibold text-zinc-500">Archetype</span>
        <span className="text-[12.5px] font-bold" style={{ color: '#f9b13a', fontFamily: 'var(--ai-font-display)' }}>
          {archetype.label}
        </span>
      </div>

      <Summary
        report={coaching}
        label={archetype.label}
        gist={archetype.gist.charAt(0).toLowerCase() + archetype.gist.slice(1)}
      />

      {/* metric gap bars */}
      <div>
        <SectionLabel
          right={
            <div className="flex items-center gap-3 text-[10.5px] text-zinc-500">
              <span className="flex items-center gap-1.5">
                <span className="w-3.5 h-1 rounded-sm" style={{ background: '#f9b13a' }} /> You
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full" style={{ background: '#7ee0a0' }} /> Pro avg
              </span>
            </div>
          }
        >
          Performance gap · you vs pro average
        </SectionLabel>
        <div className="rounded-lg border border-zinc-900 bg-[#0c0c0e] px-[18px] pt-1.5 pb-2.5">
          {rows.map((row, i) => (
            <div key={row.spec.key} style={{ borderTop: i ? '1px solid #18181b' : 'none' }}>
              <DivergeBar row={row} />
            </div>
          ))}
        </div>
      </div>

      {/* crisis management — you vs pros */}
      <div>
        <SectionLabel>Crisis management · your responses vs the cohort</SectionLabel>
        <div className="grid gap-3.5" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <div className="rounded-lg border border-zinc-900 bg-[#0c0c0e] overflow-hidden">
            <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-zinc-900">
              <span className="text-[12px] font-bold" style={{ color: '#f9b13a' }}>
                You · {data.playerName.split('-')[0]}
              </span>
              <span className="text-[10.5px] text-zinc-600 ml-auto">{userCrisis.length} crisis responses</span>
            </div>
            <div className="flex flex-col">
              {userCrisis.length === 0 && (
                <div className="px-3.5 py-3 text-[11.5px] text-zinc-600">No major crisis events recorded.</div>
              )}
              {userCrisis.map((c, i) => (
                <div key={i} className="px-3.5 py-2.5" style={{ borderTop: i ? '1px solid #18181b' : 'none' }}>
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="font-mono tabular-nums text-[10.5px] text-zinc-300">
                      {fmtTimeShort(c.atSeconds)}
                    </span>
                    {c.who && <span className="text-[11.5px] text-zinc-300">{c.who}</span>}
                    {c.hpPct != null && (
                      <span
                        className="font-mono text-[11px] font-bold"
                        style={{ color: c.hpPct <= 33 ? '#ff5a4a' : '#fbbf6b' }}
                      >
                        {c.hpPct}%
                      </span>
                    )}
                    {c.sequence.length === 1 && (
                      <span className="text-[9.5px] uppercase tracking-wider ml-auto" style={{ color: '#fbbf6b' }}>
                        thin
                      </span>
                    )}
                  </div>
                  <SeqChips sequence={c.sequence} />
                </div>
              ))}
            </div>
          </div>

          <div
            className="rounded-lg overflow-hidden"
            style={{ background: 'rgba(126,224,160,0.03)', border: '1px solid rgba(126,224,160,0.2)' }}
          >
            <div
              className="flex items-center gap-2 px-3.5 py-2.5"
              style={{ borderBottom: '1px solid rgba(126,224,160,0.15)' }}
            >
              <span className="text-[12px] font-bold" style={{ color: '#7ee0a0' }}>
                Cohort · {neighborCount} nearest pros
              </span>
              <span className="text-[10.5px] text-zinc-600 ml-auto">{proCrisis.length} responses</span>
            </div>
            <div className="flex flex-col">
              {proCrisis.length === 0 && (
                <div className="px-3.5 py-3 text-[11.5px] text-zinc-600">No pro data available.</div>
              )}
              {proCrisis.map((c, i) => (
                <div
                  key={i}
                  className="px-3.5 py-2.5"
                  style={{ borderTop: i ? '1px solid rgba(126,224,160,0.12)' : 'none' }}
                >
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="font-mono tabular-nums text-[10.5px] text-zinc-300">
                      {fmtTimeShort(c.atSeconds)}
                    </span>
                    {c.hpPct != null && (
                      <span
                        className="font-mono text-[11px] font-bold"
                        style={{ color: c.hpPct <= 33 ? '#ff5a4a' : '#fbbf6b' }}
                      >
                        {c.hpPct}%
                      </span>
                    )}
                  </div>
                  <SeqChips sequence={c.sequence} tone="pro" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* how it works + provenance */}
      <div className="grid gap-3.5" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <div className="rounded-lg border border-zinc-900 bg-[#0a0a0c] p-[13px_14px]">
          <div className="flex items-center gap-2 mb-2" style={{ color: '#f9b13a' }}>
            <VectorIcon size={14} />
            <span className="text-[11px] uppercase tracking-[0.12em] text-zinc-400 font-bold">
              How the match is found
            </span>
          </div>
          <p className="text-[11.5px] text-zinc-500 leading-relaxed">
            Your match is embedded as a high-dimensional vector — talent fingerprint, rotation rhythm (TF-IDF of 3-spell
            chains), and performance scalars — then matched by cosine distance against the reference corpus. The{' '}
            {neighborCount} nearest share your spec, build &amp; bracket.
          </p>
        </div>
        <div className="rounded-lg border border-zinc-900 bg-[#0c0c0e] p-[12px_14px] text-[11.5px] text-zinc-500 leading-relaxed">
          <span className="text-zinc-300 font-medium">Analyzer notes:</span> Comparison draws only from same-build,
          same-bracket games. Metric gaps are descriptive, not prescriptive — match context (comp, dampening, teammate
          play) is not held constant. Crisis examples reflect the nearest neighbours only. Claude Sonnet 4.6.
        </div>
      </div>
    </div>
  );
}
