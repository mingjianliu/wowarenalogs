// Findings cards — the hero of the AI analysis screen. Always-visible
// What/Alternative/Impact; expand for app-derived evidence + counterfactual.

import { ReactNode, useMemo } from 'react';

import { fmtTime } from '../../../../utils/cooldowns';
import { AIFinding } from '../aiFindings';
import { deriveEvidence, EvidenceKind, EvidenceMoment, formatEvidenceWindow } from '../findingEvidence';
import { MatchAnalysisData } from '../matchAnalysisData';
import {
  BoltIcon,
  CCIcon,
  ChevronDown,
  ClassGlyph,
  ConfidencePill,
  PurgeIcon,
  SeverityDot,
  ShieldIcon,
  SparkleIcon,
  SwordIcon,
  TargetIcon,
  TimePill,
} from './icons';

const KIND_META: Record<EvidenceKind, { icon: ReactNode; color: string; label: string }> = {
  'owner-cd': { icon: <BoltIcon size={12} />, color: '#a1a1aa', label: 'Your CD' },
  'enemy-cd': { icon: <SwordIcon size={12} />, color: '#ff8a7d', label: 'Enemy CD' },
  'enemy-burst': { icon: <BoltIcon size={12} />, color: '#ff5a4a', label: 'Burst' },
  cc: { icon: <CCIcon size={12} />, color: '#a78bfa', label: 'CC' },
  purge: { icon: <PurgeIcon size={12} />, color: '#60a5fa', label: 'Purge miss' },
  kill: { icon: <TargetIcon size={12} />, color: '#7ee0a0', label: 'Death' },
};

function EvidenceMomentRow({ m }: { m: EvidenceMoment }) {
  const k = KIND_META[m.kind] ?? { icon: <ShieldIcon size={12} />, color: '#a1a1aa', label: 'Event' };
  return (
    <div className="flex items-center gap-2.5 py-1">
      <TimePill secs={m.atSeconds} />
      <span className="shrink-0" style={{ color: k.color }}>
        {k.icon}
      </span>
      <span
        className="text-[10px] uppercase tracking-[0.1em] font-semibold w-[68px] shrink-0"
        style={{ color: k.color }}
      >
        {k.label}
      </span>
      {m.cls && <ClassGlyph cls={m.cls} size="sm" />}
      <span className="text-[12px] text-zinc-300">{m.label}</span>
    </div>
  );
}

const SEVERITY_RAIL: Record<AIFinding['severity'], string> = {
  Critical: 'linear-gradient(180deg, #ff5a4a, #b92a1d)',
  High: 'linear-gradient(180deg, #f97316, #b04408)',
  Medium: 'linear-gradient(180deg, #facc15, #a17a04)',
  Low: 'linear-gradient(180deg, #60a5fa, #2962b8)',
};

interface FindingCardProps {
  finding: AIFinding;
  data: MatchAnalysisData;
  expanded: boolean;
  isFocused: boolean;
  onToggle: () => void;
}

function FindingCard({ finding: f, data, expanded, isFocused, onToggle }: FindingCardProps) {
  const evidence = useMemo(() => deriveEvidence(f.atSeconds, data), [f.atSeconds, data]);

  return (
    <article
      id={`ai-finding-${f.rank}`}
      className={`relative rounded-lg border transition overflow-hidden ${
        isFocused
          ? 'border-[#f28c18]/60 bg-gradient-to-b from-[#1a120a] to-[#0e0e10]'
          : 'border-zinc-900 bg-[#0e0e10] hover:border-zinc-800'
      }`}
      style={isFocused ? { boxShadow: '0 0 0 1px rgba(242,140,24,0.15), 0 0 32px rgba(242,140,24,0.08)' } : undefined}
    >
      <div className="absolute left-0 top-0 bottom-0 w-1" style={{ background: SEVERITY_RAIL[f.severity] }} />

      <button onClick={onToggle} className="w-full text-left flex items-start gap-4 p-4 pl-5">
        <div className="flex flex-col items-center gap-1 mt-0.5 shrink-0">
          <div
            className="w-7 h-7 rounded-md flex items-center justify-center text-[13px] font-bold tabular-nums"
            style={{
              background: 'linear-gradient(135deg, #f9b13a, #f28c18)',
              color: '#1a0d00',
              fontFamily: 'var(--ai-font-display)',
              boxShadow: 'inset 0 -1px 0 rgba(0,0,0,0.25), 0 1px 0 rgba(255,255,255,0.05)',
            }}
          >
            {f.rank}
          </div>
          <TimePill secs={f.atSeconds} />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <SeverityDot value={f.severity} />
            <span className="text-zinc-700">·</span>
            <ConfidencePill value={f.confidence} />
            {f.impactDelta && (
              <>
                <span className="text-zinc-700">·</span>
                <span className="text-[11px] text-zinc-500 font-medium">{f.impactDelta}</span>
              </>
            )}
          </div>
          <h2
            className="text-[16.5px] font-semibold leading-snug tracking-tight text-zinc-50"
            style={{ fontFamily: 'var(--ai-font-display)' }}
          >
            {f.title}
          </h2>
          {f.summary && <p className="text-[13px] text-zinc-400 mt-1.5 leading-relaxed">{f.summary}</p>}
        </div>

        <ChevronDown
          size={16}
          className={`text-zinc-500 mt-1 transition-transform shrink-0 ${expanded ? 'rotate-180' : ''}`}
        />
      </button>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 px-5 pb-4 pl-9">
        <div>
          <div className="text-[9.5px] uppercase tracking-[0.14em] text-zinc-600 font-semibold mb-1.5">
            What happened
          </div>
          <p className="text-[12px] text-zinc-400 leading-relaxed">{f.whatHappened}</p>
        </div>
        <div>
          <div
            className="text-[9.5px] uppercase tracking-[0.14em] font-semibold mb-1.5"
            style={{ color: 'rgba(242,140,24,0.7)' }}
          >
            Alternative
          </div>
          <p className="text-[12px] text-zinc-300 leading-relaxed">{f.alternative}</p>
        </div>
        <div>
          <div className="text-[9.5px] uppercase tracking-[0.14em] text-zinc-600 font-semibold mb-1.5">Impact</div>
          <p className="text-[12px] text-zinc-400 leading-relaxed">{f.impact}</p>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-zinc-900 bg-[#08080a]">
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-0">
            <div className="p-5 pl-9">
              <div className="text-[10px] uppercase tracking-[0.12em] text-zinc-500 font-semibold mb-3">
                Evidence — key moments {formatEvidenceWindow(evidence)}
              </div>
              <div className="rounded-md bg-[#0c0c0e] border border-zinc-900 p-3">
                {evidence.keyMoments.length === 0 ? (
                  <div className="text-[12px] text-zinc-600 py-1">No logged events in this window.</div>
                ) : (
                  <div className="flex flex-col">
                    {evidence.keyMoments.map((m, i) => (
                      <EvidenceMomentRow key={i} m={m} />
                    ))}
                  </div>
                )}
              </div>

              {f.counterfactual && (
                <div
                  className="mt-4 flex items-start gap-3 rounded-md p-3 border"
                  style={{ borderColor: 'rgba(242,140,24,0.25)', background: 'rgba(242,140,24,0.04)' }}
                >
                  <div className="shrink-0 mt-0.5 text-[#f9b13a]">
                    <SparkleIcon size={14} />
                  </div>
                  <div>
                    <div
                      className="text-[10px] uppercase tracking-[0.12em] font-semibold mb-1"
                      style={{ color: '#f9b13a' }}
                    >
                      Counterfactual estimate
                    </div>
                    <p className="text-[12.5px] text-zinc-300 leading-relaxed">{f.counterfactual}</p>
                  </div>
                </div>
              )}
            </div>

            <div className="border-t lg:border-t-0 lg:border-l border-zinc-900 p-5 flex flex-col gap-4 bg-[#0a0a0c]">
              <div>
                <div className="text-[10px] uppercase tracking-[0.12em] text-zinc-500 font-semibold mb-1.5">
                  Confidence note
                </div>
                <p className="text-[12px] text-zinc-400 leading-relaxed">{f.confidenceNote}</p>
              </div>
              <div className="grid grid-cols-2 gap-3 mt-auto pt-2">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.12em] text-zinc-500 font-semibold mb-1">Anchor</div>
                  <div className="text-[12px] text-zinc-300 font-mono tabular-nums">{fmtTime(f.atSeconds)}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-[0.12em] text-zinc-500 font-semibold mb-1">
                    Estimated
                  </div>
                  <div className="text-[12px] font-semibold" style={{ color: '#f9b13a' }}>
                    {f.impactDelta || '—'}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </article>
  );
}

interface FindingsListProps {
  findings: AIFinding[];
  data: MatchAnalysisData;
  expandedRanks: Set<number>;
  focused: number;
  onToggle: (rank: number) => void;
}

export function FindingsList({ findings, data, expandedRanks, focused, onToggle }: FindingsListProps) {
  return (
    <div className="flex flex-col gap-3">
      {findings.map((f) => (
        <FindingCard
          key={f.rank}
          finding={f}
          data={data}
          expanded={expandedRanks.has(f.rank)}
          isFocused={focused === f.rank}
          onToggle={() => onToggle(f.rank)}
        />
      ))}
    </div>
  );
}
