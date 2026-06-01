// packages/shared/src/utils/combatStates.ts
import { AtomicArenaCombat, ICombatUnit, LogEvent } from '@wowarenalogs/parser';

export interface IFormInterval {
  form: 'Bear' | 'Cat';
  startSeconds: number;
  endSeconds: number;
}

export interface IStasisEvent {
  startSeconds: number;
  releaseSeconds: number;
  spells: string[];
}

export function extractShapeshiftIntervals(unit: ICombatUnit, combat: AtomicArenaCombat): IFormInterval[] {
  const intervals: IFormInterval[] = [];
  let bearStart: number | null = null;
  let catStart: number | null = null;

  for (const aura of unit.auraEvents) {
    if (!aura.spellName) continue;

    const isBear = aura.spellId === '5487' || aura.spellId === '9634'; // Bear Form, Dire Bear Form
    const isCat = aura.spellId === '768'; // Cat Form

    if (aura.logLine.event === LogEvent.SPELL_AURA_APPLIED) {
      if (isBear) {
        bearStart = aura.logLine.timestamp;
      } else if (isCat) {
        catStart = aura.logLine.timestamp;
      }
    } else if (aura.logLine.event === LogEvent.SPELL_AURA_REMOVED) {
      if (isBear && bearStart !== null) {
        intervals.push({
          form: 'Bear',
          startSeconds: (bearStart - combat.startTime) / 1000,
          endSeconds: (aura.logLine.timestamp - combat.startTime) / 1000,
        });
        bearStart = null;
      } else if (isCat && catStart !== null) {
        intervals.push({
          form: 'Cat',
          startSeconds: (catStart - combat.startTime) / 1000,
          endSeconds: (aura.logLine.timestamp - combat.startTime) / 1000,
        });
        catStart = null;
      }
    }
  }

  // Handle forms held until the end of the match
  if (bearStart !== null) {
    intervals.push({
      form: 'Bear',
      startSeconds: (bearStart - combat.startTime) / 1000,
      endSeconds: (combat.endTime - combat.startTime) / 1000,
    });
  }
  if (catStart !== null) {
    intervals.push({
      form: 'Cat',
      startSeconds: (catStart - combat.startTime) / 1000,
      endSeconds: (combat.endTime - combat.startTime) / 1000,
    });
  }

  return intervals;
}

export function extractStasisEvents(unit: ICombatUnit, combat: AtomicArenaCombat): IStasisEvent[] {
  const events: IStasisEvent[] = [];
  let isBuffering = false;
  let startSeconds = 0;
  let bufferedSpells: string[] = [];

  const evokerHeals = new Set([
    'Dream Breath',
    'Spiritbloom',
    'Reversion',
    'Emerald Blossom',
    'Verdant Embrace',
    'Living Flame',
  ]);

  // Evokers buffer heals when Stasis (370537) is active.
  // We scan both aura events (for boundaries) and cast events (for the buffered spells).
  const mergedEvents = [...unit.auraEvents, ...unit.spellCastEvents]
    .filter(
      (e) =>
        e.logLine.event === LogEvent.SPELL_AURA_APPLIED ||
        e.logLine.event === LogEvent.SPELL_AURA_REMOVED ||
        e.logLine.event === LogEvent.SPELL_CAST_SUCCESS,
    )
    .sort((a, b) => {
      if (a.logLine.timestamp !== b.logLine.timestamp) {
        return a.logLine.timestamp - b.logLine.timestamp;
      }
      // Prioritize Cast Success before Aura Removed to capture spells cast at the exact ms Stasis is removed
      const getPriority = (event: string) => {
        if (event === LogEvent.SPELL_AURA_APPLIED) return 0;
        if (event === LogEvent.SPELL_CAST_SUCCESS) return 1;
        if (event === LogEvent.SPELL_AURA_REMOVED) return 2;
        return 3;
      };
      return getPriority(a.logLine.event) - getPriority(b.logLine.event);
    });

  for (const e of mergedEvents) {
    if (e.spellId === '370537' && e.logLine.event === LogEvent.SPELL_AURA_APPLIED) {
      isBuffering = true;
      startSeconds = (e.logLine.timestamp - combat.startTime) / 1000;
      bufferedSpells = [];
    } else if (e.spellId === '370537' && e.logLine.event === LogEvent.SPELL_AURA_REMOVED && isBuffering) {
      events.push({
        startSeconds,
        releaseSeconds: (e.logLine.timestamp - combat.startTime) / 1000,
        spells: [...bufferedSpells],
      });
      isBuffering = false;
    } else if (isBuffering && e.logLine.event === LogEvent.SPELL_CAST_SUCCESS) {
      if (e.spellName && evokerHeals.has(e.spellName) && bufferedSpells.length < 3) {
        bufferedSpells.push(e.spellName);
      }
    }
  }

  return events;
}
