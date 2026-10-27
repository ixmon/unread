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

Machine English is split:

| Where | How many lines |
| --- | --- |
| Static HTML | first **5** machine lines (`--mt-html-lines`, env `SEO_MT_HTML_LINES`; `0` = old behaviour) |
| Browser | the rest, filled by `web/js/static-mt.js` from **`GET /api/text/<id>`** |

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

## Proposed rate-limit / WAF changes (**do not apply yet**)

Context: on 2026-10-27 about **20k** `/t/*.html` opens came from a scraper that slipped past the
`visits.py` bot UA filter. Those were static HTML fetches (today: full MT in the page). After this
moat, the same scraper only gets the 5-line teaser unless it calls `/api/text/*`.

Current API WAF (`unread-atlas-search-waf`, CloudFront scope, us-east-1): **300 requests / 5 minutes / IP**.

Proposed (Hayden to approve before `deploy.sh waf` / console edits):

| Rule | Limit | Why |
| --- | --- | --- |
| API `/text*` (URI path) | **120 requests / 5 min / IP** | ~24 tablets/min sustained; human browsing fine; caps bulk full-JSON at ~1.4k tablets/hour/IP |
| API `/search*` | keep **300 / 5 min / IP** | search is snippet-sized and already capped in Lambda |
| Optional Lambda soft cap | **2,000 `/text` responses / UTC day / IP hash** | stops slow-drip scrapers under the 5-min window |
| Site CloudFront (HTML) | optional **2,000 req / 5 min / IP** | bounds `/t/` hammering; do **not** block known good crawlers by UA |
| `visits.py` | report IPs with **>100 `/t/*.html` / min** even when UA looks human | analytics only; no auto-ban |

Do **not** add robots `Disallow` for GPTBot / ClaudeBot / etc.

## Open decisions

1. Is **5** HTML teaser lines the right default (vs 3 or 10)?
2. Auto-fetch full draft on page load (current) vs click-to-load?
3. Apply the `/text*` WAF 120/5min change now, or wait for the Wed 2026-10-28 rate-limit review?
4. Should curated `web/t/*.html` be regenerated in the same PR (needs `build_static.py` + corpus DB)?
