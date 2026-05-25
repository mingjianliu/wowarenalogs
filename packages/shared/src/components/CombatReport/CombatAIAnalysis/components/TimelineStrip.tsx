// Match timeline spine: enemy burst windows, your CD casts, finding markers, deaths.

import { fmtTime } from '../../../../utils/cooldowns';
import { AIFinding } from '../aiFindings';
import { MatchAnalysisData } from '../matchAnalysisData';

interface TimelineStripProps {
  data: MatchAnalysisData;
  findings: AIFinding[];
  activeFinding?: number;
  onFindingClick?: (rank: number) => void;
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
        <div className="text-[10.5px] text-zinc-500 tabular-nums">0:00 → {fmtTime(matchSeconds)}</div>
      </div>

      <svg viewBox={`0 0 ${W} 132`} className="w-full" preserveAspectRatio="none" style={{ height: 132 }}>
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
        <rect x={pad} y={20} width={innerW} height={92} rx="6" fill="url(#ai-damp-bg)" stroke="#1a1a1d" />

        {ticks.map((s) => (
          <g key={s}>
            <line
              x1={xAt(s)}
              y1={20}
              x2={xAt(s)}
              y2={112}
              stroke="#1d1d22"
              strokeWidth="1"
              strokeDasharray={s % (tickStep * 2) === 0 ? '' : '2 4'}
            />
            <text x={xAt(s)} y={128} fontSize="9.5" fill="#52525b" textAnchor="middle" fontFamily="var(--ai-font-mono)">
              {fmtTime(s)}
            </text>
          </g>
        ))}

        {/* enemy burst windows */}
        {data.burstWindows.map((b, i) => {
          const x = xAt(b.fromSeconds);
          const w = Math.max(6, xAt(b.toSeconds) - x);
          return (
            <g key={`burst-${i}`}>
              <rect
                x={x}
                y={22}
                width={w}
                height={88}
                fill="url(#ai-burst-grad)"
                stroke="rgba(255,90,74,0.5)"
                strokeWidth="1"
                rx="3"
              />
              <text x={x + 4} y={36} fontSize="9.5" fill="#ff8a7d" fontWeight="600" fontFamily="var(--ai-font-mono)">
                BURST {i + 1} · {b.dangerScore.toFixed(1)} {b.dangerLabel}
              </text>
              <text x={x + 4} y={48} fontSize="9" fill="#ff8a7d" opacity="0.7" fontFamily="var(--ai-font-mono)">
                {(b.damageInWindow / 1_000_000).toFixed(2)}M · damp {Math.round(b.dampeningPct * 100)}%
              </text>
            </g>
          );
        })}

        {/* your CD casts */}
        <text x={pad} y={72} fontSize="9.5" fill="#71717a" fontFamily="var(--ai-font-mono)">
          You
        </text>
        {data.ownerCDs.flatMap((cd) =>
          cd.casts.map((c, i) => {
            const x = xAt(c.timeSeconds);
            const reactive = c.timingLabel === 'Reactive';
            return (
              <g key={`${cd.spellName}-${i}`}>
                <line x1={x} y1={60} x2={x} y2={86} stroke={reactive ? '#fbbf6b' : '#a1a1aa'} strokeWidth="1.5" />
                <circle
                  cx={x}
                  cy={70}
                  r="3.5"
                  fill={reactive ? '#fbbf6b' : '#a1a1aa'}
                  stroke="#0c0c0e"
                  strokeWidth="1.5"
                />
                <text
                  x={x + 5}
                  y={67}
                  fontSize="8.5"
                  fill={reactive ? '#fbbf6b' : '#d4d4d8'}
                  fontFamily="var(--ai-font-mono)"
                >
                  {cd.spellName.split(' ')[0]}
                </text>
              </g>
            );
          }),
        )}

        {/* finding markers */}
        <text x={pad} y={14} fontSize="9.5" fill="#f9b13a" fontFamily="var(--ai-font-mono)" fontWeight="600">
          Findings
        </text>
        {findings.map((f) => {
          const x = xAt(f.atSeconds);
          const isActive = activeFinding === f.rank;
          return (
            <g key={f.rank} style={{ cursor: 'pointer' }} onClick={() => onFindingClick?.(f.rank)}>
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
              <line x1={x} y1={22} x2={x} y2={110} stroke={color} strokeWidth="1.5" strokeDasharray="3 2" />
              <circle cx={x} cy={102} r="4" fill={color} />
              <text x={x - 6} y={106} fontSize="9" fill={color} textAnchor="end" fontFamily="var(--ai-font-mono)">
                ☠ {d.spec}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
