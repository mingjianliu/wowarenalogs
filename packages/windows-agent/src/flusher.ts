import { closeSync, fstatSync, openSync, readSync } from 'fs';
import { gzipSync } from 'zlib';

import { firstLineChecksum, gen8Of } from './protocol/identity';
import { buildSegmentKey } from './protocol/segments';
import { FileCheckpoint } from './state';
import { StorageAdapter } from './storage/StorageAdapter';

export interface FlushOutcome {
  checkpoint: FileCheckpoint | undefined;
  flushedBytes: number;
  reset: boolean;
  segmentKey: string | null;
}

const IDENTITY_HEAD_BYTES = 4096;

/**
 * Read-delta-and-upload for one file. Open → read → close every time; never
 * hold a handle between flushes (Windows: open handles can block the game or
 * cleanup tools from rotating/deleting the file — Filebeat's documented pitfall).
 * The checkpoint advances only after the adapter acks the put (at-least-once);
 * re-uploads land on the same key, so duplicates are idempotent end-to-end.
 */
export async function flushFile(opts: {
  filePath: string;
  logFileName: string;
  hostname: string;
  checkpoint: FileCheckpoint | undefined;
  adapter: StorageAdapter;
}): Promise<FlushOutcome> {
  const { filePath, logFileName, hostname, adapter } = opts;
  let checkpoint = opts.checkpoint;

  const fd = openSync(filePath, 'r'); // read-only, shared; WoW keeps writing happily
  let head: Buffer;
  let size: number;
  let delta: Buffer;
  let reset = false;
  try {
    size = fstatSync(fd).size;

    const headBuf = Buffer.alloc(Math.min(IDENTITY_HEAD_BYTES, size));
    readSync(fd, headBuf, 0, headBuf.length, 0);
    head = headBuf;

    const checksum = firstLineChecksum(head);
    if (checksum === null) {
      // No complete first line yet — identity pending, try again next flush.
      return { checkpoint, flushedBytes: 0, reset: false, segmentKey: null };
    }

    if (checkpoint && (checkpoint.firstLineChecksum !== checksum || size < checkpoint.offset)) {
      // Recreated or truncated file: new generation, re-stream from 0.
      checkpoint = undefined;
      reset = true;
    }

    const startOffset = checkpoint?.offset ?? 0;
    if (size <= startOffset) {
      // Duplicate fs.watch event or no growth — idempotent no-op.
      return {
        checkpoint: checkpoint ?? { offset: startOffset, firstLineChecksum: checksum },
        flushedBytes: 0,
        reset,
        segmentKey: null,
      };
    }

    delta = Buffer.alloc(size - startOffset);
    readSync(fd, delta, 0, delta.length, startOffset);

    const gen8 = gen8Of(checksum);
    const segmentKey = buildSegmentKey(hostname, logFileName, gen8, startOffset);
    await adapter.put(segmentKey, gzipSync(delta));
    return {
      checkpoint: { offset: size, firstLineChecksum: checksum },
      flushedBytes: delta.length,
      reset,
      segmentKey,
    };
  } finally {
    closeSync(fd);
  }
}
