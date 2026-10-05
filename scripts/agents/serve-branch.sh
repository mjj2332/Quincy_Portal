#!/usr/bin/env bash
# Serve a git ref on :8787 from the dedicated serve worktree. See --help.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

usage() {
  cat <<EOF
Usage: scripts/agents/serve-branch.sh <ref> [--takeover] [--reseed] [--prepare-only] [--scratch DIR]

Serves <ref> on http://localhost:$QA_PORT from the serve worktree $SERVE_WT
(override with QUINCY_SERVE_WT). The checkout you run this from is never switched.

Steps:
  1. git fetch origin; resolve <ref> to a commit.
  2. Create the serve worktree (git worktree add --detach) if it is missing.
  3. Stop the server on :$QA_PORT if the serve worktree owns it. A server started from any
     other checkout is left alone and the script exits 2, unless --takeover is given.
  4. Check out <ref> detached in the serve worktree (refuses if it has tracked edits).
  5. npm ci in portal/ only when portal/package-lock.json changed since the last run.
  6. npm run build -w @quincy/web.
  7. Local D1 (see below), then npm run db:migrate:local (migrations + seed + local flags).
  8. nohup wrangler dev --config workers/app/wrangler.jsonc --port $QA_PORT, wait for HTTP 200,
     print: ref HEAD pid cwd bundle.

Local state. Wrangler keeps local D1 beside the config: portal/workers/app/.wrangler/state/v3/d1,
so each checkout has its own database. Better-auth sessions live in D1 (the session table), so
on first use the serve worktree gets a consistent copy of the main checkout's D1
(sqlite3 .backup of each *.sqlite) and the owner's existing localhost sign-in keeps working.
Branch migrations then apply to that copy only, never to the main checkout's database.
--reseed replaces the copy with a fresh one from the main checkout (discarding what QA wrote).
If the main checkout has no local D1, db:migrate:local seeds an empty one and the owner must
sign in again in Chrome.

Secrets. portal/workers/app/.dev.vars is symlinked from the main checkout by path; this script
only tests that the file exists and never opens it.

Options:
  --takeover      stop a :$QA_PORT server that another checkout started (ask the owner first:
                  another session may be mid-QA on it)
  --reseed        refresh the serve worktree's D1 copy from the main checkout
  --prepare-only  do steps 1, 2, 4-7 without touching :$QA_PORT
  --scratch DIR   where logs go (default: \$SCRATCH, else the serve worktree's git dir)
  -h, --help      this text

Exit: 0 served (or prepared), 1 failure, 2 port owned by another checkout.
EOF
}

REF="" TAKEOVER=0 RESEED=0 PREPARE_ONLY=0 LOGDIR="${SCRATCH:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --takeover) TAKEOVER=1 ;;
    --reseed) RESEED=1 ;;
    --prepare-only) PREPARE_ONLY=1 ;;
    --scratch) shift; LOGDIR="${1:-}" ;;
    -*) die "unknown option $1 (see --help)" ;;
    *) [ -z "$REF" ] || die "one ref only"; REF="$1" ;;
  esac
  shift
done
[ -n "$REF" ] || { usage >&2; exit 1; }

REPO=$(repo_root)
MAIN=$(main_checkout)
[ -n "$MAIN" ] || die "cannot find the main checkout from git worktree list"
case "$SERVE_WT" in "$MAIN"|"$MAIN"/*) die "the serve worktree must not be the main checkout" ;; esac

git -C "$REPO" fetch -q origin || echo "warn: git fetch origin failed; using local refs" >&2
SHA=$(git -C "$REPO" rev-parse --verify -q "$REF^{commit}") || die "unknown ref $REF"

# 3 first: who owns the port? Decide before doing any work.
OLD_PID=$(listener_pid || true)
if [ "$PREPARE_ONLY" = 0 ] && [ -n "$OLD_PID" ]; then
  OLD_CWD=$(proc_cwd "$OLD_PID")
  case "$OLD_CWD" in
    "$SERVE_WT"|"$SERVE_WT"/*) ;;
    *)
      if [ "$TAKEOVER" = 0 ]; then
        echo "refusing: :$QA_PORT is served from another checkout" >&2
        server_identity >&2 || true
        echo "Another session may be mid-QA on it. With the owner's OK, rerun with --takeover." >&2
        exit 2
      fi ;;
  esac
fi

# 2. The serve worktree.
if [ ! -e "$SERVE_WT/.git" ]; then
  echo "==> creating serve worktree $SERVE_WT"
  mkdir -p "$(dirname "$SERVE_WT")"
  git -C "$REPO" worktree add -q --detach "$SERVE_WT" "$SHA"
fi
SERVE_COMMON=$(cd "$SERVE_WT" && cd "$(git rev-parse --git-common-dir)" && pwd)
REPO_COMMON=$(cd "$REPO" && cd "$(git rev-parse --git-common-dir)" && pwd)
[ "$SERVE_COMMON" = "$REPO_COMMON" ] || die "$SERVE_WT belongs to another repository ($SERVE_COMMON)"

GITDIR=$(git -C "$SERVE_WT" rev-parse --absolute-git-dir)
if [ -z "$LOGDIR" ]; then LOGDIR="$GITDIR/serve-logs"; fi
LOGDIR=$(scratch_dir "$LOGDIR")
STAMP=$(date +%Y%m%d-%H%M%S)

# All descendants of a pid, depth first.
descendants() { local c; for c in $(pgrep -P "$1" 2>/dev/null); do descendants "$c"; echo "$c"; done; }

stop_server() {
  local pid="$1" p cmd victims="" i
  # Walk up from the listening workerd to the npm/npx/wrangler launcher, then take its whole tree.
  p="$pid"
  for i in 1 2 3 4 5; do
    cmd=$(ps -o command= -p "$p" 2>/dev/null || true)
    case "$cmd" in
      */bin/zsh*|*/bin/bash*|*/bin/sh*|zsh\ *|bash\ *|sh\ *) break ;;  # never the launching shell
      *wrangler*" dev"*|*"workerd serve"*) victims="$p $victims" ;;
      *) break ;;
    esac
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
    [ -n "$p" ] && [ "$p" != 1 ] || break
  done
  for p in $victims; do victims="$victims $(descendants "$p" | tr '\n' ' ')"; done
  echo "==> stopping :$QA_PORT server (pids:$victims)"
  # shellcheck disable=SC2086
  kill $victims 2>/dev/null || true
  for i in $(seq 1 20); do [ -z "$(listener_pid)" ] && return 0; sleep 1; done
  # shellcheck disable=SC2086
  kill -9 $victims 2>/dev/null || true
  sleep 1
  [ -z "$(listener_pid)" ] || die ":$QA_PORT still busy after kill -9"
}

if [ "$PREPARE_ONLY" = 0 ] && [ -n "$OLD_PID" ]; then stop_server "$OLD_PID"; fi

# 4. Check out the ref.
if [ -n "$(git -C "$SERVE_WT" status --porcelain --untracked-files=no)" ]; then
  git -C "$SERVE_WT" status --short --untracked-files=no >&2
  die "the serve worktree has tracked edits; it is for serving only"
fi
git -C "$SERVE_WT" checkout -q --detach "$SHA"
HEAD12=$(git -C "$SERVE_WT" rev-parse --short=12 HEAD)
echo "==> serve worktree at $HEAD12 ($REF)"

PORTAL="$SERVE_WT/portal"

# 5. Dependencies, only when the lockfile changed.
LOCK_SUM=$(shasum -a 256 "$PORTAL/package-lock.json" | cut -d' ' -f1)
LOCK_STAMP="$GITDIR/quincy-serve.lock-sha"
if [ ! -d "$PORTAL/node_modules" ] || [ "$(cat "$LOCK_STAMP" 2>/dev/null || true)" != "$LOCK_SUM" ]; then
  echo "==> npm ci (log: $LOGDIR/serve-ci-$STAMP.log)"
  (cd "$PORTAL" && npm ci) > "$LOGDIR/serve-ci-$STAMP.log" 2>&1 || { tail -20 "$LOGDIR/serve-ci-$STAMP.log" >&2; die "npm ci failed"; }
  echo "$LOCK_SUM" > "$LOCK_STAMP"
else
  echo "==> lockfile unchanged; skipping npm ci"
fi

# 6. Build web.
echo "==> building @quincy/web (log: $LOGDIR/serve-build-$STAMP.log)"
(cd "$PORTAL" && npm run build -w @quincy/web) > "$LOGDIR/serve-build-$STAMP.log" 2>&1 || { tail -30 "$LOGDIR/serve-build-$STAMP.log" >&2; die "web build failed"; }
BUILT_BUNDLE=$(grep -o 'index-[A-Za-z0-9_-]*\.js' "$PORTAL/apps/web/dist/index.html" | head -1)

# Secrets: symlink by path, never read.
DEV_VARS_SRC="$MAIN/portal/workers/app/.dev.vars"
DEV_VARS_DST="$PORTAL/workers/app/.dev.vars"
[ -e "$DEV_VARS_SRC" ] || die "the main checkout has no portal/workers/app/.dev.vars; ask the owner"
if [ -e "$DEV_VARS_DST" ] && [ ! -L "$DEV_VARS_DST" ]; then
  echo "warn: $DEV_VARS_DST is a regular file; leaving it" >&2
else
  ln -sfn "$DEV_VARS_SRC" "$DEV_VARS_DST"
fi

# 7. Local D1: a consistent copy of the main checkout's, then this ref's migrations on top.
D1_SUB="workers/app/.wrangler/state/v3/d1/miniflare-D1DatabaseObject"
SRC_D1="$MAIN/portal/$D1_SUB"
DST_D1="$PORTAL/$D1_SUB"
if [ "$RESEED" = 1 ] || [ ! -d "$DST_D1" ]; then
  if [ -d "$SRC_D1" ]; then
    echo "==> copying local D1 from the main checkout (sqlite3 .backup)"
    rm -rf "$DST_D1"
    mkdir -p "$DST_D1"
    for f in "$SRC_D1"/*.sqlite; do
      sqlite3 "$f" ".backup '$DST_D1/$(basename "$f")'" || die "sqlite3 backup of $(basename "$f") failed"
    done
  else
    echo "warn: the main checkout has no local D1; seeding an empty one. The owner signs in again." >&2
  fi
fi
echo "==> npm run db:migrate:local (log: $LOGDIR/serve-migrate-$STAMP.log)"
(cd "$PORTAL" && npm run db:migrate:local) > "$LOGDIR/serve-migrate-$STAMP.log" 2>&1 || { tail -20 "$LOGDIR/serve-migrate-$STAMP.log" >&2; die "local D1 migration failed"; }
ls "$DST_D1"/*.sqlite > /dev/null 2>&1 || die "migrations ran but no D1 file under $DST_D1"

STATE_FILE=$(serve_state_file)
echo "ref=$REF HEAD=$HEAD12 bundle=$BUILT_BUNDLE prepared=$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STATE_FILE"

if [ "$PREPARE_ONLY" = 1 ]; then
  echo "prepared ref=$REF HEAD=$HEAD12 cwd=$SERVE_WT bundle=$BUILT_BUNDLE (not serving)"
  exit 0
fi

# 8. Serve.
[ -z "$(listener_pid)" ] || die ":$QA_PORT was taken while preparing"
SERVER_LOG="$LOGDIR/wrangler-$QA_PORT-$STAMP.log"
echo "==> starting wrangler dev (log: $SERVER_LOG)"
cd "$PORTAL"
nohup ./node_modules/.bin/wrangler dev --config workers/app/wrangler.jsonc --port "$QA_PORT" \
  > "$SERVER_LOG" 2>&1 < /dev/null &
WPID=$!
disown "$WPID" 2>/dev/null || true

for i in $(seq 1 90); do
  code=$(curl -s -o /dev/null -m 2 -w '%{http_code}' "http://localhost:$QA_PORT/" || true)
  [ "$code" = 200 ] && break
  kill -0 "$WPID" 2>/dev/null || { tail -30 "$SERVER_LOG" >&2; die "wrangler dev exited"; }
  sleep 1
done
[ "${code:-}" = 200 ] || { tail -30 "$SERVER_LOG" >&2; die "no HTTP 200 on :$QA_PORT after 90 s"; }

BUNDLE=$(served_bundle)
[ "$BUNDLE" = "$BUILT_BUNDLE" ] || echo "warn: served $BUNDLE but dist/index.html names $BUILT_BUNDLE" >&2
echo "ref=$REF HEAD=$HEAD12 bundle=$BUNDLE pid=$WPID log=$SERVER_LOG prepared=$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STATE_FILE"
echo "ref=$REF HEAD=$HEAD12 pid=$WPID cwd=$PORTAL bundle=$BUNDLE"
