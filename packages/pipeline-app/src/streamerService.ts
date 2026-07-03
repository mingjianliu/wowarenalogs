import { readdirSync, statSync, watch } from 'fs';
import { join } from 'path';

import { AgentConfig } from '../../windows-agent/src/config';
import { flushBatch } from '../../windows-agent/src/index';
import { selectInitialFiles } from '../../windows-agent/src/initialScan';
import { loadState } from '../../windows-agent/src/state';
import { createAdapter } from '../../windows-agent/src/storage/createAdapter';
import { startLogWatcher } from '../../windows-agent/src/watcher';

export interface StreamerState {
  status: 'streaming' | 'idle' | 'error';
  lastFlushAt: string | null;
  lastError: string | null;
}

const IDLE_AFTER_MS = 5 * 60 * 1000;

export class StreamerService {
  private watcher: ReturnType<typeof startLogWatcher> | null = null;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private lastFlushAt: string | null = null;

  constructor(
    private opts: {
      agentConfig: AgentConfig;
      statePath: string;
      onState: (s: StreamerState) => void;
      watchFn?: typeof watch;
    },
  ) {}

  start(): void {
    const { agentConfig, statePath, onState, watchFn } = this.opts;
    const adapter = createAdapter(agentConfig.storage);
    const state = loadState(statePath);
    const logsDir = join(agentConfig.wowDirectory, 'Logs');

    this.watcher = startLogWatcher({
      logsDir,
      flushIntervalMs: agentConfig.flushIntervalMs,
      quietPeriodMs: agentConfig.quietPeriodMs,
      watchFn,
      onFlush: async (fileNames) => {
        try {
          await flushBatch({ fileNames, config: agentConfig, adapter, state, statePath, logsDir });
          this.lastFlushAt = new Date().toISOString();
          onState({ status: 'streaming', lastFlushAt: this.lastFlushAt, lastError: null });
        } catch (e) {
          onState({
            status: 'error',
            lastFlushAt: this.lastFlushAt,
            lastError: e instanceof Error ? e.message : String(e),
          });
          throw e; // watcher re-dirties the batch for retry
        }
      },
    });

    // Restart/first-run seed (mirrors windows-agent/src/index.ts).
    const entries: Array<{ name: string; mtimeMs: number }> = [];
    try {
      for (const name of readdirSync(logsDir)) {
        try {
          entries.push({ name, mtimeMs: statSync(join(logsDir, name)).mtimeMs });
        } catch {
          /* vanished between readdir and stat — skip */
        }
      }
    } catch (e) {
      this.opts.onState({
        status: 'error',
        lastFlushAt: null,
        lastError: `Logs directory unreadable: ${e instanceof Error ? e.message : e}`,
      });
    }
    for (const f of selectInitialFiles(entries, Date.now(), agentConfig.ignoreOlderDays)) {
      this.watcher.handleEvent('change', f);
    }

    this.idleTimer = setInterval(() => {
      const last = this.lastFlushAt ? new Date(this.lastFlushAt).getTime() : 0;
      if (Date.now() - last > IDLE_AFTER_MS) {
        onState({ status: 'idle', lastFlushAt: this.lastFlushAt, lastError: null });
      }
    }, 60_000);
  }

  simulateEvent(fileName: string): void {
    this.watcher?.handleEvent('change', fileName);
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
  }
}
