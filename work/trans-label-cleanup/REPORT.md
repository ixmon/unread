# Human translation range-label dry run

- DB `~/cursor/unread-db/corpus.sqlite` (**read-only**, not swapped)
- Human EN rows: **440,344**
- Hyphen+digit `line_ref` rows: **24** across **11** texts
- Safe single-unit relabel candidates: **0**
- Flagged for review: **24** ({'multi_line_merge': 19, 'index_oob': 5})

## Before / after samples

- `Q005730`
  - before: `Obverse [46:62] 4949–64-6564-65`
  - after: review — multi_line_merge, span ['49', '50', '51', '52', '53', '54', '55', '56', '57', '58', '59', '60', '61', '62', '63', '64-65', '66']
  - content: In the future may a later prince, when that temple becomes dilapidated and he renovates (it), anoint my monumental inscriptions with oil, ma

- `P338646`
  - before: `Obverse Column i [5:7] o i 66–o i 7-87-8`
  - after: review — multi_line_merge, span ['6', '7-8', '9-10']
  - content: In Tašritu (VII), on the 15th day, the Sun rises in the middle of the Scales [...] and the Moon stands in front of the Bristle, behind the H

- `P338646`
  - before: `Obverse Column i [7:8] o i 9-109-10–o i 9-109-10`
  - after: review — multi_line_merge, span ['9-10', '11-13']
  - content: In Ṭebetu (X), on the 15th day, the Arrow appears in the evening and the daytime watch is 2 minas, the night-time watch 4 minas.

- `P338646`
  - before: `Obverse Column i [8:10] o i 11-1311-13–o i 1414`
  - after: review — multi_line_merge, span ['11-13', '14', '15']
  - content: The Sun, which rose southwards with the Lion's head, turns and keeps rising northwards at 40 nindanu a day. The days lengthen. The nights sh

- `P338646`
  - before: `Obverse Column i [24:27] o i 34-3534-35–o i 3737`
  - after: review — multi_line_merge, span ['34-35', '36', '37', "1'"]
  - content: They touch [...] of heaven. [...] you observe their risings [...]. They touch bitumen.

- `P338646`
  - before: `Reverse Column i [5:8] r i 6-76-7–r i 1616`
  - after: review — multi_line_merge, span ['6', '7-8', '9-10', '11-13']
  - content: [...] cubit shadow: 2 [...]. [...] cubit shadow [...].

- `P229919`
  - before: `Obverse [0:1] o 1-21-2–o 1-21-2`
  - after: review — multi_line_merge, span ['1-2', '3-4']
  - content: at the established time he owned it

- `P229919`
  - before: `Obverse [1:2] o 3-43-4–o 3-43-4`
  - after: review — multi_line_merge, span ['3-4', '5-6']
  - content: at the established time he gave it to him

## Artifacts

- `work/trans-label-cleanup/summary.json`
- `work/trans-label-cleanup/dryrun_actions.jsonl`
- `work/trans-label-cleanup/normalize_dryrun.py`

No live DB writes performed.
