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
