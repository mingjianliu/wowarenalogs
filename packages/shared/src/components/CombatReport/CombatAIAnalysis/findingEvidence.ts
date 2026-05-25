// Deterministic evidence derivation. The AI supplies a finding's anchor timestamp;
// the app pulls the real timestamped events around it from already-computed match
// data so the evidence drawer never shows hallucinated timestamps.

import { fmtTime } from '../../../utils/cooldowns';
import { ClassKey, MatchAnalysisData } from './matchAnalysisData';

export type EvidenceKind = 'owner-cd' | 'enemy-cd' | 'enemy-burst' | 'cc' | 'purge' | 'kill';

export interface EvidenceMoment {
  atSeconds: number;
  kind: EvidenceKind;
  label: string;
  cls?: ClassKey;
}

export interface FindingEvidence {
  windowStart: number;
  windowEnd: number;
  keyMoments: EvidenceMoment[];
}

export interface EvidenceWindowOptions {
  beforeSeconds?: number;
  afterSeconds?: number;
  maxMoments?: number;
}

const DEFAULT_BEFORE = 10;
const DEFAULT_AFTER = 8;
const DEFAULT_MAX = 8;

function buildClassMap(data: MatchAnalysisData): Map<string, ClassKey> {
  const map = new Map<string, ClassKey>();
  [...data.friends, ...data.enemies].forEach((p) => map.set(p.name, p.cls));
  return map;
}

export function deriveEvidence(
  anchorSeconds: number,
  data: MatchAnalysisData,
  options: EvidenceWindowOptions = {},
): FindingEvidence {
  const before = options.beforeSeconds ?? DEFAULT_BEFORE;
  const after = options.afterSeconds ?? DEFAULT_AFTER;
  const maxMoments = options.maxMoments ?? DEFAULT_MAX;

  const windowStart = Math.max(0, anchorSeconds - before);
  const windowEnd = Math.min(data.durationSeconds, anchorSeconds + after);
  const inWindow = (t: number) => t >= windowStart && t <= windowEnd;

  const classOf = buildClassMap(data);
  const moments: EvidenceMoment[] = [];

  // Enemy aligned burst windows
  data.burstWindows.forEach((b, i) => {
    if (!inWindow(b.fromSeconds)) return;
    moments.push({
      atSeconds: b.fromSeconds,
      kind: 'enemy-burst',
      label: `Burst window #${i + 1} — score ${b.dangerScore.toFixed(1)} ${b.dangerLabel}`,
    });
  });

  // Enemy offensive CD casts
  data.enemyCDs.forEach((enemy) => {
    enemy.offensiveCDs.forEach((cd) => {
      if (!inWindow(cd.castTimeSeconds)) return;
      moments.push({
        atSeconds: cd.castTimeSeconds,
        kind: 'enemy-cd',
        label: `${cd.spellName} — ${enemy.playerName}`,
        cls: classOf.get(enemy.playerName),
      });
    });
  });

  // Owner major CD casts
  data.ownerCDs.forEach((cd) => {
    cd.casts.forEach((cast) => {
      if (!inWindow(cast.timeSeconds)) return;
      const reactive = cast.timingLabel === 'Reactive' ? ' [reactive]' : '';
      moments.push({
        atSeconds: cast.timeSeconds,
        kind: 'owner-cd',
        label: `${cd.spellName} cast${reactive}`,
        cls: classOf.get(data.ownerName),
      });
    });
  });

  // Missed offensive purges
  data.missedPurges.forEach((p) => {
    if (!inWindow(p.timeSeconds)) return;
    moments.push({
      atSeconds: p.timeSeconds,
      kind: 'purge',
      label: `${p.spellName} [${p.priority}] — ${Math.round(p.durationSeconds)}s unpurged on ${p.enemySpec}`,
      cls: classOf.get(p.enemyName),
    });
  });

  // Hard CC received by our team
  data.ccTrinketSummaries.forEach((summary) => {
    summary.ccInstances.forEach((cc) => {
      if (!inWindow(cc.atSeconds)) return;
      const trinketNote = cc.trinketState === 'available_unused' ? ', trinket up' : '';
      moments.push({
        atSeconds: cc.atSeconds,
        kind: 'cc',
        label: `${cc.spellName} → ${summary.playerName} [${cc.durationSeconds.toFixed(1)}s${trinketNote}]`,
        cls: classOf.get(cc.sourceName),
      });
    });
  });

  // Deaths
  [...data.friendlyDeaths, ...data.enemyDeaths].forEach((d) => {
    if (!inWindow(d.atSeconds)) return;
    moments.push({
      atSeconds: d.atSeconds,
      kind: 'kill',
      label: `${d.spec} dies (${d.side === 'enemy' ? 'enemy' : 'your team'})`,
      cls: d.cls,
    });
  });

  moments.sort((a, b) => a.atSeconds - b.atSeconds || a.label.localeCompare(b.label));

  // Cap to the moments nearest the anchor, then restore chronological order.
  let trimmed = moments;
  if (moments.length > maxMoments) {
    trimmed = [...moments]
      .sort((a, b) => Math.abs(a.atSeconds - anchorSeconds) - Math.abs(b.atSeconds - anchorSeconds))
      .slice(0, maxMoments)
      .sort((a, b) => a.atSeconds - b.atSeconds);
  }

  return { windowStart, windowEnd, keyMoments: trimmed };
}

/** Human-readable window label, e.g. "1:44–2:00". */
export function formatEvidenceWindow(ev: FindingEvidence): string {
  return `${fmtTime(ev.windowStart)}–${fmtTime(ev.windowEnd)}`;
}
