#!/usr/bin/env bash
# Read-only readiness checks before dispatching Codex / Agy / a browser pass. See --help.
set -uo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

usage() {
  cat <<EOF
Usage: scripts/agents/preflight.sh [-h|--help]

Read-only. One PASS/FAIL/WARN line per check; changes nothing and prints no secrets
(status commands are judged by exit code, their output is discarded).

  codex      codex CLI on PATH and \`codex login status\` exits 0
  agy        agy CLI on PATH (version shown) and huashu-chrome in \`agy mcp list\`
  huashu     \`huashu-chrome doctor\` reports the Chrome extension online
  huashu-2x  ~/.huashu-chrome/bridge.log: a "2 Chrome instances connected" warning newer than the
             last extension disconnect means the extension is live in two Chrome profiles, the
             cause of [NO_TAB] (heuristic; see docs/subagents/agy-cli.md)
  cdp-9333   dedicated debugging Chrome answers /json/version on 127.0.0.1:9333
  cdp-9334   second debugging Chrome (two-session passes) on 127.0.0.1:9334
  serve      :$QA_PORT returns 200; prints pid, cwd, HEAD, bundle and whether the serve
             worktree ($SERVE_WT) owns it (FAIL if another checkout serves it)
  gh         \`gh auth status\` exits 0

Exit: number of FAIL lines (0 = ready).
EOF
}
case "${1:-}" in -h|--help) usage; exit 0 ;; "") ;; *) usage >&2; exit 1 ;; esac

FAILS=0
pass() { printf 'PASS  %-9s %s\n' "$1" "$2"; }
fail() { printf 'FAIL  %-9s %s\n' "$1" "$2"; FAILS=$((FAILS + 1)); }
warn() { printf 'WARN  %-9s %s\n' "$1" "$2"; }

# codex
if command -v codex > /dev/null; then
  if codex login status > /dev/null 2>&1; then pass codex "$(codex --version 2>/dev/null | head -1), logged in"
  else fail codex "not logged in (owner runs: codex login)"; fi
else fail codex "codex not on PATH"; fi

# agy
if command -v agy > /dev/null; then
  if agy mcp list 2>/dev/null | grep -q huashu-chrome; then pass agy "agy $(agy --version 2>/dev/null | head -1), huashu-chrome MCP configured"
  else fail agy "agy present but huashu-chrome missing from \`agy mcp list\`"; fi
else fail agy "agy not on PATH"; fi

# huashu bridge + extension
DOCTOR=$(perl -e 'alarm 60; exec @ARGV' npx -y huashu-chrome doctor 2>&1 || true)
if printf '%s' "$DOCTOR" | grep -q '扩展在线'; then
  pass huashu "bridge up, Chrome extension online"
  if printf '%s' "$DOCTOR" | grep -q '扩展版本.*不一致'; then warn huashu "extension/CLI version mismatch (warns but works)"; fi
else fail huashu "extension not connected (owner: extension icon -> Reconnect; see agy-cli.md [NO_TAB])"; fi

BRIDGE_LOG="$HOME/.huashu-chrome/bridge.log"
if [ -f "$BRIDGE_LOG" ]; then
  MULTI=$(grep -n '个 Chrome 实例连着' "$BRIDGE_LOG" | tail -1 | cut -d: -f1)
  DISC=$(grep -n '扩展断开' "$BRIDGE_LOG" | tail -1 | cut -d: -f1)
  if [ -n "$MULTI" ] && [ "${MULTI:-0}" -gt "${DISC:-0}" ]; then
    fail huashu-2x "extension connected from 2+ Chrome profiles since $(sed -n "${MULTI}s/^\[\([0-9:]*\)\].*/\1/p" "$BRIDGE_LOG"): disable it in the non-everyday profile"
  else pass huashu-2x "no multi-profile connection since the last disconnect"; fi
else warn huashu-2x "no $BRIDGE_LOG"; fi

# debugging Chromes
for port in 9333 9334; do
  if curl -s -m 3 "http://127.0.0.1:$port/json/version" | grep -q '"Browser"'; then
    tabs=$(curl -s -m 3 "http://127.0.0.1:$port/json" | grep -c '"url": "http://localhost:'"$QA_PORT" || true)
    pass "cdp-$port" "debugging Chrome up, $tabs localhost:$QA_PORT tab(s)"
  else fail "cdp-$port" "nothing answers on 127.0.0.1:$port (agy-cli.md §Option A)"; fi
done

# the QA server
code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://localhost:$QA_PORT/" || true)
if [ "$code" = 200 ]; then
  ID=$(server_identity)
  case "$ID" in
    *owner=serve-worktree*) ST=$(serve_state 2>/dev/null || true); pass serve "$ID${ST:+ | last serve: $ST}" ;;
    *) fail serve "$ID (QA serves only via scripts/agents/serve-branch.sh)" ;;
  esac
else fail serve ":$QA_PORT returned ${code:-nothing}"; fi

# gh
if command -v gh > /dev/null && gh auth status > /dev/null 2>&1; then pass gh "authenticated"
else fail gh "gh missing or not authenticated"; fi

exit "$FAILS"
