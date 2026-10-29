# Quiet browser-check token (step 1, shadow mode)

Status: **preview only** on branch `bot-token-shadow` (off `ui-tweaks-nav-mt`).
Local preview: `python3 scripts/serve_token_preview.py (or .preview/serve_token.py) 8850` → http://127.0.0.1:8850/
(Does not replace the :8840 UI-tweaks preview, which still proxies `/api` to production.)

## Design

1. `web/js/browser-token.js` runs on pages that fetch full text (map reader, search text view, static `/t/` lazy MT).
   No visible UI. It records light signals (screen/viewport/DPR, language, timezone, webdriver flag,
   a small interaction-entropy score) and `POST`s them to `/api/token`.
2. Lambda `POST /token` sanity-checks the signals, then mints a 15-minute (10–30 configurable) HMAC-SHA256
   token loosely bound to IP prefix + UA hash. Secret: env `TOKEN_HMAC_SECRET` (never in the repo).
3. Clients send `Authorization: Bearer …` (and `X-Unread-Token`) on `/api/text/<id>`.
4. **`TOKEN_MODE=shadow` (default / preview):** missing or invalid tokens are **logged only**
   (`event=text_token_shadow`) and the response is unchanged. Existing WAF per-IP limits stay as they are.
5. **`TOKEN_MODE=enforce` (not enabled):** `/text` returns 401 without a valid token. Not for preview.

Headless Chrome is allowed (`webdriver: true` is recorded, not rejected) so real automation and our tests still mint.
Naive `curl` / `requests` without a plausible signal body do not get a token; `/text` without a token still
succeeds in shadow mode and is logged.

## Go-live checklist (do not do until Hayden says)

1. Set `TOKEN_HMAC_SECRET` on the Lambda (Secrets Manager or env), `TOKEN_MODE=shadow` first.
2. Deploy Lambda code (`./deploy.sh code`) — zip still only packs `app.py`.
3. Deploy site JS (`browser-token.js` + wired `static-mt.js` / `app.js` / `search.js` + script tags).
4. Watch CloudWatch for `token_mint` / `text_token_shadow` ratios for a few days.
5. Before `TOKEN_MODE=enforce`: stop CloudFront caching of `/text*` on `Authorization` (or set
   `/text` to `Cache-Control: private, no-store` when a token is required), or enforce will be bypassed by cache.
6. Keep WAF 300/5 min; optionally add the proposed `/text` 60/min + 200/day caps from `docs/moat.md`.

## Cost impact (estimate)

- Extra `POST /token` ≈ one per browser session / 15 min, not per tablet. At a few hundred real visitors/day
  that is &lt;1k Lambda invocations/day — pennies/month on top of the existing search function.
- No new AWS services required for shadow mode (no DynamoDB; mint cap is in-process best-effort).
- Negligible CloudWatch log volume.

## Related preview work still waiting on Hayden (not this branch alone)

Already on `ui-tweaks-nav-mt` / earlier preview branches, **not live**:

1. Shared Explore nav + short MT stamp + teaser-copy removal
2. Self-hosted IBM Plex / Source Serif 4 (GDPR; live still hits Google Fonts)
3. Moat teaser MT in `/t/` HTML (full draft via `/api/text`)
4. Awaiting-work map layer
5. Crawl-delay for AhrefsBot / SemrushBot in robots.txt
6. Lambda NOTICE wording scrub (source patched, API not redeployed)
7. Optional later: self-host Leaflet + translator CDN; WAF rate rule for SEO bots (~$1/mo); API-key signup age checkbox
