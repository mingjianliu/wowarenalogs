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

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function flushBatch(opts: {
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

  // Sequential per batch — files are flushed one at a time (per-file
  // serialization; the watcher's overlap guard prevents concurrent batches).
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
      lastError = e instanceof Error ? e.message : String(e);
      console.error(`[wal-agent] ${fileName}: flush failed — ${lastError}`);
      throw e; // rethrow so the watcher re-marks the batch dirty
    } finally {
      const hb: AgentHeartbeat = {
        hostname: config.hostname,
        lastFlushAt: new Date().toISOString(),
        activeFile,
        offset,
        agentVersion: AGENT_VERSION,
        lastError,
      };
      await writeHeartbeat(adapter, hb).catch(() => undefined); // heartbeat is best-effort
    }
  }
}

async function main(): Promise<void> {
  const configPath = argValue('--config') ?? 'wal-agent.config.json';
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
  const entries = readdirSync(logsDir).map((name) => ({
    name,
    mtimeMs: statSync(join(logsDir, name)).mtimeMs,
  }));
  for (const f of selectInitialFiles(entries, Date.now(), config.ignoreOlderDays)) {
    watcher.handleEvent('change', f);
  }

  console.log(`[wal-agent] v${AGENT_VERSION} watching ${logsDir} → ${config.storage.provider}`);
  process.on('SIGINT', () => {
    watcher.close();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error(`[wal-agent] fatal: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
