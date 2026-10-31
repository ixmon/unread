#!/usr/bin/env python3
"""Dry-run normalizer for bizarre human line_ref labels. Never writes the DB."""
import argparse, json, re, sqlite3, sys
from pathlib import Path

SPAN = re.compile(r"\[(\d+):(\d+)\]")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=str(Path.home() / "cursor/unread-db/corpus.sqlite"))
    ap.add_argument("--out", default="dryrun_actions.jsonl")
    args = ap.parse_args()
    con = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    cur = con.cursor()
    rows = cur.execute(
        "SELECT id,text_id,line_ref,content FROM translations "
        "WHERE author_type='human' AND lang='en' AND line_ref LIKE '%[%' "
        "AND (line_ref LIKE '%–%' OR line_ref LIKE '%—%')"
    ).fetchall()
    n = 0
    with open(args.out, "w") as f:
        for id_, tid, lr, content in rows:
            m = SPAN.search(lr or "")
            if not m:
                continue
            a, b = int(m.group(1)), int(m.group(2))
            lines = cur.execute(
                "SELECT seq,line_no FROM lines WHERE text_id=? ORDER BY seq", (tid,)
            ).fetchall()
            if not (0 <= a <= b < len(lines)):
                action = {"id": id_, "text_id": tid, "action": "review", "reason": "index_oob", "before": lr}
            elif b > a:
                action = {
                    "id": id_, "text_id": tid, "action": "review", "reason": "multi_line_merge",
                    "before": lr, "proposed_first_line": lines[a][1], "span_lines": [x[1] for x in lines[a:b+1]],
                }
            else:
                action = {
                    "id": id_, "text_id": tid, "action": "relabel", "reason": "single_unit",
                    "before": lr, "after_line_ref": lines[a][1],
                }
            f.write(json.dumps(action, ensure_ascii=False) + "\n")
            n += 1
    print(f"wrote {n} actions to {args.out} (DB untouched)", file=sys.stderr)

if __name__ == "__main__":
    main()
