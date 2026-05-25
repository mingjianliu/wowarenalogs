// Match identity hero: team rosters flanking the WIN/LOSS badge.

import { fmtTime } from '../../../../utils/cooldowns';
import { MatchAnalysisData, RosterEntry } from '../matchAnalysisData';
import { ClassGlyph } from './icons';

function TeamStrip({ players, align, label }: { players: RosterEntry[]; align: 'left' | 'right'; label: string }) {
  const right = align === 'right';
  return (
    <div className={`flex flex-col gap-2 min-w-[220px] py-4 ${right ? 'items-end pr-5' : 'items-start pl-5'}`}>
      <div className="text-[10px] uppercase tracking-[0.12em] text-zinc-500 font-semibold mb-1">{label}</div>
      {players.map((p) => (
        <div key={p.name} className={`flex items-center gap-2.5 ${right ? 'flex-row-reverse' : ''}`}>
          <ClassGlyph cls={p.cls} size="md" title={p.spec} />
          <div className={`flex flex-col ${right ? 'items-end' : 'items-start'}`}>
            <div className="flex items-center gap-1.5 leading-none whitespace-nowrap">
              <span
                className="text-[13px] font-semibold whitespace-nowrap"
                style={{ color: p.isOwner ? '#f9b13a' : '#e4e4e7' }}
              >
                {p.name}
              </span>
              {p.isOwner && <span className="text-[9px] uppercase tracking-wider text-[#f28c18] font-bold">You</span>}
            </div>
            <span className="text-[10.5px] text-zinc-500 leading-none mt-1 whitespace-nowrap">{p.spec}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function ResultBadge({ result, durationSeconds }: { result: MatchAnalysisData['result']; durationSeconds: number }) {
  const win = result === 'Win';
  const color = result === 'Unknown' ? '#a1a1aa' : win ? '#7ee0a0' : '#ff5a4a';
  const text = result === 'Unknown' ? '—' : win ? 'WIN' : 'LOSS';
  return (
    <div className="flex flex-col items-center gap-2 px-6 select-none">
      <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold">Outcome</div>
      <div
        className="text-[42px] font-bold leading-none tracking-tight"
        style={{
          color,
          textShadow: result === 'Unknown' ? undefined : `0 0 24px ${color}40`,
          fontFamily: 'var(--ai-font-display)',
        }}
      >
        {text}
      </div>
      <div className="flex items-center gap-3 mt-1">
        <div className="text-[12px] text-zinc-400 font-mono tabular-nums">{fmtTime(durationSeconds)}</div>
      </div>
    </div>
  );
}

export function MatchHero({ data }: { data: MatchAnalysisData }) {
  return (
    <div className="px-5 pt-5">
      <div className="rounded-lg border border-zinc-900 bg-gradient-to-b from-[#15151a] to-[#0e0e10] overflow-hidden">
        <div className="flex items-stretch">
          <TeamStrip players={data.friends} align="left" label="Your team" />
          <div className="flex-1 flex items-center justify-center">
            <div className="flex flex-col items-center gap-3 py-4 w-full">
              <div className="flex items-center gap-2 text-[10.5px] uppercase tracking-[0.14em] text-zinc-500 font-semibold">
                <span className="px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-300">
                  {data.bracket}
                </span>
                <span>·</span>
                <span>{data.zone}</span>
              </div>
              <ResultBadge result={data.result} durationSeconds={data.durationSeconds} />
              <div className="text-[10.5px] uppercase tracking-[0.12em] text-zinc-600 font-semibold">vs</div>
            </div>
          </div>
          <TeamStrip players={data.enemies} align="right" label="Enemy team" />
        </div>
      </div>
    </div>
  );
}
