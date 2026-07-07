#!/usr/bin/env bash
# launchd / Run-Now entrypoint: overlap lock + repo-relative npm invocation.
set -euo pipefail
# launchd's default PATH is minimal (/usr/bin:/bin:/usr/sbin:/sbin) and won't
# find Homebrew/nvm-installed node+npm — extend it for scheduled runs.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SYNC_DIR="${WAL_SYNC_DIR:-$HOME/wal-sync}"
mkdir -p "$SYNC_DIR"

LOCKDIR="$SYNC_DIR/run.lock"
# Only acquire (and therefore only release) the lock if a parent hasn't already —
# releasing a lock this process didn't create would strip a concurrent holder's guard.
if [ "${RUN_LOCK_ACQUIRED:-false}" != "true" ]; then
  if ! mkdir "$LOCKDIR" 2>/dev/null; then
    echo "[collect-and-analyze] previous run still active, skipping ($(date))"
    exit 0
  fi
  trap 'rmdir "$LOCKDIR"' EXIT
fi

cd "$REPO_ROOT/packages/tools"
export RUN_LOCK_ACQUIRED=true
npm run start:collectAndAnalyze
