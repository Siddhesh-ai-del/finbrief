# Evals

Deterministic evaluation gates. Plan rule: **PR-blocking evals never
call a model** — real-model runs are nightly-only (Step 4.5).

## Categorization (Step 2.3 → 4.5)

```sh
npm run eval:categorization        # exit 1 below the accuracy bar (block gate)
```

- **Corpus** — `datasets/categorization-v0.jsonl`, one JSON row per
  line so PR diffs stay reviewable. Ground truth follows the plan's
  recipe: fixture-derived rows (`source: "fixture"`, Plaid
  `personal_finance_category` as ground truth) + hand-reviewed rows
  (`source: "hand-reviewed"`, `reviewed: true`). Hostile rows carry
  bidi/zero-width/NUL characters as `\u` escapes so the eval runs the
  SAME Step 1.5 sanitization boundary production does.
- **Taxonomy** — labels are the real Plaid PFCv2 primaries, vendored
  from <https://plaid.com/documents/pfc-taxonomy-all.csv> in
  `categorization/taxonomy.ts` (fetched 2026-10-27; a taxonomy change
  is a reviewed diff, never silent CI drift).
- **Metric** — exact match on the primary category; integer
  correctness only, no fuzzy credit.
- **Threshold** — `--min-accuracy` / `EVAL_CATEGORIZATION_MIN_ACCURACY`
  is required; there is no default (policy lives in CI config, plan
  anti-pattern list). The npm script pins 0.9, below the measured
  no-LLM baseline floor (0.9597 on v0), so the gate blocks
  regressions below the fallback's quality from day one. The 4.5 CI
  workflow raises the bar for the AI categorizer once measured.
- **Subjects** — default is `categorization/baseline-categorizer.ts`
  (deterministic token rules; also the compliance fallback if Plaid
  refuses LLM categorization). Point `EVAL_CATEGORIZER_MODULE` at a
  module with a default-exported `Categorizer` to evaluate another
  subject — the nightly AI categorizer lands that way in 4.5.

Known honest baseline misses on v0 (do not tune the baseline to chase
them — circular gates are worthless): c058 (ambiguous "professional
service fee"), f005/f012/f013 (hostile or direction-ambiguous
counterparty strings), f015 (sanitizer word-split "CHIP OTLE").
