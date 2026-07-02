# Arena Log Streaming + Auto-Analysis Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A low-CPU Windows agent that streams WoW combat-log bytes to pluggable cloud storage, plus a Mac-side collector + scheduled AI analysis + local dashboard.

**Architecture:** The agent tails `WoWCombatLog*.txt` with `fs.watch`, uploads gzip'd byte-range segments through a 3-method `StorageAdapter` (GCS first; in-memory + local-dir adapters for tests/e2e). The Mac collector reconstructs log files from segments byte-exactly, then chains into the existing `localBatchAnalysis` (per-match Claude analysis → `results.jsonl`, meta-eval → `summary.md`). launchd schedules it; a framework-free localhost dashboard shows heartbeat, runs, schedule.

**Tech Stack:** Node 22 / TypeScript (strict), `@google-cloud/storage@^6.7.0`, esbuild (agent bundle), tsdx/jest for tests, ts-node scripts in `packages/tools`, launchd + bash for scheduling.

**Spec:** `docs/superpowers/specs/2026-07-02-log-streaming-pipeline-design.md`

## Global Constraints

- Zero lint warnings: `npm run lint` must pass with `--max-warnings 0` in every package.
- `strict: true` TypeScript everywhere; avoid `any`.
- `packages/windows-agent` must NOT import from any other workspace package (standalone deploy). Tools MAY import windows-agent **source** (repo already does cross-package source imports, e.g. web→shared).
- Never import `@wowarenalogs/app` anywhere new.
- After editing any file: `npx prettier --write <file_path>`.
- All work happens in the worktree: `/Users/mingjianliu/code/wowarenalogs/.worktrees/log-streaming-pipeline`. All paths below are relative to that root.
- Parser must be built once before tools scripts run: `npm run build:parser` (already done in this worktree).
- Push with `git push-clean` from inside the worktree when done (origin only, never upstream; no PR unless asked).
- Segment key scheme (protocol invariant): `raw/<hostname>/<logFileName>/<gen8>/<offset padded to 12>.seg`; heartbeat key `status/<hostname>.json`. Offsets are **uncompressed** byte positions; segment bodies are gzip'd.
- Known pre-existing issue, DO NOT touch: `packages/tools/src/__tests__/promptBuilder.test.ts` fails under `npx tsdx test` (calls `process.exit`). Tools gets no `test` script in this plan.

---

### Task 1: Scaffold `packages/windows-agent`

**Files:**

- Create: `packages/windows-agent/package.json`
- Create: `packages/windows-agent/tsconfig.json`
- Create: `packages/windows-agent/.eslintrc.js`
- Create: `packages/windows-agent/.eslintignore`

**Interfaces:**

- Consumes: nothing.
- Produces: a workspace package `@wowarenalogs/windows-agent` where `npm run -w @wowarenalogs/windows-agent lint|typecheck` pass; later tasks add `src/` and tests.

- [ ] **Step 1: Create `packages/windows-agent/package.json`**

```json
{
  "name": "@wowarenalogs/windows-agent",
  "version": "0.1.0",
  "description": "Standalone Windows agent that streams WoW combat logs to cloud storage",
  "main": "./src/index.ts",
  "author": "WoW Arena Logs",
  "scripts": {
    "lint": "eslint . --max-warnings 0",
    "lint:fix": "eslint . --fix",
    "typecheck": "tsc --noEmit",
    "test": "npx tsdx test --passWithNoTests=false",
    "build": "esbuild src/index.ts --bundle --platform=node --target=node22 --outfile=dist/wal-agent.js"
  },
  "dependencies": {
    "@google-cloud/storage": "^6.7.0"
  },
  "devDependencies": {
    "@types/node": "^22",
    "esbuild": "^0.25.0",
    "eslint-config-wowarenalogs": "*",
    "typescript": "^4.9.5"
  }
}
```

- [ ] **Step 2: Create `packages/windows-agent/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "es2020",
    "lib": ["es2020"],
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

- [ ] **Step 3: Create `packages/windows-agent/.eslintrc.js`** (mirrors tools: CLI package, console is the UI)

```js
module.exports = {
  extends: ['wowarenalogs'],
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
  },
  rules: {
    // Standalone CLI agent: console output is the primary interface
    // (mirrors the tools package, which disables this rule for the same reason).
    'no-console': 'off',
  },
};
```

- [ ] **Step 4: Create `packages/windows-agent/.eslintignore`**

```
node_modules
dist
.eslintrc.js
```

- [ ] **Step 5: Install and verify empty package passes gates**

```bash
cd /Users/mingjianliu/code/wowarenalogs/.worktrees/log-streaming-pipeline
npm install
npm run -w @wowarenalogs/windows-agent typecheck
npm run -w @wowarenalogs/windows-agent lint
```

Expected: `npm install` links the new workspace; typecheck and lint exit 0 (no src files yet — tsc with an empty include prints nothing and exits 0; if tsc errors with "No inputs were found", create `src/index.ts` containing only `export {};` and re-run).

- [ ] **Step 6: Commit**

```bash
git add packages/windows-agent package-lock.json
git commit -m "feat(windows-agent): scaffold standalone agent package"
```

---

### Task 2: Segment key protocol (`segments.ts`)

**Files:**

- Create: `packages/windows-agent/src/protocol/segments.ts`
- Test: `packages/windows-agent/src/__tests__/segments.test.ts`
- Modify: `docs/superpowers/specs/2026-07-02-log-streaming-pipeline-design.md` (key scheme gains a `<gen8>` component)

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `OFFSET_PAD = 12`
  - `buildSegmentKey(hostname: string, logFileName: string, gen8: string, startOffset: number): string`
  - `parseSegmentKey(key: string): SegmentRef | null` where `SegmentRef = { hostname: string; logFileName: string; gen8: string; startOffset: number; key: string }`
  - `buildHeartbeatKey(hostname: string): string`

**Why `gen8`:** if a log file is deleted and recreated with the same name, offsets restart at 0 and offset-only keys would collide with the dead file's segments, silently interleaving two files. An 8-hex-char prefix of the file's first-line checksum ("generation") namespaces each incarnation.

- [ ] **Step 1: Write the failing test** — `packages/windows-agent/src/__tests__/segments.test.ts`

```ts
import { buildHeartbeatKey, buildSegmentKey, parseSegmentKey } from '../protocol/segments';

describe('segment key protocol', () => {
  const file = 'WoWCombatLog-061426_183000.txt';

  it('builds zero-padded, generation-namespaced keys', () => {
    expect(buildSegmentKey('GAMING-PC', file, 'a1b2c3d4', 0)).toBe(`raw/GAMING-PC/${file}/a1b2c3d4/000000000000.seg`);
    expect(buildSegmentKey('GAMING-PC', file, 'a1b2c3d4', 1048576)).toBe(
      `raw/GAMING-PC/${file}/a1b2c3d4/000001048576.seg`,
    );
  });

  it('lexicographic key order equals numeric offset order', () => {
    const keys = [123456789, 999, 0, 1048576].map((o) => buildSegmentKey('h', file, 'a1b2c3d4', o));
    const sortedLex = [...keys].sort();
    const sortedNum = [0, 999, 1048576, 123456789].map((o) => buildSegmentKey('h', file, 'a1b2c3d4', o));
    expect(sortedLex).toEqual(sortedNum);
  });

  it('round-trips through parseSegmentKey', () => {
    const key = buildSegmentKey('GAMING-PC', file, 'deadbeef', 42);
    expect(parseSegmentKey(key)).toEqual({
      hostname: 'GAMING-PC',
      logFileName: file,
      gen8: 'deadbeef',
      startOffset: 42,
      key,
    });
  });

  it('rejects malformed keys', () => {
    expect(parseSegmentKey('status/GAMING-PC.json')).toBeNull();
    expect(parseSegmentKey('raw/host/file.txt/gen/notanumber.seg')).toBeNull();
    expect(parseSegmentKey('raw/host/file.txt/000000000042.seg')).toBeNull(); // missing gen
  });

  it('builds heartbeat keys', () => {
    expect(buildHeartbeatKey('GAMING-PC')).toBe('status/GAMING-PC.json');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/mingjianliu/code/wowarenalogs/.worktrees/log-streaming-pipeline/packages/windows-agent
npx tsdx test --passWithNoTests=false
```

Expected: FAIL — `Cannot find module '../protocol/segments'`.

- [ ] **Step 3: Implement** — `packages/windows-agent/src/protocol/segments.ts`

```ts
export const OFFSET_PAD = 12;

export interface SegmentRef {
  hostname: string;
  logFileName: string;
  gen8: string;
  startOffset: number;
  key: string;
}

export function buildSegmentKey(hostname: string, logFileName: string, gen8: string, startOffset: number): string {
  return `raw/${hostname}/${logFileName}/${gen8}/${String(startOffset).padStart(OFFSET_PAD, '0')}.seg`;
}

export function parseSegmentKey(key: string): SegmentRef | null {
  const parts = key.split('/');
  if (parts.length !== 5 || parts[0] !== 'raw') return null;
  const [, hostname, logFileName, gen8, last] = parts;
  const m = /^(\d+)\.seg$/.exec(last);
  if (!m) return null;
  return { hostname, logFileName, gen8, startOffset: parseInt(m[1], 10), key };
}

export function buildHeartbeatKey(hostname: string): string {
  return `status/${hostname}.json`;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx tsdx test --passWithNoTests=false
```

Expected: PASS (5 tests).

- [ ] **Step 5: Amend the spec's key scheme** — in `docs/superpowers/specs/2026-07-02-log-streaming-pipeline-design.md`, replace the sentence starting `- Segment key scheme (provider-agnostic):` so it reads:

```markdown
- Segment key scheme (provider-agnostic): `raw/<hostname>/<logFileName>/<gen8>/<startOffset>.seg`, where `gen8` is the first 8 hex chars of the file's first-line checksum — a "generation" id that prevents a recreated same-name file from colliding with its predecessor's offsets. WoW opens a new timestamped log per session, so rotation is handled naturally (new filename → new key prefix). Offsets are zero-padded to 12 digits so lexicographic order equals numeric order.
```

Also update the two other spec occurrences of the old scheme (`<startOffset>.seg` in the duplicate-safety invariant bullet and the ASCII diagram `<offset>.seg` line) to include `<gen8>`.

- [ ] **Step 6: Prettier, lint, commit**

```bash
npx prettier --write src/protocol/segments.ts src/__tests__/segments.test.ts
npm run lint
cd /Users/mingjianliu/code/wowarenalogs/.worktrees/log-streaming-pipeline
git add packages/windows-agent/src docs/superpowers/specs/2026-07-02-log-streaming-pipeline-design.md
git commit -m "feat(windows-agent): segment key protocol with generation namespacing"
```

---

### Task 3: File identity checksum (`identity.ts`)

**Files:**

- Create: `packages/windows-agent/src/protocol/identity.ts`
- Test: `packages/windows-agent/src/__tests__/identity.test.ts`

**Interfaces:**

- Consumes: nothing (node `crypto`).
- Produces:
  - `firstLineChecksum(head: Buffer): string | null` — sha1 hex of the bytes up to (not including) the first `\n`; `null` if `head` contains no `\n` (identity not yet establishable).
  - `gen8Of(checksum: string): string` — first 8 chars.

- [ ] **Step 1: Write the failing test** — `packages/windows-agent/src/__tests__/identity.test.ts`

```ts
import { createHash } from 'crypto';

import { firstLineChecksum, gen8Of } from '../protocol/identity';

describe('firstLineChecksum', () => {
  it('hashes exactly the first line, excluding the newline', () => {
    const line = '6/14/2026 18:30:00.123  COMBAT_LOG_VERSION,21,ADVANCED_LOG_ENABLED,1';
    const head = Buffer.from(`${line}\nSECOND_LINE,stuff\n`);
    const expected = createHash('sha1').update(Buffer.from(line)).digest('hex');
    expect(firstLineChecksum(head)).toBe(expected);
  });

  it('is stable regardless of how much of the file follows', () => {
    const a = firstLineChecksum(Buffer.from('first\nsecond\n'));
    const b = firstLineChecksum(Buffer.from('first\nDIFFERENT REST OF FILE'));
    expect(a).toBe(b);
  });

  it('handles CRLF by stripping the trailing \\r', () => {
    const a = firstLineChecksum(Buffer.from('first\r\nsecond\r\n'));
    const b = firstLineChecksum(Buffer.from('first\nsecond\n'));
    expect(a).toBe(b);
  });

  it('returns null when no complete first line exists yet', () => {
    expect(firstLineChecksum(Buffer.from('partial line without newline'))).toBeNull();
    expect(firstLineChecksum(Buffer.alloc(0))).toBeNull();
  });

  it('gen8Of takes the first 8 chars', () => {
    expect(gen8Of('abcdef0123456789')).toBe('abcdef01');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/mingjianliu/code/wowarenalogs/.worktrees/log-streaming-pipeline/packages/windows-agent
npx tsdx test --passWithNoTests=false
```

Expected: FAIL — `Cannot find module '../protocol/identity'`.

- [ ] **Step 3: Implement** — `packages/windows-agent/src/protocol/identity.ts`

```ts
import { createHash } from 'crypto';

/**
 * Content-based file identity (Vector's fingerprinting lesson): hash the first
 * line so a recreated file with the same name is detected by checksum change,
 * not just by shrinking size. Returns null until the file has a complete first
 * line — WoW writes whole lines constantly, so this resolves within seconds.
 */
export function firstLineChecksum(head: Buffer): string | null {
  const nl = head.indexOf(0x0a); // \n
  if (nl === -1) return null;
  const end = nl > 0 && head[nl - 1] === 0x0d ? nl - 1 : nl; // strip \r for CRLF logs
  return createHash('sha1').update(head.subarray(0, end)).digest('hex');
}

export function gen8Of(checksum: string): string {
  return checksum.slice(0, 8);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx tsdx test --passWithNoTests=false
```

Expected: PASS (segments + identity suites).

- [ ] **Step 5: Prettier, lint, commit**

```bash
npx prettier --write src/protocol/identity.ts src/__tests__/identity.test.ts
npm run lint
git add src
git commit -m "feat(windows-agent): first-line checksum file identity"
```

---

### Task 4: `StorageAdapter` interface, Memory + LocalDir adapters, contract suite

**Files:**

- Create: `packages/windows-agent/src/storage/StorageAdapter.ts`
- Create: `packages/windows-agent/src/storage/MemoryStorageAdapter.ts`
- Create: `packages/windows-agent/src/storage/LocalDirStorageAdapter.ts`
- Create: `packages/windows-agent/src/storage/adapterContract.ts`
- Test: `packages/windows-agent/src/__tests__/storageAdapters.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `interface StorageAdapter { put(key: string, body: Buffer): Promise<void>; list(prefix: string): Promise<string[]>; get(key: string): Promise<Buffer>; }`
  - `class MemoryStorageAdapter implements StorageAdapter` (plus test helper `keys(): string[]`)
  - `class LocalDirStorageAdapter implements StorageAdapter` — `new LocalDirStorageAdapter(rootDir: string)`; keys map to files under rootDir (slashes → subdirectories). Used for no-GCP e2e.
  - `describeStorageAdapterContract(name: string, factory: () => Promise<StorageAdapter>): void` — jest suite any adapter must pass.

- [ ] **Step 1: Write the interface** — `packages/windows-agent/src/storage/StorageAdapter.ts`

```ts
/**
 * Minimal storage contract shared by the Windows agent (write side) and the
 * Mac collector (read side). Deliberately tiny — 3 methods, flat keys, no
 * streaming/multipart — so S3 / Google Drive / R2 adapters are drop-in later.
 */
export interface StorageAdapter {
  put(key: string, body: Buffer): Promise<void>;
  /** Returns keys under prefix in lexicographic order. */
  list(prefix: string): Promise<string[]>;
  get(key: string): Promise<Buffer>;
}
```

- [ ] **Step 2: Write the contract suite** — `packages/windows-agent/src/storage/adapterContract.ts`

```ts
import { StorageAdapter } from './StorageAdapter';

/**
 * Contract every StorageAdapter implementation must pass. New adapters (S3,
 * Google Drive, ...) get correctness-checked by calling this with a factory.
 */
export function describeStorageAdapterContract(name: string, factory: () => Promise<StorageAdapter>): void {
  describe(`StorageAdapter contract: ${name}`, () => {
    let adapter: StorageAdapter;
    beforeEach(async () => {
      adapter = await factory();
    });

    it('round-trips put → get', async () => {
      const body = Buffer.from('hello \u{1F30D} bytes\x00\x01');
      await adapter.put('raw/h/f.txt/gen/000000000000.seg', body);
      expect(await adapter.get('raw/h/f.txt/gen/000000000000.seg')).toEqual(body);
    });

    it('lists keys under a prefix in lexicographic order', async () => {
      await adapter.put('raw/h/f/g/000000000010.seg', Buffer.from('b'));
      await adapter.put('raw/h/f/g/000000000002.seg', Buffer.from('a'));
      await adapter.put('status/h.json', Buffer.from('{}'));
      const keys = await adapter.list('raw/');
      expect(keys).toEqual(['raw/h/f/g/000000000002.seg', 'raw/h/f/g/000000000010.seg']);
    });

    it('put is an idempotent overwrite', async () => {
      await adapter.put('k/a', Buffer.from('v1'));
      await adapter.put('k/a', Buffer.from('v2'));
      expect((await adapter.get('k/a')).toString()).toBe('v2');
      expect(await adapter.list('k/')).toEqual(['k/a']);
    });

    it('list of an unknown prefix returns empty', async () => {
      expect(await adapter.list('nope/')).toEqual([]);
    });

    it('get of a missing key rejects', async () => {
      await expect(adapter.get('missing')).rejects.toBeTruthy();
    });
  });
}
```

- [ ] **Step 3: Write the failing test file** — `packages/windows-agent/src/__tests__/storageAdapters.test.ts`

```ts
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { describeStorageAdapterContract } from '../storage/adapterContract';
import { LocalDirStorageAdapter } from '../storage/LocalDirStorageAdapter';
import { MemoryStorageAdapter } from '../storage/MemoryStorageAdapter';

describeStorageAdapterContract('MemoryStorageAdapter', async () => new MemoryStorageAdapter());
describeStorageAdapterContract(
  'LocalDirStorageAdapter',
  async () => new LocalDirStorageAdapter(mkdtempSync(join(tmpdir(), 'wal-store-'))),
);
```

- [ ] **Step 4: Run test to verify it fails**

```bash
cd /Users/mingjianliu/code/wowarenalogs/.worktrees/log-streaming-pipeline/packages/windows-agent
npx tsdx test --passWithNoTests=false
```

Expected: FAIL — cannot find `../storage/MemoryStorageAdapter` / `LocalDirStorageAdapter`.

- [ ] **Step 5: Implement MemoryStorageAdapter** — `packages/windows-agent/src/storage/MemoryStorageAdapter.ts`

```ts
import { StorageAdapter } from './StorageAdapter';

export class MemoryStorageAdapter implements StorageAdapter {
  private objects = new Map<string, Buffer>();

  async put(key: string, body: Buffer): Promise<void> {
    this.objects.set(key, Buffer.from(body));
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }

  async get(key: string): Promise<Buffer> {
    const body = this.objects.get(key);
    if (!body) throw new Error(`MemoryStorageAdapter: no such key ${key}`);
    return Buffer.from(body);
  }

  /** Test helper. */
  keys(): string[] {
    return [...this.objects.keys()].sort();
  }
}
```

- [ ] **Step 6: Implement LocalDirStorageAdapter** — `packages/windows-agent/src/storage/LocalDirStorageAdapter.ts`

```ts
import { promises as fs } from 'fs';
import { dirname, join, relative, sep } from 'path';

import { StorageAdapter } from './StorageAdapter';

/**
 * Filesystem-backed adapter: keys map to files under rootDir. Used for
 * GCP-free end-to-end testing (agent and collector share a local directory)
 * and as a template for future adapters.
 */
export class LocalDirStorageAdapter implements StorageAdapter {
  constructor(private rootDir: string) {}

  private pathOf(key: string): string {
    return join(this.rootDir, ...key.split('/'));
  }

  async put(key: string, body: Buffer): Promise<void> {
    const filePath = this.pathOf(key);
    await fs.mkdir(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}`;
    await fs.writeFile(tmp, body);
    await fs.rename(tmp, filePath); // atomic publish, mirrors object-store semantics
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return; // root or subdir doesn't exist yet → no keys
      }
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else if (!e.name.includes('.tmp-')) out.push(relative(this.rootDir, p).split(sep).join('/'));
      }
    };
    await walk(this.rootDir);
    return out.filter((k) => k.startsWith(prefix)).sort();
  }

  async get(key: string): Promise<Buffer> {
    return fs.readFile(this.pathOf(key));
  }
}
```

- [ ] **Step 7: Run test to verify it passes**

```bash
npx tsdx test --passWithNoTests=false
```

Expected: PASS — contract suite runs twice (Memory, LocalDir), 10 contract tests total green.

- [ ] **Step 8: Prettier, lint, commit**

```bash
npx prettier --write src/storage/*.ts src/__tests__/storageAdapters.test.ts
npm run lint
git add src
git commit -m "feat(windows-agent): StorageAdapter interface, memory/local-dir impls, contract suite"
```

---

### Task 5: `GcsStorageAdapter`

**Files:**

- Create: `packages/windows-agent/src/storage/GcsStorageAdapter.ts`
- Test: `packages/windows-agent/src/__tests__/gcsAdapter.test.ts`

**Interfaces:**

- Consumes: `StorageAdapter` (Task 4).
- Produces: `class GcsStorageAdapter implements StorageAdapter` — `new GcsStorageAdapter({ bucket: string; keyFilename?: string }, injectedStorage?)`. Second constructor arg is an optional pre-built `Storage`-like client for tests.

- [ ] **Step 1: Write the failing test** (stubbed client — verifies our call mapping, not Google's SDK) — `packages/windows-agent/src/__tests__/gcsAdapter.test.ts`

```ts
import { GcsStorageAdapter, GcsClientLike } from '../storage/GcsStorageAdapter';

function makeStub() {
  const calls: Record<string, unknown[]> = { save: [], download: [], getFiles: [] };
  const stub: GcsClientLike = {
    bucket: (bucketName: string) => ({
      file: (key: string) => ({
        save: async (body: Buffer, opts: unknown) => {
          calls.save.push([bucketName, key, body, opts]);
        },
        download: async () => {
          calls.download.push([bucketName, key]);
          return [Buffer.from(`content-of-${key}`)] as [Buffer];
        },
      }),
      getFiles: async (opts: { prefix: string }) => {
        calls.getFiles.push([bucketName, opts]);
        return [[{ name: 'raw/h/f/g/000000000010.seg' }, { name: 'raw/h/f/g/000000000002.seg' }]] as [
          { name: string }[],
        ];
      },
    }),
  };
  return { stub, calls };
}

describe('GcsStorageAdapter', () => {
  it('put maps to file(key).save with resumable disabled', async () => {
    const { stub, calls } = makeStub();
    const adapter = new GcsStorageAdapter({ bucket: 'my-bucket' }, stub);
    await adapter.put('k/a', Buffer.from('x'));
    expect(calls.save).toEqual([['my-bucket', 'k/a', Buffer.from('x'), { resumable: false }]]);
  });

  it('list maps to getFiles(prefix) and sorts the names', async () => {
    const { stub } = makeStub();
    const adapter = new GcsStorageAdapter({ bucket: 'my-bucket' }, stub);
    expect(await adapter.list('raw/')).toEqual(['raw/h/f/g/000000000002.seg', 'raw/h/f/g/000000000010.seg']);
  });

  it('get maps to file(key).download', async () => {
    const { stub } = makeStub();
    const adapter = new GcsStorageAdapter({ bucket: 'my-bucket' }, stub);
    expect((await adapter.get('k/a')).toString()).toBe('content-of-k/a');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/mingjianliu/code/wowarenalogs/.worktrees/log-streaming-pipeline/packages/windows-agent
npx tsdx test --passWithNoTests=false
```

Expected: FAIL — cannot find `../storage/GcsStorageAdapter`.

- [ ] **Step 3: Implement** — `packages/windows-agent/src/storage/GcsStorageAdapter.ts`

```ts
import { Storage } from '@google-cloud/storage';

import { StorageAdapter } from './StorageAdapter';

/** Structural subset of the GCS SDK we use — lets tests inject a stub. */
export interface GcsClientLike {
  bucket(name: string): {
    file(key: string): {
      save(body: Buffer, opts: { resumable: boolean }): Promise<void>;
      download(): Promise<[Buffer]>;
    };
    getFiles(opts: { prefix: string }): Promise<[{ name: string }[]]>;
  };
}

export interface GcsStorageConfig {
  bucket: string;
  /** Path to a service-account JSON key. Omit to use ambient ADC credentials. */
  keyFilename?: string;
}

export class GcsStorageAdapter implements StorageAdapter {
  private bucketRef: ReturnType<GcsClientLike['bucket']>;

  constructor(config: GcsStorageConfig, client?: GcsClientLike) {
    const storage = client ?? (new Storage({ keyFilename: config.keyFilename }) as unknown as GcsClientLike);
    this.bucketRef = storage.bucket(config.bucket);
  }

  async put(key: string, body: Buffer): Promise<void> {
    // resumable:false — segments are small (≤ a few MB); resumable uploads add
    // 2 extra round-trips and a session object per call.
    await this.bucketRef.file(key).save(body, { resumable: false });
  }

  async list(prefix: string): Promise<string[]> {
    const [files] = await this.bucketRef.getFiles({ prefix });
    return files.map((f) => f.name).sort();
  }

  async get(key: string): Promise<Buffer> {
    const [body] = await this.bucketRef.file(key).download();
    return body;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx tsdx test --passWithNoTests=false
```

Expected: PASS.

- [ ] **Step 5: Prettier, lint, typecheck, commit**

```bash
npx prettier --write src/storage/GcsStorageAdapter.ts src/__tests__/gcsAdapter.test.ts
npm run lint && npm run typecheck
git add src
git commit -m "feat(windows-agent): GCS storage adapter"
```

---

### Task 6: Agent config + checkpoint state

**Files:**

- Create: `packages/windows-agent/src/config.ts`
- Create: `packages/windows-agent/src/state.ts`
- Create: `packages/windows-agent/src/storage/createAdapter.ts`
- Test: `packages/windows-agent/src/__tests__/configState.test.ts`

**Interfaces:**

- Consumes: `StorageAdapter`, `GcsStorageAdapter`, `LocalDirStorageAdapter` (Tasks 4–5).
- Produces:
  - `type StorageConfig = { provider: 'gcs'; bucket: string; keyFilename?: string } | { provider: 'localDir'; directory: string }`
  - `interface AgentConfig { wowDirectory: string; hostname: string; flushIntervalMs: number; quietPeriodMs: number; ignoreOlderDays: number; storage: StorageConfig }`
  - `loadAgentConfig(path: string): AgentConfig` — applies defaults (`flushIntervalMs: 60000`, `quietPeriodMs: 30000`, `ignoreOlderDays: 7`), throws `Error` with a descriptive message on missing/invalid fields.
  - `createAdapter(storage: StorageConfig): StorageAdapter`
  - `interface FileCheckpoint { offset: number; firstLineChecksum: string }`
  - `interface AgentState { files: Record<string, FileCheckpoint> }`
  - `loadState(path: string): AgentState` (missing/corrupt file → `{ files: {} }`)
  - `saveState(path: string, state: AgentState): void` — write temp + rename (atomic).

- [ ] **Step 1: Write the failing test** — `packages/windows-agent/src/__tests__/configState.test.ts`

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/mingjianliu/code/wowarenalogs/.worktrees/log-streaming-pipeline/packages/windows-agent
npx tsdx test --passWithNoTests=false
```

Expected: FAIL — modules not found.

- [ ] **Step 3: Implement config** — `packages/windows-agent/src/config.ts`

```ts
import { readFileSync } from 'fs';

export type StorageConfig =
  | { provider: 'gcs'; bucket: string; keyFilename?: string }
  | { provider: 'localDir'; directory: string };

export interface AgentConfig {
  wowDirectory: string;
  hostname: string;
  flushIntervalMs: number;
  quietPeriodMs: number;
  ignoreOlderDays: number;
  storage: StorageConfig;
}

const DEFAULTS = { flushIntervalMs: 60000, quietPeriodMs: 30000, ignoreOlderDays: 7 };

export function loadAgentConfig(path: string): AgentConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    throw new Error(`Config file not found or unreadable: ${path}`);
  }
  const json = JSON.parse(raw) as Partial<AgentConfig>;
  if (!json.wowDirectory || typeof json.wowDirectory !== 'string') {
    throw new Error(`Config error: "wowDirectory" (string) is required in ${path}`);
  }
  if (!json.hostname || typeof json.hostname !== 'string') {
    throw new Error(`Config error: "hostname" (string) is required in ${path}`);
  }
  const storage = json.storage as StorageConfig | undefined;
  if (!storage || (storage.provider !== 'gcs' && storage.provider !== 'localDir')) {
    throw new Error(`Config error: "storage.provider" must be "gcs" or "localDir" in ${path}`);
  }
  if (storage.provider === 'gcs' && !storage.bucket) {
    throw new Error(`Config error: "storage.bucket" is required for provider gcs in ${path}`);
  }
  if (storage.provider === 'localDir' && !storage.directory) {
    throw new Error(`Config error: "storage.directory" is required for provider localDir in ${path}`);
  }
  return {
    wowDirectory: json.wowDirectory,
    hostname: json.hostname,
    flushIntervalMs: json.flushIntervalMs ?? DEFAULTS.flushIntervalMs,
    quietPeriodMs: json.quietPeriodMs ?? DEFAULTS.quietPeriodMs,
    ignoreOlderDays: json.ignoreOlderDays ?? DEFAULTS.ignoreOlderDays,
    storage,
  };
}
```

- [ ] **Step 4: Implement adapter factory** — `packages/windows-agent/src/storage/createAdapter.ts`

```ts
import { StorageConfig } from '../config';
import { GcsStorageAdapter } from './GcsStorageAdapter';
import { LocalDirStorageAdapter } from './LocalDirStorageAdapter';
import { StorageAdapter } from './StorageAdapter';

export function createAdapter(storage: StorageConfig): StorageAdapter {
  switch (storage.provider) {
    case 'gcs':
      return new GcsStorageAdapter({ bucket: storage.bucket, keyFilename: storage.keyFilename });
    case 'localDir':
      return new LocalDirStorageAdapter(storage.directory);
  }
}
```

- [ ] **Step 5: Implement state** — `packages/windows-agent/src/state.ts`

```ts
import { readFileSync, renameSync, writeFileSync } from 'fs';

export interface FileCheckpoint {
  offset: number;
  firstLineChecksum: string;
}

export interface AgentState {
  files: Record<string, FileCheckpoint>;
}

/** Missing or corrupt state file → start fresh (worst case: re-upload, which is idempotent). */
export function loadState(path: string): AgentState {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as AgentState;
    return parsed && typeof parsed.files === 'object' && parsed.files !== null ? parsed : { files: {} };
  } catch {
    return { files: {} };
  }
}

/** Registry-file pattern (Filebeat): flush state after every acked upload, atomically. */
export function saveState(path: string, state: AgentState): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}
```

- [ ] **Step 6: Run test to verify it passes**

```bash
npx tsdx test --passWithNoTests=false
```

Expected: PASS.

- [ ] **Step 7: Prettier, lint, commit**

```bash
npx prettier --write src/config.ts src/state.ts src/storage/createAdapter.ts src/__tests__/configState.test.ts
npm run lint
git add src
git commit -m "feat(windows-agent): config loader, adapter factory, checkpoint state"
```

---

### Task 7: The flusher (core agent logic)

**Files:**

- Create: `packages/windows-agent/src/flusher.ts`
- Test: `packages/windows-agent/src/__tests__/flusher.test.ts`

**Interfaces:**

- Consumes: `FileCheckpoint` (Task 6), `StorageAdapter` (Task 4), `buildSegmentKey`/`firstLineChecksum`/`gen8Of` (Tasks 2–3).
- Produces:
  - `interface FlushOutcome { checkpoint: FileCheckpoint | undefined; flushedBytes: number; reset: boolean; segmentKey: string | null }`
  - `flushFile(opts: { filePath: string; logFileName: string; hostname: string; checkpoint: FileCheckpoint | undefined; adapter: StorageAdapter }): Promise<FlushOutcome>`

Behavior contract (each bullet is a test):

1. New file with a complete first line → uploads gzip of `[0, EOF)` at key offset 0, returns checkpoint `{ offset: EOF, firstLineChecksum }`.
2. Grown file → uploads only `[checkpoint.offset, EOF)` at key offset `checkpoint.offset`, same gen.
3. `EOF <= offset` and checksum unchanged → no-op (`flushedBytes: 0`, `segmentKey: null`, checkpoint unchanged) — duplicate `fs.watch` event guard.
4. First-line checksum mismatch (recreated file) → reset: uploads `[0, EOF)` under the NEW gen, checkpoint offset = EOF, `reset: true`.
5. File has no complete first line yet → no-op, checkpoint `undefined` (identity pending).
6. Adapter `put` rejects → the promise rejects and the returned/observable checkpoint must NOT advance (caller keeps the old one) — checkpoint-after-ack.
7. Segment body is gzip'd; gunzip restores the exact bytes.

- [ ] **Step 1: Write the failing tests** — `packages/windows-agent/src/__tests__/flusher.test.ts`

```ts
import { appendFileSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { gunzipSync } from 'zlib';

import { flushFile } from '../flusher';
import { MemoryStorageAdapter } from '../storage/MemoryStorageAdapter';

const LINE1 = '6/14 18:30:00.000  COMBAT_LOG_VERSION,21\n';
const LINE2 = '6/14 18:30:01.000  SPELL_CAST_SUCCESS,stuff\n';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'wal-flush-'));
  const filePath = join(dir, 'WoWCombatLog-1.txt');
  const adapter = new MemoryStorageAdapter();
  return { dir, filePath, adapter };
}
const base = { logFileName: 'WoWCombatLog-1.txt', hostname: 'PC' };

describe('flushFile', () => {
  it('uploads a new file from offset 0 and returns a checkpoint', async () => {
    const { filePath, adapter } = setup();
    writeFileSync(filePath, LINE1 + LINE2);
    const out = await flushFile({ ...base, filePath, checkpoint: undefined, adapter });
    expect(out.flushedBytes).toBe(Buffer.byteLength(LINE1 + LINE2));
    expect(out.checkpoint?.offset).toBe(Buffer.byteLength(LINE1 + LINE2));
    expect(out.reset).toBe(false);
    expect(adapter.keys()).toHaveLength(1);
    expect(adapter.keys()[0]).toMatch(/^raw\/PC\/WoWCombatLog-1\.txt\/[0-9a-f]{8}\/000000000000\.seg$/);
    const body = gunzipSync(await adapter.get(adapter.keys()[0]));
    expect(body.toString()).toBe(LINE1 + LINE2);
  });

  it('uploads only the delta for a grown file', async () => {
    const { filePath, adapter } = setup();
    writeFileSync(filePath, LINE1);
    const first = await flushFile({ ...base, filePath, checkpoint: undefined, adapter });
    appendFileSync(filePath, LINE2);
    const second = await flushFile({ ...base, filePath, checkpoint: first.checkpoint, adapter });
    expect(second.flushedBytes).toBe(Buffer.byteLength(LINE2));
    expect(adapter.keys()).toHaveLength(2);
    const deltaKey = adapter.keys().find((k) => k.endsWith(`${String(LINE1.length).padStart(12, '0')}.seg`));
    expect(deltaKey).toBeDefined();
    expect(gunzipSync(await adapter.get(deltaKey as string)).toString()).toBe(LINE2);
  });

  it('is a no-op when nothing new was written (duplicate watch event)', async () => {
    const { filePath, adapter } = setup();
    writeFileSync(filePath, LINE1);
    const first = await flushFile({ ...base, filePath, checkpoint: undefined, adapter });
    const again = await flushFile({ ...base, filePath, checkpoint: first.checkpoint, adapter });
    expect(again.flushedBytes).toBe(0);
    expect(again.segmentKey).toBeNull();
    expect(again.checkpoint).toEqual(first.checkpoint);
    expect(adapter.keys()).toHaveLength(1);
  });

  it('resets and re-streams under a new generation when the file is recreated', async () => {
    const { filePath, adapter } = setup();
    writeFileSync(filePath, LINE1 + LINE2);
    const first = await flushFile({ ...base, filePath, checkpoint: undefined, adapter });
    const RECREATED = '6/15 09:00:00.000  COMBAT_LOG_VERSION,21,NEW_SESSION\n';
    writeFileSync(filePath, RECREATED); // same name, new (shorter) content
    const out = await flushFile({ ...base, filePath, checkpoint: first.checkpoint, adapter });
    expect(out.reset).toBe(true);
    expect(out.flushedBytes).toBe(Buffer.byteLength(RECREATED));
    const gens = new Set(adapter.keys().map((k) => k.split('/')[3]));
    expect(gens.size).toBe(2); // old and new generation both present, no collision
  });

  it('defers when the file has no complete first line yet', async () => {
    const { filePath, adapter } = setup();
    writeFileSync(filePath, 'partial-without-newline');
    const out = await flushFile({ ...base, filePath, checkpoint: undefined, adapter });
    expect(out.checkpoint).toBeUndefined();
    expect(out.flushedBytes).toBe(0);
    expect(adapter.keys()).toHaveLength(0);
  });

  it('does not advance the checkpoint when the upload fails', async () => {
    const { filePath, adapter } = setup();
    writeFileSync(filePath, LINE1);
    const failing = {
      put: async () => {
        throw new Error('network down');
      },
      list: adapter.list.bind(adapter),
      get: adapter.get.bind(adapter),
    };
    await expect(flushFile({ ...base, filePath, checkpoint: undefined, adapter: failing })).rejects.toThrow(
      'network down',
    );
    // caller keeps the old checkpoint (undefined here); a retry then succeeds:
    const retry = await flushFile({ ...base, filePath, checkpoint: undefined, adapter });
    expect(retry.checkpoint?.offset).toBe(Buffer.byteLength(LINE1));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/mingjianliu/code/wowarenalogs/.worktrees/log-streaming-pipeline/packages/windows-agent
npx tsdx test --passWithNoTests=false
```

Expected: FAIL — `Cannot find module '../flusher'`.

- [ ] **Step 3: Implement** — `packages/windows-agent/src/flusher.ts`

```ts
import { closeSync, fstatSync, openSync, readSync } from 'fs';
import { gzipSync } from 'zlib';

import { firstLineChecksum, gen8Of } from './protocol/identity';
import { buildSegmentKey } from './protocol/segments';
import { FileCheckpoint } from './state';
import { StorageAdapter } from './storage/StorageAdapter';

export interface FlushOutcome {
  checkpoint: FileCheckpoint | undefined;
  flushedBytes: number;
  reset: boolean;
  segmentKey: string | null;
}

const IDENTITY_HEAD_BYTES = 4096;

/**
 * Read-delta-and-upload for one file. Open → read → close every time; never
 * hold a handle between flushes (Windows: open handles can block the game or
 * cleanup tools from rotating/deleting the file — Filebeat's documented pitfall).
 * The checkpoint advances only after the adapter acks the put (at-least-once);
 * re-uploads land on the same key, so duplicates are idempotent end-to-end.
 */
export async function flushFile(opts: {
  filePath: string;
  logFileName: string;
  hostname: string;
  checkpoint: FileCheckpoint | undefined;
  adapter: StorageAdapter;
}): Promise<FlushOutcome> {
  const { filePath, logFileName, hostname, adapter } = opts;
  let checkpoint = opts.checkpoint;

  const fd = openSync(filePath, 'r'); // read-only, shared; WoW keeps writing happily
  let head: Buffer;
  let size: number;
  let delta: Buffer;
  let reset = false;
  try {
    size = fstatSync(fd).size;

    const headBuf = Buffer.alloc(Math.min(IDENTITY_HEAD_BYTES, size));
    readSync(fd, headBuf, 0, headBuf.length, 0);
    head = headBuf;

    const checksum = firstLineChecksum(head);
    if (checksum === null) {
      // No complete first line yet — identity pending, try again next flush.
      return { checkpoint, flushedBytes: 0, reset: false, segmentKey: null };
    }

    if (checkpoint && (checkpoint.firstLineChecksum !== checksum || size < checkpoint.offset)) {
      // Recreated or truncated file: new generation, re-stream from 0.
      checkpoint = undefined;
      reset = true;
    }

    const startOffset = checkpoint?.offset ?? 0;
    if (size <= startOffset) {
      // Duplicate fs.watch event or no growth — idempotent no-op.
      return {
        checkpoint: checkpoint ?? { offset: startOffset, firstLineChecksum: checksum },
        flushedBytes: 0,
        reset,
        segmentKey: null,
      };
    }

    delta = Buffer.alloc(size - startOffset);
    readSync(fd, delta, 0, delta.length, startOffset);

    const gen8 = gen8Of(checksum);
    const segmentKey = buildSegmentKey(hostname, logFileName, gen8, startOffset);
    await adapter.put(segmentKey, gzipSync(delta));
    return {
      checkpoint: { offset: size, firstLineChecksum: checksum },
      flushedBytes: delta.length,
      reset,
      segmentKey,
    };
  } finally {
    closeSync(fd);
  }
}
```

Note: `await` inside `try` with `finally { closeSync }` — the fd closes on both success and failure paths. `readSync` on an open fd is safe while WoW appends; we read a snapshot `[startOffset, size)`.

- [ ] **Step 4: Run test to verify it passes**

```bash
npx tsdx test --passWithNoTests=false
```

Expected: PASS (all 6 flusher tests + prior suites).

- [ ] **Step 5: Prettier, lint, commit**

```bash
npx prettier --write src/flusher.ts src/__tests__/flusher.test.ts
npm run lint
git add src
git commit -m "feat(windows-agent): delta flusher with identity check and checkpoint-after-ack"
```

---

### Task 8: Watcher with debounce + quiet-period flush

**Files:**

- Create: `packages/windows-agent/src/watcher.ts`
- Test: `packages/windows-agent/src/__tests__/watcher.test.ts`

**Interfaces:**

- Consumes: nothing (node `fs.watch`, injected for tests).
- Produces:
  - `interface LogWatcher { close(): void; handleEvent(eventType: string, fileName: string | Buffer | null): void }`
  - `startLogWatcher(opts: { logsDir: string; flushIntervalMs: number; quietPeriodMs: number; onFlush: (fileNames: string[]) => Promise<void>; watchFn?: typeof watch }): LogWatcher`

Behavior contract:

1. `change` events for `WoWCombatLog*.txt` mark the file dirty; every `flushIntervalMs` while dirty, `onFlush([files])` fires and the dirty set clears.
2. `rename` events are dropped (existing `logWatcher.ts` workaround: rename fires on create/delete and races the first change).
3. Non-matching filenames (no `WoWCombatLog`, non-`.txt`) and null filenames are ignored.
4. Quiet period: after the LAST event, one extra flush fires `quietPeriodMs` later even if the interval timer already stopped (end-of-session tail).
5. Overlap guard: if a previous `onFlush` promise is still pending, the tick is skipped (serialization; files stay dirty and flush next tick).

- [ ] **Step 1: Write the failing tests** — `packages/windows-agent/src/__tests__/watcher.test.ts`

```ts
import { startLogWatcher } from '../watcher';

// watchFn stub: capture the listener, never touch the real fs
const noopWatch = (() => ({ close: jest.fn() })) as unknown as typeof import('fs').watch;

describe('startLogWatcher', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function make(onFlush: (files: string[]) => Promise<void>) {
    return startLogWatcher({
      logsDir: '/fake/Logs',
      flushIntervalMs: 60000,
      quietPeriodMs: 30000,
      onFlush,
      watchFn: noopWatch,
    });
  }

  it('flushes dirty files on the interval and clears the set', async () => {
    const flushes: string[][] = [];
    const w = make(async (files) => {
      flushes.push(files);
    });
    w.handleEvent('change', 'WoWCombatLog-1.txt');
    w.handleEvent('change', 'WoWCombatLog-2.txt');
    await jest.advanceTimersByTimeAsync(60000);
    expect(flushes).toEqual([['WoWCombatLog-1.txt', 'WoWCombatLog-2.txt']]);
    await jest.advanceTimersByTimeAsync(60000);
    expect(flushes).toHaveLength(1); // nothing dirty → no second flush
    w.close();
  });

  it('drops rename events and non-log filenames', async () => {
    const flushes: string[][] = [];
    const w = make(async (files) => {
      flushes.push(files);
    });
    w.handleEvent('rename', 'WoWCombatLog-1.txt');
    w.handleEvent('change', 'SoundCache.dat');
    w.handleEvent('change', null);
    await jest.advanceTimersByTimeAsync(120000);
    expect(flushes).toHaveLength(0);
    w.close();
  });

  it('fires a final quiet-period flush after events stop', async () => {
    const flushes: string[][] = [];
    const w = make(async (files) => {
      flushes.push(files);
    });
    w.handleEvent('change', 'WoWCombatLog-1.txt');
    // quiet period (30s) elapses before the 60s interval tick
    await jest.advanceTimersByTimeAsync(30000);
    expect(flushes).toEqual([['WoWCombatLog-1.txt']]);
    await jest.advanceTimersByTimeAsync(120000);
    expect(flushes).toHaveLength(1); // no repeat flushes while idle
    w.close();
  });

  it('skips a tick while a previous flush is still running', async () => {
    let release: () => void = () => undefined;
    const flushes: string[][] = [];
    const w = make(
      (files) =>
        new Promise<void>((resolve) => {
          flushes.push(files);
          release = resolve;
        }),
    );
    w.handleEvent('change', 'WoWCombatLog-1.txt');
    await jest.advanceTimersByTimeAsync(30000); // quiet flush starts, never resolves yet
    w.handleEvent('change', 'WoWCombatLog-2.txt');
    await jest.advanceTimersByTimeAsync(60000); // tick during pending flush → skipped
    expect(flushes).toHaveLength(1);
    release();
    await jest.advanceTimersByTimeAsync(60000); // next tick flushes the still-dirty file
    expect(flushes[1]).toEqual(['WoWCombatLog-2.txt']);
    w.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/mingjianliu/code/wowarenalogs/.worktrees/log-streaming-pipeline/packages/windows-agent
npx tsdx test --passWithNoTests=false
```

Expected: FAIL — `Cannot find module '../watcher'`.

- [ ] **Step 3: Implement** — `packages/windows-agent/src/watcher.ts`

```ts
import { watch } from 'fs';

export interface LogWatcher {
  close(): void;
  /** Exposed for tests; production events arrive via fs.watch. */
  handleEvent(eventType: string, fileName: string | Buffer | null): void;
}

/**
 * Event-driven watcher (zero polling): fs.watch marks files dirty; a flush
 * timer drains the dirty set every flushIntervalMs while active, plus one
 * quiet-period flush after the last event (wow-recorder's inactivity-timer
 * lesson — uploads the tail of the final match promptly). 'rename' events are
 * dropped, mirroring the app's logWatcher.ts new-file race workaround.
 */
export function startLogWatcher(opts: {
  logsDir: string;
  flushIntervalMs: number;
  quietPeriodMs: number;
  onFlush: (fileNames: string[]) => Promise<void>;
  watchFn?: typeof watch;
}): LogWatcher {
  const dirty = new Set<string>();
  let interval: ReturnType<typeof setInterval> | null = null;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  let flushing = false;
  let closed = false;

  const drain = async (): Promise<void> => {
    if (flushing || dirty.size === 0) return; // overlap guard: files stay dirty for the next tick
    const files = [...dirty].sort();
    dirty.clear();
    flushing = true;
    try {
      await opts.onFlush(files);
    } catch (e) {
      // Flush failures must not kill the watcher; files were cleared from the
      // dirty set but their checkpoints didn't advance, so the next event
      // (or quiet flush) retries the same byte range.
      for (const f of files) dirty.add(f);
      console.error(`[wal-agent] flush failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      flushing = false;
    }
  };

  const stopTimers = () => {
    if (interval) clearInterval(interval);
    interval = null;
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = null;
  };

  const handleEvent = (eventType: string, fileName: string | Buffer | null): void => {
    if (closed || eventType === 'rename') return;
    if (typeof fileName !== 'string' || !fileName.includes('WoWCombatLog') || !fileName.endsWith('.txt')) return;
    dirty.add(fileName);

    if (!interval) {
      interval = setInterval(() => {
        void drain();
        if (dirty.size === 0 && !flushing) stopTimers(); // fully idle → stop ticking
      }, opts.flushIntervalMs);
    }
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = setTimeout(() => {
      void drain();
    }, opts.quietPeriodMs);
  };

  const watcher = (opts.watchFn ?? watch)(opts.logsDir, handleEvent);

  return {
    handleEvent,
    close(): void {
      closed = true;
      stopTimers();
      watcher.close();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx tsdx test --passWithNoTests=false
```

Expected: PASS. If the interval-stop test (`no second flush`) fails because the interval was stopped before the tick, re-read the drain/stopTimers ordering — `drain` must run before the idle check in the tick.

- [ ] **Step 5: Prettier, lint, commit**

```bash
npx prettier --write src/watcher.ts src/__tests__/watcher.test.ts
npm run lint
git add src
git commit -m "feat(windows-agent): debounced watcher with quiet-period flush and overlap guard"
```

---

### Task 9: Agent main, heartbeat, bundle, README

**Files:**

- Create: `packages/windows-agent/src/heartbeat.ts`
- Create: `packages/windows-agent/src/index.ts` (replace the `export {};` placeholder if Task 1 created one)
- Create: `packages/windows-agent/src/initialScan.ts`
- Create: `packages/windows-agent/README.md`
- Test: `packages/windows-agent/src/__tests__/initialScan.test.ts`

**Interfaces:**

- Consumes: everything from Tasks 2–8.
- Produces:
  - `interface AgentHeartbeat { hostname: string; lastFlushAt: string; activeFile: string | null; offset: number | null; agentVersion: string; lastError: string | null }` and `writeHeartbeat(adapter: StorageAdapter, hb: AgentHeartbeat): Promise<void>` (puts JSON at `buildHeartbeatKey(hb.hostname)`).
  - `selectInitialFiles(entries: Array<{ name: string; mtimeMs: number }>, nowMs: number, ignoreOlderDays: number): string[]` — pure, testable first-run filter.
  - CLI: `node dist/wal-agent.js --config <path>` runs the agent; `--check` validates config + storage reachability (does a `list('status/')`) and exits.

- [ ] **Step 1: Write the failing test for the initial-scan filter** — `packages/windows-agent/src/__tests__/initialScan.test.ts`

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/mingjianliu/code/wowarenalogs/.worktrees/log-streaming-pipeline/packages/windows-agent
npx tsdx test --passWithNoTests=false
```

Expected: FAIL — `Cannot find module '../initialScan'`.

- [ ] **Step 3: Implement initialScan + heartbeat**

`packages/windows-agent/src/initialScan.ts`:

```ts
/**
 * First-run policy (Vector's ignore_older lesson): never blast months of
 * stale logs on install — only files touched within ignoreOlderDays are
 * seeded into the flush queue at startup.
 */
export function selectInitialFiles(
  entries: Array<{ name: string; mtimeMs: number }>,
  nowMs: number,
  ignoreOlderDays: number,
): string[] {
  const cutoff = nowMs - ignoreOlderDays * 86_400_000;
  return entries
    .filter((e) => e.name.includes('WoWCombatLog') && e.name.endsWith('.txt') && e.mtimeMs >= cutoff)
    .map((e) => e.name)
    .sort();
}
```

`packages/windows-agent/src/heartbeat.ts`:

```ts
import { buildHeartbeatKey } from './protocol/segments';
import { StorageAdapter } from './storage/StorageAdapter';

export interface AgentHeartbeat {
  hostname: string;
  lastFlushAt: string;
  activeFile: string | null;
  offset: number | null;
  agentVersion: string;
  lastError: string | null;
}

export async function writeHeartbeat(adapter: StorageAdapter, hb: AgentHeartbeat): Promise<void> {
  await adapter.put(buildHeartbeatKey(hb.hostname), Buffer.from(JSON.stringify(hb, null, 2)));
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx tsdx test --passWithNoTests=false
```

Expected: PASS.

- [ ] **Step 5: Implement the entry point** — `packages/windows-agent/src/index.ts`

```ts
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
```

- [ ] **Step 6: Typecheck, bundle, and smoke-test on the Mac with the localDir adapter**

```bash
npm run typecheck && npm run build
ls -la dist/wal-agent.js   # bundle exists

# smoke: fake WoW dir + localDir "bucket"
SMOKE=$(mktemp -d)
mkdir -p "$SMOKE/wow/Logs" "$SMOKE/bucket"
cat > "$SMOKE/wal-agent.config.json" <<EOF
{ "wowDirectory": "$SMOKE/wow", "hostname": "SMOKE-PC",
  "flushIntervalMs": 1000, "quietPeriodMs": 500,
  "storage": { "provider": "localDir", "directory": "$SMOKE/bucket" } }
EOF
node dist/wal-agent.js --config "$SMOKE/wal-agent.config.json" --check
```

Expected: bundle builds (if esbuild warns about optional GCS SDK dynamic requires, add `--external:@google-cloud/storage` to the build script AND document in the README that deployment then requires `npm install @google-cloud/storage` next to the bundle on the Windows box); `--check` prints `[wal-agent] config OK: ...` and exits 0.

- [ ] **Step 7: Live smoke — stream a growing file**

```bash
node dist/wal-agent.js --config "$SMOKE/wal-agent.config.json" &
AGENT_PID=$!
printf '6/14 18:30:00.000  COMBAT_LOG_VERSION,21\n' > "$SMOKE/wow/Logs/WoWCombatLog-061426_183000.txt"
sleep 2
printf '6/14 18:30:05.000  SPELL_CAST_SUCCESS,fake\n' >> "$SMOKE/wow/Logs/WoWCombatLog-061426_183000.txt"
sleep 2
kill $AGENT_PID
find "$SMOKE/bucket" -type f | sort
```

Expected: at least one `.seg` under `raw/SMOKE-PC/WoWCombatLog-061426_183000.txt/<gen8>/` and a `status/SMOKE-PC.json` heartbeat.

- [ ] **Step 8: Write `packages/windows-agent/README.md`**

```markdown
# wal-agent — WoW combat log streaming agent

Streams `WoWCombatLog*.txt` byte deltas from a Windows gaming PC to cloud
storage as gzip'd segments (`raw/<host>/<file>/<gen8>/<offset>.seg`).
Event-driven (`fs.watch`, zero polling), delta reads only, checkpoint advances
only after upload ack. Design: `docs/superpowers/specs/2026-07-02-log-streaming-pipeline-design.md`.

## Build (on the dev machine)

    npm run -w @wowarenalogs/windows-agent build   # → dist/wal-agent.js

## Deploy to the gaming PC

1. Install Node 22 LTS (https://nodejs.org).
2. Copy `dist/wal-agent.js` to e.g. `C:\wal-agent\wal-agent.js`.
3. Create `C:\wal-agent\wal-agent.config.json`:

   {
   "wowDirectory": "C:\\Program Files (x86)\\World of Warcraft\\_retail_",
   "hostname": "GAMING-PC",
   "storage": {
   "provider": "gcs",
   "bucket": "YOUR-BUCKET",
   "keyFilename": "C:\\wal-agent\\service-account.json"
   }
   }

4. GCP setup (once): create a private bucket; create a service account with
   ONLY `roles/storage.objectCreator` on that bucket; download its JSON key to
   `C:\wal-agent\service-account.json`. Add a 30-day lifecycle-delete rule on
   the bucket. The agent also needs `roles/storage.objectViewer` **denied is
   fine** — `--check` uses list, so grant `roles/storage.legacyBucketReader`
   for `--check`, or skip `--check` and watch the heartbeat instead.
5. Verify: `node C:\wal-agent\wal-agent.js --config C:\wal-agent\wal-agent.config.json --check`
6. Register at logon (elevated prompt):

   schtasks /create /tn "wal-agent" /sc onlogon ^
   /tr "\"C:\Program Files\nodejs\node.exe\" C:\wal-agent\wal-agent.js --config C:\wal-agent\wal-agent.config.json"

In WoW: enable Advanced Combat Logging (System → Network) and `/combatlog`
(or use an addon that toggles it in arena).

## Config reference

| field           | default | notes                                 |
| --------------- | ------- | ------------------------------------- |
| wowDirectory    | —       | the `_retail_` dir containing `Logs/` |
| hostname        | —       | tag used in storage keys + heartbeat  |
| flushIntervalMs | 60000   | upload cadence while playing          |
| quietPeriodMs   | 30000   | final flush after writes stop         |
| ignoreOlderDays | 7       | first-run: skip files older than this |
| storage         | —       | `{provider: "gcs"\|"localDir", ...}`  |

CPU: idle 0% (event-driven), ~40MB RSS; flush cost = read new bytes + gzip + one HTTPS PUT.
```

- [ ] **Step 9: Prettier, lint, full package test, commit**

```bash
npx prettier --write src/index.ts src/heartbeat.ts src/initialScan.ts README.md
npm run lint && npm run typecheck && npx tsdx test --passWithNoTests=false
git add src README.md package.json
git commit -m "feat(windows-agent): agent entrypoint, heartbeat, initial scan, esbuild bundle, README"
```

---

### Task 10: Reconstruction planner (`reconstruct.ts`)

**Files:**

- Create: `packages/windows-agent/src/protocol/reconstruct.ts`
- Test: `packages/windows-agent/src/__tests__/reconstruct.test.ts`

**Interfaces:**

- Consumes: nothing (pure).
- Produces:
  - `type NextAction = { type: 'append'; startOffset: number } | { type: 'gap'; expected: number; nextAvailable: number } | { type: 'done' }`
  - `nextAction(currentSize: number, availableOffsets: number[]): NextAction`

The collector loop is: `nextAction` → download/gunzip/append that segment → size grows → repeat. Duplicates (offset < size) are skipped; a hole (smallest offset > size) reports `gap` and the collector stops that file with a warning rather than corrupt it.

- [ ] **Step 1: Write the failing test** — `packages/windows-agent/src/__tests__/reconstruct.test.ts`

```ts
import { nextAction } from '../protocol/reconstruct';

describe('nextAction', () => {
  it('appends the segment that starts exactly at current size', () => {
    expect(nextAction(0, [0, 100, 250])).toEqual({ type: 'append', startOffset: 0 });
    expect(nextAction(100, [0, 100, 250])).toEqual({ type: 'append', startOffset: 100 });
  });

  it('skips duplicate/already-applied offsets', () => {
    expect(nextAction(250, [0, 100])).toEqual({ type: 'done' });
    expect(nextAction(100, [0, 0, 100])).toEqual({ type: 'append', startOffset: 100 });
  });

  it('reports a gap instead of appending past a hole', () => {
    expect(nextAction(100, [0, 250])).toEqual({ type: 'gap', expected: 100, nextAvailable: 250 });
  });

  it('done when no offsets remain at or past current size', () => {
    expect(nextAction(0, [])).toEqual({ type: 'done' });
  });

  it('handles unsorted input', () => {
    expect(nextAction(100, [250, 0, 100])).toEqual({ type: 'append', startOffset: 100 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/mingjianliu/code/wowarenalogs/.worktrees/log-streaming-pipeline/packages/windows-agent
npx tsdx test --passWithNoTests=false
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `packages/windows-agent/src/protocol/reconstruct.ts`

```ts
export type NextAction =
  | { type: 'append'; startOffset: number }
  | { type: 'gap'; expected: number; nextAvailable: number }
  | { type: 'done' };

/**
 * One step of byte-exact reconstruction: the only appendable segment is the
 * one starting exactly at the current reconstructed size. Anything earlier is
 * an already-applied duplicate; anything later means a segment is missing and
 * appending would corrupt the log — surface it as a gap instead.
 */
export function nextAction(currentSize: number, availableOffsets: number[]): NextAction {
  const candidates = [...new Set(availableOffsets)].filter((o) => o >= currentSize).sort((a, b) => a - b);
  if (candidates.length === 0) return { type: 'done' };
  if (candidates[0] === currentSize) return { type: 'append', startOffset: currentSize };
  return { type: 'gap', expected: currentSize, nextAvailable: candidates[0] };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx tsdx test --passWithNoTests=false
```

Expected: PASS.

- [ ] **Step 5: Prettier, lint, commit**

```bash
npx prettier --write src/protocol/reconstruct.ts src/__tests__/reconstruct.test.ts
npm run lint
git add src
git commit -m "feat(windows-agent): reconstruction planner with gap detection"
```

---

### Task 11: Mac collector (`packages/tools`)

**Files:**

- Create: `packages/tools/src/collect/collectorConfig.ts`
- Create: `packages/tools/src/collect/statusFile.ts`
- Create: `packages/tools/src/collectLogs.ts`
- Modify: `packages/tools/package.json` (add script `start:collectLogs`)

**Interfaces:**

- Consumes (cross-package source imports from `../../windows-agent/src/...` — same pattern web uses for shared): `StorageAdapter`, `createAdapter`, `StorageConfig`, `parseSegmentKey`, `nextAction`.
- Produces:
  - `interface CollectorConfig { storage: StorageConfig; syncDir: string }` and `loadCollectorConfig(): CollectorConfig` — reads `${WAL_SYNC_DIR ?? ~/wal-sync}/collector.config.json`; `syncDir` defaults to that dir.
  - `runCollection(config: CollectorConfig): Promise<CollectStats>` where `CollectStats = { segmentsFetched: number; bytesAppended: number; filesUpdated: string[]; gaps: string[] }`.
  - `writeStatus(syncDir: string, status: CollectorStatus): void` and `appendRun(syncDir: string, run: RunRecord): void` with types below (Task 13/14 consume them):
    - `CollectorStatus = { phase: 'idle' | 'collecting' | 'analyzing'; updatedAt: string; detail: string }`
    - `RunRecord = { startedAt: string; finishedAt: string; segmentsFetched: number; bytesAppended: number; filesUpdated: string[]; gaps: string[]; analysisExitCode: number | null; error: string | null }`
- No unit tests here (tools has no working test harness — see Global Constraints); all logic with branching (`nextAction`, `parseSegmentKey`) is already unit-tested in windows-agent, and this task ends with a scripted functional check against a localDir fixture.

- [ ] **Step 1: Implement collector config** — `packages/tools/src/collect/collectorConfig.ts`

```ts
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

import { StorageConfig } from '../../../windows-agent/src/config';

export interface CollectorConfig {
  storage: StorageConfig;
  syncDir: string;
}

export function syncDirPath(): string {
  return process.env.WAL_SYNC_DIR ?? path.join(os.homedir(), 'wal-sync');
}

export function loadCollectorConfig(): CollectorConfig {
  const syncDir = syncDirPath();
  const configPath = path.join(syncDir, 'collector.config.json');
  if (!fs.pathExistsSync(configPath)) {
    throw new Error(
      `Collector config not found: ${configPath}\n` +
        `Create it, e.g. { "storage": { "provider": "gcs", "bucket": "YOUR-BUCKET", "keyFilename": "${path.join(
          syncDir,
          'reader-key.json',
        )}" } }`,
    );
  }
  const json = fs.readJsonSync(configPath) as { storage?: StorageConfig };
  if (!json.storage) throw new Error(`Collector config error: "storage" block is required in ${configPath}`);
  return { storage: json.storage, syncDir };
}
```

- [ ] **Step 2: Implement status/run files** — `packages/tools/src/collect/statusFile.ts`

```ts
import fs from 'fs-extra';
import path from 'path';

export interface CollectorStatus {
  phase: 'idle' | 'collecting' | 'analyzing';
  updatedAt: string;
  detail: string;
}

export interface RunRecord {
  startedAt: string;
  finishedAt: string;
  segmentsFetched: number;
  bytesAppended: number;
  filesUpdated: string[];
  gaps: string[];
  analysisExitCode: number | null;
  error: string | null;
}

export function writeStatus(syncDir: string, status: CollectorStatus): void {
  const p = path.join(syncDir, 'status.json');
  fs.ensureDirSync(syncDir);
  fs.writeJsonSync(`${p}.tmp`, status, { spaces: 2 });
  fs.renameSync(`${p}.tmp`, p);
}

export function appendRun(syncDir: string, run: RunRecord): void {
  fs.ensureDirSync(syncDir);
  fs.appendFileSync(path.join(syncDir, 'runs.jsonl'), `${JSON.stringify(run)}\n`);
}

export function readRuns(syncDir: string, limit: number): RunRecord[] {
  const p = path.join(syncDir, 'runs.jsonl');
  if (!fs.pathExistsSync(p)) return [];
  const lines = fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean);
  return lines.slice(-limit).flatMap((l) => {
    try {
      return [JSON.parse(l) as RunRecord];
    } catch {
      return [];
    }
  });
}
```

- [ ] **Step 3: Implement the collector** — `packages/tools/src/collectLogs.ts`

```ts
/* eslint-disable no-console */
/**
 * collectLogs.ts — pull new log segments from storage and reconstruct
 * WoWCombatLog files byte-exactly under <syncDir>/logs/.
 *
 * Usage: npm run -w @wowarenalogs/tools start:collectLogs
 * Config: <syncDir>/collector.config.json  (syncDir = $WAL_SYNC_DIR or ~/wal-sync)
 */
import fs from 'fs-extra';
import path from 'path';
import zlib from 'zlib';

import { nextAction } from '../../windows-agent/src/protocol/reconstruct';
import { parseSegmentKey, SegmentRef } from '../../windows-agent/src/protocol/segments';
import { createAdapter } from '../../windows-agent/src/storage/createAdapter';
import { StorageAdapter } from '../../windows-agent/src/storage/StorageAdapter';
import { CollectorConfig, loadCollectorConfig } from './collect/collectorConfig';

export interface CollectStats {
  segmentsFetched: number;
  bytesAppended: number;
  filesUpdated: string[];
  gaps: string[];
}

/** Multiple generations of the same file name get distinct outputs (rare). */
function outputNameFor(ref: SegmentRef, genOrder: string[]): string {
  if (genOrder.length <= 1 || ref.gen8 === genOrder[0]) return ref.logFileName;
  return ref.logFileName.replace(/\.txt$/, `.${ref.gen8}.txt`);
}

export async function runCollection(config: CollectorConfig): Promise<CollectStats> {
  const adapter: StorageAdapter = createAdapter(config.storage);
  const logsDir = path.join(config.syncDir, 'logs');
  fs.ensureDirSync(logsDir);

  const stats: CollectStats = { segmentsFetched: 0, bytesAppended: 0, filesUpdated: [], gaps: [] };
  const keys = await adapter.list('raw/');
  const refs = keys.map(parseSegmentKey).filter((r): r is SegmentRef => r !== null);

  // Group segments by (hostname, logFileName, gen8)
  const groups = new Map<string, SegmentRef[]>();
  for (const ref of refs) {
    const groupKey = `${ref.hostname}/${ref.logFileName}/${ref.gen8}`;
    const group = groups.get(groupKey) ?? [];
    group.push(ref);
    groups.set(groupKey, group);
  }

  // Stable generation order per file name = first-seen order in sorted keys
  const genOrder = new Map<string, string[]>();
  for (const ref of refs) {
    const gens = genOrder.get(ref.logFileName) ?? [];
    if (!gens.includes(ref.gen8)) gens.push(ref.gen8);
    genOrder.set(ref.logFileName, gens);
  }

  for (const [groupKey, group] of groups) {
    const outName = outputNameFor(group[0], genOrder.get(group[0].logFileName) ?? []);
    const outPath = path.join(logsDir, outName);
    const offsets = group.map((r) => r.startOffset);
    const byOffset = new Map(group.map((r) => [r.startOffset, r]));

    let updated = false;
    // Append-only loop: each appended segment advances the file size to the
    // next expected offset. tmp+rename per cycle keeps crashes clean.
    for (;;) {
      const size = fs.pathExistsSync(outPath) ? fs.statSync(outPath).size : 0;
      const action = nextAction(size, offsets);
      if (action.type === 'done') break;
      if (action.type === 'gap') {
        const warning = `${groupKey}: gap at ${action.expected}, next segment ${action.nextAvailable}`;
        console.warn(`[collect] WARN ${warning}`);
        stats.gaps.push(warning);
        break;
      }
      const ref = byOffset.get(action.startOffset) as SegmentRef;
      const body = zlib.gunzipSync(await adapter.get(ref.key));
      const tmpPath = `${outPath}.tmp`;
      const existing = fs.pathExistsSync(outPath) ? fs.readFileSync(outPath) : Buffer.alloc(0);
      fs.writeFileSync(tmpPath, Buffer.concat([existing, body]));
      fs.renameSync(tmpPath, outPath);
      stats.segmentsFetched += 1;
      stats.bytesAppended += body.length;
      updated = true;
    }
    if (updated) stats.filesUpdated.push(outName);
  }

  console.log(
    `[collect] fetched ${stats.segmentsFetched} segment(s), +${stats.bytesAppended}B across ${stats.filesUpdated.length} file(s)` +
      (stats.gaps.length ? `, ${stats.gaps.length} gap warning(s)` : ''),
  );
  return stats;
}

if (require.main === module) {
  runCollection(loadCollectorConfig()).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Add the npm script** — in `packages/tools/package.json` scripts, after `"start:collectBenchmarks"`:

```json
    "start:collectLogs": "dotenv -- ts-node --files ./src/collectLogs.ts",
```

- [ ] **Step 5: Functional check against the Task 9 smoke fixture** (agent output is still in `$SMOKE/bucket`; if the shell is gone, re-run Task 9 Step 7 first)

```bash
cd /Users/mingjianliu/code/wowarenalogs/.worktrees/log-streaming-pipeline
SYNC=$(mktemp -d)
cat > "$SYNC/collector.config.json" <<EOF
{ "storage": { "provider": "localDir", "directory": "$SMOKE/bucket" } }
EOF
WAL_SYNC_DIR=$SYNC npm run -w @wowarenalogs/tools start:collectLogs
diff "$SYNC/logs/WoWCombatLog-061426_183000.txt" "$SMOKE/wow/Logs/WoWCombatLog-061426_183000.txt" && echo "BYTE-EXACT ✅"
# idempotency: second run fetches nothing
WAL_SYNC_DIR=$SYNC npm run -w @wowarenalogs/tools start:collectLogs
```

Expected: `BYTE-EXACT ✅`; second run prints `fetched 0 segment(s)`.

- [ ] **Step 6: Prettier, lint, typecheck, commit**

```bash
npx prettier --write packages/tools/src/collectLogs.ts packages/tools/src/collect/*.ts packages/tools/package.json
npm run -w @wowarenalogs/tools lint && npm run -w @wowarenalogs/tools typecheck
npm run -w @wowarenalogs/windows-agent lint   # tools imports agent source; both must stay clean
git add packages/tools
git commit -m "feat(tools): storage collector reconstructs logs byte-exactly from segments"
```

Note: if `npm run -w @wowarenalogs/tools typecheck` fails inside `@google-cloud/storage` typings (tools has TS 4.1.5; the import chain pulls GCS types through `createAdapter`), fix by having `collectLogs.ts` import `createAdapter` lazily via `require` inside `runCollection` OR bump `typescript` in `packages/tools/devDependencies` to `^4.9.5` (preferred; verify `npm run -w @wowarenalogs/tools typecheck` still passes on the whole package).

---

### Task 12: Archive meta-eval summaries per run

**Files:**

- Modify: `packages/tools/src/localBatchAnalysis.ts` (Phase 2 tail, after `await fs.writeFile(SUMMARY_FILE, ...)`)
- Modify: `packages/tools/.gitignore` or root `.gitignore` if `local-batch/` isn't ignored (check first)

**Interfaces:**

- Consumes: existing `SUMMARY_FILE`/`OUTPUT_DIR` constants in `localBatchAnalysis.ts`.
- Produces: `packages/tools/local-batch/reports/summary-YYYY-MM-DD.md` written on every Phase 2 run.

- [ ] **Step 1: Check ignore status**

```bash
cd /Users/mingjianliu/code/wowarenalogs/.worktrees/log-streaming-pipeline
git check-ignore -v packages/tools/local-batch/results.jsonl || echo "NOT IGNORED"
```

If NOT IGNORED, add to `packages/tools/.gitignore` (create if missing):

```
local-batch/
```

- [ ] **Step 2: Add the archive write** — in `packages/tools/src/localBatchAnalysis.ts`, `runPhase2()`, immediately after the existing `await fs.writeFile(SUMMARY_FILE, fullSummary, 'utf-8');` line:

```ts
// Archive each run's meta-eval so history survives the next overwrite.
const reportsDir = path.join(OUTPUT_DIR, 'reports');
await fs.ensureDir(reportsDir);
const archivePath = path.join(reportsDir, `summary-${reportDate}.md`);
await fs.writeFile(archivePath, fullSummary, 'utf-8');
console.log(`Archived → ${archivePath}`);
```

- [ ] **Step 3: Verify with a no-API-key Phase 2 run** (requires `results.jsonl` to exist; if `packages/tools/local-batch/results.jsonl` is absent in the worktree, copy it from the main repo checkout, or create a one-line stub:)

```bash
mkdir -p packages/tools/local-batch
[ -f packages/tools/local-batch/results.jsonl ] || cp /Users/mingjianliu/code/wowarenalogs/packages/tools/local-batch/results.jsonl packages/tools/local-batch/ 2>/dev/null || \
  echo '{"meta":{"logFile":"x.txt","matchIndex":1,"spec":"Unknown","bracket":"3v3","result":"Win","durationSeconds":120,"myTeam":[],"enemyTeam":[],"processedAt":"2026-07-02T00:00:00Z"},"prompt":"p","aiResponse":"r","feedbackSection":""}' > packages/tools/local-batch/results.jsonl
npm run -w @wowarenalogs/tools start:localBatchAnalysis -- --phase2-only
ls packages/tools/local-batch/reports/
```

Expected: runs without `ANTHROPIC_API_KEY` (summary body is `[SKIPPED — no ANTHROPIC_API_KEY]`), and `reports/summary-2026-07-02.md` exists.

- [ ] **Step 4: Prettier, lint, commit**

```bash
npx prettier --write packages/tools/src/localBatchAnalysis.ts
npm run -w @wowarenalogs/tools lint
git add packages/tools/src/localBatchAnalysis.ts packages/tools/.gitignore
git commit -m "feat(tools): archive meta-eval summary per run under local-batch/reports"
```

---

### Task 13: `collectAndAnalyze` orchestrator + launchd scheduling

**Files:**

- Create: `packages/tools/src/collectAndAnalyze.ts`
- Create: `packages/tools/launchd/collect-and-analyze.sh` (mode 755)
- Create: `packages/tools/launchd/com.wowarenalogs.collect.plist`
- Create: `packages/tools/launchd/README.md`
- Modify: `packages/tools/package.json` (add `start:collectAndAnalyze`)

**Interfaces:**

- Consumes: `runCollection`, `loadCollectorConfig` (Task 11), `writeStatus`/`appendRun` + `RunRecord` (Task 11), existing `start:localBatchAnalysis` script.
- Produces: one `RunRecord` appended to `<syncDir>/runs.jsonl` per run; `<syncDir>/status.json` live-updated; `npm run -w @wowarenalogs/tools start:collectAndAnalyze` as the single scheduled entrypoint.

- [ ] **Step 1: Implement the orchestrator** — `packages/tools/src/collectAndAnalyze.ts`

```ts
/* eslint-disable no-console */
/**
 * collectAndAnalyze.ts — scheduled pipeline entrypoint:
 *   collect segments → reconstruct logs → run localBatchAnalysis (LOG_DIR=<syncDir>/logs)
 * Writes status.json (live) and one runs.jsonl record per run for the dashboard.
 *
 * Usage: npm run -w @wowarenalogs/tools start:collectAndAnalyze
 */
import { spawnSync } from 'child_process';
import path from 'path';

import { loadCollectorConfig } from './collect/collectorConfig';
import { appendRun, writeStatus } from './collect/statusFile';
import { CollectStats, runCollection } from './collectLogs';

async function main(): Promise<void> {
  const config = loadCollectorConfig();
  const startedAt = new Date().toISOString();
  let stats: CollectStats = { segmentsFetched: 0, bytesAppended: 0, filesUpdated: [], gaps: [] };
  let analysisExitCode: number | null = null;
  let error: string | null = null;

  try {
    writeStatus(config.syncDir, {
      phase: 'collecting',
      updatedAt: new Date().toISOString(),
      detail: 'listing segments',
    });
    stats = await runCollection(config);

    writeStatus(config.syncDir, {
      phase: 'analyzing',
      updatedAt: new Date().toISOString(),
      detail: `analyzing logs in ${path.join(config.syncDir, 'logs')}`,
    });
    // Child process so the analysis keeps its own lifecycle/output; inherits
    // stdio so launchd's log file captures per-match progress.
    const result = spawnSync('npm', ['run', 'start:localBatchAnalysis'], {
      cwd: __dirname.replace(/\/src$/, ''), // packages/tools
      env: { ...process.env, LOG_DIR: path.join(config.syncDir, 'logs') },
      stdio: 'inherit',
    });
    analysisExitCode = result.status;
    if (result.status !== 0) error = `localBatchAnalysis exited ${result.status}`;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    console.error(`[collectAndAnalyze] ${error}`);
  } finally {
    writeStatus(config.syncDir, { phase: 'idle', updatedAt: new Date().toISOString(), detail: error ?? 'ok' });
    appendRun(config.syncDir, {
      startedAt,
      finishedAt: new Date().toISOString(),
      segmentsFetched: stats.segmentsFetched,
      bytesAppended: stats.bytesAppended,
      filesUpdated: stats.filesUpdated,
      gaps: stats.gaps,
      analysisExitCode,
      error,
    });
  }
  if (error) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Add the npm script** — in `packages/tools/package.json`, after `start:collectLogs`:

```json
    "start:collectAndAnalyze": "dotenv -- ts-node --files ./src/collectAndAnalyze.ts",
```

- [ ] **Step 3: Create the lock-guarded shell wrapper** — `packages/tools/launchd/collect-and-analyze.sh`

```bash
#!/usr/bin/env bash
# launchd / Run-Now entrypoint: overlap lock + repo-relative npm invocation.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SYNC_DIR="${WAL_SYNC_DIR:-$HOME/wal-sync}"
mkdir -p "$SYNC_DIR"

LOCKDIR="$SYNC_DIR/run.lock"
if ! mkdir "$LOCKDIR" 2>/dev/null; then
  echo "[collect-and-analyze] previous run still active, skipping ($(date))"
  exit 0
fi
trap 'rmdir "$LOCKDIR"' EXIT

cd "$REPO_ROOT/packages/tools"
npm run start:collectAndAnalyze
```

```bash
chmod 755 packages/tools/launchd/collect-and-analyze.sh
```

- [ ] **Step 4: Create the plist template** — `packages/tools/launchd/com.wowarenalogs.collect.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.wowarenalogs.collect</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/Users/mingjianliu/code/wowarenalogs/packages/tools/launchd/collect-and-analyze.sh</string>
  </array>
  <key>StartInterval</key>
  <integer>21600</integer><!-- every 6 hours -->
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>/Users/mingjianliu/wal-sync/launchd.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/mingjianliu/wal-sync/launchd.log</string>
</dict>
</plist>
```

- [ ] **Step 5: Write install docs** — `packages/tools/launchd/README.md`

```markdown
# Scheduled collection + analysis (macOS launchd)

Points at the MAIN repo checkout (not a worktree). Install after merging:

    mkdir -p ~/wal-sync
    # one-time: ~/wal-sync/collector.config.json with your storage block, and
    # ANTHROPIC_API_KEY in packages/tools/.env (dotenv loads it; never leaves this Mac)
    cp packages/tools/launchd/com.wowarenalogs.collect.plist ~/Library/LaunchAgents/
    launchctl load ~/Library/LaunchAgents/com.wowarenalogs.collect.plist

Interval: edit StartInterval (seconds; 21600 = 6h) and `launchctl unload` + `load`.
Manual run: `bash packages/tools/launchd/collect-and-analyze.sh` (same overlap lock).
Logs: ~/wal-sync/launchd.log. Uninstall: `launchctl unload ...` and delete the plist.
```

- [ ] **Step 6: Functional check (no launchd, direct invocation, localDir fixture from Task 11)**

```bash
cd /Users/mingjianliu/code/wowarenalogs/.worktrees/log-streaming-pipeline
WAL_SYNC_DIR=$SYNC bash packages/tools/launchd/collect-and-analyze.sh
cat "$SYNC/runs.jsonl" | tail -1
cat "$SYNC/status.json"
```

Expected: run completes (analysis phase runs `localBatchAnalysis` against `$SYNC/logs` — without `ANTHROPIC_API_KEY` it records `[SKIPPED]` responses, exit 0); `runs.jsonl` gains a record with `analysisExitCode: 0`; `status.json` shows `"phase": "idle"`. Second concurrent invocation (`bash ... & bash ...`) → one prints `previous run still active`.

- [ ] **Step 7: Prettier, lint, commit**

```bash
npx prettier --write packages/tools/src/collectAndAnalyze.ts packages/tools/launchd/README.md
npm run -w @wowarenalogs/tools lint && npm run -w @wowarenalogs/tools typecheck
git add packages/tools
git commit -m "feat(tools): collectAndAnalyze orchestrator with launchd schedule + overlap lock"
```

---

### Task 14: Dashboard

**Files:**

- Create: `packages/tools/src/dashboard/schedule.ts`
- Create: `packages/tools/src/dashboard/server.ts`
- Create: `packages/tools/src/dashboard/index.html`
- Modify: `packages/tools/package.json` (add `dashboard` script)
- Test: `packages/windows-agent/src/__tests__/` — none; the one pure helper (`nextRunAt`) lives in tools where there's no harness, so it is kept trivial enough to verify by the functional check below.

**Interfaces:**

- Consumes: `readRuns`, `CollectorStatus`, `RunRecord` (Task 11), `loadCollectorConfig`/`syncDirPath` (Task 11), `createAdapter` + `buildHeartbeatKey`-shaped keys (`status/` prefix) from windows-agent source, `AgentHeartbeat` shape (Task 9), launchd plist at `~/Library/LaunchAgents/com.wowarenalogs.collect.plist`, lock dir `<syncDir>/run.lock`, `collect-and-analyze.sh` (Task 13).
- Produces: `npm run -w @wowarenalogs/tools dashboard` → `http://127.0.0.1:5178` with `GET /` (page), `GET /api/status` (JSON below), `POST /api/run` (spawns the shell wrapper, 409 if locked).

`GET /api/status` response shape:

```ts
interface DashboardStatus {
  heartbeats: Array<{
    hostname: string;
    lastFlushAt: string;
    activeFile: string | null;
    offset: number | null;
    agentVersion: string;
    lastError: string | null;
  }>;
  collector: { phase: string; updatedAt: string; detail: string } | null;
  runs: RunRecord[]; // last 20, newest last
  schedule: { intervalSeconds: number | null; lastRunAt: string | null; nextRunAt: string | null };
  running: boolean;
  reportsDir: string;
}
```

- [ ] **Step 1: Implement schedule helper** — `packages/tools/src/dashboard/schedule.ts`

```ts
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

const PLIST_PATH = path.join(os.homedir(), 'Library/LaunchAgents/com.wowarenalogs.collect.plist');

export function readScheduleInterval(): number | null {
  if (!fs.pathExistsSync(PLIST_PATH)) return null;
  const m = /<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(fs.readFileSync(PLIST_PATH, 'utf-8'));
  return m ? parseInt(m[1], 10) : null;
}

export function nextRunAt(lastRunAt: string | null, intervalSeconds: number | null): string | null {
  if (!lastRunAt || !intervalSeconds) return null;
  return new Date(new Date(lastRunAt).getTime() + intervalSeconds * 1000).toISOString();
}
```

- [ ] **Step 2: Implement the server** — `packages/tools/src/dashboard/server.ts`

```ts
/* eslint-disable no-console */
/**
 * dashboard/server.ts — framework-free localhost dashboard for the pipeline.
 * Usage: npm run -w @wowarenalogs/tools dashboard   →  http://127.0.0.1:5178
 */
import { spawn } from 'child_process';
import fs from 'fs-extra';
import http from 'http';
import path from 'path';

import { createAdapter } from '../../../windows-agent/src/storage/createAdapter';
import { loadCollectorConfig, syncDirPath } from '../collect/collectorConfig';
import { readRuns } from '../collect/statusFile';
import { nextRunAt, readScheduleInterval } from './schedule';

const PORT = 5178;
const PAGE = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');

async function buildStatus(): Promise<unknown> {
  const syncDir = syncDirPath();
  let heartbeats: unknown[] = [];
  try {
    const config = loadCollectorConfig();
    const adapter = createAdapter(config.storage);
    const keys = await adapter.list('status/');
    heartbeats = await Promise.all(keys.map(async (k) => JSON.parse((await adapter.get(k)).toString())));
  } catch (e) {
    console.warn(`[dashboard] heartbeat read failed: ${e instanceof Error ? e.message : e}`);
  }
  const statusPath = path.join(syncDir, 'status.json');
  const collector = fs.pathExistsSync(statusPath) ? fs.readJsonSync(statusPath) : null;
  const runs = readRuns(syncDir, 20);
  const intervalSeconds = readScheduleInterval();
  const lastRunAt = runs.length > 0 ? runs[runs.length - 1].finishedAt : null;
  return {
    heartbeats,
    collector,
    runs,
    schedule: { intervalSeconds, lastRunAt, nextRunAt: nextRunAt(lastRunAt, intervalSeconds) },
    running: fs.pathExistsSync(path.join(syncDir, 'run.lock')),
    reportsDir: path.resolve(__dirname, '../../local-batch/reports'),
  };
}

const server = http.createServer((req, res) => {
  void (async () => {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE);
    } else if (req.method === 'GET' && req.url === '/api/status') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(await buildStatus()));
    } else if (req.method === 'POST' && req.url === '/api/run') {
      if (fs.pathExistsSync(path.join(syncDirPath(), 'run.lock'))) {
        res.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'already running' }));
        return;
      }
      const script = path.resolve(__dirname, '../../launchd/collect-and-analyze.sh');
      const child = spawn('bash', [script], { detached: true, stdio: 'ignore' });
      child.unref();
      res.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify({ started: true }));
    } else {
      res.writeHead(404).end('not found');
    }
  })().catch((e) => {
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(e) }));
  });
});

// 127.0.0.1 only — never expose the Run button beyond this machine.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[dashboard] http://127.0.0.1:${PORT}`);
});
```

- [ ] **Step 3: Create the page** — `packages/tools/src/dashboard/index.html`

```html
<!-- Served by server.ts; self-contained, polls /api/status every 5s. -->
<meta charset="utf-8" />
<title>WAL Pipeline</title>
<style>
  :root {
    color-scheme: dark;
  }
  body {
    font:
      14px/1.5 ui-monospace,
      monospace;
    background: #111418;
    color: #d5dbe1;
    margin: 2rem auto;
    max-width: 900px;
    padding: 0 1rem;
  }
  h1 {
    font-size: 1.2rem;
  }
  h2 {
    font-size: 1rem;
    margin-top: 1.6rem;
    color: #8ab4f8;
  }
  table {
    border-collapse: collapse;
    width: 100%;
  }
  td,
  th {
    border-bottom: 1px solid #2a2f36;
    padding: 4px 8px;
    text-align: left;
  }
  .ok {
    color: #7ee787;
  }
  .warn {
    color: #f0b429;
  }
  .err {
    color: #ff7b72;
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
  button:disabled {
    background: #30363d;
    cursor: default;
  }
  .stale {
    opacity: 0.6;
  }
</style>
<h1>WoW Arena Logs — streaming pipeline</h1>
<div id="agent">
  <h2>Gaming PC agent</h2>
  <div id="heartbeats">loading…</div>
</div>
<div>
  <h2>Collector</h2>
  <div id="collector">loading…</div>
  <p><button id="run">Run now</button> <span id="runmsg"></span></p>
</div>
<div>
  <h2>Schedule</h2>
  <div id="schedule">loading…</div>
</div>
<div>
  <h2>Recent runs</h2>
  <div id="runs">loading…</div>
</div>
<script>
  const $ = (id) => document.getElementById(id);
  const ago = (iso) => {
    if (!iso) return 'never';
    const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    return s < 90 ? s + 's ago' : s < 5400 ? Math.round(s / 60) + 'm ago' : Math.round(s / 3600) + 'h ago';
  };
  async function refresh() {
    const r = await fetch('/api/status');
    const s = await r.json();
    $('heartbeats').innerHTML = s.heartbeats.length
      ? s.heartbeats
          .map((h) => {
            const staleMs = Date.now() - new Date(h.lastFlushAt).getTime();
            const cls = staleMs < 10 * 60e3 ? 'ok' : 'warn';
            return `<p class="${staleMs > 60 * 60e3 ? 'stale' : ''}"><b>${h.hostname}</b>
            <span class="${cls}">last streamed ${ago(h.lastFlushAt)}</span>
            ${h.activeFile ? `— ${h.activeFile} @ ${h.offset}` : ''}
            ${h.lastError ? `<span class="err"> err: ${h.lastError}</span>` : ''}</p>`;
          })
          .join('')
      : '<p class="warn">no agent heartbeat found</p>';
    $('collector').innerHTML = s.collector
      ? `<p>phase <b>${s.collector.phase}</b> (${ago(s.collector.updatedAt)}) — ${s.collector.detail}</p>`
      : '<p class="warn">no collector status yet</p>';
    $('run').disabled = s.running;
    $('runmsg').textContent = s.running ? 'running…' : '';
    $('schedule').innerHTML = s.schedule.intervalSeconds
      ? `<p>every ${s.schedule.intervalSeconds / 3600}h — last ${ago(s.schedule.lastRunAt)}, next ~${
          s.schedule.nextRunAt ? new Date(s.schedule.nextRunAt).toLocaleString() : '?'
        }</p>`
      : '<p class="warn">launchd schedule not installed</p>';
    $('runs').innerHTML = s.runs.length
      ? `<table><tr><th>finished</th><th>segs</th><th>bytes</th><th>files</th><th>gaps</th><th>analysis</th></tr>` +
        s.runs
          .slice()
          .reverse()
          .map(
            (x) => `<tr>
          <td>${ago(x.finishedAt)}</td><td>${x.segmentsFetched}</td><td>${x.bytesAppended}</td>
          <td>${x.filesUpdated.length}</td>
          <td class="${x.gaps.length ? 'warn' : ''}">${x.gaps.length}</td>
          <td class="${x.error ? 'err' : 'ok'}">${x.error ?? 'exit ' + x.analysisExitCode}</td></tr>`,
          )
          .join('') +
        `</table><p>reports: <code id="rd"></code></p>`
      : '<p>no runs recorded yet</p>';
    if ($('rd')) $('rd').textContent = s.reportsDir;
  }
  $('run').onclick = async () => {
    $('run').disabled = true;
    const r = await fetch('/api/run', { method: 'POST' });
    $('runmsg').textContent = r.status === 202 ? 'started' : 'already running';
  };
  refresh();
  setInterval(refresh, 5000);
</script>
```

- [ ] **Step 4: Add the npm script** — in `packages/tools/package.json`, after `start:collectAndAnalyze`:

```json
    "dashboard": "dotenv -- ts-node --files ./src/dashboard/server.ts",
```

- [ ] **Step 5: Functional check**

```bash
cd /Users/mingjianliu/code/wowarenalogs/.worktrees/log-streaming-pipeline
WAL_SYNC_DIR=$SYNC npm run -w @wowarenalogs/tools dashboard &
sleep 3
curl -s http://127.0.0.1:5178/api/status | head -c 600; echo
curl -s -X POST http://127.0.0.1:5178/api/run
sleep 5
curl -s http://127.0.0.1:5178/api/status | grep -o '"running":[a-z]*'
kill %1
```

Expected: `/api/status` returns JSON with `heartbeats` (containing `SMOKE-PC` from the fixture), `runs` from Task 13's record, `schedule` (null interval — plist not installed on this machine yet); POST returns `{"started":true}`; a new run appears afterward. Also open `http://127.0.0.1:5178` in a browser and confirm the page renders all four sections.

- [ ] **Step 6: Prettier, lint, commit**

```bash
npx prettier --write packages/tools/src/dashboard/server.ts packages/tools/src/dashboard/schedule.ts packages/tools/src/dashboard/index.html
npm run -w @wowarenalogs/tools lint && npm run -w @wowarenalogs/tools typecheck
git add packages/tools
git commit -m "feat(tools): localhost pipeline dashboard (heartbeat, runs, schedule, run-now)"
```

---

### Task 15: Full end-to-end validation + repo docs

**Files:**

- Modify: `CLAUDE.md` (add source locations)
- Modify: `docs/repo-overview.md` (add `windows-agent` row to the package table)

**Interfaces:** consumes everything; produces a verified pipeline + updated docs.

- [ ] **Step 1: Fresh end-to-end with a realistic growing log**

```bash
cd /Users/mingjianliu/code/wowarenalogs/.worktrees/log-streaming-pipeline
E2E=$(mktemp -d); mkdir -p "$E2E/wow/Logs" "$E2E/bucket" "$E2E/sync"
# Source material: a real log if available, else synthetic lines
SRC=$(ls ~/Downloads/wow\ logs/WoWCombatLog*.txt 2>/dev/null | head -1)
[ -n "$SRC" ] || { SRC="$E2E/synthetic.txt"; for i in $(seq 1 5000); do echo "6/14 18:30:0$((i % 10)).000  SPELL_CAST_SUCCESS,line-$i"; done > "$SRC"; }

cat > "$E2E/wal-agent.config.json" <<EOF
{ "wowDirectory": "$E2E/wow", "hostname": "E2E-PC", "flushIntervalMs": 1000, "quietPeriodMs": 500,
  "storage": { "provider": "localDir", "directory": "$E2E/bucket" } }
EOF
cat > "$E2E/sync/collector.config.json" <<EOF
{ "storage": { "provider": "localDir", "directory": "$E2E/bucket" } }
EOF

node packages/windows-agent/dist/wal-agent.js --config "$E2E/wal-agent.config.json" &
AGENT=$!
# stream the source file into the "WoW log" in 64KB chunks, like a live session
DST="$E2E/wow/Logs/WoWCombatLog-070226_120000.txt"
SIZE=$(wc -c < "$SRC"); OFF=0
while [ $OFF -lt $SIZE ]; do
  dd if="$SRC" bs=65536 skip=$((OFF / 65536)) count=4 2>/dev/null >> "$DST"
  OFF=$((OFF + 262144)); sleep 1.2
done
sleep 3; kill $AGENT

WAL_SYNC_DIR="$E2E/sync" npm run -w @wowarenalogs/tools start:collectLogs
cmp "$E2E/sync/logs/WoWCombatLog-070226_120000.txt" "$DST" && echo "E2E BYTE-EXACT ✅"
```

Expected: `E2E BYTE-EXACT ✅` — multiple segments were flushed during "play" and reassembled identically. If `cmp` fails, debug with `find "$E2E/bucket" -type f | sort` (offsets must chain: each key's offset = previous offset + previous segment's uncompressed size).

- [ ] **Step 2: Chain analysis on the e2e output (no API key)**

```bash
WAL_SYNC_DIR="$E2E/sync" bash packages/tools/launchd/collect-and-analyze.sh
tail -1 "$E2E/sync/runs.jsonl"
```

Expected: exit 0; run record has `analysisExitCode: 0` (synthetic lines parse to zero matches — `localBatchAnalysis` exits 1 with "No WoWCombatLog files" only if the logs dir is empty, which it isn't; with a real `$SRC` log it processes matches with `[SKIPPED — no ANTHROPIC_API_KEY]` responses). If using synthetic input and `localBatchAnalysis` exits 1 because no matches parse, note it in the run record and treat exit-1-with-that-cause as expected here.

- [ ] **Step 3: Update `docs/repo-overview.md`** — add to the package table after the `recorder` row:

```markdown
| `windows-agent` | Library | Standalone Windows agent streaming combat logs to cloud storage. No workspace imports. |
```

- [ ] **Step 4: Update `CLAUDE.md`** — in `<source_locations>`, add:

```markdown
- Log streaming agent (Windows): `packages/windows-agent/src/` (protocol + storage adapters shared with collector)
- Log collector + pipeline dashboard: `packages/tools/src/collectLogs.ts`, `packages/tools/src/dashboard/`
```

- [ ] **Step 5: Full-repo gates**

```bash
cd /Users/mingjianliu/code/wowarenalogs/.worktrees/log-streaming-pipeline
npm run lint && npm run typecheck
npm run -w @wowarenalogs/windows-agent test
```

Expected: all pass, zero warnings.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md docs/repo-overview.md
git commit -m "docs: register windows-agent package and pipeline source locations"
```

- [ ] **Step 7: Finish** — use superpowers:finishing-a-development-branch. Note for ops (not code): before first real use, complete the GCP setup in `packages/windows-agent/README.md` and the launchd install in `packages/tools/launchd/README.md`.

---

## Self-Review (performed at write time)

**Spec coverage:** agent low-CPU behavior (T7–T9), storage adapter + GCS + contract tests (T4–T5), extra adapters for tests/e2e (T4), config/state/identity/first-run policy (T3, T6, T9), collector + gap detection + tmp/rename (T10–T11), analysis reuse + archive addition (T12–T13), launchd + lock (T13), dashboard incl. heartbeat + Run Now on 127.0.0.1 (T9, T14), e2e vs real corpus (T15), docs (T9, T13, T15). Security: write-only agent creds documented (T9 README); Anthropic key stays in tools/.env (T13 README).

**Known deviations from spec, intentional:** (1) segment keys gained a `<gen8>` generation component (collision fix — spec amended in T2); (2) collector tests live in windows-agent as pure protocol functions because tools has no working test harness (documented in Global Constraints); (3) heartbeat needs list+get on the bucket from the Mac (reader credential), and `--check` needs list from the PC — README notes the permission implications.

**Type consistency check:** `FileCheckpoint`/`AgentState` (T6) used by T7/T9; `FlushOutcome` (T7) consumed in T9's `flushBatch`; `SegmentRef` (T2) consumed by T11; `RunRecord`/`CollectorStatus` (T11) consumed by T13/T14; `CollectStats` (T11) consumed by T13; `StorageConfig` (T6) consumed by T11's `CollectorConfig`. All names verified consistent.
