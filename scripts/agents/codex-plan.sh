#!/usr/bin/env bash
# Codex planning run via codex exec, as docs/subagents/codex-cli.md prescribes. See --help.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

usage() {
  cat <<USAGE
Usage: scripts/agents/codex-plan.sh <brief.md> <out.md> [--workdir DIR] [--timeout SECONDS]

Pipes <brief.md> on stdin to \`codex exec --sandbox read-only -m gpt-6.1-sol
-c model_reasoning_effort=high\`, bounded by \`perl -e 'alarm N; exec @ARGV'\`.
Start the brief from docs/subagents/templates/plan-brief.md. Read-only Codex is offline, so the
brief carries the issue and parent-spec text.

Writes:
  <out.md>        the plan only (--output-last-message)
  <out>.run.log   the raw Codex transcript (grep it; don't read it whole)

Options:
  --workdir DIR    checkout to plan against (default: this repo root)
  --timeout SECS   time limit (default 1800)
  -h, --help       this text

Exit: 0 plan written; 142 timed out; 3 out of Codex credits (resume id printed); else codex's.
Env: CODEX_MODEL / CODEX_EFFORT override the model and effort.
The settled plan goes to the issue as a comment or docs/plans/<issue>.md, never only a scratchpad.
USAGE
}

POS=() WD="" SECS=1800
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --workdir) shift; WD="${1:-}" ;;
    --timeout) shift; SECS="${1:-}" ;;
    -*) die "unknown option $1 (see --help)" ;;
    *) POS+=("$1") ;;
  esac
  shift
done
[ "${#POS[@]}" = 2 ] || { usage >&2; exit 1; }
BRIEF="${POS[0]}" OUT="${POS[1]}"
[ -s "$BRIEF" ] || die "empty or missing brief: $BRIEF"
if grep -q '<paste' "$BRIEF"; then die "$BRIEF still has template placeholders (<paste …>)"; fi
WD="${WD:-$(repo_root)}"
WD=$(cd "$WD" && pwd)
BRIEF="$(cd "$(dirname "$BRIEF")" && pwd)/$(basename "$BRIEF")"
mkdir -p "$(dirname "$OUT")"
OUT="$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"
LOG="${OUT%.md}.run.log"

echo "==> Codex plan from $BRIEF in $WD (limit ${SECS}s)"
set +e
run_codex_readonly "$BRIEF" "$OUT" "$LOG" "$SECS" "$WD"
RC=$?
set -e
[ "$RC" = 0 ] && echo "plan: $OUT ($(wc -l < "$OUT" | tr -d ' ') lines)"
exit "$RC"
