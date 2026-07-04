import { AtomicArenaCombat, CombatUnitReaction, CombatUnitSpec, CombatUnitType } from '@wowarenalogs/parser';

import { buildMatchEmbeddingRecord, BuiltEmbeddingRecord, isHealerSpec } from '../../../utils/matchEmbeddingRecord';

/**
 * Everything /api/compare needs about the USER's match, computed client-side from the locally
 * parsed combat. In the desktop app the API routes run on the user's machine with no Google
 * Cloud credentials, so the server cannot resolve the match from Firestore/GCS — but the client
 * already holds the parsed combat, making the server round-trip redundant. The pro cohort side
 * (reference_vectors.json) is bundled with the server and needs nothing remote.
 */
export interface CompareLocalContext {
  playerName: string;
  /** CombatUnitSpec of the log owner — server re-checks the healer gate on this. */
  specId: CombatUnitSpec;
  bracket: string;
  /** Team damage taken per second — B151 pressure-matching for the offensiveIndex percentile. */
  teamDtps: number;
  raw: BuiltEmbeddingRecord;
}

export function deriveBracket(combat: AtomicArenaCombat): string {
  if (combat.startInfo?.bracket) return String(combat.startInfo.bracket);
  const combatRecord = combat as unknown as Record<string, unknown>;
  if (combatRecord.dataType === 'ShuffleRound' || typeof combatRecord.sequenceNumber === 'number') {
    return 'solo_shuffle';
  }
  const friendly = Object.values(combat.units).filter(
    (u) => u.type === CombatUnitType.Player && u.reaction === CombatUnitReaction.Friendly,
  ).length;
  return friendly >= 3 ? '3v3' : '2v2';
}

/** Returns null when the log owner is missing or not a healer (compare is healer-only). */
export function buildCompareLocalContext(combat: AtomicArenaCombat): CompareLocalContext | null {
  const owner = combat.units[combat.playerId];
  if (!owner || !isHealerSpec(owner.spec)) return null;

  const raw = buildMatchEmbeddingRecord(combat, owner.name);
  const durationSeconds = Math.max((combat.endTime - combat.startTime) / 1000, 1);
  const teamDtps =
    Object.values(combat.units)
      .filter((u) => u.type === CombatUnitType.Player && u.reaction === owner.reaction)
      .reduce((s, u) => s + u.damageIn.reduce((x, d) => x + Math.abs(d.effectiveAmount), 0), 0) / durationSeconds;

  return {
    playerName: owner.name,
    specId: owner.spec,
    bracket: deriveBracket(combat),
    teamDtps,
    raw,
  };
}
