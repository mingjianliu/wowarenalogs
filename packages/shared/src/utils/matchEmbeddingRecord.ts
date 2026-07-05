import { AtomicArenaCombat, CombatUnitType, ICombatUnit } from '@wowarenalogs/parser';

import { PASSIVE_SPELL_BLOCKLIST } from './cooldowns';
import { englishSpellName } from './englishSpellName';
import { computeHealerMetrics } from './healerMetrics';
import { RawMatchRecord } from './vectorEmbedding';

export { isHealerSpec } from './cooldowns';

export interface IExtractedRotations {
  opener: string[];
  coreSequences: string[];
  crisisEvents: string[];
}

// Moved verbatim (modulo typing) from packages/tools/src/analyzeSpecPlaystyle.ts
// (single-match, request-time safe).
export function extractRotations(player: ICombatUnit, match: AtomicArenaCombat): IExtractedRotations {
  const casts = player.spellCastEvents
    .filter(
      (e) => e.spellName && e.logLine?.event === 'SPELL_CAST_SUCCESS' && !PASSIVE_SPELL_BLOCKLIST.has(e.spellName),
    )
    .map((e) => ({
      spellId: e.spellId,
      name: e.spellName as string,
      time: (e.logLine.timestamp - match.startTime) / 1000,
    }))
    .sort((a, b) => a.time - b.time);

  const opener = casts.filter((c) => c.time <= 30).map((c) => c.name);

  const seqCounts: Record<string, number> = {};
  for (let i = 0; i < casts.length - 2; i++) {
    // Canonicalize by spellId so the stored chain is English regardless of the pro's client locale
    // (there is no localized->English source, so this must happen at extraction time; see B121).
    const chain = `${englishSpellName(casts[i].spellId ?? '', casts[i].name)} -> ${englishSpellName(casts[i + 1].spellId ?? '', casts[i + 1].name)} -> ${englishSpellName(casts[i + 2].spellId ?? '', casts[i + 2].name)}`;
    seqCounts[chain] = (seqCounts[chain] || 0) + 1;
  }
  const coreSequences = Object.entries(seqCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([seq, count]) => `${seq} (used ${count}x)`);

  const teamUnits = Object.values(match.units).filter(
    (u) => u.type === CombatUnitType.Player && u.reaction === player.reaction,
  );
  const allTeamHpRecords = teamUnits
    .flatMap((u) =>
      (u.advancedActions || [])
        .filter((a) => a.advanced && a.advancedActorId === u.id && a.advancedActorMaxHp > 0)
        .map((a) => ({
          targetName: u.name,
          time: (a.logLine.timestamp - match.startTime) / 1000,
          pct: (a.advancedActorCurrentHp / a.advancedActorMaxHp) * 100,
        })),
    )
    .sort((a, b) => a.time - b.time);

  const crisisEvents: string[] = [];
  let lastCrisisTime = -999;
  for (const record of allTeamHpRecords) {
    if (record.pct < 40 && record.time - lastCrisisTime > 15) {
      lastCrisisTime = record.time;
      const responseCasts = casts
        .filter((c) => c.time >= record.time && c.time <= record.time + 6)
        .map((c) => englishSpellName(c.spellId ?? '', c.name));
      if (responseCasts.length > 0) {
        crisisEvents.push(
          `At ${record.time.toFixed(1)}s (Teammate ${record.targetName} HP: ${Math.floor(record.pct)}%): ${responseCasts.join(' -> ')}`,
        );
      }
    }
  }
  return { opener, coreSequences, crisisEvents };
}

export interface BuiltEmbeddingRecord extends RawMatchRecord {
  rotations: { coreSequences: string[]; crisisEvents: string[] };
  pythonResult: { nodes_info: Record<string, unknown> };
  offensiveIndex: number;
  ccDensity: number;
  reactionLatency: number | null;
  defensiveOverlapRatio: number;
  effectiveCastRatio: number;
  ccAvoidanceRate: number;
}

/**
 * Build the RawMatchRecord that vectorizeMatch consumes, from a parsed combat + owner name.
 * Talent ids come from the owner unit's info.talents `id1` field (confirmed 100% aligned with the
 * reference model's talentVocab), shaped as pythonResult.nodes_info to match the corpus encoding.
 */
export function buildMatchEmbeddingRecord(combat: AtomicArenaCombat, playerName: string): BuiltEmbeddingRecord {
  const owner = Object.values(combat.units).find((u) => u.name === playerName && u.type === CombatUnitType.Player);
  if (!owner) {
    throw new Error(`Player ${playerName} not found in combat.`);
  }

  const rotations = extractRotations(owner, combat);
  const metrics = computeHealerMetrics(combat, playerName);
  const talentIds: number[] = (owner.info?.talents ?? [])
    .filter((t): t is { id1: number; id2: number; count: number } => !!t && typeof t.id1 === 'number')
    .map((t) => t.id1);
  const nodes_info: Record<string, unknown> = {};
  for (const id of talentIds) nodes_info[String(id)] = {};

  return {
    rotations: { coreSequences: rotations.coreSequences, crisisEvents: rotations.crisisEvents },
    pythonResult: { nodes_info },
    offensiveIndex: metrics.offensiveIndex,
    ccDensity: metrics.ccDensity,
    reactionLatency: metrics.reactionLatency,
    defensiveOverlapRatio: metrics.defensiveOverlapRatio,
    effectiveCastRatio: metrics.effectiveCastRatio,
    ccAvoidanceRate: metrics.ccAvoidanceRate,
  };
}
