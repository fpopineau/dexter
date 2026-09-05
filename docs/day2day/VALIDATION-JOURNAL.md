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

_(empty — the freeze-tag window never opened; superseded below)_

## Live-loop program (2026-09-05 — SPEC.md § "Live-loop program", supersedes the tag protocol)

Epochs replace the freeze window: one line per epoch start/stop, ladder
step and promotion. Epoch 1 starts at the WP1 gateway restart
(`performance reset` + the line below, filled by the operator; WP3
automates the lines from epoch 2).

- 2026-09-05 — `risk-rules.live.yaml` RATIFIED as the CEILING policy
  (REQ-RISK-011; operator decision R10-Q3): 0.5%/trade ceiling, 1.5% daily
  halt, 15% × 4 slots, 6 trades/day, 35% sector cap. Effective intraday
  risk = min(ceiling, ladder rung); the rung starts at 0.25%.
- 2026-09-05 — WP1 landed (trigger bar 60 / cap 30, significance ranking,
  large-cap lane, vehicle complexes, pre-open spread two-tier, sizer rung
  overlay, epoch latch, spend cap, live/veto seams). Fingerprint after the
  restart: _pending_ (the scorecard prints it; record here).
- epoch 1 START _pending_ — `epoch 1 START <iso> fp <12hex> netliq $<n> rung 0.25`
