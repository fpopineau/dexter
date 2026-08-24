# Validation journal — frozen-sample log

One line per event, newest last. This file is the audit trail
[VALIDATION-PROTOCOL.md](../handbook/VALIDATION-PROTOCOL.md) requires:
accounting-only bug fixes during the window (with commit SHA), weekly
scorecard runs, anomalies and their resolutions, and the tag-time
fingerprint. Behavior changes do NOT get journaled — they END the
window (new tag, fresh sample).

## Pre-freeze

- 2026-08-21 — performance epoch reset 13:03:57Z ("fresh statistics"),
  floor 0 (D6), flat sizing verified in both profiles. Freeze tag
  `validation-freeze-1` NOT yet placed (operator prerequisites:
  WP2/WP11 opportunistic paper observation or acceptance on harness
  coverage, one clean boot — boot verified 2026-08-21 13:36Z).
- 2026-08-21 — evaluator `scripts/validation-scorecard.ts` pinned
  (round-4 fixes: node+bun runtimes, NetLiq denominator from
  netliq-baseline.json, integrity gate, ISO weeks, aggregated verdict).
  Pre-freeze rows proposed before model/regime stamping carry NULLs;
  they drain before the tag and the purity check flags any stragglers.

## Tag-time fingerprint (fill at `validation-freeze-1`)

- Annotated tag OBJECT SHA (review-30 — NOT the commit SHA; this is
  what restores `.dexter/data/freeze-tag-pin.json` if it is ever lost):
  `git for-each-ref --format="%(objectname)" refs/tags/validation-freeze-1`
  → _pending_
- Strategy fingerprint (the scorecard prints it): _pending_
- Model + provider: _pending_ (from `.dexter/settings.json` at tag time)
- SHA-256 of `.dexter/RULES.md`: _pending_
- Scorer-weights provenance line: _pending_
- risk-rules pins: paper max_risk_per_trade_pct 0.25 / live 0.5 /
  live max_daily_loss_pct 1.5 (re-verify against the yamls at tag time)

## Window log

_(empty — starts at the freeze tag)_
