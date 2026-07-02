import { selectInitialFiles } from '../initialScan';

describe('selectInitialFiles', () => {
  const DAY = 86_400_000;
  const now = 1_800_000_000_000;

  it('keeps recent combat logs, drops old ones and non-logs', () => {
    const entries = [
      { name: 'WoWCombatLog-recent.txt', mtimeMs: now - 2 * DAY },
      { name: 'WoWCombatLog-ancient.txt', mtimeMs: now - 30 * DAY },
      { name: 'SoundCache.dat', mtimeMs: now },
      { name: 'notes-WoWCombatLog.txt.bak', mtimeMs: now },
    ];
    expect(selectInitialFiles(entries, now, 7)).toEqual(['WoWCombatLog-recent.txt']);
  });

  it('boundary: exactly ignoreOlderDays old is kept', () => {
    expect(selectInitialFiles([{ name: 'WoWCombatLog-x.txt', mtimeMs: now - 7 * DAY }], now, 7)).toEqual([
      'WoWCombatLog-x.txt',
    ]);
  });
});
