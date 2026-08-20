# Validation protocol — the frozen paper sample (Phase 4)

Pre-registered BEFORE the first frozen trade, per
[REMEDIATION-2026-08-20.md](REMEDIATION-2026-08-20.md) Phase 4. This
document is the acceptance contract for going live: the numbers below
were chosen before the sample existed and do not move to fit it. The
audit's bottom line stands until this protocol passes: the burden is
positive expectancy after costs, not improved loss control.

## Freeze

- The freeze starts at git tag `validation-freeze-1` (NOT YET TAGGED —
  see prerequisites). From the tag: no rule, gate, threshold, scorer, or
  sizing changes. The 2026-08-19 discovery rules and every remediation
  WP are part of what freezes.
- Bug fixes during the window are allowed ONLY for accounting
  correctness (a fill recorded wrong, a P&L mis-attributed), never for
  behavior, and each is logged in the validation journal
  (`docs/day2day/VALIDATION-JOURNAL.md`, one line per fix, with commit).
- A behavior change for any reason ENDS the window: new freeze tag, new
  sample, from zero.

### Prerequisites for tagging (operator checklist)

1. Live-verify on the paper gateway (WP7): the IBKR daily-volume lot
   factor (×100 in `daily-atr.ts`) against a known symbol's published
   ADV, and tick-236 field 46/49 semantics (shortable/halted) against a
   hard-to-borrow name and, opportunistically, a halted one.
2. Live-verify the WP2 resize path and the WP11 buffered-events path
   once on paper (both are wall-clock/broker-event dependent and
   test-gated).
3. One clean gateway boot: YAML validation passes, calendar coverage ok,
   no adoption-sweep surprises.

## Sample definition

- **Size**: at least 100 closed, entry-filled, non-adopted trades with
  resolved P&L (`realized_pnl NOT NULL`, `exit_reason NOT IN
  ('cancelled')`, `source != 'adopted'`), counted from the freeze tag's
  timestamp. Rows flagged untrustworthy in `note` are excluded.
- **Breadth**: the sample must span at least 2 distinct market-regime
  labels (the regime service's tags recorded at proposal creation) and
  at least 6 distinct calendar weeks. A sample that reaches 100 trades
  inside one regime keeps collecting until breadth is met.
- **Integrity gate**: zero unresolved fill/reconciliation anomalies at
  evaluation time — no `placement-unconfirmed` rows older than a day, no
  orphan-order flags outstanding, adoption sweep clean. An anomaly
  freezes the evaluation, not the collection.

## Acceptance criteria (ALL must hold)

1. **Net expectancy > 0**: mean net P&L per trade (gross − commissions)
   strictly positive.
2. **Profit factor ≥ 1.3**: gross wins / |gross losses| on net-of-
   commission trade P&L.
3. **Drawdown inside the live math**: the sample's worst peak-to-trough
   drawdown, scaled to the live account's risk profile
   (`risk-rules.live.yaml`), must not exceed 2× the live
   `max_daily_loss_pct` — a strategy whose normal drawdown eats two
   kill-switch days is not deployable on a €3.7K account.
4. **Class discipline**: every trade class that traded ≥10 times must
   individually satisfy (1); a class below 10 trades stays paper-only
   after go-live regardless of the aggregate.

## Score calibration (separate switch)

Confidence-weighted sizing (`sizing_full_score` bands) stays at a FLAT
multiplier until, on the same frozen sample:

- score deciles are monotone in mean net P&L (Spearman rank correlation
  > 0 with p < 0.05 across trades with recorded scores), and
- the top score band's win rate exceeds the bottom band's.

Fails → sizing stays flat on live; the scorer keeps collecting.

## Evaluation mechanics

- The weekly scorecard (benchmark extension) publishes the running
  sample: n, net expectancy, profit factor, drawdown, per-class and
  per-lane splits, score-decile table. Drift from this protocol must be
  visible weekly, not remembered at the end.
- Final evaluation is a one-shot read-only query over `proposals.db` at
  sample completion, checked against every criterion above, recorded in
  the validation journal with the query text.
- PASS → the live-account switch proceeds per
  [live-account plan] with `IBKR_ALLOW_LIVE` flipped only after the
  operator re-reads `risk-rules.live.yaml`.
- FAIL any criterion → no live. Diagnose, change deliberately, re-tag
  (`validation-freeze-2`), collect a fresh sample. Partial credit does
  not exist; nearly passing is failing.

## Never

- Never evaluate mid-sample and stop early on a good stretch (peeking
  is selection bias in time).
- Never widen a criterion to fit the sample after the fact.
- Never count adopted, cancelled-annotated, or pre-freeze rows.
- Never flip `earnings_bet_enabled` on live from this protocol alone —
  the class needs its own ≥10-trade paper record per criterion (4).
