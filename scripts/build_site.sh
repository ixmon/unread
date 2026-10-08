#!/usr/bin/env bash
# Build the public static site into dist/ (see scripts/build_site.py for what goes in and why).
#   ./scripts/build_site.sh            -> dist/
#   ./scripts/build_site.sh --out DIR  -> DIR
# Preview: python3 -m http.server -d dist 8000   (open http://localhost:8000/)
set -euo pipefail
cd "$(dirname "$0")/.."
python3 scripts/stamp_mt.py --check
exec python3 scripts/build_site.py "$@"
