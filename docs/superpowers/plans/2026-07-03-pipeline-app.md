# wal-pilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One Electron tray app (`wal-pilot`) that runs the streamer role on Windows and the collector+analysis role on macOS, defaulting to a Google Drive synced folder as transport, with a one-screen setup wizard and installers for both platforms.

**Architecture:** Thin Electron host around the merged pipeline services. Pure logic (config, role, detection, cleanup) lives in electron-free modules with unit tests; role services re-host the existing watcher/flusher and collector/analysis code in the main process; the existing dashboard server/page is parametrized and reused for the UI window. esbuild bundles the main process (precedent: `wal-agent.js` bundle); electron-builder produces `.dmg` + `.exe`.

**Tech Stack:** Electron ^38, electron-builder ^25 (hoisted at root), esbuild ^0.25, bare jest (hoisted patched jest 30, same as `windows-agent`), TypeScript strict, existing `windows-agent`/`tools` source modules.

**Spec:** `docs/superpowers/specs/2026-07-03-pipeline-app-design.md` (also amends `2026-07-02-log-streaming-pipeline-design.md`'s StorageAdapter interface — Task 3).

## Global Constraints

- Zero lint warnings (`--max-warnings 0` per package); `strict: true` TS; avoid `any`.
- All work in the worktree `/Users/mingjianliu/code/wowarenalogs/.worktrees/pipeline-app`; paths below relative to it. After editing any file: `npx prettier --write <file_path>`.
- `packages/pipeline-app` may import SOURCE from `packages/windows-agent/src/` and `packages/tools/src/` (established pattern); NEVER from `@wowarenalogs/app`. `windows-agent` and `tools` must NOT import from `pipeline-app`.
- Pure/testable modules in `pipeline-app/src` must NOT import `electron` (only `main.ts`, `tray.ts`, `wizardIpc.ts` may).
- CLI compatibility invariants: `start:localBatchAnalysis`, `start:collectLogs`, `start:collectAndAnalyze`, `dashboard` npm scripts keep working unchanged; app and CLI share `~/wal-sync` state files (`status.json`, `runs.jsonl`, `logs/`) and the `run.lock` dir convention.
- Do NOT pin jest/electron/etc. at the repo ROOT package.json (a root jest pin previously broke parser/shared — see ledger history). New deps go in `packages/pipeline-app/package.json` only.
- Tests: `cd packages/pipeline-app && npm test` (bare jest, `jest.config.js` preset ts-jest, mirrors `packages/windows-agent`).
- Known pre-existing failures NOT to touch: `packages/shared` claimChecker suites; `packages/tools` promptBuilder test.
- Analysis defaults: no API key → claude CLI backend, `ANALYSIS_CLI_MODEL` default `opus` (do not change).

## Existing interfaces consumed (verified on this branch)

- `packages/windows-agent/src/index.ts`: `flushBatch(opts: { fileNames: string[]; config: AgentConfig; adapter: StorageAdapter; state: AgentState; statePath: string; logsDir: string }): Promise<void>` (per-file isolation; throws aggregate error if any non-ENOENT failure).
- `packages/windows-agent/src/watcher.ts`: `startLogWatcher(opts: { logsDir; flushIntervalMs; quietPeriodMs; onFlush: (files: string[]) => Promise<void>; watchFn? }): { close(): void; handleEvent(eventType: string, fileName: string | Buffer | null): void }`.
- `packages/windows-agent/src/initialScan.ts`: `selectInitialFiles(entries: {name, mtimeMs}[], nowMs, ignoreOlderDays): string[]`.
- `packages/windows-agent/src/state.ts`: `loadState(path): AgentState`, `saveState(path, state)`, `AgentState { files: Record<string, FileCheckpoint> }`.
- `packages/windows-agent/src/config.ts`: `AgentConfig { wowDirectory; hostname; flushIntervalMs; quietPeriodMs; ignoreOlderDays; storage: StorageConfig }`, `StorageConfig`.
- `packages/windows-agent/src/storage/`: `StorageAdapter { put; list; get }` (+`delete` after Task 3), `LocalDirStorageAdapter(rootDir)`, `MemoryStorageAdapter` (+`keys()`), `GcsStorageAdapter(config, client?)`, `createAdapter(storage)`, `describeStorageAdapterContract(name, factory)`.
- `packages/windows-agent/src/protocol/segments.ts`: `parseSegmentKey(key): SegmentRef | null` (`SegmentRef { hostname; logFileName; gen8; startOffset; key }`), `buildHeartbeatKey(hostname)`.
- `packages/tools/src/collectLogs.ts`: `runCollection(config: CollectorConfig): Promise<CollectStats>`, `CollectStats { segmentsFetched; bytesAppended; filesUpdated: string[]; gaps: string[] }`, internal `outputNameFor(ref)` (exported in Task 6).
- `packages/tools/src/collect/collectorConfig.ts`: `CollectorConfig { storage: StorageConfig; syncDir: string }`, `syncDirPath()`, `loadCollectorConfig()`.
- `packages/tools/src/collect/statusFile.ts`: `CollectorStatus { phase: 'idle'|'collecting'|'analyzing'; updatedAt; detail }`, `RunRecord { startedAt; finishedAt; segmentsFetched; bytesAppended; filesUpdated; gaps; analysisExitCode: number | null; error: string | null }`, `writeStatus(syncDir, status)`, `appendRun(syncDir, run)`, `readRuns(syncDir, limit)`.
- `packages/tools/src/dashboard/server.ts`: currently a top-level script binding 5178 (refactored in Task 9); `packages/tools/src/dashboard/index.html` self-contained page; `schedule.ts` `readScheduleInterval()`, `nextRunAt(lastRunAt, intervalSeconds)`.

---

### Task 1: Scaffold `packages/pipeline-app`

**Files:**

- Create: `packages/pipeline-app/package.json`
- Create: `packages/pipeline-app/tsconfig.json`
- Create: `packages/pipeline-app/.eslintrc.js`
- Create: `packages/pipeline-app/.eslintignore`
- Create: `packages/pipeline-app/jest.config.js`
- Create: `packages/pipeline-app/src/index.ts` (placeholder `export {};`, replaced in Task 10)
- Modify: `.gitignore` (root — add `packages/pipeline-app/release/` if `release/` isn't already ignored; check with `git check-ignore packages/pipeline-app/release/x` after creating a dummy — `dist` is already covered)

**Interfaces:**

- Consumes: nothing.
- Produces: workspace `@wowarenalogs/pipeline-app` where lint/typecheck/test gates run; `npm run build` (esbuild main bundle) and `npm run dist` (electron-builder) wired for later tasks.

- [ ] **Step 1: Create `packages/pipeline-app/package.json`**

```json
{
  "name": "@wowarenalogs/pipeline-app",
  "version": "0.1.0",
  "private": true,
  "description": "wal-pilot: tray app hosting the log-streaming (Windows) and collect+analyze (macOS) pipeline roles",
  "main": "dist/main.js",
  "author": "WoW Arena Logs",
  "scripts": {
    "lint": "eslint . --max-warnings 0",
    "lint:fix": "eslint . --fix",
    "typecheck": "tsc --noEmit",
    "test": "jest --passWithNoTests=false",
    "build": "esbuild src/main.ts --bundle --platform=node --external:electron --outfile=dist/main.js && shx cp src/wizard.html src/preload.js dist/ && shx cp ../tools/src/dashboard/index.html dist/dashboard.html",
    "start": "npm run build && electron .",
    "dist": "npm run build && electron-builder --mac dmg --arm64 && electron-builder --win nsis --x64"
  },
  "dependencies": {
    "electron": "^38"
  },
  "devDependencies": {
    "@types/node": "^22",
    "esbuild": "^0.25.0",
    "eslint-config-wowarenalogs": "*",
    "fs-extra": "^11.1.0",
    "shx": "^0.3.4",
    "typescript": "^4.9.5"
  },
  "build": {
    "appId": "gg.wowarenalogs.walpilot",
    "productName": "wal-pilot",
    "directories": { "output": "release" },
    "files": ["dist/**/*", "package.json"],
    "mac": { "target": "dmg", "extendInfo": { "LSUIElement": 1 } },
    "win": { "target": "nsis" },
    "nsis": { "oneClick": true, "perMachine": false }
  }
}
```

Notes: `electron-builder` and `jest` resolve from the hoisted root install (same as `packages/app`/`windows-agent` patterns) — do NOT add them here or at root. `fs-extra` is used by imported tools source; `shx` copies assets cross-platform (same tool `packages/app` uses).

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "es2020",
    "lib": ["es2020", "dom"],
    "module": "commonjs",
    "moduleResolution": "node",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noFallthroughCasesInSwitch": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "outDir": "dist"
  },
  "include": ["src/"]
}
```

(`dom` lib because the wizard preload types touch DOM globals; main-process files stay node-only.)

- [ ] **Step 3: Create `.eslintrc.js`, `.eslintignore`, `jest.config.js`**

`.eslintrc.js`:

```js
module.exports = {
  extends: ['wowarenalogs'],
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
  },
  rules: {
    // Tray app: console output is the log surface (mirrors tools/windows-agent).
    'no-console': 'off',
  },
};
```

`.eslintignore`:

```
node_modules
dist
release
.eslintrc.js
jest.config.js
src/preload.js
```

`jest.config.js`:

```js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
};
```

- [ ] **Step 4: Create placeholder `src/index.ts`** containing exactly `export {};` (tsc needs an input; `main.ts` arrives in Task 10).

- [ ] **Step 5: Install + gates**

```bash
cd /Users/mingjianliu/code/wowarenalogs/.worktrees/pipeline-app
npm install
npm run -w @wowarenalogs/pipeline-app typecheck && npm run -w @wowarenalogs/pipeline-app lint
```

Expected: workspace links; both exit 0. Also verify the root install still applies the jest patch: `npm install` output contains `jest-environment-node@30.4.1 ✔`.

- [ ] **Step 6: Commit**

```bash
git add packages/pipeline-app package-lock.json
git commit -m "feat(pipeline-app): scaffold wal-pilot Electron package"
```

---

### Task 2: Refactor `localBatchAnalysis` to be importable

**Files:**

- Modify: `packages/tools/src/localBatchAnalysis.ts`

**Interfaces:**

- Consumes: existing internals of the file (runPhase1/runPhase2, `LOG_DIR` const).
- Produces: `export interface BatchStats { processed: number; skipped: number; failed: number; unparseable: number }` and `export async function runBatchAnalysis(opts: { logDir: string; maxMatches?: number; phase1Only?: boolean; phase2Only?: boolean }): Promise<BatchStats>`. CLI behavior unchanged (argv + `LOG_DIR` env), guarded by `require.main === module`.

- [ ] **Step 1: Refactor.** Concrete changes:

1. Change `const LOG_DIR = ...` to a function default used only by the CLI path:

```ts
const DEFAULT_LOG_DIR = process.env.LOG_DIR ?? path.join(os.homedir(), 'Downloads/wow logs');
```

2. Change `runPhase1(maxMatches: number)` to `runPhase1(logDir: string, maxMatches: number): Promise<BatchStats>`: replace every `LOG_DIR` reference inside with `logDir`; replace the `process.exit(1)` on "No WoWCombatLog files" with `throw new Error(\`No WoWCombatLog\*.txt files found in ${logDir}\`)`; at the end `return { processed: total, skipped, failed, unparseable };` (keep the console.log lines).

3. `runPhase2()` keeps its signature; replace its two `process.exit(1)` calls with `throw new Error(...)` carrying the same messages.

4. Add the exported types/function and the CLI guard at the bottom:

```ts
export interface BatchStats {
  processed: number;
  skipped: number;
  failed: number;
  unparseable: number;
}

/** In-process entry for wal-pilot; the CLI path below remains unchanged. */
export async function runBatchAnalysis(opts: {
  logDir: string;
  maxMatches?: number;
  phase1Only?: boolean;
  phase2Only?: boolean;
}): Promise<BatchStats> {
  let stats: BatchStats = { processed: 0, skipped: 0, failed: 0, unparseable: 0 };
  if (!opts.phase2Only) stats = await runPhase1(opts.logDir, opts.maxMatches ?? Number.POSITIVE_INFINITY);
  if (!opts.phase1Only) await runPhase2();
  return stats;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const maxIdx = args.indexOf('--max-matches');
  const maxMatches = maxIdx !== -1 ? parseInt(args[maxIdx + 1], 10) : undefined;
  if (maxIdx !== -1 && (Number.isNaN(maxMatches) || (maxMatches as number) <= 0)) {
    console.error('--max-matches requires a positive integer');
    process.exit(1);
  }
  await runBatchAnalysis({
    logDir: DEFAULT_LOG_DIR,
    maxMatches,
    phase1Only: args.includes('--phase1-only'),
    phase2Only: args.includes('--phase2-only'),
  });
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
```

(Delete the old `main` + top-level `main().catch(...)` and the old `--max-matches` parsing it contained — the logic above replaces them 1:1.)

- [ ] **Step 2: Verify import-safety and CLI parity**

```bash
cd /Users/mingjianliu/code/wowarenalogs/.worktrees/pipeline-app/packages/tools
npx ts-node --files -e "const m = require('./src/localBatchAnalysis'); console.log('import ok:', typeof m.runBatchAnalysis);"
# Expected: prints "import ok: function" and EXITS without running any batch.
mkdir -p local-batch && [ -f local-batch/results.jsonl ] || echo '{"meta":{"logFile":"x.txt","matchIndex":1,"spec":"Unknown","bracket":"3v3","result":"Win","durationSeconds":120,"myTeam":[],"enemyTeam":[],"processedAt":"2026-07-03T00:00:00Z"},"prompt":"p","aiResponse":"r","feedbackSection":""}' > local-batch/results.jsonl
env -u ANTHROPIC_API_KEY ANALYSIS_BACKEND= npx ts-node --files ./src/localBatchAnalysis.ts --phase2-only
# Expected: CLI path still runs Phase 2 (claude CLI backend will be used since it's installed — output is a real meta summary; that is fine and proves parity).
```

- [ ] **Step 3: Prettier, lint, typecheck, commit**

```bash
npx prettier --write src/localBatchAnalysis.ts
npm run lint && npm run typecheck
cd /Users/mingjianliu/code/wowarenalogs/.worktrees/pipeline-app
git add packages/tools && git commit -m "refactor(tools): export runBatchAnalysis; guard CLI behind require.main"
```

---

### Task 3: Add `delete` to StorageAdapter (needed by cleanup)

**Files:**

- Modify: `packages/windows-agent/src/storage/StorageAdapter.ts`
- Modify: `packages/windows-agent/src/storage/MemoryStorageAdapter.ts`
- Modify: `packages/windows-agent/src/storage/LocalDirStorageAdapter.ts`
- Modify: `packages/windows-agent/src/storage/GcsStorageAdapter.ts`
- Modify: `packages/windows-agent/src/storage/adapterContract.ts`
- Modify: `packages/windows-agent/src/__tests__/gcsAdapter.test.ts`
- Modify: `docs/superpowers/specs/2026-07-02-log-streaming-pipeline-design.md` (interface snippet + "3 methods" wording)

**Interfaces:**

- Produces: `StorageAdapter.delete(key: string): Promise<void>` — idempotent: deleting a missing key resolves silently (simplifies cleanup retries).

- [ ] **Step 1: Extend the contract suite first** — in `adapterContract.ts`, add inside the describe:

```ts
it('delete removes a key and is idempotent for missing keys', async () => {
  await adapter.put('k/gone', Buffer.from('x'));
  await adapter.delete('k/gone');
  expect(await adapter.list('k/')).toEqual([]);
  await expect(adapter.delete('k/gone')).resolves.toBeUndefined(); // second delete: no throw
  await expect(adapter.delete('never/existed')).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail** — `cd packages/windows-agent && npm test` → FAIL: `delete is not a function` for both contract-bound adapters, plus TS compile errors until the interface gains the method.

- [ ] **Step 3: Implement.**

`StorageAdapter.ts` — add to the interface (and update the doc comment "3 methods" → "4 methods"):

```ts
  /** Idempotent: deleting a missing key resolves silently. */
  delete(key: string): Promise<void>;
```

`MemoryStorageAdapter.ts`:

```ts
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
```

`LocalDirStorageAdapter.ts`:

```ts
  async delete(key: string): Promise<void> {
    try {
      await fs.unlink(this.pathOf(key));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
```

`GcsStorageAdapter.ts` — extend `GcsClientLike`'s file object with `delete(): Promise<unknown>;` and implement:

```ts
  async delete(key: string): Promise<void> {
    try {
      await this.bucketRef.file(key).delete();
    } catch (e) {
      // GCS throws a 404-coded error for missing objects — idempotent contract.
      if ((e as { code?: number }).code !== 404) throw e;
    }
  }
```

`gcsAdapter.test.ts` — extend the stub's file object with `delete: async () => { calls.delete.push([bucketName, key]); }` (add `delete: []` to `calls`) and add:

```ts
it('delete maps to file(key).delete', async () => {
  const { stub, calls } = makeStub();
  const adapter = new GcsStorageAdapter({ bucket: 'my-bucket' }, stub);
  await adapter.delete('k/a');
  expect(calls.delete).toEqual([['my-bucket', 'k/a']]);
});
```

- [ ] **Step 4: Run tests to verify pass** — `npm test` → all suites green (contract now runs the delete test against Memory and LocalDir).

- [ ] **Step 5: Amend spec** — in `docs/superpowers/specs/2026-07-02-log-streaming-pipeline-design.md`, add `delete(key: string): Promise<void>;` to the interface code block and change the sentence fragment "deliberately tiny (3 methods" to "deliberately tiny (4 methods".

- [ ] **Step 6: Prettier, lint, commit**

```bash
npx prettier --write src/storage/*.ts src/__tests__/gcsAdapter.test.ts
npm run lint && npm run typecheck
cd /Users/mingjianliu/code/wowarenalogs/.worktrees/pipeline-app
git add packages/windows-agent docs
git commit -m "feat(windows-agent): StorageAdapter.delete (idempotent) across all adapters"
```

---

### Task 4: Pilot config module

**Files:**

- Create: `packages/pipeline-app/src/pilotConfig.ts`
- Test: `packages/pipeline-app/src/__tests__/pilotConfig.test.ts`

**Interfaces:**

- Consumes: `AgentConfig`, `StorageConfig` (windows-agent), `CollectorConfig` (tools).
- Produces:

```ts
export type PilotRole = 'streamer' | 'collector';
export interface PilotConfig {
  role?: PilotRole;
  syncFolder: string;
  wowDirectory?: string;
  hostname: string;
  flushIntervalMs: number; // default 60000
  quietPeriodMs: number; // default 30000
  ignoreOlderDays: number; // default 7
  scheduleHours: number; // default 6
  cleanupAfterDays: number; // default 14; 0 = never
  storage?: { provider: 'gcs'; bucket: string; keyFilename: string };
}
export function withDefaults(partial: Partial<PilotConfig> & { syncFolder: string }): PilotConfig; // hostname default os.hostname()
export function loadPilotConfig(configPath: string): PilotConfig | null; // null when absent; throws on malformed JSON with path in message
export function savePilotConfig(configPath: string, cfg: PilotConfig): void; // tmp+rename
export function configPathFor(userDataDir: string): string; // env WAL_PILOT_CONFIG overrides; else <userData>/wal-pilot.config.json
export function resolveRole(cfg: PilotConfig, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): PilotRole; // env.WAL_PILOT_ROLE > cfg.role > (win32 → streamer, else collector); invalid env value throws
export function storageConfigOf(cfg: PilotConfig): StorageConfig; // cfg.storage ?? { provider: 'localDir', directory: cfg.syncFolder }
export function toAgentConfig(cfg: PilotConfig): AgentConfig; // throws if wowDirectory missing
export function toCollectorConfig(cfg: PilotConfig, syncDir: string): CollectorConfig;
```

- [ ] **Step 1: Write the failing tests** — `packages/pipeline-app/src/__tests__/pilotConfig.test.ts`

```ts
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
```

- [ ] **Step 2: Run to verify FAIL** — `cd packages/pipeline-app && npm test` → module not found.

- [ ] **Step 3: Implement `src/pilotConfig.ts`**

```ts
import { readFileSync, renameSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

import { AgentConfig, StorageConfig } from '../../windows-agent/src/config';
import { CollectorConfig } from '../../tools/src/collect/collectorConfig';

export type PilotRole = 'streamer' | 'collector';

export interface PilotConfig {
  role?: PilotRole;
  syncFolder: string;
  wowDirectory?: string;
  hostname: string;
  flushIntervalMs: number;
  quietPeriodMs: number;
  ignoreOlderDays: number;
  scheduleHours: number;
  cleanupAfterDays: number;
  storage?: { provider: 'gcs'; bucket: string; keyFilename: string };
}

const DEFAULTS = {
  flushIntervalMs: 60000,
  quietPeriodMs: 30000,
  ignoreOlderDays: 7,
  scheduleHours: 6,
  cleanupAfterDays: 14,
};

export function withDefaults(partial: Partial<PilotConfig> & { syncFolder: string }): PilotConfig {
  return {
    ...DEFAULTS,
    hostname: os.hostname(),
    ...partial,
    syncFolder: partial.syncFolder,
  };
}

export function configPathFor(userDataDir: string): string {
  return process.env.WAL_PILOT_CONFIG ?? path.join(userDataDir, 'wal-pilot.config.json');
}

export function loadPilotConfig(configPath: string): PilotConfig | null {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch {
    return null; // absent → first-run wizard
  }
  try {
    return withDefaults(JSON.parse(raw) as Partial<PilotConfig> & { syncFolder: string });
  } catch {
    throw new Error(`Malformed config JSON: ${configPath}`);
  }
}

export function savePilotConfig(configPath: string, cfg: PilotConfig): void {
  const tmp = `${configPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  renameSync(tmp, configPath);
}

export function resolveRole(cfg: PilotConfig, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): PilotRole {
  const envRole = env.WAL_PILOT_ROLE;
  if (envRole !== undefined) {
    if (envRole !== 'streamer' && envRole !== 'collector') {
      throw new Error(`WAL_PILOT_ROLE must be "streamer" or "collector", got "${envRole}"`);
    }
    return envRole;
  }
  if (cfg.role) return cfg.role;
  return platform === 'win32' ? 'streamer' : 'collector';
}

export function storageConfigOf(cfg: PilotConfig): StorageConfig {
  return cfg.storage ?? { provider: 'localDir', directory: cfg.syncFolder };
}

export function toAgentConfig(cfg: PilotConfig): AgentConfig {
  if (!cfg.wowDirectory) throw new Error('Config error: "wowDirectory" is required for the streamer role');
  return {
    wowDirectory: cfg.wowDirectory,
    hostname: cfg.hostname,
    flushIntervalMs: cfg.flushIntervalMs,
    quietPeriodMs: cfg.quietPeriodMs,
    ignoreOlderDays: cfg.ignoreOlderDays,
    storage: storageConfigOf(cfg),
  };
}

export function toCollectorConfig(cfg: PilotConfig, syncDir: string): CollectorConfig {
  return { storage: storageConfigOf(cfg), syncDir };
}
```

- [ ] **Step 4: Run to verify PASS**, then prettier/lint/typecheck, commit:

```bash
git add packages/pipeline-app/src
git commit -m "feat(pipeline-app): PilotConfig load/save, role resolution, service config mappers"
```

---

### Task 5: Drive-folder + WoW-dir detection

**Files:**

- Create: `packages/pipeline-app/src/detect.ts`
- Test: `packages/pipeline-app/src/__tests__/detect.test.ts`

**Interfaces:**

- Produces (pure, fs injected):

```ts
export interface FsProbe {
  exists(p: string): boolean;
  listDir(p: string): string[];
} // listDir returns [] on error
export function detectSyncFolderCandidates(opts: { platform: NodeJS.Platform; home: string; probe: FsProbe }): string[];
export function detectWowDirCandidates(opts: { platform: NodeJS.Platform; probe: FsProbe }): string[]; // each candidate has an existing Logs/ subdir
export function realFsProbe(): FsProbe;
```

Rules (from spec §4): macOS candidates = every `~/Library/CloudStorage/GoogleDrive-*/My Drive` that exists; Windows = every `<L>:\My Drive` for L in G..Z that exists, plus `<home>\My Drive`. WoW dirs (win32 only; other platforms return []): `C:\Program Files (x86)\World of Warcraft\_retail_` and `C:\Program Files\World of Warcraft\_retail_`, kept only when `<dir>\Logs` exists.

- [ ] **Step 1: Failing tests** — `packages/pipeline-app/src/__tests__/detect.test.ts`

```ts
import { detectSyncFolderCandidates, detectWowDirCandidates, FsProbe } from '../detect';

function probeOf(existing: string[], listings: Record<string, string[]> = {}): FsProbe {
  return {
    exists: (p) => existing.includes(p),
    listDir: (p) => listings[p] ?? [],
  };
}

describe('detectSyncFolderCandidates', () => {
  it('macOS: finds GoogleDrive-* CloudStorage mounts with My Drive', () => {
    const home = '/Users/me';
    const cs = '/Users/me/Library/CloudStorage';
    const probe = probeOf(['/Users/me/Library/CloudStorage/GoogleDrive-a@gmail.com/My Drive'], {
      [cs]: ['GoogleDrive-a@gmail.com', 'OneDrive-Personal'],
    });
    expect(detectSyncFolderCandidates({ platform: 'darwin', home, probe })).toEqual([
      '/Users/me/Library/CloudStorage/GoogleDrive-a@gmail.com/My Drive',
    ]);
  });
  it('windows: probes G:..Z: drive roots and the home fallback', () => {
    const probe = probeOf(['G:\\My Drive', 'H:\\My Drive', 'C:\\Users\\me\\My Drive']);
    expect(detectSyncFolderCandidates({ platform: 'win32', home: 'C:\\Users\\me', probe })).toEqual([
      'G:\\My Drive',
      'H:\\My Drive',
      'C:\\Users\\me\\My Drive',
    ]);
  });
  it('returns [] when nothing is found', () => {
    expect(detectSyncFolderCandidates({ platform: 'darwin', home: '/u', probe: probeOf([]) })).toEqual([]);
  });
});

describe('detectWowDirCandidates', () => {
  it('keeps only install dirs with an existing Logs subdir (win32)', () => {
    const withLogs = 'C:\\Program Files (x86)\\World of Warcraft\\_retail_';
    const probe = probeOf([withLogs, `${withLogs}\\Logs`, 'C:\\Program Files\\World of Warcraft\\_retail_']);
    expect(detectWowDirCandidates({ platform: 'win32', probe })).toEqual([withLogs]);
  });
  it('non-windows returns []', () => {
    expect(detectWowDirCandidates({ platform: 'darwin', probe: probeOf(['x']) })).toEqual([]);
  });
});
```

- [ ] **Step 2: FAIL run**, then **Step 3: Implement `src/detect.ts`**

```ts
import { existsSync, readdirSync } from 'fs';

export interface FsProbe {
  exists(p: string): boolean;
  listDir(p: string): string[];
}

export function realFsProbe(): FsProbe {
  return {
    exists: (p) => existsSync(p),
    listDir: (p) => {
      try {
        return readdirSync(p);
      } catch {
        return [];
      }
    },
  };
}

export function detectSyncFolderCandidates(opts: {
  platform: NodeJS.Platform;
  home: string;
  probe: FsProbe;
}): string[] {
  const { platform, home, probe } = opts;
  if (platform === 'darwin') {
    const cloudStorage = `${home}/Library/CloudStorage`;
    return probe
      .listDir(cloudStorage)
      .filter((name) => name.startsWith('GoogleDrive-'))
      .map((name) => `${cloudStorage}/${name}/My Drive`)
      .filter((p) => probe.exists(p));
  }
  if (platform === 'win32') {
    const candidates: string[] = [];
    for (let c = 'G'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
      const p = `${String.fromCharCode(c)}:\\My Drive`;
      if (probe.exists(p)) candidates.push(p);
    }
    const homeDrive = `${home}\\My Drive`;
    if (probe.exists(homeDrive)) candidates.push(homeDrive);
    return candidates;
  }
  return [];
}

export function detectWowDirCandidates(opts: { platform: NodeJS.Platform; probe: FsProbe }): string[] {
  if (opts.platform !== 'win32') return [];
  return [
    'C:\\Program Files (x86)\\World of Warcraft\\_retail_',
    'C:\\Program Files\\World of Warcraft\\_retail_',
  ].filter((dir) => opts.probe.exists(dir) && opts.probe.exists(`${dir}\\Logs`));
}
```

- [ ] **Step 4: PASS run, prettier/lint, commit** — `git add packages/pipeline-app/src && git commit -m "feat(pipeline-app): sync-folder and WoW-dir detection (pure, fs-injected)"`

---

### Task 6: Drive-folder cleanup

**Files:**

- Create: `packages/pipeline-app/src/cleanup.ts`
- Modify: `packages/tools/src/collectLogs.ts` (export `outputNameFor`)
- Test: `packages/pipeline-app/src/__tests__/cleanup.test.ts`

**Interfaces:**

- Consumes: `parseSegmentKey`, `SegmentRef` (windows-agent protocol), `outputNameFor(ref: SegmentRef): string` (tools — add `export` to the existing function, no body change).
- Produces:

```ts
export function gzipUncompressedSize(tail4: Buffer): number; // gzip ISIZE footer, little-endian
export interface CleanupResult {
  deleted: string[];
  kept: number;
}
export async function cleanupAppliedSegments(opts: {
  syncFolderRoot: string; // the Drive folder (localDir root)
  logsDir: string; // reconstructed logs dir
  cleanupAfterDays: number; // 0 = disabled (returns immediately)
  nowMs?: number;
}): Promise<CleanupResult>;
```

Behavior: walk `<syncFolderRoot>/raw/**` files via fs; for each parseable segment key (path relative to root, `/`-joined): applied ⇔ `startOffset + gzipUncompressedSize(last 4 bytes of file) <= size of <logsDir>/<outputNameFor(ref)>` (missing output file → not applied); delete applied segments with `mtimeMs < nowMs - cleanupAfterDays*86400000` via `fs.unlink`. Never touches `status/`. localDir mode only — the caller (collector service) skips cleanup when the storage override is GCS (GCS users rely on bucket lifecycle rules; note this in the spec §6 sentence if absent — it is scoped to "Drive-folder hygiene" already, no spec change needed).

- [ ] **Step 1: Failing tests** — `packages/pipeline-app/src/__tests__/cleanup.test.ts`

```ts
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
```

- [ ] **Step 2: FAIL run.** Also export `outputNameFor` in `packages/tools/src/collectLogs.ts` (change `function outputNameFor(` to `export function outputNameFor(`).

- [ ] **Step 3: Implement `src/cleanup.ts`**

```ts
import { promises as fs } from 'fs';
import path from 'path';

import { parseSegmentKey } from '../../windows-agent/src/protocol/segments';
import { outputNameFor } from '../../tools/src/collectLogs';

export function gzipUncompressedSize(tail4: Buffer): number {
  return tail4.readUInt32LE(0);
}

export interface CleanupResult {
  deleted: string[];
  kept: number;
}

/**
 * Drive-folder hygiene (spec §6): reconstructed logs are the durable copy, so
 * segments whose bytes are fully applied AND older than cleanupAfterDays are
 * safe to delete. localDir mode only — GCS users rely on bucket lifecycle.
 */
export async function cleanupAppliedSegments(opts: {
  syncFolderRoot: string;
  logsDir: string;
  cleanupAfterDays: number;
  nowMs?: number;
}): Promise<CleanupResult> {
  const result: CleanupResult = { deleted: [], kept: 0 };
  if (opts.cleanupAfterDays <= 0) return result;
  const now = opts.nowMs ?? Date.now();
  const cutoff = now - opts.cleanupAfterDays * 86_400_000;
  const rawRoot = path.join(opts.syncFolderRoot, 'raw');

  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else files.push(p);
    }
  };
  await walk(rawRoot);

  const outputSizes = new Map<string, number>();
  const sizeOf = async (outName: string): Promise<number> => {
    if (!outputSizes.has(outName)) {
      try {
        outputSizes.set(outName, (await fs.stat(path.join(opts.logsDir, outName))).size);
      } catch {
        outputSizes.set(outName, -1); // missing output → nothing from it counts as applied
      }
    }
    return outputSizes.get(outName) as number;
  };

  for (const filePath of files) {
    const key = path.relative(opts.syncFolderRoot, filePath).split(path.sep).join('/');
    const ref = parseSegmentKey(key);
    if (!ref) {
      result.kept += 1;
      continue;
    }
    const stat = await fs.stat(filePath);
    const fh = await fs.open(filePath, 'r');
    let isize: number;
    try {
      const tail = Buffer.alloc(4);
      await fh.read(tail, 0, 4, Math.max(0, stat.size - 4));
      isize = gzipUncompressedSize(tail);
    } finally {
      await fh.close();
    }
    const applied = ref.startOffset + isize <= (await sizeOf(outputNameFor(ref)));
    if (applied && stat.mtimeMs < cutoff) {
      await fs.unlink(filePath);
      result.deleted.push(key);
    } else {
      result.kept += 1;
    }
  }
  return result;
}
```

- [ ] **Step 4: PASS run** (`cd packages/pipeline-app && npm test`), prettier on both changed files, lint+typecheck BOTH packages (`pipeline-app` and `tools`), commit:

```bash
git add packages/pipeline-app/src packages/tools/src/collectLogs.ts
git commit -m "feat(pipeline-app): applied-segment cleanup via gzip ISIZE; export outputNameFor"
```

---

### Task 7: Streamer service

**Files:**

- Create: `packages/pipeline-app/src/streamerService.ts`
- Test: `packages/pipeline-app/src/__tests__/streamerService.test.ts`

**Interfaces:**

- Consumes: `flushBatch`, `startLogWatcher` (+its `watchFn` injection), `selectInitialFiles`, `loadState`/`saveState`, `createAdapter`, `AgentConfig`.
- Produces:

```ts
export interface StreamerState {
  status: 'streaming' | 'idle' | 'error';
  lastFlushAt: string | null;
  lastError: string | null;
}
export class StreamerService {
  constructor(opts: {
    agentConfig: AgentConfig;
    statePath: string; // checkpoint state file location (userData)
    onState: (s: StreamerState) => void;
    watchFn?: typeof import('fs').watch; // test injection, passed through to startLogWatcher
  });
  start(): void; // seeds initial scan, starts watcher
  stop(): void;
  simulateEvent(fileName: string): void; // forwards a 'change' event (tests + future manual flush)
}
```

Behavior: `start()` builds the adapter via `createAdapter(agentConfig.storage)`, loads state, starts the watcher with `onFlush = flushBatch(...)`; after each successful flush batch emits `{status:'streaming', lastFlushAt: now, lastError: null}`; a flush error emits `{status:'error', lastError}` (the watcher already re-dirties for retry); if no flush completed for 5 minutes emits `idle` (interval check, cleared by `stop()`). Initial scan mirrors `windows-agent/src/index.ts`: readdir + per-entry stat with try/catch, `selectInitialFiles`, forward via `simulateEvent`.

- [ ] **Step 1: Failing tests**

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { StreamerService, StreamerState } from '../streamerService';

const noopWatch = (() => ({ close: jest.fn() })) as unknown as typeof import('fs').watch;
const LINE = '6/14 18:30:00.000  COMBAT_LOG_VERSION,21\n';

function setup() {
  const wow = mkdtempSync(join(tmpdir(), 'pilot-wow-'));
  mkdirSync(join(wow, 'Logs'));
  const bucket = mkdtempSync(join(tmpdir(), 'pilot-bucket-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'pilot-state-'));
  const states: StreamerState[] = [];
  const svc = new StreamerService({
    agentConfig: {
      wowDirectory: wow,
      hostname: 'TEST-PC',
      flushIntervalMs: 30,
      quietPeriodMs: 10,
      ignoreOlderDays: 7,
      storage: { provider: 'localDir', directory: bucket },
    },
    statePath: join(stateDir, 'wal-pilot.state.json'),
    onState: (s) => states.push(s),
    watchFn: noopWatch,
  });
  return { wow, bucket, states, svc };
}

describe('StreamerService', () => {
  it('flushes a seeded file and reports streaming state', async () => {
    const { wow, states, svc } = setup();
    writeFileSync(join(wow, 'Logs', 'WoWCombatLog-1.txt'), LINE);
    svc.start(); // initial scan seeds the file
    await new Promise((r) => setTimeout(r, 200)); // quiet-period flush at 10ms
    svc.stop();
    const streaming = states.filter((s) => s.status === 'streaming');
    expect(streaming.length).toBeGreaterThanOrEqual(1);
    expect(streaming[0].lastError).toBeNull();
  });

  it('reports error state when the storage target is unwritable, and keeps running', async () => {
    const { wow, states, svc } = setup();
    writeFileSync(join(wow, 'Logs', 'WoWCombatLog-1.txt'), LINE);
    // sabotage: replace bucket dir with a file so localDir mkdir fails
    // (constructed service points at bucket; remove+recreate as file)
    svc.start();
    svc.stop();
    // rebuild service against an impossible directory
    const bad = new StreamerService({
      agentConfig: {
        wowDirectory: wow,
        hostname: 'TEST-PC',
        flushIntervalMs: 30,
        quietPeriodMs: 10,
        ignoreOlderDays: 7,
        storage: { provider: 'localDir', directory: '/dev/null/nope' },
      },
      statePath: join(mkdtempSync(join(tmpdir(), 'pilot-state2-')), 's.json'),
      onState: (s) => states.push(s),
      watchFn: noopWatch,
    });
    bad.start();
    await new Promise((r) => setTimeout(r, 200));
    bad.stop();
    expect(states.some((s) => s.status === 'error' && s.lastError)).toBe(true);
  });
});
```

- [ ] **Step 2: FAIL run.** **Step 3: Implement `src/streamerService.ts`**

```ts
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
```

- [ ] **Step 4: PASS run, prettier/lint/typecheck, commit** — `git commit -m "feat(pipeline-app): StreamerService re-hosting watcher+flushBatch with state events"`

---

### Task 8: Collector service

**Files:**

- Create: `packages/pipeline-app/src/collectorService.ts`
- Test: `packages/pipeline-app/src/__tests__/collectorService.test.ts`

**Interfaces:**

- Consumes: `runCollection`/`CollectStats`, `runBatchAnalysis`/`BatchStats` (Task 2), `writeStatus`/`appendRun`, `cleanupAppliedSegments` (Task 6), `CollectorConfig`.
- Produces:

```ts
export type CollectorPhase = 'idle' | 'collecting' | 'analyzing' | 'cleaning';
export class CollectorService {
  constructor(opts: {
    collectorConfig: CollectorConfig; // storage + syncDir (~/wal-sync)
    scheduleHours: number;
    cleanupAfterDays: number; // cleanup runs only when storage.provider === 'localDir'
    onPhase: (phase: CollectorPhase, detail: string) => void;
    runners?: {
      // test injection; defaults are the real functions
      collect?: typeof runCollection;
      analyze?: typeof runBatchAnalysis;
      cleanup?: typeof cleanupAppliedSegments;
    };
  });
  start(): void; // schedules every scheduleHours (no immediate run)
  stop(): void;
  runNow(): Promise<'completed' | 'busy' | 'failed'>; // lock-guarded; safe to call anytime
  lockPath(): string; // <syncDir>/run.lock (shared with CLI)
}
```

`runNow()` behavior: `mkdirSync(lockPath)` — `EEXIST` → return `'busy'` without touching state files; otherwise `try { writeStatus collecting → runCollection → writeStatus analyzing → runBatchAnalysis({ logDir: <syncDir>/logs }) → if localDir: writeStatus cleaning → cleanup } finally { writeStatus idle + appendRun (RunRecord shape: analysisExitCode 0 on success / 1 when analysis threw, error message captured) + rmdirSync(lock) }`. Scheduler = `setInterval(runNow, scheduleHours*3600e3)` (unref'd not required — app lifetime).

- [ ] **Step 1: Failing tests** (fake runners; real lock dir):

```ts
import { mkdirSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { readRuns } from '../../../tools/src/collect/statusFile';
import { CollectorService } from '../collectorService';

function setup(overrides: Partial<{ collectFails: boolean; analyzeFails: boolean }> = {}) {
  const syncDir = mkdtempSync(join(tmpdir(), 'pilot-sync-'));
  const drive = mkdtempSync(join(tmpdir(), 'pilot-drive-'));
  const phases: string[] = [];
  const calls = { collect: 0, analyze: 0, cleanup: 0 };
  const svc = new CollectorService({
    collectorConfig: { storage: { provider: 'localDir', directory: drive }, syncDir },
    scheduleHours: 6,
    cleanupAfterDays: 14,
    onPhase: (p, d) => phases.push(`${p}:${d.slice(0, 20)}`),
    runners: {
      collect: async () => {
        calls.collect += 1;
        if (overrides.collectFails) throw new Error('collect boom');
        return { segmentsFetched: 2, bytesAppended: 10, filesUpdated: ['a'], gaps: [] };
      },
      analyze: async () => {
        calls.analyze += 1;
        if (overrides.analyzeFails) throw new Error('analyze boom');
        return { processed: 1, skipped: 0, failed: 0, unparseable: 0 };
      },
      cleanup: async () => {
        calls.cleanup += 1;
        return { deleted: [], kept: 0 };
      },
    },
  });
  return { svc, syncDir, phases, calls };
}

describe('CollectorService.runNow', () => {
  it('runs collect → analyze → cleanup and records a successful RunRecord', async () => {
    const { svc, syncDir, calls } = setup();
    expect(await svc.runNow()).toBe('completed');
    expect(calls).toEqual({ collect: 1, analyze: 1, cleanup: 1 });
    const runs = readRuns(syncDir, 5);
    expect(runs).toHaveLength(1);
    expect(runs[0].analysisExitCode).toBe(0);
    expect(runs[0].segmentsFetched).toBe(2);
    expect(runs[0].error).toBeNull();
  });

  it('returns busy without state writes when the lock is held', async () => {
    const { svc, syncDir } = setup();
    mkdirSync(svc.lockPath());
    expect(await svc.runNow()).toBe('busy');
    expect(readRuns(syncDir, 5)).toHaveLength(0);
  });

  it('records failures and releases the lock', async () => {
    const { svc, syncDir } = setup({ analyzeFails: true });
    expect(await svc.runNow()).toBe('failed');
    const runs = readRuns(syncDir, 5);
    expect(runs[0].analysisExitCode).toBe(1);
    expect(runs[0].error).toMatch(/analyze boom/);
    expect(await svc.runNow()).toBe('failed'); // lock was released → runs again
    expect(readRuns(syncDir, 5)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: FAIL run.** **Step 3: Implement `src/collectorService.ts`**

```ts
import { mkdirSync, rmdirSync } from 'fs';
import path from 'path';

import { CollectorConfig } from '../../tools/src/collect/collectorConfig';
import { appendRun, writeStatus } from '../../tools/src/collect/statusFile';
import { CollectStats, runCollection } from '../../tools/src/collectLogs';
import { runBatchAnalysis } from '../../tools/src/localBatchAnalysis';
import { cleanupAppliedSegments } from './cleanup';

export type CollectorPhase = 'idle' | 'collecting' | 'analyzing' | 'cleaning';

export class CollectorService {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private opts: {
      collectorConfig: CollectorConfig;
      scheduleHours: number;
      cleanupAfterDays: number;
      onPhase: (phase: CollectorPhase, detail: string) => void;
      runners?: {
        collect?: typeof runCollection;
        analyze?: typeof runBatchAnalysis;
        cleanup?: typeof cleanupAppliedSegments;
      };
    },
  ) {}

  lockPath(): string {
    return path.join(this.opts.collectorConfig.syncDir, 'run.lock');
  }

  start(): void {
    this.timer = setInterval(() => {
      void this.runNow();
    }, this.opts.scheduleHours * 3_600_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runNow(): Promise<'completed' | 'busy' | 'failed'> {
    const { collectorConfig, cleanupAfterDays, onPhase } = this.opts;
    const collect = this.opts.runners?.collect ?? runCollection;
    const analyze = this.opts.runners?.analyze ?? runBatchAnalysis;
    const cleanup = this.opts.runners?.cleanup ?? cleanupAppliedSegments;
    const { syncDir, storage } = collectorConfig;
    const logDir = path.join(syncDir, 'logs');

    try {
      mkdirSync(this.lockPath());
    } catch {
      return 'busy'; // CLI run or another trigger holds the lock — same convention as collect-and-analyze.sh
    }

    const startedAt = new Date().toISOString();
    let stats: CollectStats = { segmentsFetched: 0, bytesAppended: 0, filesUpdated: [], gaps: [] };
    let analysisExitCode: number | null = null;
    let error: string | null = null;
    const setPhase = (phase: CollectorPhase, detail: string) => {
      writeStatus(syncDir, {
        phase: phase === 'cleaning' ? 'idle' : phase,
        updatedAt: new Date().toISOString(),
        detail,
      });
      onPhase(phase, detail);
    };

    try {
      setPhase('collecting', 'listing segments');
      stats = await collect(collectorConfig);
      setPhase('analyzing', `analyzing logs in ${logDir}`);
      try {
        await analyze({ logDir });
        analysisExitCode = 0;
      } catch (e) {
        analysisExitCode = 1;
        error = e instanceof Error ? e.message : String(e);
      }
      if (!error && storage.provider === 'localDir' && cleanupAfterDays > 0) {
        setPhase('cleaning', 'removing applied segments');
        await cleanup({ syncFolderRoot: storage.directory, logsDir: logDir, cleanupAfterDays });
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      writeStatus(syncDir, { phase: 'idle', updatedAt: new Date().toISOString(), detail: error ?? 'ok' });
      onPhase('idle', error ?? 'ok');
      appendRun(syncDir, {
        startedAt,
        finishedAt: new Date().toISOString(),
        segmentsFetched: stats.segmentsFetched,
        bytesAppended: stats.bytesAppended,
        filesUpdated: stats.filesUpdated,
        gaps: stats.gaps,
        analysisExitCode,
        error,
      });
      try {
        rmdirSync(this.lockPath());
      } catch {
        /* already gone */
      }
    }
    return error ? 'failed' : 'completed';
  }
}
```

Note: `CollectorStatus.phase` has no `'cleaning'` value — the status FILE reports `idle` during cleanup (see `setPhase`) while the UI callback still gets the richer phase. This keeps `statusFile.ts` untouched for CLI compatibility.

- [ ] **Step 4: PASS run, prettier/lint/typecheck, commit** — `git commit -m "feat(pipeline-app): CollectorService — scheduled lock-guarded collect→analyze→cleanup"`

---

### Task 9: Dashboard server parametrization + streamer page section

**Files:**

- Modify: `packages/tools/src/dashboard/server.ts`
- Modify: `packages/tools/src/dashboard/index.html`

**Interfaces:**

- Produces:

```ts
export interface DashboardServerOptions {
  htmlPath?: string; // default: index.html beside server.ts
  basePort?: number; // default 5178; tries +1 up to +10 on EADDRINUSE
  extraStatus?: () => Promise<Record<string, unknown>>; // merged into /api/status as `local`
  onRunNow?: () => Promise<'started' | 'busy'>; // default: spawn launchd/collect-and-analyze.sh (current behavior)
}
export function createDashboardServer(opts?: DashboardServerOptions): Promise<{ port: number; close(): void }>;
```

- CLI behavior preserved: `require.main === module` block calls `createDashboardServer()` with defaults and logs the URL — `npm run -w @wowarenalogs/tools dashboard` works exactly as before.
- New: `POST /api/run` rejects requests whose `Origin` header exists and is not `http://127.0.0.1:<port>` / `http://localhost:<port>` with 403 (closes the CSRF fix-later; browser same-page fetches send no Origin for same-origin GET but DO send it for POST — matching origins pass).
- `index.html`: when `/api/status` JSON has a `local` object (`{ role: 'streamer', state: { status, lastFlushAt, lastError } }`), render a "This machine" section at the top (escaped via the existing `esc()`); the Run Now button hides when `local.role === 'streamer'`.

- [ ] **Step 1: Refactor `server.ts`.** Wrap the existing `buildStatus`, request handler, and `listen` into `createDashboardServer(opts)`: `PORT` becomes `basePort` with an EADDRINUSE retry loop (max +10, then reject); `PAGE` reads `opts.htmlPath ?? path.join(__dirname, 'index.html')`; `/api/status` body becomes `JSON.stringify({ ...(await buildStatus()), ...(opts.extraStatus ? { local: await opts.extraStatus() } : {}) })`; `/api/run` calls `opts.onRunNow ?? defaultRunNow` where `defaultRunNow` is the current spawn logic returning `'busy'` when the lock exists and `'started'` after spawning; add the Origin check before dispatch:

```ts
const origin = req.headers.origin;
if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
  res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'forbidden origin' }));
  return;
}
```

Keep: body-before-writeHead on /api/status, `headersSent` guard in the catch, 127.0.0.1 binding. CLI entry at the bottom:

```ts
if (require.main === module) {
  void createDashboardServer().then(({ port }) => console.log(`[dashboard] http://127.0.0.1:${port}`));
}
```

- [ ] **Step 2: Extend `index.html`.** Add after the `<h1>`: `<div id="localwrap" style="display:none"><h2>This machine</h2><div id="local"></div></div>`, and in `refresh()`:

```js
if (s.local) {
  document.getElementById('localwrap').style.display = '';
  const st = s.local.state || {};
  $('local').innerHTML = `<p>role <b>${esc(s.local.role)}</b> — <span class="${
    st.status === 'error' ? 'err' : st.status === 'streaming' ? 'ok' : ''
  }">${esc(st.status)}</span> ${st.lastFlushAt ? `— last flush ${ago(st.lastFlushAt)}` : ''} ${
    st.lastError ? `<span class="err">err: ${esc(st.lastError)}</span>` : ''
  }</p>`;
  if (s.local.role === 'streamer') $('run').style.display = 'none';
}
```

- [ ] **Step 3: Functional check (CLI parity + new endpoint behavior)**

```bash
cd /Users/mingjianliu/code/wowarenalogs/.worktrees/pipeline-app
S=$(mktemp -d); B=$(mktemp -d)
echo "{ \"storage\": { \"provider\": \"localDir\", \"directory\": \"$B\" } }" > "$S/collector.config.json"
WAL_SYNC_DIR=$S npm run -w @wowarenalogs/tools dashboard &
sleep 4
curl -s http://127.0.0.1:5178/api/status | head -c 200; echo
curl -s -X POST -H "Origin: http://evil.example" http://127.0.0.1:5178/api/run; echo   # expect {"error":"forbidden origin"}
curl -s -X POST http://127.0.0.1:5178/api/run; echo                                     # expect started (no Origin header → allowed)
kill %1
```

- [ ] **Step 4: Prettier, lint, typecheck (tools), commit** — `git add packages/tools && git commit -m "refactor(tools): createDashboardServer(opts) — port fallback, Origin check, local-role section"`

---

### Task 10: Electron main — tray, wizard, window, service lifecycle

**Files:**

- Create: `packages/pipeline-app/src/main.ts` (replaces placeholder role of `src/index.ts`; delete `src/index.ts`)
- Create: `packages/pipeline-app/src/wizard.html`
- Create: `packages/pipeline-app/src/preload.js` (plain JS, tiny — stays outside tsc/eslint per .eslintignore)
- Test: none (Electron shell; verified by Step 4 smoke + Task 12 e2e). All logic with branches lives in Tasks 4–8 modules.

**Interfaces:**

- Consumes: everything from Tasks 4–9.
- Produces: the runnable app. `WAL_PILOT_ROLE`, `WAL_PILOT_CONFIG`, `WAL_SYNC_DIR` env overrides all honored (the latter via `syncDirPath()` from tools).

- [ ] **Step 1: `src/wizard.html`** (self-contained; talks to preload bridge `window.walpilot`):

```html
<meta charset="utf-8" />
<title>wal-pilot setup</title>
<style>
  :root {
    color-scheme: dark;
  }
  body {
    font:
      14px/1.6 -apple-system,
      'Segoe UI',
      sans-serif;
    background: #111418;
    color: #d5dbe1;
    margin: 2rem;
  }
  h1 {
    font-size: 1.2rem;
  }
  label {
    display: block;
    margin-top: 1rem;
    color: #8ab4f8;
  }
  input[type='text'] {
    width: 100%;
    padding: 6px 8px;
    background: #1b1f24;
    color: inherit;
    border: 1px solid #2a2f36;
    border-radius: 6px;
  }
  .row {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  button {
    background: #1f6feb;
    color: white;
    border: 0;
    padding: 8px 14px;
    border-radius: 6px;
    cursor: pointer;
    font: inherit;
  }
  button.secondary {
    background: #30363d;
  }
  .err {
    color: #ff7b72;
    min-height: 1.2em;
  }
  .hint {
    color: #8b949e;
    font-size: 12px;
  }
</style>
<h1>wal-pilot setup</h1>
<div id="roleline" class="hint"></div>
<label>Synced folder (Google Drive)</label>
<div class="row"><input id="sync" type="text" /><button class="secondary" id="pickSync">Browse…</button></div>
<div class="hint">Segments are written under this folder; it must sync on both machines.</div>
<div id="wowblock" style="display:none">
  <label>WoW folder (_retail_)</label>
  <div class="row"><input id="wow" type="text" /><button class="secondary" id="pickWow">Browse…</button></div>
</div>
<label class="row" style="color:inherit"><input id="login" type="checkbox" checked /> Start wal-pilot at login</label>
<p class="err" id="err"></p>
<p><button id="save">Save &amp; start</button></p>
<script>
  (async () => {
    const d = await window.walpilot.getDefaults();
    document.getElementById('roleline').textContent = `This machine's role: ${d.role}`;
    document.getElementById('sync').value = d.syncFolder || '';
    if (d.role === 'streamer') {
      document.getElementById('wowblock').style.display = '';
      document.getElementById('wow').value = d.wowDirectory || '';
    }
    document.getElementById('pickSync').onclick = async () => {
      const p = await window.walpilot.pickFolder();
      if (p) document.getElementById('sync').value = p;
    };
    document.getElementById('pickWow').onclick = async () => {
      const p = await window.walpilot.pickFolder();
      if (p) document.getElementById('wow').value = p;
    };
    document.getElementById('save').onclick = async () => {
      const res = await window.walpilot.saveConfig({
        syncFolder: document.getElementById('sync').value,
        wowDirectory: document.getElementById('wow').value || undefined,
        openAtLogin: document.getElementById('login').checked,
      });
      document.getElementById('err').textContent = res.error || '';
    };
  })();
</script>
```

- [ ] **Step 2: `src/preload.js`**

```js
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('walpilot', {
  getDefaults: () => ipcRenderer.invoke('walpilot:getDefaults'),
  pickFolder: () => ipcRenderer.invoke('walpilot:pickFolder'),
  saveConfig: (cfg) => ipcRenderer.invoke('walpilot:saveConfig', cfg),
});
```

- [ ] **Step 3: `src/main.ts`**

```ts
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Tray } from 'electron';
import { mkdirSync } from 'fs';
import os from 'os';
import path from 'path';

import { syncDirPath } from '../../tools/src/collect/collectorConfig';
import { createDashboardServer } from '../../tools/src/dashboard/server';
import { CollectorService } from './collectorService';
import { detectSyncFolderCandidates, detectWowDirCandidates, realFsProbe } from './detect';
import {
  configPathFor,
  loadPilotConfig,
  PilotConfig,
  resolveRole,
  savePilotConfig,
  toAgentConfig,
  toCollectorConfig,
  withDefaults,
} from './pilotConfig';
import { StreamerService, StreamerState } from './streamerService';

let tray: Tray | null = null;
let dashboardPort = 0;
let paused = false;
let streamer: StreamerService | null = null;
let collector: CollectorService | null = null;
let localState: StreamerState = { status: 'idle', lastFlushAt: null, lastError: null };
let collectorPhase = 'idle';
let restartDelayMs = 10_000;

const isMac = process.platform === 'darwin';

function trayGlyph(state: 'active' | 'idle' | 'error'): string {
  return state === 'active' ? '▶' : state === 'error' ? '⚠' : '○';
}

function updateTray(state: 'active' | 'idle' | 'error', tooltip: string): void {
  if (!tray) return;
  if (isMac) tray.setTitle(trayGlyph(state));
  tray.setToolTip(`wal-pilot — ${tooltip}`);
}

async function makeTray(role: string): Promise<Tray> {
  // macOS: empty image + title glyph in the menu bar. Windows: reuse the exe's own icon.
  let image = nativeImage.createEmpty();
  if (!isMac) {
    try {
      image = await app.getFileIcon(process.execPath, { size: 'small' });
    } catch {
      /* keep empty image */
    }
  }
  const t = new Tray(image);
  const rebuildMenu = () => {
    t.setContextMenu(
      Menu.buildFromTemplate([
        { label: `wal-pilot (${role})`, enabled: false },
        { label: 'Open Dashboard', click: () => openDashboard() },
        ...(role === 'collector' ? [{ label: 'Run Now', click: () => void collector?.runNow() }] : []),
        {
          label: paused ? 'Resume' : 'Pause',
          click: () => {
            paused = !paused;
            if (paused) stopServices();
            else startServices();
            rebuildMenu();
          },
        },
        {
          label: 'Start at Login',
          type: 'checkbox',
          checked: app.getLoginItemSettings().openAtLogin,
          click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
        },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() },
      ]),
    );
  };
  rebuildMenu();
  return t;
}

function openDashboard(): void {
  const win = new BrowserWindow({ width: 980, height: 720, title: 'wal-pilot' });
  void win.loadURL(`http://127.0.0.1:${dashboardPort}`);
}

function currentConfig(): PilotConfig | null {
  return loadPilotConfig(configPathFor(app.getPath('userData')));
}

function startServices(): void {
  const cfg = currentConfig();
  if (!cfg || paused) return;
  const role = resolveRole(cfg, process.platform, process.env);
  try {
    if (role === 'streamer') {
      streamer = new StreamerService({
        agentConfig: toAgentConfig(cfg),
        statePath: path.join(app.getPath('userData'), 'wal-pilot.state.json'),
        onState: (s) => {
          localState = s;
          updateTray(
            s.status === 'error' ? 'error' : s.status === 'streaming' ? 'active' : 'idle',
            s.lastError ?? s.status,
          );
        },
      });
      streamer.start();
      restartDelayMs = 10_000;
    } else {
      const syncDir = syncDirPath();
      mkdirSync(syncDir, { recursive: true });
      collector = new CollectorService({
        collectorConfig: toCollectorConfig(cfg, syncDir),
        scheduleHours: cfg.scheduleHours,
        cleanupAfterDays: cfg.cleanupAfterDays,
        onPhase: (phase, detail) => {
          collectorPhase = phase;
          updateTray(phase === 'idle' ? (detail === 'ok' ? 'idle' : 'error') : 'active', `${phase}: ${detail}`);
        },
      });
      collector.start();
    }
  } catch (e) {
    // Service constructor/start failure (e.g. missing wowDirectory): surface + retry with backoff.
    const msg = e instanceof Error ? e.message : String(e);
    localState = { status: 'error', lastFlushAt: null, lastError: msg };
    updateTray('error', msg);
    setTimeout(startServices, restartDelayMs);
    restartDelayMs = Math.min(restartDelayMs * 2, 300_000);
  }
}

function stopServices(): void {
  streamer?.stop();
  streamer = null;
  collector?.stop();
  collector = null;
  updateTray('idle', 'paused');
}

function openWizard(role: string): void {
  const win = new BrowserWindow({
    width: 560,
    height: 480,
    title: 'wal-pilot setup',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  void win.loadFile(path.join(__dirname, 'wizard.html'));

  ipcMain.handle('walpilot:getDefaults', () => {
    const probe = realFsProbe();
    const syncCandidates = detectSyncFolderCandidates({ platform: process.platform, home: os.homedir(), probe });
    const wowCandidates = detectWowDirCandidates({ platform: process.platform, probe });
    return {
      role,
      syncFolder: syncCandidates[0] ? path.join(syncCandidates[0], 'wal-logs') : '',
      wowDirectory: wowCandidates[0] ?? '',
    };
  });
  ipcMain.handle('walpilot:pickFolder', async () => {
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return res.canceled ? null : res.filePaths[0];
  });
  ipcMain.handle(
    'walpilot:saveConfig',
    (_evt, input: { syncFolder: string; wowDirectory?: string; openAtLogin: boolean }) => {
      if (!input.syncFolder) return { error: 'Pick a synced folder first.' };
      if (role === 'streamer' && !input.wowDirectory) return { error: 'Pick the WoW _retail_ folder.' };
      try {
        mkdirSync(input.syncFolder, { recursive: true });
        const cfg = withDefaults({ syncFolder: input.syncFolder, wowDirectory: input.wowDirectory });
        savePilotConfig(configPathFor(app.getPath('userData')), cfg);
        app.setLoginItemSettings({ openAtLogin: input.openAtLogin });
        win.close();
        startServices();
        return { error: null };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  );
}

async function main(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  await app.whenReady();
  if (isMac) app.dock?.hide();

  const cfg = currentConfig();
  const role = cfg
    ? resolveRole(cfg, process.platform, process.env)
    : process.platform === 'win32'
      ? 'streamer'
      : 'collector';
  tray = await makeTray(role);
  updateTray('idle', 'starting');

  const { port } = await createDashboardServer({
    htmlPath: path.join(__dirname, 'dashboard.html'),
    extraStatus: async () => ({
      role,
      state: role === 'streamer' ? localState : { status: collectorPhase, lastFlushAt: null, lastError: null },
    }),
    onRunNow: async () => {
      if (!collector) return 'busy';
      const result = await collector.runNow();
      return result === 'busy' ? 'busy' : 'started';
    },
  });
  dashboardPort = port;

  if (!cfg) openWizard(role);
  else startServices();
}

app.on('window-all-closed', () => {
  /* tray app: stay alive */
});
void main();
```

- [ ] **Step 4: Build + smoke on this Mac** (collector role is the platform default):

```bash
cd /Users/mingjianliu/code/wowarenalogs/.worktrees/pipeline-app/packages/pipeline-app
npm run build
ls dist/   # expect main.js, wizard.html, preload.js, dashboard.html
SMOKE_CFG=$(mktemp -d)/wal-pilot.config.json
DRIVE=$(mktemp -d); SYNC=$(mktemp -d)
cat > "$SMOKE_CFG" <<EOF
{ "syncFolder": "$DRIVE", "hostname": "SMOKE-MAC" }
EOF
WAL_PILOT_CONFIG="$SMOKE_CFG" WAL_SYNC_DIR="$SYNC" npx electron . &
sleep 6
curl -s http://127.0.0.1:5178/api/status | python3 -c "import json,sys; d=json.load(sys.stdin); print('local:', d.get('local'))"
kill %1
```

Expected: `local: {'role': 'collector', 'state': {...}}`. A menu-bar glyph appears while it runs. (If port 5178 is taken by a CLI dashboard, the app takes 5179 — adjust the curl.)

- [ ] **Step 5: Prettier (`src/main.ts`; leave `preload.js`/`wizard.html` prettier-formatted too), lint, typecheck, delete `src/index.ts`, commit**

```bash
git add packages/pipeline-app
git commit -m "feat(pipeline-app): electron main — tray, wizard, dashboard window, service lifecycle"
```

---

### Task 11: Packaging (dmg + exe)

**Files:**

- Modify: `packages/pipeline-app/package.json` (only if Step 1 uncovers config gaps)

**Interfaces:** consumes the `dist` script from Task 1; produces `release/wal-pilot-*.dmg` and `release/wal-pilot Setup *.exe`.

- [ ] **Step 1: Build both installers**

```bash
cd /Users/mingjianliu/code/wowarenalogs/.worktrees/pipeline-app/packages/pipeline-app
npm run dist 2>&1 | tail -20
ls -la release/ | grep -E '\.dmg|\.exe'
```

Expected: one `.dmg` (arm64) and one `.exe` (x64 NSIS). electron-builder resolves from the hoisted root install. If the win build fails on missing wine/signing: NSIS target does not need wine in electron-builder ≥24 and we don't sign — read the actual error before reaching for flags; `CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist` disables mac signing discovery if it stalls there.

- [ ] **Step 2: Launch the packaged mac app once**

```bash
open "release/mac-arm64/wal-pilot.app" --args
sleep 8 && curl -s http://127.0.0.1:5178/ | head -c 80; echo
osascript -e 'quit app "wal-pilot"' 2>/dev/null || pkill -f "wal-pilot.app" || true
```

Expected: with no config, the setup wizard window appears (this is the packaged smoke — first-run path); the dashboard responds. Quit cleanly. (The wizard writes to the REAL userData if completed — do NOT click Save during this smoke; just close the window.)

- [ ] **Step 3: Commit** anything changed + note artifacts are gitignored:

```bash
git status --porcelain   # release/ and dist/ must NOT appear; if they do, extend .gitignore and include that change
git add -A && git commit -m "build(pipeline-app): electron-builder dmg+nsis packaging verified" --allow-empty
```

---

### Task 12: Two-instance e2e + docs

**Files:**

- Create: `packages/pipeline-app/README.md`
- Modify: `docs/repo-overview.md` (package table row)
- Modify: `CLAUDE.md` (source location line)

**Interfaces:** consumes everything.

- [ ] **Step 1: Two-instance e2e on this Mac** (streamer override + collector, sharing a temp "Drive" folder):

```bash
cd /Users/mingjianliu/code/wowarenalogs/.worktrees/pipeline-app/packages/pipeline-app
E2E=$(mktemp -d); mkdir -p "$E2E/wow/Logs" "$E2E/drive" "$E2E/sync"
SRC=$(ls ~/Downloads/wow/WoWCombatLog*.txt 2>/dev/null | head -1)   # real log preferred

# streamer instance (role override; its own config + state)
cat > "$E2E/streamer.config.json" <<EOF
{ "syncFolder": "$E2E/drive", "wowDirectory": "$E2E/wow", "hostname": "E2E-PC",
  "flushIntervalMs": 1000, "quietPeriodMs": 500 }
EOF
WAL_PILOT_ROLE=streamer WAL_PILOT_CONFIG="$E2E/streamer.config.json" npx electron . &
STREAMER_PID=$!
sleep 5
# stream a real log in chunks (fs.watch may be rename-only in this sandbox; the
# initial-scan + restart paths cover us as in the pipeline e2e)
DST="$E2E/wow/Logs/WoWCombatLog-070326_120000.txt"
head -c 4194304 "$SRC" > "$DST"; sleep 4
cat "$SRC" > "$DST.tmp" && mv "$DST.tmp" "$DST" 2>/dev/null || cat "$SRC" > "$DST"; sleep 4
kill $STREAMER_PID; sleep 1
# restart streamer once to pick up the remaining delta from its checkpoint (legit resume path)
WAL_PILOT_ROLE=streamer WAL_PILOT_CONFIG="$E2E/streamer.config.json" npx electron . &
STREAMER_PID=$!; sleep 6; kill $STREAMER_PID
find "$E2E/drive/raw" -type f | wc -l   # expect >= 2 segments

# collector instance
cat > "$E2E/collector.config.json" <<EOF
{ "syncFolder": "$E2E/drive", "hostname": "E2E-MAC", "cleanupAfterDays": 14 }
EOF
WAL_PILOT_ROLE=collector WAL_PILOT_CONFIG="$E2E/collector.config.json" WAL_SYNC_DIR="$E2E/sync" \
  ANALYSIS_CLI_MODEL=haiku npx electron . &
COLLECTOR_PID=$!
sleep 6
PORT=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5178/ | grep -q 200 && echo 5178 || echo 5179)
curl -s -X POST "http://127.0.0.1:$PORT/api/run"; echo
sleep 240   # collection + 1 log's matches through haiku CLI (cheap model for e2e only; prod default stays opus)
tail -1 "$E2E/sync/runs.jsonl"
cmp "$E2E/sync/logs/"WoWCombatLog-070326_120000.E2E-PC.*.txt "$DST" && echo "E2E BYTE-EXACT ✅"
kill $COLLECTOR_PID
```

Expected: ≥2 segments; run record with `analysisExitCode: 0`; `E2E BYTE-EXACT ✅`. Adjust the final sleep upward if the log has many matches (or pre-trim `$SRC` to its first ~30MB). NOTE: the collector service runs analysis without `maxMatches` — a many-match log through haiku is fine cost-wise but slow; prefer the smallest real log available.

- [ ] **Step 2: `packages/pipeline-app/README.md`**

```markdown
# wal-pilot

Tray app hosting the WoW-arena log pipeline: **streamer** role on Windows
(watches `WoWCombatLog*.txt`, uploads gzip'd segments), **collector** role on
macOS (reconstructs logs, runs Claude analysis via the local `claude` CLI —
default model opus — and archives reports). Design:
`docs/superpowers/specs/2026-07-03-pipeline-app-design.md`.

## Setup (per machine)

1. Have Google Drive for desktop signed in (any synced folder works — Dropbox/iCloud too).
2. Install wal-pilot (`release/*.dmg` on the Mac, `release/*Setup*.exe` on the gaming laptop —
   accept the SmartScreen/Gatekeeper "open anyway" once; builds are unsigned).
3. Complete the one-screen wizard (synced folder is auto-detected; on Windows also the WoW folder).

That's all. The app starts at login, streams while you play, and the Mac
analyzes on a 6-hour schedule (tray → Run Now to trigger immediately).

## Build

    npm run -w @wowarenalogs/pipeline-app dist    # → packages/pipeline-app/release/

## Config & overrides

Config: `<userData>/wal-pilot.config.json` (see PilotConfig in `src/pilotConfig.ts`).
Env: `WAL_PILOT_ROLE` (role override), `WAL_PILOT_CONFIG` (config path),
`WAL_SYNC_DIR` (collector state dir, default `~/wal-sync`), `ANALYSIS_BACKEND` /
`ANALYSIS_CLI_MODEL` (analysis backend, default: local claude CLI, opus).
GCS instead of a synced folder: add `"storage": {"provider":"gcs","bucket":"…","keyFilename":"…"}`
to the config (service account needs `roles/storage.objectUser`); cleanup then
defers to bucket lifecycle rules.

Headless alternatives (no app): `packages/windows-agent/README.md` and
`packages/tools/launchd/README.md`.
```

- [ ] **Step 3: Docs rows.** `docs/repo-overview.md` package table, after the `pipeline-app`-adjacent alphabetical spot (after `linter` row or wherever fits the existing order — match the table's current ordering):

```markdown
| `pipeline-app` | Electron 38 app | wal-pilot tray app: streamer (Windows) / collector+analysis (macOS) roles. |
```

`CLAUDE.md` `<source_locations>`, after the "Log collector + pipeline dashboard" line:

```markdown
- wal-pilot tray app (both machines): `packages/pipeline-app/src/`
```

- [ ] **Step 4: Full gates + commit**

```bash
cd /Users/mingjianliu/code/wowarenalogs/.worktrees/pipeline-app
npm run lint && npm run typecheck
npm run -w @wowarenalogs/pipeline-app test && npm run -w @wowarenalogs/windows-agent test
git add packages/pipeline-app docs/repo-overview.md CLAUDE.md
git commit -m "docs(pipeline-app): README quickstart; register package in repo docs"
```

- [ ] **Step 5: Finish** — controller runs the final whole-branch review, then superpowers:finishing-a-development-branch (push-clean + worktree cleanup per project workflow).

---

## Self-Review (performed at write time)

**Spec coverage:** package/shell (T1, T10, T11), role controller + services (T4, T7, T8), localBatchAnalysis refactor (T2), wizard + detection + login item (T5, T10), config schema (T4), UI tray/dashboard/streamer section/Origin check/port fallback (T9, T10), cleanup + adapter delete (T3, T6), packaging (T11), error handling (T7 error events, T8 forensic records, T10 backoff restart), testing incl. two-instance e2e (unit tests throughout, T12), setup runbook (T12 README). Spec §6's gzip-ISIZE mechanism → T6; §5 first-free port → T9; CLI-compat invariants → T2/T8/T9 explicitly.

**Placeholder scan:** clean — every code step carries complete code; T11 intentionally has no new code (packaging verification).

**Type consistency:** `PilotConfig`/`withDefaults`/`resolveRole`/`storageConfigOf`/`toAgentConfig`/`toCollectorConfig` (T4) used in T7/T8/T10 with matching signatures; `StreamerState` (T7) consumed by T10 and the dashboard `local.state` shape (T9); `CollectorPhase` (T8) feeds T10's `updateTray`; `cleanupAppliedSegments` opts (T6) match T8's runner call; `createDashboardServer` options (T9) match T10's call; `runBatchAnalysis({logDir})` (T2) matches T8. `delete(key)` (T3) used by T6 only via fs (localDir direct) — adapter delete exists for GCS-mode future use and contract completeness, noted in T6 behavior text.

**Known intentional deviations:** cleanup walks the localDir filesystem directly rather than through the adapter (needs mtime + 4-byte tail reads the adapter doesn't expose; spec §6 is explicitly Drive-folder-scoped); `CollectorStatus.phase` file value stays within its existing union during cleanup (UI gets the richer phase via callback) to avoid touching `statusFile.ts`.
