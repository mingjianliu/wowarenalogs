import { useMemo } from 'react';

import { fmtTime } from '../../../utils/cooldowns';
import { buildMatchupIntel } from '../../../utils/matchupIntel';
import { useCombatReportContext } from '../CombatReportContext';

export function MatchupIntel() {
  const { combat, friends, enemies } = useCombatReportContext();

  const card = useMemo(() => (combat ? buildMatchupIntel(combat, friends, enemies) : null), [combat, friends, enemies]);

  if (!combat || !card) return null;

  return (
    <div className="flex flex-col gap-4 pb-8">
      <div className="flex flex-row items-center gap-2">
        <h3 className="text-xl font-bold">vs {card.enemyComp.join(' / ')}</h3>
        {card.isWin !== null && (
          <span className={`badge ${card.isWin ? 'badge-success' : 'badge-error'}`}>{card.isWin ? 'Win' : 'Loss'}</span>
        )}
      </div>

      <section>
        <h4 className="font-bold mb-2">Their kill windows</h4>
        {card.hasBurstWindows ? (
          <div className="flex flex-col gap-2">
            {card.killWindows.map((w, i) => (
              <div key={i} className="card bg-base-200 p-3">
                <div className="flex flex-row items-center gap-2">
                  <span className="font-mono text-sm">
                    {fmtTime(w.fromSeconds)}–{fmtTime(w.toSeconds)}
                  </span>
                  <span
                    className={`badge ${
                      w.threatLabel === 'Critical'
                        ? 'badge-error'
                        : w.threatLabel === 'High'
                          ? 'badge-warning'
                          : 'badge-ghost'
                    }`}
                  >
                    {w.threatLabel}
                  </span>
                  {w.healerCCed && <span className="badge badge-outline">healer CCed</span>}
                  {w.dampeningPct > 0 && (
                    <span className="text-xs opacity-70">{Math.round(w.dampeningPct * 100)}% dampening</span>
                  )}
                </div>
                <div className="text-sm mt-1">
                  {w.activeCDs.map((cd) => `${cd.playerName}: ${cd.spellName}`).join(' + ')}
                </div>
                {w.holds.length > 0 && (
                  <div className="text-sm mt-2">
                    <span className="opacity-70 mr-2">Your defensives at window start:</span>
                    {w.holds.map((h) => (
                      <span
                        key={h.spellId}
                        className={`badge badge-sm mr-1 ${
                          h.castInWindow ? 'badge-primary' : h.availableAtWindowStart ? 'badge-success' : 'badge-ghost'
                        }`}
                        title={
                          h.castInWindow ? 'used in window' : h.availableAtWindowStart ? 'was available' : 'on cooldown'
                        }
                      >
                        {h.spellName}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="text-sm opacity-70">
            No aligned burst windows were detected in this match — the card below still lists every offensive cooldown
            they used.
          </div>
        )}
      </section>

      <section>
        <h4 className="font-bold mb-2">Their cooldown inventory (as used this match)</h4>
        {card.enemyCDInventory.length === 0 ? (
          <div className="text-sm opacity-70">No offensive cooldowns (≥30s) were cast by the enemy team.</div>
        ) : (
          card.enemyCDInventory.map((p) => (
            <div key={p.playerName} className="mb-2">
              <div className="font-semibold text-sm">
                {p.playerName} <span className="opacity-70">({p.specName})</span>
              </div>
              <div className="text-sm">
                {p.offensiveCDs.map((cd, i) => (
                  <span key={i} className="mr-3 font-mono text-xs">
                    {cd.spellName} @{fmtTime(cd.castTimeSeconds)} (CD {Math.round(cd.cooldownSeconds)}s)
                  </span>
                ))}
              </div>
            </div>
          ))
        )}
      </section>

      <section>
        <h4 className="font-bold mb-2">CC they put on your healer</h4>
        {card.ccOnHealer.length === 0 ? (
          <div className="text-sm opacity-70">No enemy CC landed on the friendly healer this match.</div>
        ) : (
          <div className="text-sm">
            {card.ccOnHealer.map((cc, i) => (
              <div key={i} className="font-mono text-xs">
                {fmtTime(cc.atSeconds)} — {cc.spellName}
                {cc.inKillWindow && <span className="badge badge-sm badge-warning ml-2">inside kill window</span>}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
