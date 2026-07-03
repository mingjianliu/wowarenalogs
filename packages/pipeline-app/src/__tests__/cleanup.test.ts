import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { gzipSync } from 'zlib';

import { cleanupAppliedSegments, gzipUncompressedSize } from '../cleanup';

const DAY = 86_400_000;

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'wal-clean-root-'));
  const logs = mkdtempSync(join(tmpdir(), 'wal-clean-logs-'));
  return { root, logs };
}

function writeSegment(root: string, key: string, body: Buffer, ageDays: number, now: number): string {
  const p = join(root, ...key.split('/'));
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, gzipSync(body));
  const t = new Date(now - ageDays * DAY);
  utimesSync(p, t, t);
  return p;
}

describe('gzipUncompressedSize', () => {
  it('reads the ISIZE footer', () => {
    const gz = gzipSync(Buffer.alloc(12345, 65));
    expect(gzipUncompressedSize(gz.subarray(gz.length - 4))).toBe(12345);
  });
});

describe('cleanupAppliedSegments', () => {
  const now = 1_800_000_000_000;
  const FILE = 'WoWCombatLog-1.txt';
  const key = (off: number) => `raw/PC/${FILE}/aaaaaaaa/${String(off).padStart(12, '0')}.seg`;
  const outName = `WoWCombatLog-1.PC.aaaaaaaa.txt`;

  it('deletes old fully-applied segments, keeps recent and unapplied ones', async () => {
    const { root, logs } = setup();
    writeFileSync(join(logs, outName), Buffer.alloc(100)); // reconstructed size 100
    writeSegment(root, key(0), Buffer.alloc(60), 20, now); // applied (0+60<=100), old   → delete
    writeSegment(root, key(60), Buffer.alloc(40), 1, now); // applied (60+40<=100), new  → keep
    writeSegment(root, key(100), Buffer.alloc(50), 20, now); // NOT applied (100+50>100)   → keep
    const res = await cleanupAppliedSegments({ syncFolderRoot: root, logsDir: logs, cleanupAfterDays: 14, nowMs: now });
    expect(res.deleted).toEqual([key(0)]);
    expect(res.kept).toBe(2);
  });

  it('keeps everything when the reconstructed output is missing, never touches status/, disabled at 0', async () => {
    const { root, logs } = setup();
    writeSegment(root, key(0), Buffer.alloc(10), 30, now);
    mkdirSync(join(root, 'status'), { recursive: true });
    writeFileSync(join(root, 'status', 'PC.json'), '{}');
    expect(
      (await cleanupAppliedSegments({ syncFolderRoot: root, logsDir: logs, cleanupAfterDays: 14, nowMs: now })).deleted,
    ).toEqual([]);
    expect(
      (await cleanupAppliedSegments({ syncFolderRoot: root, logsDir: logs, cleanupAfterDays: 0, nowMs: now })).deleted,
    ).toEqual([]);
  });
});
