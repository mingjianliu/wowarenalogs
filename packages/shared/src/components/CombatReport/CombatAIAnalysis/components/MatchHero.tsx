import { fmtTime } from '../../../../utils/cooldowns';
import { MatchAnalysisData } from '../matchAnalysisData';
import { ClassGlyph } from './icons';

type PlayerSummary = MatchAnalysisData['friends'][number];

// Output strength bar — fills toward the centre of the hero, relative to the match's
// best same-role output (the strongest player pegs the bar). Square corners keep
// length readable.
function OutputBar({ rate, baseline, type, right }: { rate: number; baseline: number; type: string; right: boolean }) {
  const pct = Math.max(0.06, Math.min(1, baseline > 0 ? rate / baseline : 0));
  const color = type === 'HPS' ? '#34e08a' : '#ff6a58';
  return (
    <div
      className={`w-[58px] h-[10px] overflow-hidden shrink-0 flex ${right ? 'justify-end' : ''}`}
      style={{ background: 'rgba(255,255,255,0.05)', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.04)' }}
      title={`${baseline > 0 ? Math.round((rate / baseline) * 100) : 0}% of match-best ${type}`}
    >
      <div
        className="h-full"
        style={{
          width: `${pct * 100}%`,
          background: `linear-gradient(90deg, ${color}cc, ${color})`,
          boxShadow: `0 0 8px ${color}88`,
        }}
      />
    </div>
  );
}

function ResultBadge({ result, durationSeconds }: { result: string; durationSeconds: number }) {
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

function TeamStrip({ players, align, label }: { players: PlayerSummary[]; align: 'left' | 'right'; label: string }) {
  const right = align === 'right';
  // Healers always sort last so the HPS row lines up at the bottom of each team.
  const ordered = [...players].sort((a, b) => (a.rateType === 'HPS' ? 1 : 0) - (b.rateType === 'HPS' ? 1 : 0));
  return (
    <div className={`flex-1 flex flex-col gap-2.5 py-4 ${right ? 'pr-5 pl-4' : 'pl-5 pr-4'}`}>
      <div
        className={`text-[10px] uppercase tracking-[0.12em] text-zinc-500 font-semibold mb-1 ${right ? 'text-right' : ''}`}
      >
        {label}
      </div>
      {ordered.map((p) => {
        const glyph = <ClassGlyph cls={p.cls} size="md" title={p.spec} />;
        const nameBlock = (
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
        );
        const rateBlock = (
          <div className={`flex flex-col leading-none ${right ? 'items-start' : 'items-end'}`}>
            <span
              className="font-mono tabular-nums text-[15px] font-semibold"
              style={{ color: p.rateType === 'HPS' ? '#7ee0a0' : '#ff8a7d' }}
            >
              {p.rate.toFixed(1)}k
            </span>
            <span className="text-[8.5px] uppercase tracking-[0.1em] text-zinc-600 font-semibold mt-1">
              {p.rateType}
            </span>
          </div>
        );
        const bar = <OutputBar rate={p.rate} baseline={p.baseline} type={p.rateType} right={right} />;
        return (
          <div key={p.name} className="flex items-center gap-2.5">
            {right ? (
              <>
                <div className="flex items-center gap-2.5">
                  {rateBlock}
                  {bar}
                </div>
                <div className="ml-auto flex items-center gap-2.5">
                  {nameBlock}
                  {glyph}
                </div>
              </>
            ) : (
              <>
                {glyph}
                {nameBlock}
                <div className="ml-auto flex items-center gap-2.5">
                  {bar}
                  {rateBlock}
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function MatchHero({ data }: { data: MatchAnalysisData }) {
  return (
    <div className="px-5 pt-5">
      <div className="rounded-lg border border-zinc-900 bg-gradient-to-b from-[#15151a] to-[#0e0e10] overflow-hidden">
        <div className="flex items-stretch">
          <TeamStrip players={data.friends} align="left" label="Your team" />
          <div className="shrink-0 flex items-center justify-center">
            <div className="flex flex-col items-center gap-3 py-4 px-6">
              <div className="flex items-center gap-2 text-[10.5px] uppercase tracking-[0.14em] text-zinc-500 font-semibold">
                <span className="px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-300">
                  {data.bracket}
                </span>
                <span>·</span>
                <span>{data.zone}</span>
              </div>
              <ResultBadge result={data.result} durationSeconds={data.durationSeconds} />
            </div>
          </div>
          <TeamStrip players={data.enemies} align="right" label="Enemy team" />
        </div>
      </div>
    </div>
  );
}

export { MatchHero };
