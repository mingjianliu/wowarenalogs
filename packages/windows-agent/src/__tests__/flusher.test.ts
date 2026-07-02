import { appendFileSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { gunzipSync } from 'zlib';

import { flushFile } from '../flusher';
import { MemoryStorageAdapter } from '../storage/MemoryStorageAdapter';

const LINE1 = '6/14 18:30:00.000  COMBAT_LOG_VERSION,21\n';
const LINE2 = '6/14 18:30:01.000  SPELL_CAST_SUCCESS,stuff\n';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'wal-flush-'));
  const filePath = join(dir, 'WoWCombatLog-1.txt');
  const adapter = new MemoryStorageAdapter();
  return { dir, filePath, adapter };
}
const base = { logFileName: 'WoWCombatLog-1.txt', hostname: 'PC' };

describe('flushFile', () => {
  it('uploads a new file from offset 0 and returns a checkpoint', async () => {
    const { filePath, adapter } = setup();
    writeFileSync(filePath, LINE1 + LINE2);
    const out = await flushFile({ ...base, filePath, checkpoint: undefined, adapter });
    expect(out.flushedBytes).toBe(Buffer.byteLength(LINE1 + LINE2));
    expect(out.checkpoint?.offset).toBe(Buffer.byteLength(LINE1 + LINE2));
    expect(out.reset).toBe(false);
    expect(adapter.keys()).toHaveLength(1);
    expect(adapter.keys()[0]).toMatch(/^raw\/PC\/WoWCombatLog-1\.txt\/[0-9a-f]{8}\/000000000000\.seg$/);
    const body = gunzipSync(await adapter.get(adapter.keys()[0]));
    expect(body.toString()).toBe(LINE1 + LINE2);
  });

  it('uploads only the delta for a grown file', async () => {
    const { filePath, adapter } = setup();
    writeFileSync(filePath, LINE1);
    const first = await flushFile({ ...base, filePath, checkpoint: undefined, adapter });
    appendFileSync(filePath, LINE2);
    const second = await flushFile({ ...base, filePath, checkpoint: first.checkpoint, adapter });
    expect(second.flushedBytes).toBe(Buffer.byteLength(LINE2));
    expect(adapter.keys()).toHaveLength(2);
    const deltaKey = adapter.keys().find((k) => k.endsWith(`${String(LINE1.length).padStart(12, '0')}.seg`));
    expect(deltaKey).toBeDefined();
    expect(gunzipSync(await adapter.get(deltaKey as string)).toString()).toBe(LINE2);
  });

  it('is a no-op when nothing new was written (duplicate watch event)', async () => {
    const { filePath, adapter } = setup();
    writeFileSync(filePath, LINE1);
    const first = await flushFile({ ...base, filePath, checkpoint: undefined, adapter });
    const again = await flushFile({ ...base, filePath, checkpoint: first.checkpoint, adapter });
    expect(again.flushedBytes).toBe(0);
    expect(again.segmentKey).toBeNull();
    expect(again.checkpoint).toEqual(first.checkpoint);
    expect(adapter.keys()).toHaveLength(1);
  });

  it('resets and re-streams under a new generation when the file is recreated', async () => {
    const { filePath, adapter } = setup();
    writeFileSync(filePath, LINE1 + LINE2);
    const first = await flushFile({ ...base, filePath, checkpoint: undefined, adapter });
    const RECREATED = '6/15 09:00:00.000  COMBAT_LOG_VERSION,21,NEW_SESSION\n';
    writeFileSync(filePath, RECREATED); // same name, new (shorter) content
    const out = await flushFile({ ...base, filePath, checkpoint: first.checkpoint, adapter });
    expect(out.reset).toBe(true);
    expect(out.flushedBytes).toBe(Buffer.byteLength(RECREATED));
    const gens = new Set(adapter.keys().map((k) => k.split('/')[3]));
    expect(gens.size).toBe(2); // old and new generation both present, no collision
  });

  it('defers when the file has no complete first line yet', async () => {
    const { filePath, adapter } = setup();
    writeFileSync(filePath, 'partial-without-newline');
    const out = await flushFile({ ...base, filePath, checkpoint: undefined, adapter });
    expect(out.checkpoint).toBeUndefined();
    expect(out.flushedBytes).toBe(0);
    expect(adapter.keys()).toHaveLength(0);
  });

  it('does not advance the checkpoint when the upload fails', async () => {
    const { filePath, adapter } = setup();
    writeFileSync(filePath, LINE1);
    const failing = {
      put: async () => {
        throw new Error('network down');
      },
      list: adapter.list.bind(adapter),
      get: adapter.get.bind(adapter),
    };
    await expect(flushFile({ ...base, filePath, checkpoint: undefined, adapter: failing })).rejects.toThrow(
      'network down',
    );
    // caller keeps the old checkpoint (undefined here); a retry then succeeds:
    const retry = await flushFile({ ...base, filePath, checkpoint: undefined, adapter });
    expect(retry.checkpoint?.offset).toBe(Buffer.byteLength(LINE1));
  });
});
