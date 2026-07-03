/**
 * Shared harness for deterministic corpus audits: iterate every game in the user's log corpus with
 * the standard unit extraction done once, correctly. See docs/commands/corpus-audit.md for the
 * methodology and the gotchas this encapsulates (per-log parser instance, healer detection, etc.).
 *
 * Typical use (see auditOI.ts / auditPushback.ts / auditBurstTimeline.ts for full examples):
 *
 *   const stats = new Map<string, number>();
 *   await forEachCorpusGame((g) => {
 *     if (!g.owner) return;
 *     // ...accumulate from g.combat / g.friends / g.enemies / g.owner...
 *   });
 */
import { CombatUnitReaction, CombatUnitType, ICombatUnit } from '@wowarenalogs/parser';
import fs from 'fs-extra';
import path from 'path';

import { isHealerSpec, specToString } from '../../shared/src/utils/cooldowns';
import { parseLogText } from './printMatchPrompts';

/** The user's personal log corpus (source of the ~1100-game healer dataset). */
export const USER_LOGS_DIR = '/Users/mingjianliu/code/wowarenalogs/scratch/user-logs/wow';

export interface ICorpusGame {
  /** Parsed combat (IArenaMatch or IShuffleRound). */
  combat: Awaited<ReturnType<typeof parseLogText>>[number];
  friends: ICombatUnit[];
  enemies: ICombatUnit[];
  /** The friendly healer, if any (the log owner in this corpus). */
  owner: ICombatUnit | null;
  ownerSpec: string | null;
  file: string;
  /** 0-based combat index within the file (prompts cite 1-based: cN = combatIndex+1). */
  combatIndex: number;
  durationSeconds: number;
}

export interface IForEachOptions {
  logsDir?: string;
  /** Skip games without a friendly healer (default true — most audits are healer-centric). */
  healerOnly?: boolean;
  /** Skip games shorter than this (default 30s, mirrors the analysis pipeline). */
  minDurationSeconds?: number;
  /** Log progress every N files (default 20; set 0 to silence). */
  progressEvery?: number;
}

export async function forEachCorpusGame(
  cb: (g: ICorpusGame) => void | Promise<void>,
  opts: IForEachOptions = {},
): Promise<{ files: number; games: number }> {
  const logsDir = opts.logsDir ?? USER_LOGS_DIR;
  const healerOnly = opts.healerOnly ?? true;
  const minDur = opts.minDurationSeconds ?? 30;
  const progressEvery = opts.progressEvery ?? 20;

  const files = (await fs.readdir(logsDir)).filter((f) => f.endsWith('.txt') || f.endsWith('.log'));
  let games = 0;
  let done = 0;
  for (const file of files) {
    // One parser instance per log file (parseLogText creates its own) — module-level parser state is
    // reset per pipeline since b79a2f40/e8b6837c, but per-file parsing remains the supported pattern.
    const combats = await parseLogText(await fs.readFile(path.join(logsDir, file), 'utf8'));
    for (let i = 0; i < combats.length; i++) {
      const combat = combats[i];
      const durationSeconds = (combat.endTime - combat.startTime) / 1000;
      if (durationSeconds < minDur) continue;
      const units = Object.values(combat.units) as ICombatUnit[];
      const friends = units.filter(
        (u) => u.type === CombatUnitType.Player && u.reaction === CombatUnitReaction.Friendly,
      );
      const enemies = units.filter(
        (u) => u.type === CombatUnitType.Player && u.reaction === CombatUnitReaction.Hostile,
      );
      const owner = friends.find((u) => isHealerSpec(u.spec)) ?? null;
      if (healerOnly && !owner) continue;
      games++;
      await cb({
        combat,
        friends,
        enemies,
        owner,
        ownerSpec: owner ? specToString(owner.spec) : null,
        file,
        combatIndex: i,
        durationSeconds,
      });
    }
    done++;
    if (progressEvery > 0 && done % progressEvery === 0) {
      console.log(`...${done}/${files.length} files`);
    }
  }
  return { files: files.length, games };
}
