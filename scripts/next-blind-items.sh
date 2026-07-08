#!/bin/bash
# Prints the next N unscored blind item names (natural order). Usage: next-blind-items.sh [N]
# Operates on the current A/B blind pool under local-batch (gitignored).
# Locate repo root via this script's own path so it works from any cwd and any checkout.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT/packages/tools/local-batch/healer-eval/ab-test/blind" || exit 1
comm -23 <(ls items | sort) <(ls scores 2>/dev/null | sed 's/\.json$//' | sort) | sort -V | head -"${1:-12}"
