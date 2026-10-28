# Modest moat (static `/t/` pages)

Status: implemented on branch `moat-preview` (not deployed). Next step after merge: regenerate
cached/search-export translations with B2c and rebuild SEO pages.

## Goals

- Stay public and search-indexed. Do **not** block search engines or AI crawlers in `robots.txt`.
- Uniform rate limits for every client (no UA allow-list that punishes polite bots).
- Crawlers that only fetch static HTML should not get the full machine-English corpus.
- People (and agents) get a better path: the site UI, the rate-limited `/api`, a future MCP
  wrapper around the same API, or the downloadable model on Hugging Face.

## What changed

### Static tablet pages (`scripts/build_seo_pages.py`, curated via `scripts/build_static.py`)

HTML still carries full SEO value:

- title, meta description, canonical, Open Graph
- find-spot, period, genre, museum/collection
- source credit + outbound link
- ATF when `atf_public=1` (eBL ATF stays withheld)
- publishable human English per `translation-policy.json` (unchanged)
- schema.org `ArchiveComponent` + breadcrumbs (already present)

Machine English is split by `mt_teaser_lines(n_mt, cap)`:

| `n_mt` | Lines in static HTML |
| --- | --- |
| 0 or 1 | **0** (full draft only via API; a one-line text is not teased) |
| 2+ | **min(cap, ⌊n_mt / 2⌋)**, at least **1** (default `cap` = 5 via `--mt-html-lines` / `SEO_MT_HTML_LINES`) |
| `cap` ≤ 0 | all lines in HTML (old behaviour, for experiments) |

Examples with default cap 5: 2→1, 3→1, 4→2, 9→4, 10→5, 52→5.

The rest of the draft loads in the browser from **`GET /api/text/<id>`** via `web/js/static-mt.js`
(auto-fetch on page load; retry + Reader / translator / HF links on failure).

No predictable static `/*.json` of full drafts is written. The API path is already behind the
CloudFront WAF on the search distribution.

### JSON shape (easy to regenerate for B2c)

Reuse the existing `/api/text/<id>` response (same one the Reader uses). After a B2c retranslate:

1. Rebuild `aws-cunei-search` export (`export/build_export.py`) so MT rows carry the new model stamp.
2. Deploy the new export (`./deploy.sh data`).
3. Rebuild SEO pages (`scripts/build_seo_pages.py` / `build_site.sh`). Teaser lines come from the
   export; the browser always reads the live API.

Optional later (not built): a slim `GET /api/mt/<id>` that returns only

```json
{
  "id": "P342630",
  "model": {"repo": "montycrypto/atf-to-english", "label": "B2c", "on": "2026-10-28", "rev": "…"},
  "lines": [{"n": "1", "en": "…", "conf": 0}]
}
```

for cheaper full-draft fetches. The current `/text/<id>` payload is enough.

### MCP / agent path (not built)

An MCP server would wrap the same public endpoints (`/search`, `/search/ids`, `/search/sites`,
`/text/<id>`, `/stats`) with tool descriptions. No new data plane. Prefer that over scraping `/t/`.
A 429 on full-draft fetches should point agents there (and to the HF model) instead of retrying.

## Proposed rate-limit / WAF changes (**do not apply yet**)

Context: on 2026-10-27 about **20k** `/t/*.html` opens came from a scraper that slipped past the
`visits.py` bot UA filter. Those were static HTML fetches (today’s live site still has full MT in
the page). After this moat, the same scraper only gets the HTML teaser unless it calls `/api/text/*`.

Current API WAF (`unread-atlas-search-waf`, CloudFront scope, us-east-1): **300 requests / 5 minutes / IP**.

Proposed (Hayden approved numbers; apply only after an explicit go-ahead / the Wed review):

| Surface | Limit | Purpose |
| --- | --- | --- |
| API `/text*` (full drafts) | **60 requests / minute / IP** (WAF rate rule) | ~1 tablet/sec burst ceiling for humans; bounds bulk JSON |
| API `/text*` | **200 responses / UTC day / IP** (Lambda soft cap) | stops slow-drip scrapers under the per-minute window |
| API `/text*` on 429 | Friendly JSON/HTML message pointing to the **MCP/API**, the site Reader, and the **HF model** download (`montycrypto/atf-to-english`) — not a hard block with no alternative |
| API `/search*` | keep **300 / 5 min / IP** | server protection; search is snippet-sized and already capped in Lambda |
| Site CloudFront (general HTML, `/t/` etc.) | about **2,000 req / 5 min / IP** | server protection only, not a data moat |
| `visits.py` | report IPs with **>100 `/t/*.html` / min** even when UA looks human | analytics only; no auto-ban |

Do **not** add robots `Disallow` for GPTBot / ClaudeBot / etc.

## Open decisions (resolved 2026-10-27)

1. Teaser length: **min(5, ⌊50%⌋), ≥1 if n_mt≥2, 0 if n_mt≤1** — done.
2. Auto-fetch full draft on page load — keep.
3. Apply the `/text*` 60/min + 200/day limits — **not yet**; wait for explicit deploy / Wed review.
4. Regenerate curated `web/t/*.html` in the same PR — still open (needs corpus DB + `build_static.py` run).
