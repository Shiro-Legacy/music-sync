#!/usr/bin/env bash
#
# Run a Maestro flow against a booted iOS simulator, with unique test data.
#
# Usage:
#   scripts/test-maestro-ios.sh [FLOW...]          # run flows (default: all in .maestro/)
#   scripts/test-maestro-ios.sh --flow smoke-mini-player.yaml
#   scripts/test-maestro-ios.sh --udid <UDID> --flow create-playlist.yaml
#   scripts/test-maestro-ios.sh --device "iPhone 17" --name "MyPlaylist"
#
# Requirements (discovered automatically, with fallbacks):
#   - Java 17+ (JAVA_HOME, system java, or /opt/homebrew/opt/openjdk)
#   - Maestro CLI (PATH or ~/.maestro/bin/maestro)
#   - A booted iOS simulator (or pass --udid/--device; the app must be installed)

set -euo pipefail

APP_ID="${APP_ID:-com.jiaqi.musicsync}"
UDID=""
DEVICE=""
FLOWS=()
NAME=""

usage() {
  sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

# --- parse args ---
while [ $# -gt 0 ]; do
  case "$1" in
    --udid) UDID="$2"; shift 2 ;;
    --device) DEVICE="$2"; shift 2 ;;
    --flow) FLOWS+=("$2"); shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) FLOWS+=("$1"); shift ;;
  esac
done

[ ${#FLOWS[@]} -eq 0 ] && FLOWS=(.maestro/*.yaml)
[ ${#FLOWS[@]} -eq 0 ] && { echo "error: no flows found" >&2; exit 1; }

# --- resolve Java ---
java_ok() { command -v java >/dev/null 2>&1 && java -version >/dev/null 2>&1; }
if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/java" ]; then
  export PATH="$JAVA_HOME/bin:$PATH"
elif java_ok; then
  : # system java already works
elif [ -x "/opt/homebrew/opt/openjdk/bin/java" ]; then
  export JAVA_HOME="/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home"
  export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"
else
  echo "error: no Java runtime found. Install: brew install openjdk" >&2
  exit 1
fi

# --- resolve Maestro ---
if command -v maestro >/dev/null 2>&1; then
  MAESTRO="$(command -v maestro)"
elif [ -x "$HOME/.maestro/bin/maestro" ]; then
  MAESTRO="$HOME/.maestro/bin/maestro"
else
  echo "error: maestro not found. Install: curl -fsSL https://get.maestro.mobile.dev | bash" >&2
  exit 1
fi
export MAESTRO_CLI_NO_ANALYTICS=1

# --- resolve device ---
if [ -n "$UDID" ]; then
  :
elif [ -n "$DEVICE" ]; then
  UDID="$(xcrun simctl list devices available | grep -F "$DEVICE" | grep -oE '[0-9A-F-]{36}' | head -1)"
  [ -n "$UDID" ] || { echo "error: simulator '$DEVICE' not found" >&2; exit 1; }
else
  UDID="$(xcrun simctl list devices booted | grep -oE '[0-9A-F-]{36}' | head -1)"
  [ -n "$UDID" ] || { echo "error: no booted simulator. Boot one (e.g. xcrun simctl boot 'iPhone 17') or pass --device" >&2; exit 1; }
fi

# --- unique test data ---
if [ -z "$NAME" ]; then
  NAME="Test-$(date +%H%M%S)-$$"
fi

echo "appId:  $APP_ID"
echo "device: $UDID"
echo "name:   $NAME"
echo "flows:  ${FLOWS[*]}"

status=0
for flow in "${FLOWS[@]}"; do
  echo "--- $flow ---"
  "$MAESTRO" test --udid "$UDID" -e NAME="$NAME" "$flow" || status=1
done

exit "$status"
