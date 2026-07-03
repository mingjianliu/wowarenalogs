/* eslint-disable no-console */
/**
 * collectLogs.ts — pull new log segments from storage and reconstruct
 * WoWCombatLog files byte-exactly under <syncDir>/logs/.
 *
 * Usage: npm run -w @wowarenalogs/tools start:collectLogs
 * Config: <syncDir>/collector.config.json  (syncDir = $WAL_SYNC_DIR or ~/wal-sync)
 */
import fs from 'fs-extra';
import path from 'path';
import zlib from 'zlib';

import { nextAction } from '../../windows-agent/src/protocol/reconstruct';
import { parseSegmentKey, SegmentRef } from '../../windows-agent/src/protocol/segments';
import { createAdapter } from '../../windows-agent/src/storage/createAdapter';
import { StorageAdapter } from '../../windows-agent/src/storage/StorageAdapter';
import { CollectorConfig, loadCollectorConfig } from './collect/collectorConfig';

export interface CollectStats {
  segmentsFetched: number;
  bytesAppended: number;
  filesUpdated: string[];
  gaps: string[];
}

/**
 * Deterministic, stable output name per (hostname, logFileName, gen8): every
 * generation gets its own file from the start. gen8 is a content hash (not
 * monotonic), so any "first generation gets the plain name" scheme can flip
 * owners between runs and silently strand data — never infer naming from
 * live key order. Names keep the WoWCombatLog*.txt shape localBatchAnalysis
 * selects on.
 */
export function outputNameFor(ref: SegmentRef): string {
  const base = ref.logFileName.endsWith('.txt') ? ref.logFileName.slice(0, -4) : ref.logFileName;
  return `${base}.${ref.hostname}.${ref.gen8}.txt`;
}

export async function runCollection(config: CollectorConfig): Promise<CollectStats> {
  const adapter: StorageAdapter = createAdapter(config.storage);
  const logsDir = path.join(config.syncDir, 'logs');
  fs.ensureDirSync(logsDir);

  const stats: CollectStats = { segmentsFetched: 0, bytesAppended: 0, filesUpdated: [], gaps: [] };
  const keys = await adapter.list('raw/');
  const refs = keys.map(parseSegmentKey).filter((r): r is SegmentRef => r !== null);

  // Group segments by (hostname, logFileName, gen8)
  const groups = new Map<string, SegmentRef[]>();
  for (const ref of refs) {
    const groupKey = `${ref.hostname}/${ref.logFileName}/${ref.gen8}`;
    const group = groups.get(groupKey) ?? [];
    group.push(ref);
    groups.set(groupKey, group);
  }

  for (const [groupKey, group] of groups) {
    const outName = outputNameFor(group[0]);
    const outPath = path.join(logsDir, outName);
    const offsets = group.map((r) => r.startOffset);
    const byOffset = new Map(group.map((r) => [r.startOffset, r]));

    let updated = false;
    // Append-only loop: each appended segment advances the file size to the
    // next expected offset. tmp+rename per cycle keeps crashes clean.
    for (;;) {
      const size = fs.pathExistsSync(outPath) ? fs.statSync(outPath).size : 0;
      const action = nextAction(size, offsets);
      if (action.type === 'done') break;
      if (action.type === 'gap') {
        const warning = `${groupKey}: gap at ${action.expected}, next segment ${action.nextAvailable}`;
        console.warn(`[collect] WARN ${warning}`);
        stats.gaps.push(warning);
        break;
      }
      const ref = byOffset.get(action.startOffset) as SegmentRef;
      const body = zlib.gunzipSync(await adapter.get(ref.key));
      const tmpPath = `${outPath}.tmp`;
      const existing = fs.pathExistsSync(outPath) ? fs.readFileSync(outPath) : Buffer.alloc(0);
      fs.writeFileSync(tmpPath, Buffer.concat([existing, body]));
      fs.renameSync(tmpPath, outPath);
      stats.segmentsFetched += 1;
      stats.bytesAppended += body.length;
      updated = true;
    }
    if (updated) stats.filesUpdated.push(outName);
  }

  console.log(
    `[collect] fetched ${stats.segmentsFetched} segment(s), +${stats.bytesAppended}B across ${stats.filesUpdated.length} file(s)` +
      (stats.gaps.length ? `, ${stats.gaps.length} gap warning(s)` : ''),
  );
  return stats;
}

if (require.main === module) {
  runCollection(loadCollectorConfig()).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
