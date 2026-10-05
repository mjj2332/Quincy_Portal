#!/usr/bin/env bash
# Run one Agy stage-1 browser pass (docs/subagents/agy-cli.md §Browser pass). See --help.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

usage() {
  cat <<EOF
Usage: scripts/agents/agy-pass.sh <pass-body.md> <out-dir> [options]

Assembles the brief from docs/subagents/templates/agy-brief-head.md + agy-common-rules.md +
<pass-body.md>, records who serves :$QA_PORT, runs Agy as agy-cli.md prescribes
(gemini-3.8-flash-medium, --effort medium, accept-edits, --dangerously-skip-permissions,
--add-dir <repo root>, -p last) and checks the evidence afterwards.

<out-dir> is normally <repo root>/qa-evidence/<pass> (gitignored). It receives:
  brief.md     the rendered brief sent to Agy
  report.md    server identity header, then Agy's reply, then the post-run checks
  agy.log      Agy's stderr (its silent failures only show here)
  screens/     where the brief tells Agy to save screenshots

Placeholders replaced in all three parts: __TITLE__ __PASS__ __BUNDLE__ __EVID__ __PREFIX__.

Options:
  --title TEXT         pass title (default: the out-dir name)
  --prefix P           screenshot file prefix (default: s1; use r2, r3 … for rechecks)
  --print-timeout D    Agy --print-timeout (default 40m0s)
  --raw                send <pass-body.md> as the whole brief (placeholders still replaced)
  --any-server         run even when :$QA_PORT is not served from the serve worktree
  -h, --help           this text

Preconditions (Agy starts none of them): scripts/agents/serve-branch.sh <ref> has served the
build under test; the owner's Chrome is signed in to localhost:$QA_PORT; scripts/agents/preflight.sh
passes its huashu lines. Launch this with the Bash tool's run_in_background, never with nohup.

Exit: Agy's exit code; 2 if the server check fails; 5 if a post-run check fails.
EOF
}

BODY="" OUT="" TITLE="" PREFIX="s1" PT="40m0s" RAW=0 ANY=0
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --title) shift; TITLE="${1:-}" ;;
    --prefix) shift; PREFIX="${1:-}" ;;
    --print-timeout) shift; PT="${1:-}" ;;
    --raw) RAW=1 ;;
    --any-server) ANY=1 ;;
    -*) die "unknown option $1 (see --help)" ;;
    *) if [ -z "$BODY" ]; then BODY="$1"; elif [ -z "$OUT" ]; then OUT="$1"; else die "too many arguments"; fi ;;
  esac
  shift
done
[ -n "$BODY" ] && [ -n "$OUT" ] || { usage >&2; exit 1; }
[ -f "$BODY" ] || die "no such brief: $BODY"
command -v agy > /dev/null || die "agy not on PATH"

REPO=$(repo_root)
TPL="$REPO/docs/subagents/templates"
mkdir -p "$OUT/screens"
OUT=$(cd "$OUT" && pwd)
PASS=$(basename "$OUT")
TITLE="${TITLE:-$PASS}"
EVID="$OUT/screens"
BRIEF="$OUT/brief.md"
REPORT="$OUT/report.md"
LOG="$OUT/agy.log"

# Server identity, before the run.
ID_BEFORE=$(server_identity) || die "nothing serves :$QA_PORT; run scripts/agents/serve-branch.sh <ref> first"
case "$ID_BEFORE" in
  *owner=serve-worktree*) ;;
  *) if [ "$ANY" = 0 ]; then echo "$ID_BEFORE" >&2; echo "QA serves only via scripts/agents/serve-branch.sh (or pass --any-server and say why in the report)" >&2; exit 2; fi ;;
esac
BUNDLE=$(served_bundle)

# A rerun must not inherit an earlier pass's screenshots: refuse when this prefix is already used.
OLD_SHOTS=$(evidence_existing "$EVID" "$PREFIX")
if [ -n "$OLD_SHOTS" ]; then
  echo "$OLD_SHOTS" | head -5 >&2
  die "files with prefix $PREFIX- already exist in $EVID; use a new --prefix (r2, r3 ...) or a fresh out-dir"
fi

# Render the brief.
if [ "$RAW" = 1 ]; then cat "$BODY" > "$BRIEF.tmp"
else { cat "$TPL/agy-brief-head.md"; echo; cat "$TPL/agy-common-rules.md"; echo; cat "$BODY"; } > "$BRIEF.tmp"; fi
T_TITLE="$TITLE" T_PASS="$PASS" T_BUNDLE="$BUNDLE" T_EVID="$EVID" T_PREFIX="$PREFIX" perl -pe '
  s/__TITLE__/$ENV{T_TITLE}/g; s/__PASS__/$ENV{T_PASS}/g; s/__BUNDLE__/$ENV{T_BUNDLE}/g;
  s/__EVID__/$ENV{T_EVID}/g; s/__PREFIX__/$ENV{T_PREFIX}/g' "$BRIEF.tmp" > "$BRIEF"
rm -f "$BRIEF.tmp"
if grep -q '__[A-Z]*__' "$BRIEF"; then grep -n '__[A-Z]*__' "$BRIEF" >&2; die "unreplaced placeholder in $BRIEF"; fi

MODEL="gemini-3.8-flash-medium"
MARKER="$OUT/.pass-start"
touch "$MARKER"
sleep 1  # -newer compares whole seconds on some filesystems
START=$(date +%s)
{
  echo "<!-- header written by scripts/agents/agy-pass.sh -->"
  echo "# Agy stage-1 pass: $TITLE"
  echo
  echo "- Server (before): \`$ID_BEFORE\`"
  echo "- Serve state: \`$(serve_state 2>/dev/null || echo none)\`"
  echo "- Model: $MODEL, --effort medium, --print-timeout $PT; started $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "- Brief: \`$BRIEF\`; screenshots: \`$EVID\`"
  echo
  echo "---"
  echo
} > "$REPORT"

echo "==> agy pass $PASS against $BUNDLE (report: $REPORT)"
set +e
agy --model "$MODEL" --mode accept-edits --effort medium \
  --dangerously-skip-permissions \
  --add-dir "$REPO" \
  --print-timeout "$PT" \
  -p "$(cat "$BRIEF")" >> "$REPORT" 2> "$LOG"
RC=$?
set -e
END=$(date +%s)

# Post-run checks, appended to the report.
PROBLEMS=0
ID_AFTER=$(server_identity || true)
SHOTS=$(evidence_shots "$EVID" "$PREFIX" "$MARKER")
DUPES=$(evidence_dupes "$EVID" "$PREFIX" "$MARKER" || true)
NSHOTS=$(printf '%s' "$SHOTS" | grep -c . || true)
FIRST=$(printf '%s\n' "$SHOTS" | head -1)
{
  echo
  echo "---"
  echo "## Post-run checks (scripts/agents/agy-pass.sh)"
  echo "- agy exit $RC after $(( (END - START) / 60 )) min; stderr \`$LOG\` ($(wc -l < "$LOG" | tr -d ' ') lines)"
  echo "- Server (after): \`$ID_AFTER\`"
  [ "$ID_AFTER" = "$ID_BEFORE" ] || echo "- **Server changed during the pass**: the pass may be void."
  echo "- Screenshots: $NSHOTS new \`$PREFIX-*.png\` in \`$EVID\`"
  [ "$NSHOTS" -gt 0 ] || echo "- **No screenshots were saved by this pass.**"
  [ -z "$DUPES" ] || echo "- **Byte-identical screenshots** (md5): $(echo "$DUPES" | tr '\n' ' ')"
  [ -z "$FIRST" ] || echo "- \`file\` on one: $(file -b "$FIRST")"
  grep -q 'no output produced' "$LOG" && echo "- **stderr: a tool needed the \"command\" permission and was denied** (agy-cli.md §silent failure modes)"
  grep -q 'timed out after' "$LOG" && echo "- **print-mode shutdown hang**: recover the reply from the conversation DB (agy-cli.md)"
  true
} >> "$REPORT"
[ "$ID_AFTER" = "$ID_BEFORE" ] || PROBLEMS=1
[ -z "$DUPES" ] || PROBLEMS=1
[ "$NSHOTS" -gt 0 ] || PROBLEMS=1

echo "agy exit=$RC screenshots=$NSHOTS report=$REPORT"
tail -8 "$REPORT"
[ "$RC" = 0 ] || exit "$RC"
[ "$PROBLEMS" = 0 ] || exit 5
