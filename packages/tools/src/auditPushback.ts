/* eslint-disable no-console */
// Verify the user's 4 pushbacks against the coaching findings, deterministically:
// 1) Chain Heal (1064) on Shaman: proc'd by totems (no SPELL_CAST_START) vs hardcast — if mostly
//    proc'd, the "Chain Heal defaulted to self" finding blamed non-decisions.
// 2) Pre-CC credit: signature "dumped early" CDs (HTT/Divine Hymn/Chi-Ji) followed within 5s by
//    hard CC APPLIED on the owner — those "early" casts were insurance before a telegraphed lockout.
// 3) Rescue (370665): share of casts where the rescued ally lost a root/snare within 1.5s (offensive
//    utility value the HP-based model can't see).
import { CombatUnitReaction, CombatUnitType, ICombatUnit, LogEvent } from '@wowarenalogs/parser';
import fs from 'fs-extra';
import path from 'path';

import spellsData from '../../shared/src/data/spells.json';
import { isHealerSpec, specToString } from '../../shared/src/utils/cooldowns';
import { parseLogText } from './printMatchPrompts';

const LOGS = '/Users/mingjianliu/code/wowarenalogs/scratch/user-logs/wow';
const SPELLS = spellsData as Record<string, { type: string }>;
const SIG_CDS: Record<string, string> = { '108280': 'HealingTide', '64843': 'DivineHymn', '325197': 'ChiJi' };

async function main() {
  console.log('spells.json types:', [...new Set(Object.values(SPELLS).map((s) => s.type))].join(','));
  const files = (await fs.readdir(LOGS)).filter((f) => f.endsWith('.txt'));
  let chProc = 0,
    chHard = 0,
    chProcAfterTotem = 0;
  const preCC: Record<string, { total: number; ccSoon: number }> = {};
  let rescueTotal = 0,
    rescueRootBreak = 0,
    rescueTargetLowHp = 0;

  for (const f of files) {
    const combats = await parseLogText(await fs.readFile(path.join(LOGS, f), 'utf8'));
    for (const combat of combats) {
      const units = Object.values(combat.units) as ICombatUnit[];
      const friends = units.filter(
        (u) => u.type === CombatUnitType.Player && u.reaction === CombatUnitReaction.Friendly,
      );
      const owner = friends.find((u) => isHealerSpec(u.spec));
      if (!owner) continue;
      const spec = specToString(owner.spec);
      const casts = owner.spellCastEvents;

      // 1) Chain Heal proc vs hardcast (Shaman only)
      if (spec === 'Restoration Shaman') {
        const starts = casts.filter((e) => e.spellId === '1064' && e.logLine.event === LogEvent.SPELL_CAST_START);
        const totemCasts = casts.filter(
          (e) => e.logLine.event === LogEvent.SPELL_CAST_SUCCESS && /Totem|图腾/.test(e.spellName ?? ''),
        );
        for (const e of casts) {
          if (e.spellId !== '1064' || e.logLine.event !== LogEvent.SPELL_CAST_SUCCESS) continue;
          const hasStart = starts.some(
            (s) => e.logLine.timestamp - s.logLine.timestamp >= 0 && e.logLine.timestamp - s.logLine.timestamp < 4000,
          );
          if (hasStart) chHard++;
          else {
            chProc++;
            if (totemCasts.some((t) => Math.abs(e.logLine.timestamp - t.logLine.timestamp) < 2000)) chProcAfterTotem++;
          }
        }
      }

      // 2) Pre-CC credit on signature CDs
      for (const e of casts) {
        if (e.logLine.event !== LogEvent.SPELL_CAST_SUCCESS || !e.spellId || !(e.spellId in SIG_CDS)) continue;
        const key = SIG_CDS[e.spellId];
        preCC[key] = preCC[key] ?? { total: 0, ccSoon: 0 };
        preCC[key].total++;
        const ccSoon = owner.auraEvents.some(
          (a) =>
            a.spellId &&
            SPELLS[a.spellId]?.type === 'cc' &&
            a.logLine.event === LogEvent.SPELL_AURA_APPLIED &&
            a.logLine.timestamp - e.logLine.timestamp >= 0 &&
            a.logLine.timestamp - e.logLine.timestamp <= 5000,
        );
        if (ccSoon) preCC[key].ccSoon++;
      }

      // 3) Rescue utility (Evoker only)
      if (spec === 'Preservation Evoker') {
        for (const e of casts) {
          if (e.spellId !== '370665' || e.logLine.event !== LogEvent.SPELL_CAST_SUCCESS) continue;
          rescueTotal++;
          const ally = friends.find((u) => u.id === e.destUnitId);
          if (!ally) continue;
          const rootGone = ally.auraEvents.some(
            (a) =>
              a.spellId &&
              /root|snare|cc/.test(SPELLS[a.spellId]?.type ?? '') &&
              (a.logLine.event === LogEvent.SPELL_AURA_REMOVED || a.logLine.event === LogEvent.SPELL_AURA_BROKEN) &&
              a.logLine.timestamp - e.logLine.timestamp >= 0 &&
              a.logLine.timestamp - e.logLine.timestamp <= 1500,
          );
          if (rootGone) rescueRootBreak++;
          const hp = ally.advancedActions.find((x) => Math.abs(x.logLine.timestamp - e.logLine.timestamp) < 3000);
          if (hp && hp.advancedActorMaxHp > 0 && hp.advancedActorCurrentHp / hp.advancedActorMaxHp < 0.6)
            rescueTargetLowHp++;
        }
      }
    }
  }

  console.log(
    `1) Chain Heal (Shaman): hardcast(with CAST_START)=${chHard} | instant/proc=${chProc} (of which within 2s of a totem: ${chProcAfterTotem})`,
  );
  for (const [k, v] of Object.entries(preCC))
    console.log(
      `2) ${k}: casts=${v.total} | owner hard-CCed within 5s after cast=${v.ccSoon} (${((v.ccSoon / Math.max(v.total, 1)) * 100).toFixed(0)}%)`,
    );
  console.log(
    `3) Rescue (Evoker): total=${rescueTotal} | root/snare removed on ally <=1.5s=${rescueRootBreak} | ally <60% HP=${rescueTargetLowHp}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
