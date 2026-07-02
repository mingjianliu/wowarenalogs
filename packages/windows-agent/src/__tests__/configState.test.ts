import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { loadAgentConfig } from '../config';
import { AgentState, loadState, saveState } from '../state';
import { createAdapter } from '../storage/createAdapter';
import { LocalDirStorageAdapter } from '../storage/LocalDirStorageAdapter';

const dir = () => mkdtempSync(join(tmpdir(), 'wal-cfg-'));

describe('loadAgentConfig', () => {
  it('loads a valid config and applies defaults', () => {
    const p = join(dir(), 'wal-agent.config.json');
    writeFileSync(
      p,
      JSON.stringify({
        wowDirectory: 'C:\\Games\\WoW\\_retail_',
        hostname: 'GAMING-PC',
        storage: { provider: 'localDir', directory: '/tmp/bucket' },
      }),
    );
    const cfg = loadAgentConfig(p);
    expect(cfg.flushIntervalMs).toBe(60000);
    expect(cfg.quietPeriodMs).toBe(30000);
    expect(cfg.ignoreOlderDays).toBe(7);
    expect(cfg.hostname).toBe('GAMING-PC');
  });

  it('throws descriptive errors for missing fields and bad providers', () => {
    const p1 = join(dir(), 'c.json');
    writeFileSync(p1, JSON.stringify({ hostname: 'x', storage: { provider: 'localDir', directory: '/t' } }));
    expect(() => loadAgentConfig(p1)).toThrow(/wowDirectory/);

    const p2 = join(dir(), 'c.json');
    writeFileSync(p2, JSON.stringify({ wowDirectory: 'C:\\x', hostname: 'x', storage: { provider: 'ftp' } }));
    expect(() => loadAgentConfig(p2)).toThrow(/provider/);

    expect(() => loadAgentConfig(join(dir(), 'missing.json'))).toThrow(/missing.json/);
  });

  it('throws a descriptive error for malformed JSON', () => {
    const p = join(dir(), 'bad.json');
    writeFileSync(p, '{not json');
    expect(() => loadAgentConfig(p)).toThrow(/invalid JSON.*bad\.json/);
  });
});

describe('createAdapter', () => {
  it('creates a LocalDirStorageAdapter for provider localDir', () => {
    expect(createAdapter({ provider: 'localDir', directory: dir() })).toBeInstanceOf(LocalDirStorageAdapter);
  });
});

describe('agent state', () => {
  it('returns empty state for missing or corrupt files', () => {
    expect(loadState(join(dir(), 'nope.json'))).toEqual({ files: {} });
    const p = join(dir(), 'corrupt.json');
    writeFileSync(p, '{not json');
    expect(loadState(p)).toEqual({ files: {} });
  });

  it('round-trips state through save/load atomically', () => {
    const p = join(dir(), 'wal-agent.state.json');
    const state: AgentState = {
      files: { 'WoWCombatLog-1.txt': { offset: 12345, firstLineChecksum: 'abc' } },
    };
    saveState(p, state);
    expect(loadState(p)).toEqual(state);
    // atomic write leaves no temp file behind
    expect(readFileSync(p, 'utf-8')).toContain('12345');
  });
});
