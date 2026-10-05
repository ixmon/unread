#!/usr/bin/env bash
# Serve the static reader (web/) on all interfaces.
# Default port 42225 (8765 is reserved for the line-art app on this machine).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${1:-42225}"
BIND="${BIND:-0.0.0.0}"

# Ensure web/data points at repo data/ for a single static root
if [[ ! -e "$ROOT/web/data" ]]; then
  ln -sfn ../data "$ROOT/web/data"
fi

# Best-effort LAN address for convenience
LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo "Serving $ROOT/web"
echo "  local:  http://127.0.0.1:${PORT}/"
if [[ -n "${LAN_IP}" ]]; then
  echo "  LAN:    http://${LAN_IP}:${PORT}/"
fi
echo "  bind:   ${BIND}:${PORT}"
exec python3 -m http.server "$PORT" --directory "$ROOT/web" --bind "$BIND"
