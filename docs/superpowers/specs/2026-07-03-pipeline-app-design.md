# wal-pilot: Parallel Tray App + Minimal Setup — Design

**Date:** 2026-07-03
**Status:** Approved
**Builds on:** `docs/superpowers/specs/2026-07-02-log-streaming-pipeline-design.md` (merged to main 2026-07-03)

## Problem

The merged log-streaming pipeline works but requires ~45 minutes of manual ops (GCP bucket + service account + key, Node install, `schtasks`, launchd plist, hand-written configs) and runs headless. The user wants (1) setup minimized everywhere, and (2) a parallel desktop app on both the Windows gaming laptop (streaming role) and this Mac (collect + analyze role) with a basic UI.

## Goals

- Setup per machine collapses to: install one app, click through one first-run screen.
- Default transport becomes a **Google Drive synced folder** (via Google Drive for desktop) — no GCP project, no service accounts, no keys. GCS remains a manual power option.
- One codebase, one installer per platform; the app self-registers "start at login" (kills `schtasks` and launchd).
- Basic UI: tray/menu-bar icon with state, plus the existing dashboard page in a window.
- CLI workflows (`start:collectLogs`, `start:localBatchAnalysis`, `dashboard`) keep working unchanged; app and CLI share the same state files and lock.

## Non-Goals

- No code signing / notarization (personal use; SmartScreen/Gatekeeper "open anyway" is acceptable).
- No in-app GCS wizard (GCS = manual config edit).
- No auto-update; new versions are reinstalls.
- No Windows-side analysis; roles are fixed by platform (config override exists for testing only).
- No changes to the web app or the existing `packages/app` desktop product.

## Architecture

```
Gaming laptop (Windows)                 Google Drive                 This Mac
┌─────────────────────────┐         ┌────────────────┐         ┌──────────────────────────────┐
│ wal-pilot (tray, .exe)  │ localDir│ <Drive>/wal-logs│ localDir│ wal-pilot (menu-bar, .dmg)   │
│ role: streamer          │ ──────► │  raw/…/…seg     │ ◄────── │ role: collector              │
│ watcher+flusher (reuse) │  write  │  status/…json   │  read   │ scheduler → collect → analyze│
│ tray + dashboard window │         └────────────────┘         │ (claude CLI, opus)           │
└─────────────────────────┘        Drive client syncs           │ tray + dashboard window      │
                                                                └──────────────────────────────┘
```

The app is a thin Electron host around the already-built and already-tested pipeline services. No protocol, adapter, flusher, watcher, collector, or analysis logic changes — only re-hosting, plus one refactor (below).

## Components

### 1. Package `packages/pipeline-app`

- Electron 38 + electron-builder + webpack main-process bundle — the same toolchain and patterns as `packages/app` (which already proves parser/shared code bundles into Electron cleanly).
- Product name `wal-pilot`. Tray-only: no dock icon on macOS (`LSUIElement`), taskbar-hidden window on Windows.
- Imports pipeline services as source (established repo pattern): watcher/flusher/adapters/protocol from `packages/windows-agent/src/`, collector + analysis from `packages/tools/src/`.
- Never imports `@wowarenalogs/app`; `windows-agent` continues to import nothing from anywhere.

### 2. Role controller

- `resolveRole(): 'streamer' | 'collector'` — `win32` → streamer, `darwin` → collector; `WAL_PILOT_ROLE` env/config override for testing both roles on one machine.
- **Streamer role** (main process): `startLogWatcher` + `flushFile` loop exactly as `windows-agent/src/index.ts` wires them, `localDir` adapter → Drive folder, heartbeat to `status/<hostname>.json` in the Drive folder. Tray state: streaming (recent flush), idle, error (`lastError`).
- **Collector role**: internal `setInterval` scheduler (default 6h, configurable) + Run Now. Each run: acquire the same lock-dir convention used by `collect-and-analyze.sh` (`<syncDir>/run.lock`) so app runs and CLI runs never overlap; then `runCollection()` → `runBatchAnalysis()` in-process; writes the same `status.json` + `runs.jsonl`. Analysis uses the existing backend resolution (no API key → claude CLI, default Opus).

### 3. Refactor: make `localBatchAnalysis` importable

`packages/tools/src/localBatchAnalysis.ts` currently executes `main()` at module load. Change (same treatment `windows-agent/src/index.ts` already received):

- Export `runBatchAnalysis(opts: { logDir: string; maxMatches?: number; phase1Only?: boolean; phase2Only?: boolean }): Promise<BatchStats>` where `BatchStats = { processed: number; skipped: number; failed: number; unparseable: number }`.
- Guard CLI behavior behind `require.main === module` (argv parsing unchanged; npm scripts unaffected).
- `LOG_DIR` env keeps working; the app passes `logDir` explicitly.

### 4. First-run wizard (one window, shown when config is absent)

- **Drive folder detection**: candidates probed in order — macOS: `~/Library/CloudStorage/GoogleDrive-*/My Drive`; Windows: drive roots `G:`–`Z:` containing `My Drive`, plus `%UserProfile%\My Drive`. Proposes `<detected>/wal-logs` (creates it); manual folder picker as fallback when detection fails or the user wants Dropbox/iCloud/etc. — any synced folder works identically.
- **Streamer extras**: WoW dir detection — probe `C:\Program Files (x86)\World of Warcraft\_retail_` and `C:\Program Files\World of Warcraft\_retail_`; folder picker fallback. Validates `Logs/` exists.
- **Start at login** checkbox (default on) → `app.setLoginItemSettings({ openAtLogin: true })` (native on both platforms).
- Config persisted to `<userData>/wal-pilot.config.json`:

```ts
interface PilotConfig {
  role?: 'streamer' | 'collector'; // absent = platform default
  syncFolder: string; // the Drive folder (localDir root)
  wowDirectory?: string; // streamer only
  hostname: string; // default os.hostname()
  flushIntervalMs: number; // streamer, default 60000
  quietPeriodMs: number; // streamer, default 30000
  ignoreOlderDays: number; // streamer, default 7
  scheduleHours: number; // collector, default 6
  cleanupAfterDays: number; // collector, default 14; 0 = never
  storage?: { provider: 'gcs'; bucket: string; keyFilename: string }; // power option, manual edit only
}
```

- When `storage` is set, it overrides the `syncFolder`-derived `localDir` adapter — GCS power path with zero wizard support.

### 5. UI

- **Tray/menu-bar**: platform icon with three visual states (active / idle / error). Menu: Open Dashboard, Run Now (collector only), Pause/Resume, Start at Login toggle, Quit.
- **Dashboard window**: a `BrowserWindow` loading the existing dashboard server on `127.0.0.1` (server code reused from `packages/tools/src/dashboard/`, started inside the app; binds the first free port starting at 5178 so the standalone CLI dashboard can coexist). Additions: an Origin/Host check on `POST /api/run` (closes the known CSRF fix-later), and a streamer-role variant of the page showing the local agent's state (file, offset, last flush, lastError) when there's no collector data to show.
- No framework, no build step for the page — same self-contained HTML approach.

### 6. Drive-folder hygiene (collector role)

After a successful run, delete segment objects whose bytes are **fully applied** to a reconstructed log (`startOffset + uncompressedLength <= reconstructed size` for their generation, where `uncompressedLength` is read cheaply from the gzip ISIZE footer — the last 4 bytes of the object — without decompressing) and whose mtime is older than `cleanupAfterDays` (default 14). Reconstructed logs are the durable copy; deletion is safe by the pipeline's idempotency rules. Heartbeat objects are never deleted. `cleanupAfterDays: 0` disables.

### 7. Packaging & distribution

- electron-builder targets: macOS `dmg` (arm64), Windows `nsis` `.exe` (x64), both cross-built from this Mac, unsigned.
- `npm run -w @wowarenalogs/pipeline-app dist` produces both installers into `packages/pipeline-app/release/`.
- Windows install remains: copy `.exe` over (or download), run, accept SmartScreen once, complete wizard. Node.js is NOT required on the gaming laptop anymore (Electron embeds its runtime) — the old `wal-agent.js + Node` path stays available for headless use.

### 8. Error handling

- All service-level behavior is inherited (per-file flush isolation, checkpoint-after-ack, gap detection, forensic `runs.jsonl` trail, heartbeat `lastError`).
- App-level: role service crash → tray error state + relaunch of the service loop with backoff (never silently dead); wizard validation errors inline; missing Drive folder at runtime (client signed out / folder deleted) → tray error + dashboard banner, streamer checkpoints simply stop advancing (data safe in WoW's own log until the folder returns).
- Collector honours the shared lock dir; a stale lock (>2h) is surfaced in the UI with a one-click clear.

### 9. Testing

- Unit (new logic only, in `pipeline-app` with the same bare-jest setup as `windows-agent`): role resolution, config load/migrate/defaults, Drive-folder candidate probing (pure path logic against fake fs listings), cleanup eligibility rule.
- Re-run of the existing localDir e2e through the app's services: launch the app twice on this Mac with `WAL_PILOT_ROLE` overrides (streamer instance with a temp "wow dir" + temp "Drive" folder; collector instance reading it) → byte-exact reconstruction, then an analysis run through the claude CLI (`--max-matches 1`).
- Manual: wizard flow on both platforms, tray states, SmartScreen/Gatekeeper first-open, login-item registration.

## Setup after this ships (per machine)

1. Have Google Drive for desktop signed in (likely already true).
2. Install wal-pilot (`.exe` / `.dmg`), open it, click through one screen.

That's the whole runbook. The README's GCP/Node/schtasks/launchd sections move to an "advanced / headless" appendix.

## Prior art / feasibility anchors

- `packages/app` already bundles parser+shared source into Electron main via webpack — the exact bundling risk this design takes is already proven in-repo.
- The dashboard server + page, adapters, and both role services are running, reviewed code from the merged pipeline branch; this design re-hosts rather than rewrites.

## Future extensions (out of scope)

- Auto-update; code signing; S3/Drive-API adapters; Windows-side analysis; multi-PC aggregation UI.
