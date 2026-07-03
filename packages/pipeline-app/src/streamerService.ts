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
  private startedAt = 0;

  constructor(
    private opts: {
      agentConfig: AgentConfig;
      statePath: string;
      onState: (s: StreamerState) => void;
      watchFn?: typeof watch;
      idleAfterMs?: number;
    },
  ) {}

  start(): void {
    const { agentConfig, statePath, onState, watchFn } = this.opts;
    const logsDir = join(agentConfig.wowDirectory, 'Logs');

    // Validate the Logs dir BEFORE constructing the watcher — fs.watch throws
    // synchronously on a missing dir, which would bypass any later guard.
    let names: string[];
    try {
      names = readdirSync(logsDir);
    } catch (e) {
      const msg = `Logs directory unreadable: ${e instanceof Error ? e.message : String(e)}`;
      onState({ status: 'error', lastFlushAt: null, lastError: msg });
      throw new Error(msg);
    }

    const adapter = createAdapter(agentConfig.storage);
    const state = loadState(statePath);
    this.startedAt = Date.now();

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
    for (const name of names) {
      try {
        entries.push({ name, mtimeMs: statSync(join(logsDir, name)).mtimeMs });
      } catch {
        /* vanished between readdir and stat — skip */
      }
    }
    for (const f of selectInitialFiles(entries, Date.now(), agentConfig.ignoreOlderDays)) {
      this.watcher.handleEvent('change', f);
    }

    const idleAfterMs = this.opts.idleAfterMs ?? IDLE_AFTER_MS;
    this.idleTimer = setInterval(
      () => {
        const last = this.lastFlushAt ? new Date(this.lastFlushAt).getTime() : this.startedAt;
        if (Date.now() - last > idleAfterMs) {
          onState({ status: 'idle', lastFlushAt: this.lastFlushAt, lastError: null });
        }
      },
      Math.min(idleAfterMs, 60_000),
    );
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
