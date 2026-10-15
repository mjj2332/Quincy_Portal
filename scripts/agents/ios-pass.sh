#!/usr/bin/env bash
# Set up a phone browser pass in Safari on the iOS Simulator. See --help.
set -uo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

usage() {
  cat <<EOF
Usage: scripts/agents/ios-pass.sh <path> [--device NAME] [--scratch DIR] [--label NAME]

Stage 1 of a phone browser pass (docs/subagents/Subagent-Orchestration.md §2a):

  1. checks that :$QA_PORT is up and prints the serve header (pid, cwd, HEAD, bundle) the report
     starts with — serve the branch first with scripts/agents/serve-branch.sh <ref>;
  2. boots the Simulator device (default: \$IOS_DEVICE, else "iPhone 18 Pro"), headless: watch it
     through the iOS Simulator tool's panel (its attach action);
  3. opens http://localhost:$QA_PORT<path> in its Safari;
  4. creates <scratch>/pass-<label>/ for the screenshots (scratch: --scratch, else \$SCRATCH;
     label: --label, else the served HEAD's short sha);
  5. prints the keyboard rows every phone input surface must cover.

The session then drives the device with the iOS Simulator tool (real key taps, not text
injection). The owner signs in once in the Simulator's Safari; this script never handles a
credential. Never reads .dev.vars, .env* or .mcp.json.
EOF
}

URL_PATH=""; DEVICE="${IOS_DEVICE:-iPhone 18 Pro}"; SCRATCH_ARG=""; LABEL=""
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --device) [ $# -ge 2 ] || die "--device needs a value"; DEVICE="$2"; shift 2 ;;
    --scratch) [ $# -ge 2 ] || die "--scratch needs a value"; SCRATCH_ARG="$2"; shift 2 ;;
    --label) [ $# -ge 2 ] || die "--label needs a value"; LABEL="$2"; shift 2 ;;
    -*) usage >&2; exit 1 ;;
    *) [ -z "$URL_PATH" ] || { usage >&2; exit 1; }; URL_PATH="$1"; shift ;;
  esac
done
[ -n "$URL_PATH" ] || { usage >&2; exit 1; }
case "$URL_PATH" in /*) ;; *) URL_PATH="/$URL_PATH" ;; esac
command -v xcrun >/dev/null || die "xcrun not found: install Xcode and its iOS Simulator runtime"

# 1. The server and the report header.
PID=$(listener_pid)
[ -n "$PID" ] || die "nothing serves :$QA_PORT — run scripts/agents/serve-branch.sh <ref> first"
CWD=$(proc_cwd "$PID")
HEAD=$(git -C "$CWD" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)
BUNDLE=$(served_bundle)
echo "serve: pid=$PID cwd=$CWD HEAD=$HEAD bundle=$BUNDLE"

# 2. The device.
UDID=$(xcrun simctl list devices available | grep -F "    $DEVICE (" | head -1 | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')
[ -n "$UDID" ] || die "no available Simulator device named \"$DEVICE\" (xcrun simctl list devices available)"
if ! xcrun simctl list devices booted | grep -q "$UDID"; then
  xcrun simctl boot "$UDID" || die "could not boot $DEVICE"
fi
xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1 || true
echo "device: $DEVICE ($UDID)"

# 3. Safari on the served branch.
URL="http://localhost:$QA_PORT$URL_PATH"
xcrun simctl openurl "$UDID" "$URL" || die "could not open $URL"
echo "opened: $URL"

# 4. The screenshot folder.
DIR="$(scratch_dir "$SCRATCH_ARG")/pass-${LABEL:-$HEAD}"
mkdir -p "$DIR" || die "cannot create $DIR"
echo "screenshots: $DIR (name each <device>-<frame or state>.png)"

# 5. The rows.
cat <<'ROWS'

Phone rows for any input surface (each row: frame id when a prototype exists, measurement, screenshot):
  - at rest, before focus
  - keyboard up, field empty: the field and the controls the frame shows stay visible
  - typing until the field wraps (real key taps): nothing jumps, the caret stays visible
  - any tray or menu opened from the field, keyboard up
  - keyboard dropped (accessory checkmark): no band or flash, the surface returns to its rest state
  - leaving the surface (Cancel / Send / back): the page is where it was
Re-read the serve header after the pass; if it changed, the pass is void.
ROWS
