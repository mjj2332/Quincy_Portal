#!/usr/bin/env bash
# Sol diff review via codex exec, as docs/subagents/codex-cli.md prescribes. See --help.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

usage() {
  cat <<USAGE
Usage: scripts/agents/sol-review.sh <base> <head> <out.md> [--spec FILE]... [--scope TEXT]
                                    [--workdir DIR] [--timeout SECONDS]

Runs Sol (gpt-6.1-sol, high effort, --sandbox read-only) on \`git diff <base>...<head>\`.
The prompt is docs/subagents/templates/sol-brief.md with the refs filled in, then --scope, then
each --spec file, piped on stdin; \`perl -e 'alarm N; exec @ARGV'\` bounds the run.

Writes:
  <out.md>        Sol's final message only (--output-last-message): the findings and verdict
  <out>.run.log   the raw Codex transcript (hundreds of thousands of lines; grep, don't read)
  <out>.prompt.md the exact prompt sent

Read-only Codex is offline: put the ticket text in a --spec file (gh issue view <n> > file).

Options:
  --spec FILE      ticket/spec/decisions appended to the prompt (repeatable)
  --scope TEXT     one paragraph narrowing the review (e.g. "only the merge resolution")
  --workdir DIR    checkout to run in (default: this repo root); should have <head> checked out
  --timeout SECS   time limit (default 2400)
  -h, --help       this text

Exit: 0 report written; 142 timed out; 3 out of Codex credits (resume id printed); else codex's.
Env: CODEX_MODEL / CODEX_EFFORT override the model and effort (Sol is gpt-6.1-sol, high).
USAGE
}

POS=() SPECS=() SCOPE="" WD="" SECS=2400
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --spec) shift; SPECS+=("${1:-}") ;;
    --scope) shift; SCOPE="${1:-}" ;;
    --workdir) shift; WD="${1:-}" ;;
    --timeout) shift; SECS="${1:-}" ;;
    -*) die "unknown option $1 (see --help)" ;;
    *) POS+=("$1") ;;
  esac
  shift
done
[ "${#POS[@]}" = 3 ] || { usage >&2; exit 1; }
BASE="${POS[0]}" HEAD="${POS[1]}" OUT="${POS[2]}"
WD="${WD:-$(repo_root)}"
WD=$(cd "$WD" && pwd)
REPO=$(cd "$(dirname "$0")/../.." && pwd)

git -C "$WD" rev-parse --verify -q "$BASE^{commit}" > /dev/null || die "unknown base $BASE in $WD"
HEAD_SHA=$(git -C "$WD" rev-parse --verify -q "$HEAD^{commit}") || die "unknown head $HEAD in $WD"
[ "$(git -C "$WD" rev-parse HEAD)" = "$HEAD_SHA" ] || echo "warn: $WD has $(git -C "$WD" rev-parse --short HEAD) checked out, not $HEAD; Sol reads surrounding code from the checkout" >&2
[ "$(git -C "$WD" rev-list --count "$BASE...$HEAD")" -gt 0 ] || die "empty range $BASE...$HEAD"

mkdir -p "$(dirname "$OUT")"
OUT="$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"
STEM="${OUT%.md}"
PROMPT="$STEM.prompt.md"
LOG="$STEM.run.log"

S_BASE="$BASE" S_HEAD="$HEAD" S_SCOPE="${SCOPE:+Scope: $SCOPE}" perl -pe '
  s/__BASE__/$ENV{S_BASE}/g; s/__HEAD__/$ENV{S_HEAD}/g; s/__SCOPE__/$ENV{S_SCOPE}/g' \
  "$REPO/docs/subagents/templates/sol-brief.md" > "$PROMPT"
for f in ${SPECS[@]+"${SPECS[@]}"}; do
  [ -f "$f" ] || die "no such spec file: $f"
  { echo; echo "## $(basename "$f")"; echo; cat "$f"; } >> "$PROMPT"
done

echo "==> Sol: $BASE...$HEAD in $WD (limit ${SECS}s)"
set +e
run_codex_readonly "$PROMPT" "$OUT" "$LOG" "$SECS" "$WD"
RC=$?
set -e
[ "$RC" = 0 ] && { echo "--- $OUT"; cat "$OUT"; }
exit "$RC"
