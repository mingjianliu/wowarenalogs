# Arena Log Streaming + Auto-Analysis Pipeline — Design

**Date:** 2026-07-02
**Status:** Approved

## Problem

The user plays WoW arena on a Windows gaming PC, which writes `WoWCombatLog*.txt` files locally. Today, getting those logs analyzed requires manually copying them to the Mac (`~/Downloads/wow logs/`) and running `localBatchAnalysis` by hand. The goal is a hands-off pipeline: logs stream off the Windows machine while playing, land in cloud storage, and the Mac periodically collects them, runs per-match AI analysis plus a cross-match meta-eval, and stores reports locally — with a UI to observe progress and schedule.

## Goals

- Windows-side agent streams combat log bytes off the gaming PC in near-real-time while playing, with negligible CPU cost.
- Storage layer is an **adapter**: GCS first, swappable later for S3, Google Drive, R2, etc. with no agent/collector changes.
- Mac collects new log data on a schedule, reconstructs log files, and runs the existing analysis pipeline automatically.
- Meta-eval reports (`summary.md`) are archived per run, not overwritten.
- A local dashboard UI shows pipeline health: agent heartbeat, run history, progress, schedule.

## Non-Goals

- No parsing on the Windows machine (agent stays dumb).
- No cloud-side analysis in v1 (bucket layout permits it later via storage triggers).
- No changes to the existing Electron desktop app, web app, or cloud functions.
- No multi-user support — this is a personal pipeline for one player, one or more machines.

## Architecture

```
Windows gaming PC                    Storage (adapter)          Mac (this machine)
┌──────────────────────┐            ┌───────────────┐          ┌───────────────────────────┐
│ wal-agent (Node)     │  put(seg)  │ raw/<host>/   │  list/   │ collectLogs (launchd)     │
│ fs.watch Logs/*.txt  │ ─────────► │  <file>/      │  get     │  reconstruct logs         │
│ byte-offset ckpt     │            │  <offset>.seg │ ◄─────── │ localBatchAnalysis        │
│ heartbeat status     │            │ status/<host> │          │  → results.jsonl          │
└──────────────────────┘            └───────────────┘          │  → summary.md (+archive)  │
                                                               │ dashboard (localhost)     │
                                                               └───────────────────────────┘
```

## Components

### 1. Windows agent — `packages/windows-agent`

A single-purpose Node script, no Electron, **no imports from other workspace packages** (deployable standalone). Bundled with esbuild into one `wal-agent.js` copied to the gaming PC and registered with Task Scheduler (run at logon).

**Low-CPU by construction:**

- Native `fs.watch` on `<wow>/Logs/` — OS-level event notifications, zero polling, no directory scans. Reuses the proven pattern from `packages/app/src/nativeBridge/modules/logsModule/logWatcher.ts`, including its workaround of dropping `rename` events to avoid the new-file race.
- Fully idle when WoW isn't writing (~0% CPU, ~40MB RSS).
- Delta reads only: each flush streams just the bytes between the checkpoint and current EOF; never re-reads a file.
- No parsing, no compression beyond gzip of the segment body.

**Behavior:**

- Config file `wal-agent.config.json` beside the script: WoW install dir, storage provider + credentials block, hostname tag, flush interval (default 60s), `ignoreOlderDays` (default 7 — on first run, files not modified within this window are never uploaded; lesson from Vector's `ignore_older`, prevents blasting months of stale logs on install).
- Per-file checkpoint persisted in a local state file (`wal-agent.state.json`): byte offset **plus a checksum of the file's first line** (content-based file identity, per Vector's fingerprinting — a recreated file with the same name is detected by checksum mismatch, not just by shrinking size, and resets to offset 0). Checkpoint advances **only after upload ack** — crash-safe and network-failure-safe; on restart it resumes from the last acked offset.
- On change events (debounced to the flush interval), for each dirty file: open → read `[checkpoint, EOF)` → close (never hold a file handle between flushes — open handles on Windows can block the game or cleanup tools from rotating/deleting the file; Filebeat's documented Windows pitfall), gzip, `put` as a segment object, advance checkpoint.
- Flushes are **idempotent and serialized per file**: `fs.watch` is known to emit duplicate events for a single write (wow-recorder guards this explicitly), so a flush where `EOF <= checkpoint` is a no-op, and two flushes of the same file never run concurrently.
- **Quiet-period final flush** (from wow-recorder's inactivity timer): when write events stop, one last flush fires after ~30s of quiet so the tail of the final match uploads promptly instead of waiting for a next event that never comes.
- Segment key scheme (provider-agnostic): `raw/<hostname>/<logFileName>/<startOffset>.seg`. WoW opens a new timestamped log per session, so rotation is handled naturally (new filename → new key prefix). Offsets are zero-padded to 12 digits so lexicographic order equals numeric order.
- Heartbeat: each flush also `put`s `status/<hostname>.json` — `{ lastFlushAt, activeFile, offset, agentVersion }` — consumed by the dashboard.
- Filename filter identical to existing watcher: contains `WoWCombatLog`, ends `.txt`.

**Edge cases:**

- File truncated, shorter than checkpoint, or first-line checksum mismatch (log deleted/recreated with same name): reset checkpoint to 0 and re-stream.
- Partial last line at EOF is acceptable — the collector concatenates segments byte-for-byte, so line boundaries reassemble exactly. (This is a deliberate advantage of shipping raw bytes: line-oriented tailers like wow-recorder must special-case partial lines; we don't.)
- Upload failure: checkpoint doesn't advance; next flush retries the same range. Errors logged to a local rotating log file, and surfaced via a `lastError` field in the heartbeat.
- **Duplicate-safety invariant** (Filebeat's at-least-once lesson): a crash between upload ack and checkpoint write causes a re-upload of the same range — which produces the **same segment key** (`<startOffset>.seg`), an idempotent overwrite of identical bytes. The collector's `offset == reconstructed size` check independently skips already-appended data. Duplicates are structurally harmless end-to-end.

### 2. Storage adapter layer

A minimal interface shared by agent (write side) and collector (read side):

```ts
interface StorageAdapter {
  put(key: string, body: Buffer): Promise<void>;
  list(prefix: string): Promise<string[]>; // returns keys, lexicographic order
  get(key: string): Promise<Buffer>;
}
```

- `storage.provider` config field selects the implementation; each provider has its own credentials block in config.
- **v1 ships GCS only** (`GcsStorageAdapter`), using `@google-cloud/storage` with a service-account key. The key on the gaming PC gets `roles/storage.objectCreator` only — write-only, blast radius limited to log bytes.
- The interface is deliberately tiny (3 methods, flat keys, no streaming/multipart) so future adapters — S3, Google Drive, R2, SSH-to-Mac — are drop-in. Segment sizes (a few MB max per flush) don't need multipart.
- Adapter source lives in `packages/windows-agent/src/storage/` and is also consumed by the collector via the esbuild bundle or a small shared source copy — **decision:** collector imports the adapter source directly from `packages/windows-agent` source files at build time (tools package already does cross-source imports; agent remains dependency-free of tools).
- Bucket lifecycle rule deletes objects older than 30 days (cost stays at pennies; the Mac is the durable store).

### 3. Mac collector — `packages/tools/src/collectLogs.ts`

Runs on a schedule (launchd) or manually. Steps:

1. `list('raw/')`, diff against local fetch-state file (`~/wal-sync/state.json`).
2. Download new segments, ordered by `(logFileName, startOffset)`, and gunzip each body (offsets in keys always refer to **uncompressed** byte positions in the original log).
3. Append in offset order into reconstructed files at `~/wal-sync/logs/<logFileName>`. Gap detection: if the next segment's offset doesn't equal the current reconstructed size, stop appending that file and record a warning (agent will have retried; gaps indicate lost objects and must not silently corrupt a log).
4. Write-to-temp-then-rename on every append cycle so a crash never leaves a half-written log.
5. Update `status.json` + append a record to `runs.jsonl` (see Dashboard).

Duplicate segments (same key fetched twice) are idempotent — fetch-state prevents re-download; re-appending is prevented by the offset == size check.

### 4. Analysis + meta-eval — reuse `localBatchAnalysis`

- New npm script `start:collectAndAnalyze` chains: `collectLogs` → existing `localBatchAnalysis` with `LOG_DIR=~/wal-sync/logs`.
- Per-match analysis → `packages/tools/local-batch/results.jsonl` (already incremental via `logFile::matchIndex` dedupe; already records per-match AI failures without aborting the batch).
- Phase 2 meta-eval regenerates `summary.md` as today, **plus one addition**: archive a copy to `packages/tools/local-batch/reports/summary-YYYY-MM-DD.md` so meta-eval history is preserved across runs.
- `ANTHROPIC_API_KEY` read from a local `.env` on the Mac — the key never leaves this machine; cloud storage only ever holds raw log bytes.

### 5. Scheduling

- launchd plist (`~/Library/LaunchAgents/com.wowarenalogs.collect.plist`) runs `start:collectAndAnalyze` every 6 hours (interval configurable in the plist).
- The job is a thin shell script that sources `.env`, cds to the repo, and runs the npm script; stdout/stderr to a log file the dashboard can tail.
- Overlap guard: a lock file skips a run if the previous one is still going.

### 6. Dashboard UI — `packages/tools/src/dashboard/`

A small self-contained local web page: single static HTML file + a tiny Node HTTP server (no framework, no build step). Started via `npm run -w @wowarenalogs/tools dashboard` (and optionally its own launchd agent at login). Serves on localhost.

**Data sources (all local files + one storage read):**

- `~/wal-sync/status.json` — current collector phase, counts, errors.
- `~/wal-sync/runs.jsonl` — run history: timestamp, segments fetched, matches analyzed, duration, failures.
- `status/<hostname>.json` fetched from storage — agent heartbeat ("gaming PC last streamed 3 min ago, file X @ offset Y").
- The launchd plist — parsed to display the schedule and compute next run time.

**UI shows:** agent heartbeat/liveness, last + next scheduled run, live progress when a run is active (page polls a JSON endpoint every few seconds), run history table, links to `summary.md` reports and `results.jsonl`, and a **Run Now** button that spawns the collect-and-analyze script (guarded by the same lock file).

## Security

- Windows PC holds only a write-only (`objectCreator`) storage credential.
- Anthropic key exists only on the Mac in `.env`.
- Dashboard binds to `127.0.0.1` only.
- Log content is combat telemetry — low sensitivity, but the bucket is private regardless.

## Testing

- **Agent:** unit tests for checkpoint advance/reset logic and segment key generation against an in-memory fake `StorageAdapter`; manual e2e with a synthetically growing log file on the Mac before deploying to Windows.
- **Adapter contract tests:** a shared test suite any `StorageAdapter` must pass — put→list→get roundtrip, lexicographic list order, idempotent put. GCS impl runs it against an emulator or a test prefix; future adapters inherit the suite.
- **Collector:** unit tests for reconstruction from out-of-order/duplicate segments and gap detection.
- **End-to-end:** run the full chain against the existing `~/Downloads/wow logs/` corpus (agent pointed at a copy, collector + analysis on the output) before touching the Windows box.

## Setup prerequisites (ops, not code)

- A user-owned GCP project with one private bucket + service account (`objectCreator` for the agent key; a read credential for the Mac).
- Node LTS installed on the gaming PC; Task Scheduler entry created per README in `packages/windows-agent`.

## Prior art consulted

- **Warcraft Logs Uploader "Live Logging"** — same product shape (watch → tail deltas → upload while playing); validates the architecture. It parses client-side; we deliberately don't.
- **[wow-recorder](https://github.com/aza547/wow-recorder) `CombatLogWatcher.ts`** — production Node code tailing WoW logs on Windows. Source of: duplicate `fs.watch` event guard, quiet-period inactivity flush, serialized per-file processing, offset-delta reads.
- **[Vector `file` source](https://vector.dev/docs/reference/configuration/sources/file/)** — source of: content-checksum file identity (fingerprinting), `ignore_older` first-run policy. Vector itself was evaluated as a config-only replacement for the agent and rejected: it ships line events with time-partitioned keys (loses offset-exact reconstruction + gap detection) and makes the dashboard heartbeat awkward.
- **[Filebeat](https://www.elastic.co/docs/reference/beats/filebeat/how-filebeat-works)** — source of: at-least-once/duplicate analysis, never-hold-file-handles-on-Windows, registry (state file) hygiene.

## Future extensions (explicitly out of scope for v1)

- Additional storage adapters (S3, Google Drive, R2).
- Cloud-side analysis triggered by segment uploads.
- Dashboard controls for editing the schedule.
