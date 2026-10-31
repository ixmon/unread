# Unified Search preview — notes

Branch: `unified-search-20261031` (from browse-mobile). Preview :8861. **No deploy.**

## Browse mode control
- Removed Auto / ATF / English UI on Browse (phones and desktop).
- Search still uses `mode = 'auto'` + `detect()` (cuneiform / ATF hints → ATF, else English).
- **Desktop:** no longer needs the manual override for normal use; auto-detect covers English words, ATF (`kasz`, `š`/`sz`, `{u2}…`), and cuneiform. Keep override only if Hayden wants a hard force for ambiguous tokens — not restored in this preview.

## What shipped
- Top nav **Search** replaces Explore / Search / Browse (site-wide static navs + map header).
- Under header: **Map | List | Explore** tabs; shared `q` + sidebar filters; URL `view=map|list|explore` (map omits `view`).
- Sidebar on all three hub views; **Hide panel** → **×** close; open via Filters (map control + bar button).
- Lazy: List mounts on first visit (direct `/api/search`); Explore mounts iframe `browse.html?embed=1`.
- Redirects: `search.html?*` → `map.html?view=list&…`; `browse.html?*` → `map.html?view=explore&…` (unless `embed=1`).

## Open issues
1. **List is a slim panel**, not full `search.js` (no deep text view, pager, phrase UI parity). Next: embed or refactor search.js behind a mount API.
2. **Explore is an iframe** (weight OK for lazy; chrome/history slightly separate). Longer-term: in-process Browse mount.
3. **Legacy `?view=explore`** on map.html now means Explore (wheel), not the geo map. Bare `map.html` → Map. Call out in release notes.
4. **Sidebar sections** (map layers / curated) still show on List/Explore — useful filters stay; layer toggles are map-specific (could hide per-tab later).
5. **Reader / Stats / About** unchanged; Search hub hides when those are active.
6. Many `/t/*.html` navs updated; generated tablet pages not in this tree may still show old trio until rebuild.
