# Shared helpers for scripts/agents/*.sh. Sourced, never run. Bash 3.2 compatible (macOS /bin/bash).
#
# Never reads .dev.vars, .env* or .mcp.json. Paths come from git, $HOME and the caller's arguments.

QA_PORT="${QA_PORT:-8787}"
SERVE_WT="${QUINCY_SERVE_WT:-$HOME/quincy-wt/serve}"

die() { echo "error: $*" >&2; exit 1; }

# Root of the checkout the script was started from.
repo_root() { git rev-parse --show-toplevel 2>/dev/null || die "not inside a git checkout"; }

# The main checkout: the first entry of `git worktree list`, whichever worktree we run from.
main_checkout() { git worktree list --porcelain | sed -n '1s/^worktree //p'; }

# The scratch dir: first argument if given, else $SCRATCH, else fail.
scratch_dir() {
  local s="${1:-${SCRATCH:-}}"
  [ -n "$s" ] || die "no scratch dir: pass one or export SCRATCH"
  mkdir -p "$s" || die "cannot create $s"
  (cd "$s" && pwd)
}

# PID listening on the QA port (the workerd process), or empty.
listener_pid() { lsof -nP -iTCP:"$QA_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1; }

proc_cwd() { lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1; }

# The bundle the server serves right now (index-*.js named in its HTML), or "none".
served_bundle() {
  local b
  b=$(curl -s -m 5 "http://localhost:$QA_PORT/" 2>/dev/null | grep -o 'index-[A-Za-z0-9_-]*\.js' | head -1)
  echo "${b:-none}"
}

# The serve worktree's private state file (inside its git dir, so never tracked).
serve_state_file() {
  local gd
  gd=$(git -C "$SERVE_WT" rev-parse --absolute-git-dir 2>/dev/null) || return 1
  echo "$gd/quincy-serve.state"
}

# One line describing who serves the QA port: pid, cwd, HEAD of that cwd, bundle, and whether it
# is the serve worktree. Prints "down" when nothing listens.
server_identity() {
  local pid cwd head bundle owner
  pid=$(listener_pid)
  if [ -z "$pid" ]; then echo "port=$QA_PORT down"; return 1; fi
  cwd=$(proc_cwd "$pid")
  head=$(git -C "$cwd" rev-parse --short=12 HEAD 2>/dev/null || echo "?")
  bundle=$(served_bundle)
  case "$cwd" in
    "$SERVE_WT"|"$SERVE_WT"/*) owner="serve-worktree" ;;
    *) owner="NOT-serve-worktree" ;;
  esac
  echo "port=$QA_PORT pid=$pid cwd=$cwd HEAD=$head bundle=$bundle owner=$owner"
}

# The `ref=… built=…` line serve-branch.sh recorded, if any.
serve_state() {
  local f
  f=$(serve_state_file) && [ -f "$f" ] && cat "$f"
}

# Run one read-only Codex job exactly as docs/subagents/codex-cli.md prescribes: prompt on stdin
# (the pipe also closes stdin, so no "Reading additional input from stdin" hang), read-only sandbox,
# gpt-6.1-sol at high effort, a perl alarm time limit, the final message to its own file and the
# raw transcript to a separate log.
#   run_codex_readonly <prompt-file> <out.md> <run.log> <timeout-seconds> <workdir>
run_codex_readonly() {
  local prompt="$1" out="$2" log="$3" secs="$4" wd="$5" rc
  command -v codex > /dev/null || die "codex not on PATH"
  : > "$out"
  set +e
  (cd "$wd" && cat "$prompt" | perl -e 'alarm shift; exec @ARGV' "$secs" \
    codex exec --sandbox read-only -m "${CODEX_MODEL:-gpt-6.1-sol}" -c model_reasoning_effort="${CODEX_EFFORT:-high}" \
      --output-last-message "$out" > "$log" 2>&1)
  rc=$?
  set -e
  local sid
  sid=$(grep -m1 '^session id:' "$log" 2>/dev/null | sed 's/^session id: //')
  echo "codex exit=$rc session=${sid:-?} log=$log ($(wc -l < "$log" | tr -d ' ') lines)"
  if [ "$rc" = 142 ]; then echo "TIMED OUT after ${secs}s: $out is not a verdict" >&2; return 142; fi
  if grep -q 'Your workspace is out of credits' "$log" 2>/dev/null; then
    echo "OUT OF CREDITS: top up or switch account, then: codex exec resume ${sid:-<id>} (codex-cli.md §Resuming)" >&2
    return 3
  fi
  if grep -q 'Reading additional input from stdin' "$log" 2>/dev/null && [ ! -s "$out" ]; then
    echo "stdin hang signature in log (codex-cli.md §Failure mode)" >&2
  fi
  [ "$rc" = 0 ] || return "$rc"
  [ -s "$out" ] || { echo "empty report: read the tail of $log" >&2; return 4; }
  return 0
}

# Physical (symlink- and ..-free) absolute path. A path that does not exist yet resolves through
# its nearest existing ancestor, so a not-yet-created serve dir is still compared by identity.
phys_path() {
  local p="$1" tail=""
  while [ ! -d "$p" ]; do
    tail="/$(basename "$p")$tail"
    p=$(dirname "$p")
  done
  p=$(cd "$p" && pwd -P); echo "${p%/}$tail"
}

# True when physical paths $1 and $2 are equal, or one contains the other.
paths_overlap() {
  case "$1/" in "$2"/*) return 0 ;; esac
  case "$2/" in "$1"/*) return 0 ;; esac
  return 1
}

# Agy evidence. A pass's screenshots are <evid>/<prefix>-*.png (agy-common-rules.md).
#   evidence_existing <evid> <prefix>           files already carrying the prefix (a rerun hazard)
#   evidence_shots <evid> <prefix> <marker>     this pass's files: prefix match, newer than marker
#   evidence_dupes <evid> <prefix> <marker>     md5 values shared by 2+ of this pass's files
# Each prints nothing, and returns 0, when the selection is empty.
evidence_existing() { find "$1" -maxdepth 1 -type f -name "$2-*.png" 2>/dev/null | sort || true; }
evidence_shots() { find "$1" -maxdepth 1 -type f -name "$2-*.png" -newer "$3" 2>/dev/null | sort || true; }
evidence_dupes() {
  local shots
  shots=$(evidence_shots "$1" "$2" "$3")
  [ -z "$shots" ] || printf '%s\n' "$shots" | tr '\n' '\0' | xargs -0 md5 -r | awk '{print $1}' | sort | uniq -d
}
