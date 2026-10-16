#!/usr/bin/env bash
# Fails when a tracked file outside portal/ names a design-source path that has moved (#891):
#   quincy-video-review-revamp/  ->  design/prototypes/video-review-revamp/
#   tmp/ReUI_Full_Source_Code    ->  ~/quincy-ref/reui/  (outside the repo; never committed)
# portal/ is skipped: app-code comments are updated when the file is next touched, so this check
# never forces a production deploy. Run from anywhere in the checkout; CI runs it on every PR.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 2

PATTERN='quincy-video-review-revamp|ReUI_Full_Source_Code'
HITS=$(git grep -n -I -E "$PATTERN" -- . ':!portal/' ':!scripts/check-stale-paths.sh' || true)
if [ -n "$HITS" ]; then
  echo "Stale design-source paths (see design/README.md for where they live now):"
  echo "$HITS"
  exit 1
fi
echo "stale paths: none"
