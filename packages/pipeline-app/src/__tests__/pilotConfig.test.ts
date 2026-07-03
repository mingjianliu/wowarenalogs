import { mkdtempSync, writeFileSync } from 'fs';
import { hostname, tmpdir } from 'os';
import { join } from 'path';

import {
  configPathFor,
  loadPilotConfig,
  PilotConfig,
  resolveRole,
  savePilotConfig,
  storageConfigOf,
  toAgentConfig,
  toCollectorConfig,
  withDefaults,
} from '../pilotConfig';

const dir = () => mkdtempSync(join(tmpdir(), 'pilot-cfg-'));
const base = (): PilotConfig => withDefaults({ syncFolder: '/tmp/drive/wal-logs' });

describe('withDefaults', () => {
  it('applies spec defaults and os.hostname()', () => {
    const c = base();
    expect(c.flushIntervalMs).toBe(60000);
    expect(c.quietPeriodMs).toBe(30000);
    expect(c.ignoreOlderDays).toBe(7);
    expect(c.scheduleHours).toBe(6);
    expect(c.cleanupAfterDays).toBe(14);
    expect(c.hostname).toBe(hostname());
  });
});

describe('load/save', () => {
  it('returns null for a missing file and round-trips through save', () => {
    const p = join(dir(), 'wal-pilot.config.json');
    expect(loadPilotConfig(p)).toBeNull();
    const c = base();
    savePilotConfig(p, c);
    expect(loadPilotConfig(p)).toEqual(c);
  });
  it('throws with the path for malformed JSON', () => {
    const p = join(dir(), 'wal-pilot.config.json');
    writeFileSync(p, '{nope');
    expect(() => loadPilotConfig(p)).toThrow(/wal-pilot\.config\.json/);
  });
  it('configPathFor honors WAL_PILOT_CONFIG', () => {
    const prev = process.env.WAL_PILOT_CONFIG;
    process.env.WAL_PILOT_CONFIG = '/x/custom.config.json';
    expect(configPathFor('/ud')).toBe('/x/custom.config.json');
    if (prev === undefined) delete process.env.WAL_PILOT_CONFIG;
    else process.env.WAL_PILOT_CONFIG = prev;
    expect(configPathFor('/ud')).toBe(join('/ud', 'wal-pilot.config.json'));
  });
});

describe('resolveRole', () => {
  it('platform defaults, config override, env override (highest)', () => {
    const c = base();
    expect(resolveRole(c, 'win32', {})).toBe('streamer');
    expect(resolveRole(c, 'darwin', {})).toBe('collector');
    expect(resolveRole({ ...c, role: 'streamer' }, 'darwin', {})).toBe('streamer');
    expect(resolveRole(c, 'darwin', { WAL_PILOT_ROLE: 'streamer' })).toBe('streamer');
    expect(() => resolveRole(c, 'darwin', { WAL_PILOT_ROLE: 'bogus' })).toThrow(/WAL_PILOT_ROLE/);
  });
});

describe('mappers', () => {
  it('storageConfigOf defaults to localDir on the sync folder, honors gcs override', () => {
    expect(storageConfigOf(base())).toEqual({ provider: 'localDir', directory: '/tmp/drive/wal-logs' });
    const gcs = { provider: 'gcs' as const, bucket: 'b', keyFilename: '/k.json' };
    expect(storageConfigOf({ ...base(), storage: gcs })).toEqual(gcs);
  });
  it('toAgentConfig maps fields and requires wowDirectory', () => {
    const a = toAgentConfig({ ...base(), wowDirectory: 'C:\\WoW\\_retail_' });
    expect(a).toEqual({
      wowDirectory: 'C:\\WoW\\_retail_',
      hostname: hostname(),
      flushIntervalMs: 60000,
      quietPeriodMs: 30000,
      ignoreOlderDays: 7,
      storage: { provider: 'localDir', directory: '/tmp/drive/wal-logs' },
    });
    expect(() => toAgentConfig(base())).toThrow(/wowDirectory/);
  });
  it('toCollectorConfig pairs the storage with a local syncDir', () => {
    expect(toCollectorConfig(base(), '/Users/me/wal-sync')).toEqual({
      storage: { provider: 'localDir', directory: '/tmp/drive/wal-logs' },
      syncDir: '/Users/me/wal-sync',
    });
  });
});
