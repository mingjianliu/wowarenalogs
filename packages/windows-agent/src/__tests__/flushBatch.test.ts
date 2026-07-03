import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { AgentConfig } from '../config';
import { flushBatch } from '../index';
import { AgentState } from '../state';
import { MemoryStorageAdapter } from '../storage/MemoryStorageAdapter';

const LINE1 = '6/14 18:30:00.000  COMBAT_LOG_VERSION,21\n';

function setup() {
  const logsDir = mkdtempSync(join(tmpdir(), 'wal-batch-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'wal-batch-state-'));
  const adapter = new MemoryStorageAdapter();
  const config: AgentConfig = {
    wowDirectory: logsDir,
    hostname: 'PC',
    flushIntervalMs: 1000,
    quietPeriodMs: 500,
    ignoreOlderDays: 7,
    storage: { provider: 'localDir', directory: stateDir },
  };
  return { logsDir, adapter, config, statePath: join(stateDir, 'wal-agent.state.json') };
}

describe('flushBatch per-file isolation', () => {
  it('a vanished (ENOENT) file does not block later files in the batch', async () => {
    const { logsDir, adapter, config, statePath } = setup();
    writeFileSync(join(logsDir, 'WoWCombatLog-good.txt'), LINE1);
    const state: AgentState = { files: {} };
    await flushBatch({
      fileNames: ['WoWCombatLog-gone.txt', 'WoWCombatLog-good.txt'],
      config,
      adapter,
      state,
      statePath,
      logsDir,
    });
    expect(adapter.keys().filter((k) => k.includes('WoWCombatLog-good.txt'))).toHaveLength(1);
    expect(state.files['WoWCombatLog-good.txt']).toBeDefined();
  });

  it('a non-ENOENT failure is isolated: later files flush, then the batch rethrows for retry', async () => {
    const { logsDir, adapter, config, statePath } = setup();
    writeFileSync(join(logsDir, 'WoWCombatLog-a.txt'), LINE1);
    writeFileSync(join(logsDir, 'WoWCombatLog-b.txt'), LINE1);
    let calls = 0;
    const flaky = {
      put: async (key: string, body: Buffer) => {
        calls += 1;
        if (key.includes('WoWCombatLog-a.txt') && !key.startsWith('status/')) throw new Error('network down');
        return adapter.put(key, body);
      },
      list: adapter.list.bind(adapter),
      get: adapter.get.bind(adapter),
    };
    const state: AgentState = { files: {} };
    await expect(
      flushBatch({
        fileNames: ['WoWCombatLog-a.txt', 'WoWCombatLog-b.txt'],
        config,
        adapter: flaky,
        state,
        statePath,
        logsDir,
      }),
    ).rejects.toThrow(/WoWCombatLog-a\.txt/);
    expect(adapter.keys().filter((k) => k.includes('WoWCombatLog-b.txt'))).toHaveLength(1);
    expect(calls).toBeGreaterThan(0);
  });
});
