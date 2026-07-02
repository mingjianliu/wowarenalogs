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

   The file name must end in `.config.json` — the agent stores its resume
   checkpoint next to it as `<same-prefix>.state.json`.

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
