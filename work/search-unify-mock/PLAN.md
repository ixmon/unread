# Unified Search mock — plan (preview only)

**Mock URL (local :8861):** `/search-unified-mock.html?q=barley&view=list`  
**Branch:** `browse-mobile-20261031` · **no deploy** · old `map.html` / `search.html` / `browse.html` unchanged.

## Goal
One **Search** destination with shared query/filters in the URL and tabs that switch **Map / List / Explore** without a full page reload (real-estate map↔list pattern).

## What’s reusable
| Piece | Source | Notes |
|---|---|---|
| Full-text API + filters UI | `search.html` + `css/search.css` + search JS | Keep list rows, scope chips, filter grid; lift into shared chrome |
| Geo map + find-spot pins | `map.html` (Leaflet) + corpus search layer | Embed as Map tab; reuse sidebar hit list |
| Embedding / wheel / phone nearby | `browse.html` (+ recent phone UX) | Explore tab hosts current Browse plot; keep collapsed info + tap sheet |
| URL helpers | `web/js/browse-state.js`, map `view=` / `q=` | Extend one querystring schema across tabs |
| Home submit | `index.html` → already `search.html?q=` | Later retarget to unified Search (or redirect) |

## Proposed URL state (shared)
```
?q=barley&view=map|list|explore&period=&genre=&prov=&human=1&unread=1
(+ view-specific: map z/lat/lng or browse z/x/y/t — namespaced, e.g. mz= / bz=)
```
Tab changes `view` via `history.pushState`; filters/`q` replace or push consistently. Deep links restore the same tab + filters.

## Build phases (after OK)
1. **Shell** — shared header + search + filters + tab strip; three empty panels; URL sync (this mock).
2. **List tab** — move live search.html into the panel (API as today).
3. **Map tab** — mount Leaflet map; feed same result IDs / find-spot aggregates.
4. **Explore tab** — mount Browse WebGL/canvas; same ID filter set; keep phone nearby sheet.
5. **Nav cutover** — topnav single “Search”; `map.html` / `browse.html` / old `search.html` redirect or soft-land with `?view=`.
6. **Home** — submit already goes to Search; point at unified URL.

## Risks
- **Bundle weight:** Browse GL + Leaflet + search on one page → lazy-mount tab panels; don’t init Explore until first visit.
- **Two cameras in URL:** map lat/lng vs browse embedding x/y — namespace params; don’t clash.
- **Filter semantics differ today** (search facets vs map catalog vs browse ring) — need one filter model or clearly disable inapplicable controls per tab.
- **Mobile chrome height** — search + tabs + filters can crowd Map/Explore; collapse filters into a sheet on ≤640px (mock already stacks tabs).
- **SEO / deep links** — list view should remain crawlable; map/explore can stay noindex or share canonical list URL.
- **Regression surface** — keep old routes working until cutover; mock proves IA only.

## Screenshots
See `ui-browse-mobile-shots/unify-*.png` (phone 390 + desktop 1440 × each tab).
