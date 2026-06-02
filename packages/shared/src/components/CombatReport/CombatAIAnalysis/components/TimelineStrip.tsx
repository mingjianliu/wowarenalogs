import { fmtTime } from '../../../../utils/cooldowns';
import { MatchAnalysisData } from '../matchAnalysisData';

interface TimelineStripProps {
  data: MatchAnalysisData;
  findings: { rank: number; atSeconds: number }[];
  activeFinding: number;
  onFindingClick: (rank: number) => void;
}

export function TimelineStrip({ data, findings, activeFinding, onFindingClick }: TimelineStripProps) {
  const matchSeconds = Math.max(1, Math.ceil(data.durationSeconds));
  const pad = 16;
  const W = 1000;
  const innerW = W - pad * 2;
  const xAt = (s: number) => pad + (Math.min(Math.max(s, 0), matchSeconds) / matchSeconds) * innerW;

  const tickStep = matchSeconds > 240 ? 30 : 15;
  const ticks: number[] = [];
  for (let s = 0; s <= matchSeconds; s += tickStep) ticks.push(s);

  const deaths = [...data.friendlyDeaths, ...data.enemyDeaths];

  return (
    <div className="rounded-lg border border-zinc-900 bg-[#0c0c0e] p-4 mt-1">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="text-[11px] uppercase tracking-[0.12em] text-zinc-500 font-semibold">Match timeline</div>
          <div className="flex items-center gap-3 text-[10.5px] text-zinc-500">
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-sm" style={{ background: 'rgba(255,90,74,0.5)' }} />
              Enemy burst
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-sm bg-zinc-500" />
              Your CD
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-sm" style={{ background: '#f28c18' }} />
              Finding
            </span>
          </div>
        </div>
      </div>

      <svg viewBox={`0 0 ${W} 196`} className="w-full" preserveAspectRatio="none" style={{ height: 196 }}>
        <defs>
          <linearGradient id="ai-damp-bg" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#101015" />
            <stop offset="100%" stopColor="#1a1014" />
          </linearGradient>
          <linearGradient id="ai-burst-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(255,90,74,0.45)" />
            <stop offset="100%" stopColor="rgba(255,90,74,0.05)" />
          </linearGradient>
        </defs>
        <rect x={pad} y={20} width={innerW} height={118} rx="6" fill="url(#ai-damp-bg)" stroke="#1a1a1d" />

        {ticks.map((s) => (
          <g key={s}>
            <line
              x1={xAt(s)}
              y1={20}
              x2={xAt(s)}
              y2={138}
              stroke="#1d1d22"
              strokeWidth="1"
              strokeDasharray={s % (tickStep * 2) === 0 ? '' : '2 4'}
            />
            <text x={xAt(s)} y={151} fontSize="9.5" fill="#52525b" textAnchor="middle" fontFamily="var(--ai-font-mono)">
              {fmtTime(s)}
            </text>
          </g>
        ))}

        {/* enemy burst windows — colour only; danger + dampening read out below the plot */}
        {data.burstWindows.map((b, i) => {
          const x = xAt(b.fromSeconds);
          const w = Math.max(6, xAt(b.toSeconds) - x);
          const crit = b.dangerLabel === 'Critical';
          const meterColor = crit ? '#ff5a4a' : '#fbbf6b';
          const filled = crit ? 3 : 2; // visual danger level (no raw score)
          return (
            <g key={`burst-${i}`}>
              <rect
                x={x}
                y={22}
                width={w}
                height={114}
                fill="url(#ai-burst-grad)"
                stroke="rgba(255,90,74,0.5)"
                strokeWidth="1"
                rx="3"
              />
              {/* RISK lane: signal-strength meter + qualitative label */}
              {[0, 1, 2].map((bi) => {
                const bh = 4 + bi * 3;
                return (
                  <rect
                    key={bi}
                    x={x + bi * 5}
                    y={170 - bh}
                    width={3.5}
                    height={bh}
                    rx={1}
                    fill={bi < filled ? meterColor : 'none'}
                    stroke={meterColor}
                    strokeWidth="0.75"
                    opacity={bi < filled ? 1 : 0.3}
                  />
                );
              })}
              <text
                x={x + 18}
                y={169}
                fontSize="9.5"
                fill={meterColor}
                fontWeight="600"
                fontFamily="var(--ai-font-mono)"
              >
                {b.dangerLabel}
              </text>
              {/* DAMP lane */}
              <text x={x} y={186} fontSize="9" fill="#9ca3af" fontFamily="var(--ai-font-mono)">
                {Math.round(b.dampeningPct * 100)}% damp
              </text>
            </g>
          );
        })}

        {/* lane labels */}
        <text x={pad} y={14} fontSize="9.5" fill="#f9b13a" fontFamily="var(--ai-font-mono)" fontWeight="600">
          Findings
        </text>
        <text x={pad} y={102} fontSize="9.5" fill="#71717a" fontFamily="var(--ai-font-mono)">
          You
        </text>
        <text x={pad} y={169} fontSize="8.5" fill="#52525b" fontFamily="var(--ai-font-mono)" letterSpacing="0.5">
          RISK
        </text>
        <text x={pad} y={186} fontSize="8.5" fill="#52525b" fontFamily="var(--ai-font-mono)" letterSpacing="0.5">
          DAMP
        </text>

        {/* finding markers */}
        {findings.map((f) => {
          const x = xAt(f.atSeconds);
          const isActive = activeFinding === f.rank;
          return (
            <g key={f.rank} style={{ cursor: 'pointer' }} onClick={() => onFindingClick(f.rank)}>
              <line x1={x} y1={14} x2={x} y2={20} stroke="#f28c18" strokeWidth="1.5" />
              <circle
                cx={x}
                cy={10}
                r={isActive ? 8 : 6.5}
                fill={isActive ? '#f9b13a' : '#f28c18'}
                stroke={isActive ? '#fff8e6' : '#0c0c0e'}
                strokeWidth="2"
              />
              <text
                x={x}
                y={13.5}
                fontSize="9"
                fill="#1a0d00"
                fontWeight="700"
                textAnchor="middle"
                fontFamily="var(--ai-font-display)"
              >
                {f.rank}
              </text>
            </g>
          );
        })}

        {/* death markers */}
        {deaths.map((d, i) => {
          const x = xAt(d.atSeconds);
          const color = d.side === 'enemy' ? '#7ee0a0' : '#ff5a4a';
          return (
            <g key={`death-${i}`}>
              <line x1={x} y1={22} x2={x} y2={136} stroke={color} strokeWidth="1.5" strokeDasharray="3 2" />
              <circle cx={x} cy={126} r="4" fill={color} />
              <text x={x - 6} y={130} fontSize="9" fill={color} textAnchor="end" fontFamily="var(--ai-font-mono)">
                ☠ {d.spec}
              </text>
            </g>
          );
        })}

        {/* your CD casts — rendered LAST so the opaque chips sit on top of every grid/death line */}
        {(() => {
          const abbr = (name: string) => (name.includes(':') ? name.split(':')[1].trim() : name);
          const casts = data.ownerCDs
            .flatMap((cd) => cd.casts.map((c) => ({ ...c, spellName: cd.spellName })))
            .sort((a, b) => a.timeSeconds - b.timeSeconds);
          let prevRight = -Infinity;
          let level = 0;
          const ROWS = [36, 62]; // chip top positions, both above the You marker row
          return casts.map((c, i) => {
            const x = xAt(c.timeSeconds);
            const label = abbr(c.spellName);
            const w = label.length * 6 + 16;
            const chipX = x + 7;
            if (chipX < prevRight + 6) level = (level + 1) % ROWS.length;
            else level = 0;
            prevRight = chipX + w;
            const chipY = ROWS[level];
            const reactive = c.timingLabel === 'Reactive';
            const tickColor = reactive ? '#fbbf6b' : '#cbd5e1';
            return (
              <g key={`${c.spellName}-${i}`}>
                <line x1={x} y1={86} x2={x} y2={120} stroke={tickColor} strokeWidth="1.5" />
                <circle cx={x} cy={100} r="3.5" fill={tickColor} stroke="#0c0c0e" strokeWidth="1.5" />
                <line x1={x} y1={chipY + 15} x2={x} y2={98} stroke={tickColor} strokeWidth="1" opacity="0.45" />
                <rect
                  x={chipX}
                  y={chipY}
                  width={w}
                  height={15}
                  rx="3.5"
                  fill="#09090b"
                  stroke={tickColor}
                  strokeOpacity="0.75"
                  strokeWidth="1"
                />
                <text
                  x={chipX + 7}
                  y={chipY + 10.5}
                  fontSize="9.5"
                  fill={reactive ? '#fbbf6b' : '#f4f4f5'}
                  fontWeight="500"
                  fontFamily="var(--ai-font-mono)"
                >
                  {label}
                </text>
              </g>
            );
          });
        })()}
      </svg>
    </div>
  );
}
