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
step, look and promotion. Epoch 1 starts with the operator's `epoch new`
after the WP1..WP3 gateway restart; from there the control plane
(`src/services/loop/`) appends the lines itself (`- <date> — epoch-N START
… / LOOK n=… / STOP … / ladder STEP-UP|STEP-DOWN … / PROMOTE …`).

- 2026-09-05 — `risk-rules.live.yaml` RATIFIED as the CEILING policy
  (REQ-RISK-011; operator decision R10-Q3): 0.5%/trade ceiling, 1.5% daily
  halt, 15% × 4 slots, 6 trades/day, 35% sector cap. Effective intraday
  risk = min(ceiling, ladder rung); the rung starts at 0.25%.
- 2026-09-05 — WP1 landed (trigger bar 60 / cap 30, significance ranking,
  large-cap lane, vehicle complexes, pre-open spread two-tier, sizer rung
  overlay, epoch latch, spend cap, live/veto seams). Fingerprint after the
  restart: _pending_ (the scorecard prints it; record here).
- epoch 1 START _pending_ — `epoch 1 START <iso> fp <12hex> netliq $<n> rung 0.25`
- 2026-09-05 — sequential-test schedule A (99/97.5/96/95, now 10,000 replicates) RATIFIED after calibration: 10.3–11% measured false ACCEPT under a zero-edge null with independent days, 14% under ρ = 0.5 regime streaks, 66% power at +0.25 R (`scripts/calibrate-sequential-test.ts`); the "≈5% familywise" claim is withdrawn. Audit 2026-09-05 R0 remediation landed pre-epoch (commit cedf852).
- 2026-09-06 — ladder RESET to rung 0.25% for epoch-1
- 2026-09-06 — epoch-1 START 2026-09-06T21:33:39.997Z fp 5a37de4f2ccf constants 6f69718c525f netliq $12245.68 rung 0.25 policy incumbent
- 2026-09-08 — epoch-1 STOP 2026-09-08T19:01:59.647Z — trigger-coverage correction
- 2026-09-08 — ladder RESET to rung 0.25% for epoch-2
- 2026-09-08 — epoch-2 START 2026-09-08T19:06:11.445Z fp 4801bb194d6c constants 6f69718c525f netliq $12228.96 rung 0.25 policy incumbent
- 2026-09-09 — epoch-2 STOP 2026-09-09T15:16:29.253Z — day-1 corrections: exit commission attribution, 10148 token, intraday entry cutoff, cron spend reserve (not a REJECT)
- 2026-09-09 — ladder RESET to rung 0.25% for epoch-3
- 2026-09-09 — epoch-3 START 2026-09-09T15:18:45.341Z fp 7230906cf78f constants 6f69718c525f netliq $12218.11 rung 0.25 policy incumbent
