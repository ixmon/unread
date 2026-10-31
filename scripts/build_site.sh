#!/usr/bin/env bash
# Build the public static site into dist/ (see scripts/build_site.py for what goes in and why).
#   ./scripts/build_site.sh            -> dist/
#   ./scripts/build_site.sh --out DIR  -> DIR
# Preview: python3 -m http.server -d dist 8000   (open http://localhost:8000/)
set -euo pipefail
cd "$(dirname "$0")/.."
python3 scripts/stamp_mt.py --check
# corpus numbers: refresh web/corpus_stats.json + stamped HTML from the local corpus DB when present
# (CI has no DB and uses the committed file). Rebuild after any corpus/translation update.
DB="${UNREAD_DB:-$HOME/cursor/unread-db/corpus.sqlite}"
if [ -f "$DB" ]; then python3 scripts/build_corpus_stats.py --db "$DB"; else echo "build_site: no corpus DB at $DB; using committed web/corpus_stats.json"; fi
exec python3 scripts/build_site.py "$@"
