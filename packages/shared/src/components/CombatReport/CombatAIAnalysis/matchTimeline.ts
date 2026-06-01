import { ICombatUnit } from '@wowarenalogs/parser';

import { spellEffectData } from '../../../data/spellEffectData';
import { ccSpellIds } from '../../../data/spellTags';
import { IPlayerCCTrinketSummary } from '../../../utils/ccTrinketAnalysis';
import { IFormInterval, IStasisEvent } from '../../../utils/combatStates';
import { fmtTime, getUnitHpAtTimestamp, IMajorCooldownInfo } from '../../../utils/cooldowns';
import { IDispelSummary } from '../../../utils/dispelAnalysis';
import { IPlayerOutgoingCCChain } from '../../../utils/drAnalysis';
import { extractEnemyMajorBuffIntervals } from '../../../utils/enemyCDs';
import { IFriendlyDeathRecord } from '../../../utils/healingGaps';
import { IPlayerPressureWindow } from '../../../utils/offensiveWindows';

export interface BuildMatchTimelineParams {
  owner: ICombatUnit;
  ownerSpec: string;
  ownerCDs: IMajorCooldownInfo[];
  teammateCDs: Array<{ player: ICombatUnit; spec: string; cds: IMajorCooldownInfo[] }>;
  enemyCDTimeline: {
    alignedBurstWindows: IPlayerPressureWindow[];
  };
  ccTrinketSummaries: IPlayerCCTrinketSummary[];
  dispelSummary: IDispelSummary;
  friendlyDeaths: IFriendlyDeathRecord[];
  enemyDeaths: Array<{ spec: string; name: string; atSeconds: number }>;
  pressureWindows: IPlayerPressureWindow[];
  healingGaps: {
    from: number;
    to: number;
    reason: string;
  }[];
  friends: ICombatUnit[];
  enemies: ICombatUnit[];
  allUnits?: ICombatUnit[];
  matchStartMs: number;
  matchEndMs: number;
  isHealer: boolean;
  playerIdMap?: Map<string, number | string>;
  enemyIdMap?: Map<string, number | string>;
  outgoingCCChains: IPlayerOutgoingCCChain[];
  resourceSnapshotFn?: (params: ResourceSnapshotParams) => string;
  bracket?: string;
  gateCcAvoidanceToDanger?: boolean;
  stasisEvents?: IStasisEvent[];
  shapeshiftIntervals?: Array<{ player: ICombatUnit; intervals: IFormInterval[] }>;
  stateFormat?: 'inline' | 'summary' | 'verbose';
}

export function buildMatchTimeline(params: BuildMatchTimelineParams): string {
  const {
    owner,
    ownerSpec,
    ownerCDs,
    teammateCDs,
    enemyCDTimeline,
    ccTrinketSummaries,
    friendlyDeaths,
    enemyDeaths,
    pressureWindows,
    healingGaps,
    friends,
    enemies,
    matchStartMs,
    matchEndMs,
    isHealer,
    playerIdMap,
    enemyIdMap,
    resourceSnapshotFn,
    bracket,
    gateCcAvoidanceToDanger,
    stasisEvents = [],
    shapeshiftIntervals = [],
    stateFormat = 'summary',
  } = params;

  const enemyBuffIntervals = extractEnemyMajorBuffIntervals(enemies ?? [], matchStartMs, matchEndMs);

  // F143: Pre-calculate Grounding Totem absorbs
  const groundingTotemAbsorbs = new Map<number, string>(); // timestamp => absorbedSpellName
  for (const combatant of [...friends, ...enemies]) {
    for (const action of combatant.absorbsIn) {
      if (action.actionId === '204050') {
        // Grounding Totem
        groundingTotemAbsorbs.set(action.logLine.timestamp, action.spellName);
      }
    }
  }

  // Set up lookup functions for quick access to friendly/enemy IDs in the timeline.
  // Note: playerIds are 1-indexed, enemyIds are A,B,C...
  const pid = playerIdMap
    ? (name: string) => playerIdMap.get(name) ?? name
    : (name: string) => {
        const p = friends.find((f) => f.name === name);
        if (p) {
          const idx = friends.indexOf(p);
          return idx === -1 ? name : idx + 1;
        }
        return name;
      };

  const enemyPid = enemyIdMap
    ? (name: string) => enemyIdMap.get(name) ?? name
    : (name: string) => {
        const e = enemies.find((en) => en.name === name);
        if (e) {
          const idx = enemies.indexOf(e);
          return idx === -1 ? name : String.fromCharCode(65 + idx);
        }
        return name;
      };

  const addEntry = (timeSeconds: number, text: string, resourceText?: string) => {
    entries.push({ timeSeconds, text, resourceText });
  };

  const entries: Array<{ timeSeconds: number; text: string; resourceText?: string }> = [];

  // ── [YOU] CD events ───────────────────────────────────────────────────────
  for (const cd of ownerCDs) {
    if (cd.neverUsed) continue;
    for (const cast of cd.casts) {
      const timeSeconds = (cast.logLine.timestamp - matchStartMs) / 1000;
      const targetPart = cast.targetName ? ` → on: ${pid(cast.targetName)}` : '';
      const totemNote = groundingTotemAbsorbs.has(cast.logLine.timestamp)
        ? ` [ABSORBED: ${groundingTotemAbsorbs.get(cast.logLine.timestamp)}]`
        : '';
      addEntry(
        timeSeconds,
        `${fmtTime(timeSeconds)}  [YOU] [CD]   ${cd.spellName}${targetPart}${totemNote}`,
        resourceSnapshotFn
          ? resourceSnapshotFn({ owner, combat, timeSeconds, ownerCDs, teammateCDs, enemyCDTimeline, friends, enemies })
          : undefined,
      );
    }
  }

  // ── [YOU] [CAST] events (filler casts + CC) ────────────────────────────────────────────────────
  for (const e of owner.spellCastEvents) {
    const timeSeconds = (e.logLine.timestamp - matchStartMs) / 1000;
    const displayName = e.spellName || String(e.spellId);
    const targetPart = e.targetName ? ` → on: ${pid(e.targetName)}` : '';
    const totemNote = groundingTotemAbsorbs.has(e.logLine.timestamp)
      ? ` [ABSORBED: ${groundingTotemAbsorbs.get(e.logLine.timestamp)}]`
      : '';
    const interruptedSuffix = e.interrupted ? ' [INTERRUPTED]' : '';

    // F95: Offensive CC casts should carry a CC annotation or use an [YOU] [CC] prefix.
    if (ccSpellIds.has(e.spellId)) {
      addEntry(
        timeSeconds,
        `${fmtTime(timeSeconds)}  [YOU] [CC]   ${displayName}${targetPart}${totemNote}${interruptedSuffix}`,
        resourceSnapshotFn
          ? resourceSnapshotFn({ owner, combat, timeSeconds, ownerCDs, teammateCDs, enemyCDTimeline, friends, enemies })
          : undefined,
      );
      continue;
    }

    let stasisAnnotation = '';
    const activeStasis = stasisEvents.find((s) => timeSeconds >= s.startSeconds && timeSeconds < s.releaseSeconds);
    if (activeStasis && activeStasis.spells.includes(displayName)) {
      if (stateFormat === 'summary') {
        continue; // Suppress buffered heals in summary mode
      } else if (stateFormat === 'inline') {
        stasisAnnotation = ' [STASIS STORED]';
      }
    }

    // B38: promote major-CD spells (CD ≥ 30s) to [YOU] [CD] format when extractMajorCooldowns
    // missed them (e.g. missing talent data). This keeps Avenging Crusader etc. from appearing
    // as filler casts when they are significant cooldown activations.
    const effectData = spellEffectData[e.spellId];
    const cdSeconds = effectData?.cooldownSeconds ?? effectData?.charges?.chargeCooldownSeconds ?? 0;
    if (cdSeconds >= 30) {
      addEntry(
        timeSeconds,
        `${fmtTime(timeSeconds)}  [YOU] [CD]   ${displayName}${targetPart}${totemNote}${stasisAnnotation}`,
        resourceSnapshotFn
          ? resourceSnapshotFn({ owner, combat, timeSeconds, ownerCDs, teammateCDs, enemyCDTimeline, friends, enemies })
          : undefined,
      );
      continue;
    }

    // B56: don't track auto-attacks as "casts"
    if (e.spellName === 'Attack' || e.spellName === 'Shoot') continue;

    addEntry(
      timeSeconds,
      `${fmtTime(timeSeconds)}  [YOU] [CAST]   ${displayName}${targetPart}${totemNote}${interruptedSuffix}${stasisAnnotation}`,
      resourceSnapshotFn
        ? resourceSnapshotFn({ owner, combat, timeSeconds, ownerCDs, teammateCDs, enemyCDTimeline, friends, enemies })
        : undefined,
    );
  }

  // ── [TEAM] [CD] events ────────────────────────────────────────────────────
  for (const { player, cds } of teammateCDs) {
    const pLabel = pid(player.name);
    for (const cd of cds) {
      if (cd.neverUsed) continue;
      for (const cast of cd.casts) {
        const timeSeconds = (cast.logLine.timestamp - matchStartMs) / 1000;
        const targetPart = cast.targetName ? ` → on: ${pid(cast.targetName)}` : '';
        const totemNote = groundingTotemAbsorbs.has(cast.logLine.timestamp)
          ? ` [ABSORBED: ${groundingTotemAbsorbs.get(cast.logLine.timestamp)}]`
          : '';
        addEntry(
          timeSeconds,
          `${fmtTime(timeSeconds)}  [TEAM] [CD]   ${pLabel}: ${cd.spellName}${targetPart}${totemNote}`,
          resourceSnapshotFn
            ? resourceSnapshotFn({
                owner,
                combat,
                timeSeconds,
                ownerCDs,
                teammateCDs,
                enemyCDTimeline,
                friends,
                enemies,
              })
            : undefined,
        );
      }
    }
  }

  // ── [ENEMY] [CD] events ───────────────────────────────────────────────────
  for (const window of enemyCDTimeline.windows) {
    if (window.activeCDs.length === 0) continue;
    const castTime = window.fromSeconds;
    const cdNames = window.activeCDs.map((cd) => `${enemyPid(cd.player.name)}:${cd.spellName}`).join(' + ');
    addEntry(
      castTime,
      `${fmtTime(castTime)}  [ENEMY] [CD]   ${cdNames} (${window.dangerLabel})`,
      resourceSnapshotFn
        ? resourceSnapshotFn({
            owner,
            combat,
            timeSeconds: castTime,
            ownerCDs,
            teammateCDs,
            enemyCDTimeline,
            friends,
            enemies,
          })
        : undefined,
    );
  }

  // ── [TEAM] [CC] events ────────────────────────────────────────────────────
  for (const summary of ccTrinketSummaries) {
    const isOwner = summary.playerName === owner.name;
    const pLabel = isOwner ? 'YOU' : pid(summary.playerName);

    for (const cc of summary.ccUseTimes) {
      const timeSeconds = (cc.time - matchStartMs) / 1000;
      const targetPart = cc.targetName ? ` → on: ${pid(cc.targetName)}` : '';
      const dispelNote = cc.wasDispelled ? ' [DISPELLED]' : '';
      const drNote = cc.drCategory ? ` [DR: ${cc.drCategory} ${Math.round(cc.drDuration)}s]` : '';
      addEntry(
        timeSeconds,
        `${fmtTime(timeSeconds)}  [${isOwner ? 'YOU' : 'TEAM'}] [CC]   ${pLabel}: ${cc.spellName}${targetPart}${dispelNote}${drNote}`,
        resourceSnapshotFn
          ? resourceSnapshotFn({ owner, combat, timeSeconds, ownerCDs, teammateCDs, enemyCDTimeline, friends, enemies })
          : undefined,
      );
    }

    if (gateCcAvoidanceToDanger) {
      for (const avoided of summary.ccAvoidedInstances) {
        const timeSeconds = (avoided.time - matchStartMs) / 1000;
        // Only show if enemy offensive CDs are active.
        const hasEnemyOffensiveCDs = enemyCDTimeline.alignedBurstWindows.some(
          (w) => timeSeconds >= w.fromSeconds && timeSeconds <= w.toSeconds,
        );
        if (hasEnemyOffensiveCDs) {
          addEntry(
            timeSeconds,
            `${fmtTime(timeSeconds)}  [${isOwner ? 'YOU' : 'TEAM'}] [CC AVOIDED] ${pLabel}: ${avoided.spellName} (${avoided.reason})`,
            resourceSnapshotFn
              ? resourceSnapshotFn({
                  owner,
                  combat,
                  timeSeconds,
                  ownerCDs,
                  teammateCDs,
                  enemyCDTimeline,
                  friends,
                  enemies,
                })
              : undefined,
          );
        }
      }
    } else {
      for (const avoided of summary.ccAvoidedInstances) {
        const timeSeconds = (avoided.time - matchStartMs) / 1000;
        addEntry(
          timeSeconds,
          `${fmtTime(timeSeconds)}  [${isOwner ? 'YOU' : 'TEAM'}] [CC AVOIDED] ${pLabel}: ${avoided.spellName} (${avoided.reason})`,
          resourceSnapshotFn
            ? resourceSnapshotFn({
                owner,
                combat,
                timeSeconds,
                ownerCDs,
                teammateCDs,
                enemyCDTimeline,
                friends,
                enemies,
              })
            : undefined,
        );
      }
    }

    if (summary.trinketUseTimes.length > 0) {
      for (const t of summary.trinketUseTimes) {
        const timeSeconds = (t - matchStartMs) / 1000;
        addEntry(
          timeSeconds,
          `${fmtTime(timeSeconds)}  [${isOwner ? 'YOU' : 'TEAM'}] [TRINKET]  ${pLabel}: PvP trinket`,
          resourceSnapshotFn
            ? resourceSnapshotFn({
                owner,
                combat,
                timeSeconds,
                ownerCDs,
                teammateCDs,
                enemyCDTimeline,
                friends,
                enemies,
              })
            : undefined,
        );
      }
    }
  }

  // ── [DMG SPIKE] events (for enemies) ────────────────────────────────────────────────────
  for (const pw of pressureWindows) {
    if (pw.targetUnit.id === owner.id || friends.some((f) => f.id === pw.targetUnit.id)) {
      addEntry(
        pw.fromSeconds,
        `${fmtTime(pw.fromSeconds)}  [DMG SPIKE]   ${pid(pw.targetUnit.name)} took ${(
          pw.totalDamage / 1_000_000
        ).toFixed(2)}M in ${pw.durationSeconds}s (${pw.peakDamagePerSecond.toFixed(0)}k/s)`,
        resourceSnapshotFn
          ? resourceSnapshotFn({
              owner,
              combat,
              timeSeconds: pw.fromSeconds,
              ownerCDs,
              teammateCDs,
              enemyCDTimeline,
              friends,
              enemies,
            })
          : undefined,
      );
    } else {
      addEntry(
        pw.fromSeconds,
        `${fmtTime(pw.fromSeconds)}  [ENEMY DMG SPIKE]   ${enemyPid(pw.targetUnit.name)} took ${(
          pw.totalDamage / 1_000_000
        ).toFixed(2)}M in ${pw.durationSeconds}s (${pw.peakDamagePerSecond.toFixed(0)}k/s)`,
        resourceSnapshotFn
          ? resourceSnapshotFn({
              owner,
              combat,
              timeSeconds: pw.fromSeconds,
              ownerCDs,
              teammateCDs,
              enemyCDTimeline,
              friends,
              enemies,
            })
          : undefined,
      );
    }
  }

  // ── [DEATH] events ────────────────────────────────────────────────────────
  for (const death of friendlyDeaths) {
    addEntry(
      death.atSeconds,
      `${fmtTime(death.atSeconds)}  [YOU] [DEATH]   ${pid(death.name)} dies${death.note ? ` (${death.note})` : ''}`,
      resourceSnapshotFn
        ? resourceSnapshotFn({
            owner,
            combat,
            timeSeconds: death.atSeconds,
            ownerCDs,
            teammateCDs,
            enemyCDTimeline,
            friends,
            enemies,
          })
        : undefined,
    );
  }
  for (const death of enemyDeaths) {
    addEntry(
      death.atSeconds,
      `${fmtTime(death.atSeconds)}  [ENEMY] [DEATH]   ${enemyPid(death.name)} dies`,
      resourceSnapshotFn
        ? resourceSnapshotFn({
            owner,
            combat,
            timeSeconds: death.atSeconds,
            ownerCDs,
            teammateCDs,
            enemyCDTimeline,
            friends,
            enemies,
          })
        : undefined,
    );
  }

  // ── [HEALING GAP] events (for owner only) ─────────────────────────────────
  if (isHealer) {
    for (const gap of healingGaps) {
      addEntry(gap.from, `${fmtTime(gap.from)}  [HEALING GAP]   ${gap.reason}`);
    }
  }

  // ── [ENEMY BUFF] events ───────────────────────────────────────────────────
  for (const buff of enemyBuffIntervals) {
    if (buff.endSeconds === 0) {
      // Still active at end of match.
      addEntry(
        buff.startSeconds,
        `${fmtTime(buff.startSeconds)}  [ENEMY BUFF]   ${enemyPid(buff.player.name)}: ${buff.spellName} (active until match end)`,
      );
    } else {
      addEntry(
        buff.startSeconds,
        `${fmtTime(buff.startSeconds)}  [ENEMY BUFF]   ${enemyPid(buff.player.name)}: ${buff.spellName} (${fmtTime(buff.startSeconds)}–${fmtTime(buff.endSeconds)})`,
      );
    }
  }

  // ── [DAMPENING ALERT] events (F149) ─────────────────────────────────────────────────
  const dampeningMilestones = [10, 20, 30, 40, 50, 60, 70, 80, 90];
  for (const pct of dampeningMilestones) {
    const timestamp = (combat.startTime + (combat.endTime - combat.startTime) * (pct / 100)) / 1000;
    if (timestamp < (combat.endTime - combat.startTime) / 1000) {
      addEntry(timestamp, `${fmtTime(timestamp)}  [DAMPENING ALERT: ${pct}%]`);
    }
  }

  // ── [STATE] events ────────────────────────────────────────────────────────
  // Only sample every few seconds, or for "critical windows" (burst, deaths).
  const tickIntervalSeconds = 3;
  const matchEndSeconds = (matchEndMs - matchStartMs) / 1000;
  const criticalWindowSet = new Set<number>(); // timestamps where something important happened

  for (const entry of entries) {
    criticalWindowSet.add(Math.floor(entry.timeSeconds));
  }
  for (let t = 0; t <= matchEndSeconds; t += 1) {
    if (t % tickIntervalSeconds === 0 || criticalWindowSet.has(t)) {
      criticalWindowSet.add(t);
    }
  }
  const tickTimes = [...criticalWindowSet].sort((a, b) => a - b);

  const lastEmittedHp = new Map<string, number | null>();
  const lastEmittedStatus = new Map<string, 'alive' | 'dead'>();

  for (const t of tickTimes) {
    const tsMs = matchStartMs + t * 1000;
    let stateChanged = false;

    const friendlyHpUnits = friends.map((u) => ({ unit: u, label: pid }));
    const enemyHpUnits = enemies.map((u) => ({ unit: u, label: enemyPid }));

    const friendlyDeathAtByName = new Map<string, number>();
    for (const d of friendlyDeaths) friendlyDeathAtByName.set(d.name, d.atSeconds);
    const enemyDeathAtByName = new Map<string, number>();
    for (const d of enemyDeaths) enemyDeathAtByName.set(d.name, d.atSeconds);

    const friendlyParts: string[] = [];
    const currentFriendlies = friendlyHpUnits.map(({ unit, label }) => {
      const deathAt = friendlyDeathAtByName.get(unit.name);
      const isDead = deathAt !== undefined && t >= Math.floor(deathAt);
      const pct = getUnitHpAtTimestamp(unit, tsMs, sampleWindowMs);
      const clamped = pct !== null ? Math.min(pct, 100) : null;

      let formStr = '';
      if (stateFormat === 'inline') {
        const formRecord = shapeshiftIntervals.find((s) => s.player.id === unit.id);
        if (formRecord) {
          const activeForm = formRecord.intervals.find((i) => t >= i.startSeconds && t <= i.endSeconds);
          if (activeForm) formStr = `:${activeForm.form.toLowerCase()}`;
        }
      }

      if (isDead) {
        friendlyParts.push(`${label(unit.name)}:dead`);
      } else if (clamped !== null) {
        friendlyParts.push(`${label(unit.name)}:${clamped}${formStr}`);
      }
      return { name: unit.name, isDead, hp: clamped };
    });

    const enemyParts: string[] = [];
    const currentEnemies =
      criticalWindowSet.has(t) && enemyHpUnits.length > 0
        ? enemyHpUnits.map(({ unit, label }) => {
            const deathAt = enemyDeathAtByName.get(unit.name);
            const isDead = deathAt !== undefined && t >= Math.floor(deathAt);
            const pct = getUnitHpAtTimestamp(unit, tsMs, sampleWindowMs);
            const clamped = pct !== null ? Math.min(pct, 100) : null;

            if (isDead) {
              enemyParts.push(`${label(unit.name)}:dead`);
            } else if (clamped !== null) {
              let formStr = '';
              if (stateFormat === 'inline') {
                const formRecord = shapeshiftIntervals.find((s) => s.player.id === unit.id);
                if (formRecord) {
                  const activeForm = formRecord.intervals.find((i) => t >= i.startSeconds && t <= i.endSeconds);
                  if (activeForm) formStr = `:${activeForm.form.toLowerCase()}`;
                }
              }
              enemyParts.push(`${label(unit.name)}:${clamped}${formStr}`);
            }
            return { name: unit.name, isDead, hp: clamped };
          })
        : [];

    for (const p of [...currentFriendlies, ...currentEnemies]) {
      const lastHp = lastEmittedHp.get(p.name);
      const lastStatus = lastEmittedStatus.get(p.name) ?? 'alive';
      const currentStatus = p.isDead ? 'dead' : 'alive';

      if (
        (lastHp !== null && p.hp !== null && Math.abs(p.hp - lastHp) > 10) ||
        lastStatus !== currentStatus ||
        (lastHp === null && p.hp !== null)
      ) {
        stateChanged = true;
      }
      lastEmittedHp.set(p.name, p.hp);
      lastEmittedStatus.set(p.name, currentStatus);
    }

    if (stateChanged || (friendlyParts.length === 0 && enemyParts.length === 0)) {
      let stateParts = '';
      if (friendlyParts.length > 0 && enemyParts.length > 0) {
        stateParts = `friends ${friendlyParts.join(' ')} / enemies ${enemyParts.join(' ')}`;
      } else if (friendlyParts.length > 0) {
        stateParts = `friends ${friendlyParts.join(' ')}`;
      } else {
        stateParts = `enemies ${enemyParts.join(' ')}`;
      }

      addEntry(t, `${fmtTime(t)}  [STATE]   ${stateParts}`);
    }
  }

  // 9. Add Form shifts (Verbose mode only)
  if (stateFormat === 'verbose') {
    for (const { player, intervals } of shapeshiftIntervals) {
      const isOwner = player.id === owner.id;
      const prefix = isOwner ? '[YOU]' : friends.some((f) => f.id === player.id) ? '[TEAM]' : '[ENEMY]';
      const pLabel = isOwner ? '' : ` ${pid(player.name)}`;

      for (const interval of intervals) {
        addEntry(
          interval.startSeconds,
          `${fmtTime(interval.startSeconds)}  ${prefix} [SHIFT]${pLabel} entered ${interval.form} Form`,
        );
      }
    }
  }

  // 10. Process Stasis Events
  for (const stasis of stasisEvents) {
    if (stateFormat === 'summary') {
      addEntry(
        stasis.releaseSeconds,
        `${fmtTime(stasis.releaseSeconds)}  [YOU] [STASIS RELEASE] → ${stasis.spells.join(', ')}`,
      );
    }
  }

  // ── Sort and format ───────────────────────────────────────────────────────

  entries.sort((a, b) => a.timeSeconds - b.timeSeconds);

  const summaryLines: string[] = [];
  if (stateFormat === 'summary' && shapeshiftIntervals.length > 0) {
    summaryLines.push('## NOTABLE STATES');
    for (const { player, intervals } of shapeshiftIntervals) {
      const bearTime = intervals
        .filter((i) => i.form === 'Bear')
        .reduce((acc, i) => acc + (i.endSeconds - i.startSeconds), 0);
      const catTime = intervals
        .filter((i) => i.form === 'Cat')
        .reduce((acc, i) => acc + (i.endSeconds - i.startSeconds), 0);
      const pLabel = player.id === owner.id ? 'YOU' : pid(player.name);

      if (bearTime > 0) summaryLines.push(`- ${pLabel} spent ${Math.round(bearTime)}s in Bear Form.`);
      if (catTime > 0) summaryLines.push(`- ${pLabel} spent ${Math.round(catTime)}s in Cat Form.`);
    }
    if (summaryLines.length > 1) {
      summaryLines.push('');
    } else {
      summaryLines.length = 0; // Empty if no valid times found
    }
  }

  const outputLines: string[] = [
    ...summaryLines,
    'MATCH TIMELINE',
    '  Units: M = Million damage (1,000,000), k = Thousand damage (1,000)',
    '',
    `[PERSPECTIVE: Log Owner - ${ownerSpec}]`,
    `(You are the ${ownerSpec} in this match. Your actions are marked with [YOU].)`,
    '',
  ];

  let currentFold: {
    spellName: string;
    targetPart: string;
    count: number;
    firstTime: number;
    lastTime: number;
    linesToReplace: string[];
  } | null = null;

  const pushFold = () => {
    if (currentFold) {
      if (currentFold.count > 1) {
        const duration = currentFold.lastTime - currentFold.firstTime;
        outputLines.push(
          `${fmtTime(currentFold.firstTime)}  [YOU] [CAST]   ${currentFold.spellName}${
            currentFold.targetPart
          } (x${currentFold.count} over ${fmtTime(duration)}s)`,
        );
      } else {
        outputLines.push(...currentFold.linesToReplace);
      }
      currentFold = null;
    }
  };

  for (const entry of entries) {
    // F151: Repetitive Cast Folding
    // Collapse multiple consecutive identical [YOU] [CAST] lines that occur within a short time
    // and outside of dangerous windows.
    if (entry.text.includes('[YOU] [CAST]') && !resourceSnapshotFn) {
      const parts = entry.text.split('   ');
      const spellAndTarget = parts[1].split(' [STASIS STORED]')[0]; // Remove Stasis annotation for folding
      const [spellName, ...targetParts] = spellAndTarget.split(' → on: ');
      const targetPart = targetParts.length > 0 ? ` → on: ${targetParts.join(' → on: ')}` : '';

      const isCriticalWindow = pressureWindows.some(
        (pw) => entry.timeSeconds >= pw.fromSeconds && entry.timeSeconds <= pw.toSeconds,
      );

      if (
        currentFold &&
        currentFold.spellName === spellName &&
        currentFold.targetPart === targetPart &&
        entry.timeSeconds - currentFold.lastTime < 5 && // Less than 5s between casts
        !isCriticalWindow // Not in a critical window
      ) {
        currentFold.count++;
        currentFold.lastTime = entry.timeSeconds;
      } else {
        pushFold();
        currentFold = {
          spellName,
          targetPart,
          count: 1,
          firstTime: entry.timeSeconds,
          lastTime: entry.timeSeconds,
          linesToReplace: [entry.text],
        };
      }
    } else {
      pushFold();
      outputLines.push(entry.text);
    }
    if (entry.resourceText) {
      outputLines.push(entry.resourceText);
    }
  }
  pushFold();

  outputLines.push(
    ...buildKillSequenceBlock({
      matchStartMs,
      matchEndSeconds,
      bracket,
      owner,
      friends,
      enemies: enemies ?? [],
      friendlyDeaths,
      enemyDeaths,
      pid,
      enemyPid,
    }),
  );

  return outputLines.join('\n');
}
