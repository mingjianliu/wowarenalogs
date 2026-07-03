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
