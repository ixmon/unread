#!/usr/bin/env bash
# Deploy generated SEO tablet pages (<out>/t/*.html) to the Unread Atlas site bucket + CloudFront.
#
# Usage: scripts/deploy_seo_pages.sh [--dry-run | --go] [--out DIR]
#   default is --dry-run (read-only: lists live objects, compares MD5s, prints counts).
#   --go: backs up live versions of objects to be overwritten, uploads changed/new files only,
#         then one CloudFront invalidation for '/t/*'.
#
# Safety: never uses --delete; only regular files under <out>/t/ (symlinks skipped, so the data
# symlink / demo proxy can never ship); refuses if any changed HTML lacks the Cloudflare beacon.
# Concurrency (max_concurrent_requests=100) lives in a temp AWS_CONFIG_FILE copy; the user's
# ~/.aws/config is never modified.
set -euo pipefail

MODE=dry-run; OUT=dist
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) MODE=dry-run ;;
    --go) MODE=go ;;
    --out) OUT="$2"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac; shift
done

BUCKET=${BUCKET:-unread-atlas-site-474665692465}
DIST_ID=${DIST_ID:-E1KPD0GVW3J49N}
export AWS_PROFILE=${AWS_PROFILE:-unread-atlas} AWS_REGION=${AWS_REGION:-us-east-2}
CACHE_CONTROL="public, max-age=300"
CONTENT_TYPE="text/html; charset=utf-8"
CONC=${CONC:-100}

cd "$(dirname "$0")/.."
SRC="$OUT/t"; [ -d "$SRC" ] || { echo "no $SRC (run build_seo_pages.py + build_site.py first)" >&2; exit 1; }

STAMP=$(date +%Y%m%d-%H%M%S)
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
# script-local AWS config: copy of the user's config + higher s3 concurrency for our profile only
cp "${AWS_CONFIG_FILE:-$HOME/.aws/config}" "$WORK/config" 2>/dev/null || : > "$WORK/config"
export AWS_CONFIG_FILE="$WORK/config"
aws configure set s3.max_concurrent_requests "$CONC" --profile "$AWS_PROFILE"
aws configure set s3.max_queue_size 10000 --profile "$AWS_PROFILE"

T0=$(date +%s); tp=$T0
phase() { local n; n=$(date +%s); echo "== $1: $((n-tp))s (total $((n-T0))s)"; tp=$n; }

echo "mode=$MODE src=$SRC bucket=$BUCKET dist=$DIST_ID profile=$AWS_PROFILE region=$AWS_REGION"

# 1. live listing (key, etag) for t/
aws s3api list-objects-v2 --bucket "$BUCKET" --prefix t/ \
  --query 'Contents[].[Key,ETag]' --output text > "$WORK/live.tsv"
phase "list live ($(wc -l < "$WORK/live.tsv") objects)"

# 2. diff by MD5 (single-part uploads -> ETag is MD5; multipart ETags just count as changed)
python3 - "$SRC" "$WORK" <<'PY'
import hashlib, os, sys
src, work = sys.argv[1:3]
live = {}
for line in open(f"{work}/live.tsv"):
    p = line.rstrip("\n").split("\t")
    if len(p) == 2 and p[0] != "None": live[p[0]] = p[1].strip('"')
chg, new, nobeacon = [], [], []
with os.scandir(src) as it:
    for e in it:
        if not e.is_file(follow_symlinks=False) or not e.name.endswith(".html"): continue
        b = open(e.path, "rb").read(); key = "t/" + e.name
        md5 = hashlib.md5(b).hexdigest()
        if key not in live: new.append(key)
        elif live[key] != md5: chg.append(key)
        else: continue
        if b"cloudflareinsights.com/beacon" not in b: nobeacon.append(key)
for n, l in (("changed", chg), ("new", new), ("nobeacon", nobeacon)):
    open(f"{work}/{n}.lst", "w").write("".join(k + "\n" for k in sorted(l)))
PY
NCHG=$(wc -l < "$WORK/changed.lst"); NNEW=$(wc -l < "$WORK/new.lst"); NNB=$(wc -l < "$WORK/nobeacon.lst")
phase "diff: $NCHG changed, $NNEW new, $NNB missing beacon"

if [ "$NNB" -gt 0 ]; then
  echo "REFUSING: $NNB pages to upload lack the Cloudflare beacon (run build_site.py). e.g.:"; head -5 "$WORK/nobeacon.lst"
  [ "$MODE" = go ] && exit 1
fi

if [ "$MODE" != go ]; then
  echo "dry run: would back up $NCHG, upload $((NCHG+NNEW)), invalidate '/t/*'. Pass --go to deploy."
  head -5 "$WORK/changed.lst" "$WORK/new.lst"; exit 0
fi
[ $((NCHG+NNEW)) -eq 0 ] && { echo "nothing to upload"; exit 0; }

# 3. backup live versions of objects we will overwrite (~/backup pattern)
BK="$HOME/backup/seo-$STAMP"; LISTS="$BK-lists"; mkdir -p "$BK" "$LISTS"
cp "$WORK/changed.lst" "$WORK/new.lst" "$LISTS/"
echo "$BUCKET" > "$BK.bucket"
if [ "$NCHG" -gt 0 ]; then
  xargs -P 32 -I{} aws s3 cp "s3://$BUCKET/{}" "$BK/{}" --only-show-errors < "$WORK/changed.lst"
  got=$(find "$BK/t" -type f | wc -l)
  [ "$got" -eq "$NCHG" ] || { echo "backup incomplete ($got/$NCHG); aborting before upload" >&2; exit 1; }
fi
cat > "$LISTS/ROLLBACK.md" <<RB
# Rollback seo-$STAMP
AWS_PROFILE=$AWS_PROFILE AWS_REGION=$AWS_REGION; bucket $BUCKET; CloudFront $DIST_ID
aws s3 cp $BK/t/ s3://$BUCKET/t/ --recursive --content-type "$CONTENT_TYPE" --cache-control "$CACHE_CONTROL"
aws cloudfront create-invalidation --distribution-id $DIST_ID --paths '/t/*'
New objects (new.lst) can be left in place.
RB
phase "backup $NCHG -> $BK"

# 4. upload changed+new via a hardlink staging dir (no --delete, ever)
mkdir -p "$WORK/stage/t"
cat "$WORK/changed.lst" "$WORK/new.lst" | while read -r k; do ln "$SRC/${k#t/}" "$WORK/stage/$k" 2>/dev/null || cp "$SRC/${k#t/}" "$WORK/stage/$k"; done
aws s3 cp "$WORK/stage/t/" "s3://$BUCKET/t/" --recursive --only-show-errors \
  --content-type "$CONTENT_TYPE" --cache-control "$CACHE_CONTROL" 2>&1 | tee "$LISTS/upload.log"
phase "upload $((NCHG+NNEW))"

# 5. single invalidation
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths '/t/*' \
  --query Invalidation.Id --output text | tee "$LISTS/invalidation.id"
phase "invalidate /t/*"
echo "done. backup: $BK  lists: $LISTS"
