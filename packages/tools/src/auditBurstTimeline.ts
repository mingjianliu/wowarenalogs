/* eslint-disable no-console */
// Deterministic audit of the enemy-CD timeline / burst-window / defensive-timing pipeline.
// Quantifies the suspected biases across the full user corpus before fixing anything.
import { CombatUnitReaction, CombatUnitType, ICombatUnit, LogEvent } from '@wowarenalogs/parser';
import fs from 'fs-extra';
import path from 'path';

import spellsData from '../../shared/src/data/spells.json';
import {
  annotateDefensiveTimings,
  extractMajorCooldowns,
  IEnemyCDTimelineForTiming,
  isHealerSpec,
} from '../../shared/src/utils/cooldowns';
import { reconstructEnemyCDTimeline } from '../../shared/src/utils/enemyCDs';
import { parseLogText } from './printMatchPrompts';

const LOGS = '/Users/mingjianliu/code/wowarenalogs/scratch/user-logs/wow';
const SPELLS = spellsData as Record<string, { type: string }>;

async function main() {
  const files = (await fs.readdir(LOGS)).filter((f) => f.endsWith('.txt'));
  let games = 0;
  let totalWindows = 0;
  // #1 duration-missing truncation
  let truncatedWindows = 0;
  const truncSpells = new Map<string, number>();
  // #1b suspicious Late labels
  let lateTotal = 0;
  let lateNearTruncated = 0;
  // #2 damage sampling mismatch
  let longWindows = 0;
  let dmgMismatch25 = 0;
  let ratioSum = 0;
  let ratioN = 0;
  // #3 pseudo-CC share
  let ccWindows = 0;
  let pseudoCC = 0;
  // #4 CDR violations (recast earlier than static CD predicts)
  let cdrViolations = 0;
  const cdrSpells = new Map<string, number>();
  // #5 missed buff-overlap pairs (cast gap >10s but buffs overlap >=3s)
  let missedOverlapPairs = 0;
  let gamesWithMissedOverlap = 0;
  // #6 zero-window games with real threat
  let zeroWindowThreatGames = 0;

  for (const f of files) {
    const combats = await parseLogText(await fs.readFile(path.join(LOGS, f), 'utf8'));
    for (const combat of combats) {
      const units = Object.values(combat.units) as ICombatUnit[];
      const friends = units.filter(
        (u) => u.type === CombatUnitType.Player && u.reaction === CombatUnitReaction.Friendly,
      );
      const enemies = units.filter(
        (u) => u.type === CombatUnitType.Player && u.reaction === CombatUnitReaction.Hostile,
      );
      const owner = friends.find((u) => isHealerSpec(u.spec));
      if (!owner) continue;
      games++;
      const matchStartMs = combat.startTime;
      const tl = reconstructEnemyCDTimeline(enemies, combat, owner, friends);
      totalWindows += tl.alignedBurstWindows.length;

      const allCasts = tl.players.flatMap((p) => p.offensiveCDs.map((cd) => ({ ...cd, playerName: p.playerName })));

      // #1 truncated windows: window end coincides with a duration-less cast's cast time
      const truncated = new Set<number>();
      tl.alignedBurstWindows.forEach((w, wi) => {
        const ender = allCasts.find(
          (c) => Math.abs(c.buffEndSeconds - w.toSeconds) < 0.01 && c.buffEndSeconds === c.castTimeSeconds,
        );
        if (ender) {
          truncated.add(wi);
          truncatedWindows++;
          truncSpells.set(ender.spellName, (truncSpells.get(ender.spellName) ?? 0) + 1);
        }
      });

      // #1b Late labels near truncated windows
      const cds = extractMajorCooldowns(owner, combat);
      annotateDefensiveTimings(cds, owner, combat, tl as unknown as IEnemyCDTimelineForTiming);
      for (const cd of cds) {
        for (const cast of cd.casts) {
          if (cast.timingLabel !== 'Late') continue;
          lateTotal++;
          const t = cast.timeSeconds;
          const isNearTrunc = tl.alignedBurstWindows.some(
            (w, wi) => truncated.has(wi) && t > w.toSeconds && t <= w.toSeconds + 8,
          );
          if (isNearTrunc) lateNearTruncated++;
        }
      }

      // #2 damage sampling mismatch (±10s around start vs actual [start,end] span)
      const allDmg = friends.flatMap((u) => u.damageIn);
      for (const w of tl.alignedBurstWindows) {
        const span = w.toSeconds - w.fromSeconds;
        if (span > 10) longWindows++;
        const dmgIn = (a: number, b: number) =>
          allDmg
            .filter((e) => {
              const t = (e.logLine.timestamp - matchStartMs) / 1000;
              return t >= a && t <= b;
            })
            .reduce((s, e) => s + Math.abs(e.effectiveAmount), 0);
        const sampled = dmgIn(w.fromSeconds - 10, w.fromSeconds + 10);
        const actual = dmgIn(w.fromSeconds, w.toSeconds);
        if (actual > 0 || sampled > 0) {
          const ratio = actual > 0 ? sampled / actual : 2;
          ratioSum += ratio;
          ratioN++;
          if (ratio > 1.25 || ratio < 0.8) dmgMismatch25++;
        }
      }

      // #3 pseudo-CC share: healerCCed windows without a real CC aura overlap
      for (const w of tl.alignedBurstWindows) {
        if (!w.healerCCed) continue;
        ccWindows++;
        const wStartMs = matchStartMs + w.fromSeconds * 1000;
        const wEndMs = matchStartMs + w.toSeconds * 1000;
        let auraCC = false;
        const ccStart = new Map<string, number>();
        for (const a of owner.auraEvents) {
          if (!a.spellId || SPELLS[a.spellId]?.type !== 'cc') continue;
          const ev = a.logLine.event;
          if (ev === LogEvent.SPELL_AURA_APPLIED || ev === LogEvent.SPELL_AURA_REFRESH) {
            ccStart.set(a.spellId, a.logLine.timestamp);
          } else if (
            ev === LogEvent.SPELL_AURA_REMOVED ||
            ev === LogEvent.SPELL_AURA_BROKEN ||
            ev === LogEvent.SPELL_AURA_BROKEN_SPELL
          ) {
            const s = ccStart.get(a.spellId) ?? 0;
            if (s > 0 && s < wEndMs && a.logLine.timestamp > wStartMs) {
              auraCC = true;
              break;
            }
            ccStart.delete(a.spellId);
          }
        }
        if (!auraCC) pseudoCC++;
      }

      // #4 CDR violations: same enemy+spell recast before static CD elapsed (2s tolerance)
      for (const p of tl.players) {
        const bySpell = new Map<string, typeof p.offensiveCDs>();
        for (const c of p.offensiveCDs) {
          const arr = bySpell.get(c.spellId) ?? [];
          arr.push(c);
          bySpell.set(c.spellId, arr);
        }
        for (const [, casts] of bySpell) {
          for (let i = 1; i < casts.length; i++) {
            if (casts[i].castTimeSeconds < casts[i - 1].castTimeSeconds + casts[i - 1].cooldownSeconds - 2) {
              cdrViolations++;
              cdrSpells.set(casts[i].spellName, (cdrSpells.get(casts[i].spellName) ?? 0) + 1);
            }
          }
        }
      }

      // #5 missed buff-overlap pairs: casts >10s apart whose buffs still overlap >=3s
      const sorted = [...allCasts].sort((a, b) => a.castTimeSeconds - b.castTimeSeconds);
      let missedHere = 0;
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          const gap = sorted[j].castTimeSeconds - sorted[i].castTimeSeconds;
          if (gap <= 10) continue;
          if (gap > 60) break;
          const overlap = Math.min(sorted[i].buffEndSeconds, sorted[j].buffEndSeconds) - sorted[j].castTimeSeconds;
          if (overlap >= 3) missedHere++;
        }
      }
      if (missedHere > 0) {
        missedOverlapPairs += missedHere;
        gamesWithMissedOverlap++;
      }

      // #6 zero-window games with >=2 enemy CD casts and a friendly death
      const friendlyDeaths = friends.reduce((s, u) => s + u.deathRecords.length, 0);
      if (tl.alignedBurstWindows.length === 0 && allCasts.length >= 2 && friendlyDeaths > 0) {
        zeroWindowThreatGames++;
      }
    }
  }

  const top = (m: Map<string, number>) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([k, v]) => `${k}:${v}`)
      .join(', ');

  console.log(`games(healer): ${games} | burst windows: ${totalWindows}`);
  console.log(
    `#1 truncated windows (duration-less ender): ${truncatedWindows}/${totalWindows} | top: ${top(truncSpells)}`,
  );
  console.log(`#1b Late labels: ${lateTotal} | Late adjacent to truncated window (suspect): ${lateNearTruncated}`);
  console.log(
    `#2 long windows(>10s): ${longWindows}/${totalWindows} | sampled/actual dmg mean ratio: ${(ratioSum / Math.max(ratioN, 1)).toFixed(2)} | windows off by >25%: ${dmgMismatch25}/${ratioN}`,
  );
  console.log(
    `#3 healerCCed windows: ${ccWindows} | pseudo-CC (no aura, zero-cast fallback): ${pseudoCC} (${((pseudoCC / Math.max(ccWindows, 1)) * 100).toFixed(0)}%)`,
  );
  console.log(`#4 CDR violations (recast early): ${cdrViolations} | top: ${top(cdrSpells)}`);
  console.log(
    `#5 missed buff-overlap pairs (gap>10s, overlap>=3s): ${missedOverlapPairs} in ${gamesWithMissedOverlap} games`,
  );
  console.log(`#6 zero-window games with >=2 CD casts + a death: ${zeroWindowThreatGames}/${games}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
