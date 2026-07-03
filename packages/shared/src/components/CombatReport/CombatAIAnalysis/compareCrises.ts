/**
 * Shared helpers for the comparative (/api/compare) crisis-contrast assembly. Extracted so the live
 * endpoint (packages/web/pages/api/compare.ts) and the eval corpus builder
 * (packages/tools/src/buildUserCompareCorpus.ts) use ONE implementation and can't drift apart.
 */
import { PASSIVE_SPELL_BLOCKLIST } from '../../../utils/cooldowns';
import { BuiltEmbeddingRecord } from '../../../utils/matchEmbeddingRecord';
import { MetricKey } from './metricRegistry';

export const MAX_PRO_CRISES = 6;

/**
 * Strip passive-proc spells (PASSIVE_SPELL_BLOCKLIST) from a "At Ns (...): A -> B -> C" crisis line.
 * Older reference vectors baked passives (e.g. Reclamation) into crisis sequences before those names
 * were blocklisted at extraction; filtering here guarantees they never reach the prompt as "pro casts".
 * Returns null if nothing meaningful remains.
 */
export function stripPassiveCasts(line: string): string | null {
  const i = line.indexOf('): ');
  if (i < 0) return line;
  const spells = line
    .slice(i + 3)
    .split(' -> ')
    .filter((s) => !PASSIVE_SPELL_BLOCKLIST.has(s.trim()));
  return spells.length ? `${line.slice(0, i + 3)}${spells.join(' -> ')}` : null;
}

/** One crisis sequence per distinct pro player, up to MAX_PRO_CRISES — real diversification. */
export function diversifiedProCrises(cell: { playerName: string; crisisEvents?: string[] }[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const spellCount = (s: string) => (s.split('): ')[1] ?? s).split(' -> ').length;
  for (const r of cell) {
    if (out.length >= MAX_PRO_CRISES) break;
    if (seen.has(r.playerName)) continue;
    const crises = (r.crisisEvents ?? [])
      .map((s) => (s && s.trim().length > 0 ? stripPassiveCasts(s) : null))
      .filter((s): s is string => !!s);
    if (crises.length === 0) continue;
    // Pick this pro's MOST instructive crisis (most casts) — avoids surfacing a thin single-spell
    // "crisis" (e.g. a lone racial like Bag of Tricks) as a comparable pro when a richer one exists.
    const c = crises.reduce((best, s) => (spellCount(s) > spellCount(best) ? s : best));
    seen.add(r.playerName);
    out.push(c);
  }
  return out;
}

/** Maps the user's computed metrics onto MetricKey (the record stores legacy `reactionLatency`). */
export function toUserMetrics(raw: BuiltEmbeddingRecord): Partial<Record<MetricKey, number | null>> {
  return {
    offensiveIndex: raw.offensiveIndex,
    ccDensity: raw.ccDensity,
    responseLatencySec: raw.reactionLatency,
    effectiveCastRatio: raw.effectiveCastRatio,
    ccAvoidanceRate: raw.ccAvoidanceRate,
  };
}
