import { readdirSync, statSync } from 'fs';
import { join } from 'path';

import { AgentConfig, loadAgentConfig } from './config';
import { flushFile } from './flusher';
import { AgentHeartbeat, writeHeartbeat } from './heartbeat';
import { selectInitialFiles } from './initialScan';
import { AgentState, loadState, saveState } from './state';
import { createAdapter } from './storage/createAdapter';
import { StorageAdapter } from './storage/StorageAdapter';
import { startLogWatcher } from './watcher';

const AGENT_VERSION = '0.1.0';

// Tracks the last heartbeat-write failure message so repeated failures within
// the same flush cadence don't spam the console (heartbeat runs every flush,
// e.g. every 60s) — only log when the failure is new or when it clears.
let lastHeartbeatError: string | null = null;

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

export async function flushBatch(opts: {
  fileNames: string[];
  config: AgentConfig;
  adapter: StorageAdapter;
  state: AgentState;
  statePath: string;
  logsDir: string;
}): Promise<void> {
  const { fileNames, config, adapter, state, statePath, logsDir } = opts;
  let lastError: string | null = null;
  let activeFile: string | null = null;
  let offset: number | null = null;
  const failed: string[] = [];

  // Sequential per batch — files are flushed one at a time (per-file
  // serialization; the watcher's overlap guard prevents concurrent batches).
  // Each file's failure is isolated: one bad file (e.g. a vanished ENOENT
  // file seeded by the initial scan) must not starve the rest of the batch,
  // since the watcher re-adds the *whole* batch on any thrown error.
  for (const fileName of fileNames) {
    activeFile = fileName;
    try {
      const outcome = await flushFile({
        filePath: join(logsDir, fileName),
        logFileName: fileName,
        hostname: config.hostname,
        checkpoint: state.files[fileName],
        adapter,
      });
      if (outcome.checkpoint) {
        state.files[fileName] = outcome.checkpoint;
        saveState(statePath, state); // registry flush after every acked upload
        offset = outcome.checkpoint.offset;
      }
      if (outcome.flushedBytes > 0) {
        console.log(`[wal-agent] ${fileName}: +${outcome.flushedBytes}B${outcome.reset ? ' (reset)' : ''}`);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
        // File is gone (e.g. deleted after being seeded by the initial scan).
        // Not a failure to retry — a recreate produces new watch events.
        console.warn(`[wal-agent] ${fileName}: vanished, dropping from queue`);
      } else {
        lastError = e instanceof Error ? e.message : String(e);
        console.error(`[wal-agent] ${fileName}: flush failed — ${lastError}`);
        failed.push(fileName);
      }
      // Continue to the next file — don't let one bad file starve the batch.
    } finally {
      const hb: AgentHeartbeat = {
        hostname: config.hostname,
        lastFlushAt: new Date().toISOString(),
        activeFile,
        offset,
        agentVersion: AGENT_VERSION,
        lastError,
      };
      await writeHeartbeat(adapter, hb)
        .then(() => {
          lastHeartbeatError = null;
        })
        .catch((hbErr: unknown) => {
          const msg = hbErr instanceof Error ? hbErr.message : String(hbErr);
          if (msg !== lastHeartbeatError) {
            lastHeartbeatError = msg;
            console.warn(`[wal-agent] heartbeat write failed: ${msg}`);
          }
        });
    }
  }

  if (failed.length > 0) {
    throw new Error(`flush failed for: ${failed.join(', ')} — ${lastError}`);
  }
}

// Exported (not self-invoked here) so this module has no top-level side effects — it is
// imported/bundled into pipeline-app's main.ts via streamerService.ts (only `flushBatch` is used
// there, but static imports still pull this whole module's top-level code into the bundle). The
// standalone CLI runner (windows-agent's own packaged `dist/wal-agent.js`) lives in ./cli.ts,
// which is the actual esbuild entry point (see package.json's `build` script) and calls this
// directly — it does NOT rely on `require.main === module`: once a module is imported by another
// bundled entry point (like pipeline-app), all module-scope code shares that entry's
// `require.main`/`module`, so such a guard would silently evaluate true and run this CLI logic
// (starting a real file watcher / cloud upload loop) inside the host process too.
export async function main(): Promise<void> {
  const configPath = argValue('--config') ?? 'wal-agent.config.json';
  if (!/\.config\.json$/.test(configPath)) {
    throw new Error(
      `Config file must be named *.config.json (got "${configPath}") — the agent derives its state file from that suffix`,
    );
  }
  const config = loadAgentConfig(configPath);
  const adapter = createAdapter(config.storage);
  const logsDir = join(config.wowDirectory, 'Logs');

  if (process.argv.includes('--check')) {
    statSync(logsDir); // throws if the Logs dir is wrong
    await adapter.list('status/'); // throws if storage/credentials are wrong
    console.log(`[wal-agent] config OK: watching ${logsDir}, storage ${config.storage.provider}`);
    return;
  }

  const statePath = configPath.replace(/\.config\.json$/, '.state.json');
  const state = loadState(statePath);

  const watcher = startLogWatcher({
    logsDir,
    flushIntervalMs: config.flushIntervalMs,
    quietPeriodMs: config.quietPeriodMs,
    onFlush: (fileNames) => flushBatch({ fileNames, config, adapter, state, statePath, logsDir }),
  });

  // First-run / restart seed: recent files may have grown while we were off.
  const entries: Array<{ name: string; mtimeMs: number }> = [];
  for (const name of readdirSync(logsDir)) {
    try {
      entries.push({ name, mtimeMs: statSync(join(logsDir, name)).mtimeMs });
    } catch {
      // File vanished between readdir and stat (AV/cleanup race) — skip it.
    }
  }
  for (const f of selectInitialFiles(entries, Date.now(), config.ignoreOlderDays)) {
    watcher.handleEvent('change', f);
  }

  console.log(`[wal-agent] v${AGENT_VERSION} watching ${logsDir} → ${config.storage.provider}`);
  process.on('SIGINT', () => {
    watcher.close();
    process.exit(0);
  });
}
