#!/usr/bin/env python3
"""PREVIEW ONLY. Copy the search export and replace all machine English with B2c hybrid
(out_clean.sqlite). Never modifies the live export or corpus.sqlite.

Then:
  SEARCH_DB=<out> ./scripts/build_site.sh --out dist-b2c-moat-preview
"""
from __future__ import annotations

import datetime as dt
import json
import os
import shutil
import sqlite3
import sys
import time

SRC = os.path.expanduser("~/cursor/aws-cunei-search/out/unread-atlas-search.sqlite")
MT = os.path.expanduser("~/cursor/unread-db/mt_b2c_hybrid/out_clean.sqlite")
OUT = (
    sys.argv[1]
    if len(sys.argv) > 1
    else os.path.expanduser("~/cursor/unread-db/mt_b2c_hybrid/search-preview.sqlite")
)

AUTHOR = "montycrypto/t5large-B2c"
VERSION = "ckpt-22000-hybrid-ct2bf16"
LABEL = "B2c"
LICENSE = "MIT"
CREATED = dt.date.today().isoformat()


def main() -> None:
    src_abs, out_abs, mt_abs = map(os.path.abspath, (SRC, OUT, MT))
    if out_abs == src_abs:
        raise SystemExit("refusing to overwrite live search export")
    if not os.path.isfile(src_abs):
        raise SystemExit(f"missing search export: {src_abs}")
    if not os.path.isfile(mt_abs):
        raise SystemExit(f"missing out_clean: {mt_abs}")

    t0 = time.time()
    print(f"copy {src_abs} -> {out_abs}", flush=True)
    os.makedirs(os.path.dirname(out_abs), exist_ok=True)
    if os.path.exists(out_abs):
        os.remove(out_abs)
    shutil.copy2(src_abs, out_abs)

    c = sqlite3.connect(out_abs)
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA synchronous=NORMAL")
    c.execute("ATTACH ? AS mt", (mt_abs,))

    # New tr_source rows per src that has B2c lines
    srcs = [r[0] for r in c.execute(
        "SELECT DISTINCT source_id FROM mt.translations WHERE author_type='model' AND author=? AND version=?",
        (AUTHOR, VERSION),
    )]
    print(f"sources with B2c MT: {srcs}", flush=True)
    ts: dict[str, int] = {}
    for s in srcs:
        c.execute(
            "INSERT OR IGNORE INTO tr_source(src,author_type,author,license,version,model_label,edition) "
            "VALUES(?,?,?,?,?,?,NULL)",
            (s, "model", AUTHOR, LICENSE, VERSION, LABEL),
        )
        # ensure label even if row already existed
        c.execute(
            "UPDATE tr_source SET model_label=? WHERE src=? AND author_type='model' AND author=? AND version=?",
            (LABEL, s, AUTHOR, VERSION),
        )
        tsid = c.execute(
            "SELECT tsid FROM tr_source WHERE src=? AND author_type='model' AND author=? AND version=?",
            (s, AUTHOR, VERSION),
        ).fetchone()[0]
        ts[s] = tsid

    old_n = c.execute("SELECT COUNT(*) FROM tr WHERE human=0").fetchone()[0]
    print(f"delete {old_n:,} old machine rows", flush=True)
    c.execute("DELETE FROM tr WHERE human=0")

    print("insert B2c rows…", flush=True)
    c.execute(
        """
        INSERT INTO tr(rid, lid, line_ref, content, human, tsid, created)
        SELECT t.rid, NULL, x.line_ref, x.content, 0, ts.tsid, ?
        FROM text t
        JOIN mt.translations x
          ON x.source_id = t.src AND x.text_id = t.id
        JOIN tr_source ts
          ON ts.src = x.source_id AND ts.author_type = 'model'
         AND ts.author = ? AND ts.version = ?
        WHERE x.author_type = 'model' AND x.author = ? AND x.version = ?
          AND x.content IS NOT NULL AND trim(x.content) <> ''
        """,
        (CREATED, AUTHOR, VERSION, AUTHOR, VERSION),
    )
    new_n = c.execute("SELECT COUNT(*) FROM tr WHERE human=0").fetchone()[0]
    print(f"inserted {new_n:,} B2c machine rows", flush=True)

    print("align lids…", flush=True)
    c.execute("DROP TABLE IF EXISTS temp.lk")
    c.execute(
        """
        CREATE TEMP TABLE lk AS
        SELECT rid, trim(coalesce(surface,'')||' '||line_no) k, min(lid) lid
        FROM line GROUP BY 1,2
        """
    )
    c.execute("CREATE INDEX temp.ix_lk ON lk(rid,k)")
    c.execute(
        "UPDATE tr SET lid=(SELECT lid FROM lk WHERE lk.rid=tr.rid AND lk.k=tr.line_ref) WHERE human=0"
    )
    aligned = c.execute("SELECT COUNT(*), COUNT(lid) FROM tr WHERE human=0").fetchone()
    print(f"aligned lids: {aligned[1]:,} / {aligned[0]:,}", flush=True)

    c.execute(
        """
        UPDATE text SET
          n_mt = coalesce((SELECT count(*) FROM tr WHERE tr.rid=text.rid AND human=0), 0)
        """
    )

    # Refresh FTS English so local /search snippets match (optional but cheap enough)
    print("rebuild fts_en…", flush=True)
    try:
        c.execute("INSERT INTO fts_en(fts_en) VALUES('delete-all')")
    except sqlite3.OperationalError:
        pass
    c.execute("INSERT INTO fts_en(rowid, en) SELECT trid, content FROM tr")
    c.execute("INSERT INTO fts_en(fts_en) VALUES('optimize')")

    # Update meta keys the /stats endpoint reads (each value is JSON-encoded)
    print("update meta…", flush=True)
    models = [{
        "repo": AUTHOR,
        "revision": VERSION,
        "label": LABEL,
        "translated_on": CREATED,
        "lines": new_n,
    }]
    built = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    twm = c.execute("SELECT COUNT(*) FROM text WHERE n_mt>0").fetchone()[0]
    c.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('models',?)", (json.dumps(models),))
    c.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('mt_lines',?)", (json.dumps(new_n),))
    c.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('texts_with_mt',?)", (json.dumps(twm),))
    c.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('built_at',?)", (json.dumps(built),))
    c.execute(
        "INSERT OR REPLACE INTO meta(key,value) VALUES('preview_mt',?)",
        (
            json.dumps(
                {
                    "author": AUTHOR,
                    "version": VERSION,
                    "label": LABEL,
                    "source": mt_abs,
                    "created": CREATED,
                    "lines": new_n,
                }
            ),
        ),
    )
    c.commit()
    c.execute("DETACH mt")
    c.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    c.close()
    # drop sidecars so consumers open a single file
    for suf in ("-wal", "-shm"):
        p = out_abs + suf
        if os.path.exists(p):
            os.remove(p)

    print(
        f"OK preview export {out_abs}: {new_n:,} B2c lines "
        f"(was {old_n:,}) in {time.time()-t0:.1f}s",
        flush=True,
    )


if __name__ == "__main__":
    main()
