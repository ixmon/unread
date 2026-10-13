# Sign-to-English gloss table (training-data artifact)

`sign_glosses.json` / `.csv`: one row per eBL sign (2,493). `gloss` = the displayed choice; `all_sources` keeps every
candidate with its source, so rows can be filtered by licence or confidence. Rebuilt by
`scripts/mockups/build_sign_dictionary.py`.

Coverage, 13 Oct 2026 (was 929 / 2,493): **1,246 / 2,493 signs (50.0%)**
| source (priority order) | signs | licence |
|---|---|---|
| ORACC ePSD2 glossary, base via eBL reading (≥5 attestations) | 897 | CC0 |
| ORACC ePSD2, base via OGSL index (old fallback) | 4 | CC0 |
| ORACC ePSD2, base resolved directly through OGSL (new; incl. <5 attestations, flagged) | 277 | CC0 |
| ORACC Akkadian glossaries SAAo/RINAP/RIBo, logographic spellings (new) | 22 | CC0 |
| eBL dictionary guide words via eBL public API sign logograms (new) | 2 (236 signs have it as a 2nd source) | eBL/LMU, attributed |
| Wiktionary Sumerian/Akkadian senses (new) | 27 | CC BY-SA 4.0 |
| CDLI co-occurrence, **inferred** | 17 | derived |
| none | 1,247 | |

The 1,247 still without a gloss are mostly compounds/variants that are unattested in our corpus and in the glossaries.

## Can Qwen or v4e fill the rest? (`eval_gloss_models.py`, `model_gloss_eval.json`)
Held-out: 200 signs that already have a dictionary gloss (100 simple, 100 compound); the model sees only the sign name,
Unicode and eBL readings. Correct = shares a content-word stem with any dictionary sense we hold (lenient).
| model | simple | compound | all | precision when it answers |
|---|---|---|---|---|
| Qwen (local llama.cpp, no thinking, may say UNKNOWN) | 34% | 4% | 19% | 42% (answers 45%) |
| v4e atf→English on the sign's reading | 13% | 5% | 9% | 9% |

Neither is good enough to label signs, even as "inferred" (the missing set is ~97% compounds, where Qwen is right 4%
of the time). **No model glosses were applied** (`model_inferred.json` is not created; the build supports it).
On the 1,247 missing signs Qwen offered an answer for 122; those are kept in `model_gloss_eval.json` for review only.
