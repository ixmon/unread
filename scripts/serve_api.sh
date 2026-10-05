#!/usr/bin/env bash
# Start the local ATF → English translate API (default 0.0.0.0:42226).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-42226}"
BIND="${BIND:-0.0.0.0}"
MODEL="${ATF_MODEL:-$ROOT/../atf-translate-test/models/atf-en-best-v2}"

# Prefer the project that already has transformers + torch + CUDA
PY="${ATF_PYTHON:-}"
if [[ -z "$PY" ]]; then
  if [[ -x "$ROOT/../atf-translate-test/.venv/bin/python" ]]; then
    PY="$ROOT/../atf-translate-test/.venv/bin/python"
  elif [[ -x "$ROOT/../deep-cuneiform/.venv/bin/python" ]]; then
    PY="$ROOT/../deep-cuneiform/.venv/bin/python"
  else
    PY="python3"
  fi
fi

LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo "ATF translate API"
echo "  python: $PY"
echo "  model:  $MODEL"
echo "  local:  http://127.0.0.1:${PORT}/api/health"
if [[ -n "${LAN_IP}" ]]; then
  echo "  LAN:    http://${LAN_IP}:${PORT}/api/health"
fi

export ATF_MODEL="$MODEL"
exec "$PY" "$ROOT/api/translate_server.py" --host "$BIND" --port "$PORT" --model "$MODEL" "$@"
