// Right-rail supporting data drawers — what the analyzer saw, summarized from
// the same computed match data the prompt is built from.

import { ReactNode, useMemo, useState } from 'react';

import { fmtTime } from '../../../../utils/cooldowns';
import { ClassKey, MatchAnalysisData } from '../matchAnalysisData';
import { BoltIcon, CCIcon, ChevronDown, ClassGlyph, PurgeIcon, ShieldIcon, SwordIcon, TimePill } from './icons';

function Drawer({
  title,
  count,
  icon,
  accent,
  defaultOpen = true,
  hint,
  children,
}: {
  title: string;
  count?: string | number;
  icon: ReactNode;
  accent?: string;
  defaultOpen?: boolean;
  hint?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rounded-lg border border-zinc-900 bg-[#0c0c0e] overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2.5 px-3.5 py-2.5 hover:bg-zinc-900/40 transition text-left"
      >
        <span style={{ color: accent || '#a1a1aa' }} className="shrink-0">
          {icon}
        </span>
        <span className="text-[12px] font-semibold tracking-tight text-zinc-200 flex-1">{title}</span>
        {count !== undefined && (
          <span className="text-[10.5px] text-zinc-500 tabular-nums px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800">
            {count}
          </span>
        )}
        <ChevronDown size={13} className={`text-zinc-500 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="border-t border-zinc-900 px-3.5 py-3">
          {hint && <div className="text-[10.5px] text-zinc-500 mb-2.5">{hint}</div>}
          {children}
        </div>
      )}
    </section>
  );
}

export function SupportingRail({ data }: { data: MatchAnalysisData }) {
  const classOf = useMemo(() => {
    const map = new Map<string, ClassKey>();
    [...data.friends, ...data.enemies].forEach((p) => map.set(p.name, p.cls));
    return map;
  }, [data]);

  const usedCDs = data.ownerCDs.filter((cd) => !cd.neverUsed).length;
  const criticalPurges = data.missedPurges.filter((p) => p.priority === 'Critical').length;
  const ccEvents = data.ownerTrinket?.ccInstances ?? [];
  const flaggedCC = ccEvents.filter((e) => e.trinketState === 'available_unused' && e.damageTakenDuring > 0);

  return (
    <div className="flex flex-col gap-2.5">
      <div className="text-[10px] uppercase tracking-[0.14em] text-zinc-600 font-semibold pl-1">Source data</div>

      <Drawer
        title="Enemy aligned burst windows"
        count={data.burstWindows.length}
        icon={<BoltIcon size={14} />}
        accent="#ff8a7d"
        hint="Stacked enemy offensive CDs — score weights CD danger × damage × dampening."
      >
        {data.burstWindows.length === 0 ? (
          <div className="text-[11.5px] text-zinc-600">No aligned burst windows detected.</div>
        ) : (
          <div className="flex flex-col gap-2">
            {data.burstWindows.map((b, i) => (
              <div key={i} className="rounded-md border border-zinc-900 bg-[#0a0a0c] p-2.5">
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2">
                    <TimePill secs={b.fromSeconds} />
                    <span
                      className="text-[10px] font-bold uppercase tracking-[0.08em] px-1.5 py-0.5 rounded"
                      style={{
                        color: b.dangerLabel === 'Critical' ? '#ff5a4a' : '#fbbf6b',
                        background: b.dangerLabel === 'Critical' ? 'rgba(255,90,74,0.1)' : 'rgba(251,191,107,0.1)',
                        border: `1px solid ${b.dangerLabel === 'Critical' ? 'rgba(255,90,74,0.3)' : 'rgba(251,191,107,0.3)'}`,
                      }}
                    >
                      {b.dangerLabel} · {b.dangerScore.toFixed(1)}
                    </span>
                  </div>
                  <div className="text-[10.5px] text-zinc-500 tabular-nums">
                    {(b.damageInWindow / 1_000_000).toFixed(2)}M · damp {Math.round(b.dampeningPct * 100)}%
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  {b.activeCDs.map((c, j) => (
                    <div key={j} className="flex items-center gap-2 text-[11.5px] text-zinc-400 min-w-0">
                      <span className="w-1 h-1 rounded-full bg-zinc-600 shrink-0" />
                      <span className="text-zinc-300 whitespace-nowrap shrink-0">{c.spellName}</span>
                      <span className="text-[10px] text-zinc-600 ml-auto shrink-0 truncate">{c.playerName}</span>
                    </div>
                  ))}
                </div>
                <div className="text-[10.5px] text-zinc-500 mt-1.5">
                  Healer: <span className="text-zinc-400">{b.healerCCed ? 'CC’d' : 'free to cast'}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Drawer>

      <Drawer
        title="Missed offensive purges"
        count={data.missedPurges.length}
        icon={<PurgeIcon size={14} />}
        accent="#60a5fa"
        hint={data.ownerCanPurge ? `${criticalPurges} critical` : 'Log owner cannot offensive purge — context only.'}
        defaultOpen={data.missedPurges.length > 0}
      >
        {data.missedPurges.length === 0 ? (
          <div className="text-[11.5px] text-zinc-600">No missed purge windows.</div>
        ) : (
          <div className="flex flex-col gap-1">
            {data.missedPurges.map((p, i) => (
              <div key={i} className="flex items-center gap-2 text-[11.5px] py-1">
                <TimePill secs={p.timeSeconds} />
                <ClassGlyph cls={classOf.get(p.enemyName) ?? 'unknown'} size="sm" />
                <span className="text-zinc-300 truncate">{p.spellName}</span>
                <span
                  className="ml-auto text-[10px] tabular-nums"
                  style={{ color: p.priority === 'Critical' ? '#ff5a4a' : '#fbbf6b' }}
                >
                  {p.priority} · {Math.round(p.durationSeconds)}s
                </span>
              </div>
            ))}
          </div>
        )}
      </Drawer>

      <Drawer
        title="CC & trinket usage"
        count={ccEvents.length}
        icon={<CCIcon size={14} />}
        accent="#a78bfa"
        defaultOpen={false}
        hint={
          data.ownerTrinket
            ? `Trinket: ${data.ownerTrinket.trinketType} — ${data.ownerTrinket.trinketUseTimes.length} casts. ${flaggedCC.length} flagged.`
            : undefined
        }
      >
        {ccEvents.length === 0 ? (
          <div className="text-[11.5px] text-zinc-600">No hard CC on the log owner.</div>
        ) : (
          <div className="flex flex-col gap-1">
            {ccEvents.map((e, i) => {
              const flagged = e.trinketState === 'available_unused' && e.damageTakenDuring > 0;
              return (
                <div key={i} className={`flex items-center gap-2 text-[11.5px] py-1 ${flagged ? '' : 'opacity-70'}`}>
                  <TimePill secs={e.atSeconds} />
                  <ClassGlyph cls={classOf.get(e.sourceName) ?? 'unknown'} size="sm" />
                  <span className="text-zinc-300 truncate flex-1">{e.spellName}</span>
                  <span className="text-[10px] tabular-nums text-zinc-500">{e.durationSeconds.toFixed(1)}s</span>
                  {flagged && (
                    <span className="text-[9.5px] uppercase tracking-wider font-semibold" style={{ color: '#ff5a4a' }}>
                      ⚠
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Drawer>

      <Drawer title="Enemy CD timeline" icon={<SwordIcon size={14} />} accent="#ff8a7d" defaultOpen={false}>
        <div className="flex flex-col gap-2.5">
          {data.enemyCDs.map((e, i) => (
            <div key={i}>
              <div className="flex items-center gap-2 mb-1">
                <ClassGlyph cls={classOf.get(e.playerName) ?? 'unknown'} size="sm" />
                <span className="text-[11.5px] text-zinc-300 font-medium">{e.specName}</span>
                <span className="text-[10.5px] text-zinc-600 ml-auto truncate">{e.playerName}</span>
              </div>
              {e.offensiveCDs.map((cd, j) => (
                <div key={j} className="ml-7 mb-1.5">
                  <div className="text-[11px] text-zinc-400">
                    {cd.spellName} <span className="text-zinc-600">· {cd.cooldownSeconds}s</span>
                  </div>
                  <div className="flex gap-1.5 mt-0.5 flex-wrap">
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded font-mono tabular-nums"
                      style={{
                        background: 'rgba(255,90,74,0.08)',
                        color: '#ff8a7d',
                        border: '1px solid rgba(255,90,74,0.25)',
                      }}
                    >
                      {fmtTime(cd.castTimeSeconds)}–{fmtTime(cd.buffEndSeconds)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </Drawer>

      <Drawer
        title="Your major cooldowns"
        count={`${usedCDs}/${data.ownerCDs.length}`}
        icon={<ShieldIcon size={14} />}
        accent="#f9b13a"
        defaultOpen={false}
      >
        <div className="flex flex-col gap-2.5">
          {data.ownerCDs.map((cd, i) => (
            <div key={i}>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[11.5px] font-medium text-zinc-300">{cd.spellName}</span>
                <span className="text-[10px] text-zinc-600">
                  · {cd.tag} · {cd.cooldownSeconds}s
                </span>
                {cd.neverUsed && (
                  <span
                    className="text-[9.5px] uppercase tracking-wider px-1.5 py-0.5 rounded ml-auto font-semibold"
                    style={{
                      background: 'rgba(255,90,74,0.1)',
                      color: '#ff5a4a',
                      border: '1px solid rgba(255,90,74,0.3)',
                    }}
                  >
                    Never used
                  </span>
                )}
              </div>
              {!cd.neverUsed && (
                <div className="flex gap-1.5 ml-0.5 flex-wrap">
                  {cd.casts.map((c, k) => {
                    const reactive = c.timingLabel === 'Reactive';
                    return (
                      <span
                        key={k}
                        className={`text-[10px] px-1.5 py-0.5 rounded font-mono tabular-nums ${reactive ? 'border' : ''}`}
                        style={
                          reactive
                            ? {
                                background: 'rgba(251,191,107,0.08)',
                                color: '#fbbf6b',
                                borderColor: 'rgba(251,191,107,0.3)',
                              }
                            : { background: '#1a1a1d', color: '#d4d4d8' }
                        }
                      >
                        {fmtTime(c.timeSeconds)}
                        {reactive ? ' · reactive' : ''}
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      </Drawer>
    </div>
  );
}
