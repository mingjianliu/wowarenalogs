import { CombatUnitReaction, CombatUnitType } from '@wowarenalogs/parser';
import { CSSProperties, useCallback, useEffect, useMemo, useState } from 'react';

import { useCombatReportContext } from '../CombatReportContext';
import { AIFinding } from './aiFindings';
import { buildMatchContext } from './buildMatchContext';
import { ComparativeAnalysisData } from './comparativePrompt';
import { FindingsList } from './components/FindingsList';
import { RefreshIcon, SparkleIcon } from './components/icons';
import { MatchHero } from './components/MatchHero';
import { ProComparison } from './components/ProComparison';
import { SupportingRail } from './components/SupportingRail';
import { TimelineStrip } from './components/TimelineStrip';
import { computeMatchAnalysisData } from './matchAnalysisData';

// re-export pure helpers so existing imports from this file continue to work
export type { CriticalMoment, MomentRole } from './utils';
export {
  buildDeathRootCauseTrace,
  buildKillMomentFields,
  buildMatchArc,
  buildMatchFlow,
  findContributingDeath,
  getEnemyStateAtTime,
  getOwnerCDsAvailable,
  identifyCriticalMoments,
} from './utils';
export { buildMatchContext } from './buildMatchContext';

// ──────────────────────────────────────────────────────────────────────────────

// Minimal markdown renderer (bold, bullets, headers)
function MarkdownBlock({ text }: { text: string }) {
  return (
    <div className="prose prose-sm max-w-none">
      {text.split('\n').map((line, i) => {
        if (line.startsWith('## ')) {
          return (
            <h3 key={i} className="text-base font-bold mt-4 mb-1">
              {line.slice(3)}
            </h3>
          );
        }
        if (line.startsWith('- ') || line.startsWith('* ')) {
          return (
            <div key={i} className="flex gap-2 my-0.5">
              <span className="text-primary mt-0.5">•</span>
              <span dangerouslySetInnerHTML={{ __html: renderInline(line.slice(2)) }} />
            </div>
          );
        }
        if (/^\d+\. /.test(line)) {
          const num = line.match(/^(\d+)\. /)?.[1];
          return (
            <div key={i} className="flex gap-2 my-0.5">
              <span className="text-primary font-bold min-w-[1.2rem]">{num}.</span>
              <span dangerouslySetInnerHTML={{ __html: renderInline(line.replace(/^\d+\. /, '')) }} />
            </div>
          );
        }
        if (line.trim() === '') return <div key={i} className="h-1" />;
        return <p key={i} className="my-0.5" dangerouslySetInnerHTML={{ __html: renderInline(line) }} />;
      })}
    </div>
  );
}

function renderInline(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code class="text-xs bg-base-300 px-1 rounded">$1</code>');
}

interface AnalysisResult {
  findings: AIFinding[];
  /** Raw prose fallback shown when JSON parsing failed server-side. */
  raw: string;
}

// Session-level cache: persists across tab switches and match switches without a server round-trip.
const analysisCache = new Map<string, AnalysisResult>();
// In-flight requests: allows re-attaching to an ongoing fetch after a tab switch.
const inFlightRequests = new Map<string, Promise<AnalysisResult>>();

// Scoped design tokens — fonts + near-black palette applied only inside the AI tab.
const AI_VIEW_STYLE = {
  '--ai-font-display': '"IBM Plex Sans", system-ui, sans-serif',
  '--ai-font-sans': '"IBM Plex Sans", system-ui, sans-serif',
  '--ai-font-mono': '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  fontFamily: 'var(--ai-font-sans)',
  background: '#08080a',
  color: '#e4e4e7',
} as CSSProperties;

export function CombatAIAnalysis() {
  const { combat, friends, enemies } = useCombatReportContext();
  const [result, setResult] = useState<AnalysisResult | null>(() => analysisCache.get(combat?.id ?? '') ?? null);
  const [loading, setLoading] = useState(() => inFlightRequests.has(combat?.id ?? ''));
  const [error, setError] = useState<string | null>(null);
  const [expandedRanks, setExpandedRanks] = useState<Set<number>>(() => new Set());
  const [focused, setFocused] = useState(0);
  const [comparison, setComparison] = useState<ComparativeAnalysisData | undefined>(undefined);
  const [comparisonReport, setComparisonReport] = useState<string | undefined>(undefined);
  const [comparisonLoading, setComparisonLoading] = useState(false);

  const data = useMemo(
    () => (combat ? computeMatchAnalysisData(combat, friends, enemies) : null),
    [combat, friends, enemies],
  );

  // When the combat changes (or on mount): sync cached result or re-attach to an in-flight request.
  useEffect(() => {
    if (!combat) return;
    setExpandedRanks(new Set());
    setFocused(0);
    setComparison(undefined);
    setComparisonReport(undefined);
    setComparisonLoading(false);

    const cached = analysisCache.get(combat.id);
    if (cached) {
      setResult(cached);
      setExpandedRanks(new Set(cached.findings.length > 0 ? [cached.findings[0].rank] : []));
      setFocused(cached.findings[0]?.rank ?? 0);
      setLoading(false);
      setError(null);
      return;
    }

    const inFlight = inFlightRequests.get(combat.id);
    if (inFlight) {
      setResult(null);
      setLoading(true);
      setError(null);
      inFlight
        .then((r) => {
          setResult(r);
          setLoading(false);
        })
        .catch((e: unknown) => {
          setError(e instanceof Error ? e.message : 'Analysis failed');
          setLoading(false);
        });
      return;
    }

    setResult(null);
    setLoading(false);
    setError(null);
  }, [combat?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = useCallback((rank: number) => {
    setExpandedRanks((prev) => {
      const next = new Set(prev);
      if (next.has(rank)) next.delete(rank);
      else next.add(rank);
      return next;
    });
    setFocused(rank);
  }, []);

  const onTimelineClick = useCallback((rank: number) => {
    setFocused(rank);
    setExpandedRanks((prev) => new Set(prev).add(rank));
    const el = document.getElementById(`ai-finding-${rank}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  const handleAnalyze = useCallback(async () => {
    if (!combat) return;
    const combatId = combat.id;
    setLoading(true);
    setError(null);
    setResult(null);

    // Part II · Pro comparison — independent, guarded, never blocks Part I.
    setComparison(undefined);
    setComparisonReport(undefined);
    setComparisonLoading(true);
    (async () => {
      try {
        const apiKey = (await window.wowarenalogs?.settings?.getAnthropicApiKey?.()) ?? undefined;
        const r = await fetch('/api/compare', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ matchId: combatId, apiKey }),
        });
        const body = (await r.json()) as { comparison?: ComparativeAnalysisData; comparisonReport?: string };
        if (combat.id !== combatId) return; // stale guard, mirrors the findings path
        setComparison(body.comparison);
        setComparisonReport(body.comparisonReport);
      } catch {
        if (combat.id === combatId) setComparison(undefined);
      } finally {
        if (combat.id === combatId) setComparisonLoading(false);
      }
    })();

    const fetchPromise: Promise<AnalysisResult> = (async () => {
      const matchContext = buildMatchContext(combat, friends, enemies);
      const apiKey = (await window.wowarenalogs?.settings?.getAnthropicApiKey?.()) ?? undefined;
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ matchContext, apiKey, findingsJson: true, matchId: combatId }),
      });
      const body = (await res.json()) as {
        analysis?: string;
        findings?: AIFinding[];
        error?: string;
      };
      if (!res.ok || body.error) throw new Error(body.error ?? 'Analysis failed');
      const analysisResult: AnalysisResult = { findings: body.findings ?? [], raw: body.analysis ?? '' };
      analysisCache.set(combatId, analysisResult);
      return analysisResult;
    })();

    inFlightRequests.set(combatId, fetchPromise);
    fetchPromise.finally(() => inFlightRequests.delete(combatId));

    try {
      const r = await fetchPromise;
      if (combat.id !== combatId) return;
      setResult(r);
      setExpandedRanks(new Set(r.findings.length > 0 ? [r.findings[0].rank] : []));
      setFocused(r.findings[0]?.rank ?? 0);
    } catch (e) {
      if (combat.id !== combatId) return;
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      if (combat.id === combatId) setLoading(false);
    }
  }, [combat, friends, enemies]);

  if (!combat) return null;

  const allPlayers = [...friends, ...enemies];
  const hasPlayers = allPlayers.some(
    (p) => p.type === CombatUnitType.Player && p.reaction === CombatUnitReaction.Friendly,
  );
  if (!hasPlayers || !data) {
    return <div className="p-4 text-base-content opacity-60">No player data available for analysis.</div>;
  }

  const findings = result?.findings ?? [];
  const parseFailed = result !== null && findings.length === 0 && result.raw.length > 0;

  return (
    <div className="rounded-xl overflow-hidden" style={AI_VIEW_STYLE}>
      <div className="max-w-[1480px] mx-auto pb-10">
        <MatchHero data={data} />

        <div className="px-5">
          {/* AI hero strip */}
          <div className="flex items-end justify-between gap-4 mt-6 mb-3">
            <div className="flex items-center gap-3">
              <div
                className="w-9 h-9 rounded-lg flex items-center justify-center text-[#f9b13a]"
                style={{
                  background: 'radial-gradient(circle at 30% 30%, rgba(242,140,24,0.25), rgba(242,140,24,0.05))',
                  border: '1px solid rgba(242,140,24,0.3)',
                  boxShadow: '0 0 32px rgba(242,140,24,0.12), inset 0 0 16px rgba(242,140,24,0.08)',
                }}
              >
                <SparkleIcon size={18} />
              </div>
              <div>
                <h1
                  className="text-[22px] font-bold tracking-tight leading-tight text-zinc-50"
                  style={{ fontFamily: 'var(--ai-font-display)' }}
                >
                  AI cooldown analysis
                </h1>
                <p className="text-[12.5px] text-zinc-500 mt-0.5 max-w-[640px]">
                  {findings.length > 0
                    ? `${findings.length} findings, ranked by estimated match impact. Reviewed against your spec baseline, enemy CD timeline, and burst-window alignment.`
                    : `Reviews ${data.ownerSpec} cooldown decisions against the enemy CD timeline and burst-window alignment.`}
                </p>
              </div>
            </div>
            {findings.length > 0 && (
              <button
                onClick={handleAnalyze}
                className="shrink-0 whitespace-nowrap flex items-center gap-1.5 text-[12px] text-zinc-100 px-3 py-1.5 rounded-md bg-zinc-900 border border-zinc-800 hover:border-zinc-700 transition"
              >
                <RefreshIcon /> Re-analyze
              </button>
            )}
          </div>

          <TimelineStrip data={data} findings={findings} activeFinding={focused} onFindingClick={onTimelineClick} />
        </div>

        <div className="px-5 mt-5 grid gap-5" style={{ gridTemplateColumns: 'minmax(0, 1fr) 340px' }}>
          <div className="min-w-0">
            {!result && !loading && !error && (
              <div className="rounded-lg border border-zinc-900 bg-[#0e0e10] p-8 flex flex-col items-center gap-4 text-center">
                <div className="text-[13px] text-zinc-400 max-w-md">
                  Run Claude over this match to get ranked findings on your cooldown decisions, with evidence drawn from
                  the timeline above.
                </div>
                <button
                  onClick={handleAnalyze}
                  className="flex items-center gap-2 text-[13px] font-semibold text-[#1a0d00] px-4 py-2 rounded-md"
                  style={{ background: 'linear-gradient(135deg, #f9b13a, #f28c18)' }}
                >
                  <SparkleIcon size={14} /> Analyse this match
                </button>
              </div>
            )}

            {loading && (
              <div className="rounded-lg border border-zinc-900 bg-[#0e0e10] p-8 flex items-center justify-center gap-3">
                <span className="loading loading-spinner loading-sm" style={{ color: '#f28c18' }} />
                <span className="text-[13px] text-zinc-400">Analysing your cooldown decisions…</span>
              </div>
            )}

            {error && (
              <div className="rounded-lg border border-red-900/50 bg-red-950/20 p-4 flex items-center gap-3">
                <span className="text-[13px] text-red-300 flex-1">{error}</span>
                <button
                  className="text-[12px] px-3 py-1.5 rounded-md bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-200"
                  onClick={handleAnalyze}
                >
                  Retry
                </button>
              </div>
            )}

            {result && findings.length > 0 && (
              <>
                <div className="flex items-center justify-between gap-4 mb-3 px-1">
                  <h2 className="text-[12px] uppercase tracking-[0.14em] text-zinc-500 font-semibold whitespace-nowrap">
                    Findings · ranked by match impact
                  </h2>
                  <div className="flex items-center gap-3 text-[11px] text-zinc-500 shrink-0">
                    <button
                      className="whitespace-nowrap hover:text-zinc-300 transition"
                      onClick={() => setExpandedRanks(new Set(findings.map((f) => f.rank)))}
                    >
                      Expand all
                    </button>
                    <span className="text-zinc-800">·</span>
                    <button
                      className="whitespace-nowrap hover:text-zinc-300 transition"
                      onClick={() => setExpandedRanks(new Set())}
                    >
                      Collapse all
                    </button>
                  </div>
                </div>
                <FindingsList
                  findings={findings}
                  data={data}
                  expandedRanks={expandedRanks}
                  focused={focused}
                  onToggle={toggle}
                />
                <div className="mt-6 rounded-lg border border-zinc-900 bg-[#0c0c0e] p-4 text-[11.5px] text-zinc-500 leading-relaxed">
                  <span className="text-zinc-300 font-medium">Analyzer notes:</span> Findings exclude rule-based flags
                  with no causal link to a moment. Confidence reflects log-coverage gaps — exact HP, healer mana, and
                  positioning are not always in the combat log. Evidence timestamps are pulled from the parsed log, not
                  generated. Claude Sonnet 4.6.
                </div>
              </>
            )}

            {parseFailed && (
              <div className="flex flex-col gap-3">
                <div className="rounded-md border border-amber-900/40 bg-amber-950/15 px-3 py-2 text-[11.5px] text-amber-300/90">
                  Couldn’t structure the findings for this run — showing the raw analysis below. The match timeline and
                  source-data panels are computed from the log and remain accurate.
                </div>
                <div className="rounded-lg border border-zinc-900 bg-[#0c0c0e] p-4 text-zinc-200">
                  <MarkdownBlock text={result.raw} />
                </div>
                <button
                  className="text-[12px] px-3 py-1.5 rounded-md bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-200 w-fit"
                  onClick={handleAnalyze}
                >
                  Re-analyse
                </button>
              </div>
            )}

            {result && findings.length === 0 && !parseFailed && (
              <div className="rounded-lg border border-zinc-900 bg-[#0e0e10] p-6 flex flex-col gap-3">
                <div className="text-[13px] text-zinc-300 font-medium">No actionable findings for this match.</div>
                <div className="text-[12px] text-zinc-500 leading-relaxed">
                  The analyzer didn’t surface a ranked cooldown decision worth flagging — often the case for very short
                  rounds or clean execution. The match timeline and source-data panels above are computed directly from
                  the log and remain accurate.
                </div>
                <button
                  className="text-[12px] px-3 py-1.5 rounded-md bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-200 w-fit"
                  onClick={handleAnalyze}
                >
                  Re-analyse
                </button>
              </div>
            )}
          </div>

          <aside className="hidden lg:block">
            <SupportingRail data={data} />
          </aside>
        </div>

        {(comparisonLoading || comparison) && (
          <div className="px-5 mt-8">
            <div className="flex items-center gap-3.5 mb-4">
              <div
                className="shrink-0 w-[34px] h-[34px] rounded-lg flex items-center justify-center"
                style={{
                  color: '#7ee0a0',
                  background: 'rgba(126,224,160,0.08)',
                  border: '1px solid rgba(126,224,160,0.23)',
                }}
              >
                <SparkleIcon size={17} />
              </div>
              <div>
                <span className="text-[10px] font-bold tracking-[0.16em] uppercase text-zinc-600">Part II</span>
                <h2
                  className="text-[18px] font-bold text-zinc-50 leading-tight"
                  style={{ fontFamily: 'var(--ai-font-display)' }}
                >
                  Pro comparison
                </h2>
                <p className="text-[12.5px] text-zinc-500 mt-0.5">
                  Your pacing &amp; crisis decisions vs the nearest gold-standard games on your build.
                </p>
              </div>
            </div>
            {comparison ? (
              <ProComparison data={comparison} report={comparisonReport} />
            ) : (
              <div className="text-[12.5px] text-zinc-600 py-6">Finding your nearest pro games…</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
