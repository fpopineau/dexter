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
  sizing changes. The 2026-08-19 discovery rules, every remediation WP,
  and the 2026-08-22 take-at-x% exit policy (WP-EXIT — `exit_style` is
  pinned at tag time; flipping it ends the window) are part of what
  freezes.
- **The sample is SHADOW-LIVE** (WP-SHADOW, operator decision
  2026-08-22): the paper account is reset to ≈$11,700 (≈€10K, the live
  target) and runs `risk-rules.live.yaml` via `DEXTER_RISK_PROFILE=live`
  — the validation trades the exact live policy at the live scale, so no
  cross-profile extrapolation survives in the evaluator. ONE documented
  deviation: `earnings_bet_enabled` is forced true in shadow so the
  class keeps building its per-class record (criterion 4 still keeps it
  paper-only after go-live until its own ≥10-trade record passes).
- **The judgment policy freezes too** (review 2026-08-21): the runtime
  model/provider settings are pinned at tag time and recorded in the
  validation journal; every proposal stamps its `model` column, and the
  final evaluation VERIFIES the sample is single-model. A mid-sample
  model change ends the window like any behavior change.
- Confidence sizing is FLAT (multipliers 1.0) in both profiles as of
  2026-08-21 — verified in config, not just mandated here.
- Auto-execution's final floor is 0 (D6) so the decile-monotonicity
  test gets cross-band data. HONESTY NOTE (review 2026-08-21): the
  sample is still shaped upstream (trigger rank threshold, skill score
  floors, the daily cap's time-of-day bias) — floor 0 removes the last
  selection stage, it does not make sampling unbiased; the monotonicity
  result is conditional on the proposed-score range.
- At tag time the journal also records: the model AND provider strings,
  a SHA-256 of `.dexter/RULES.md` (mutable judgment input), a SHA-256 of
  `.dexter/data/performance-epoch.json` (the window's pin is a mutable
  JSON file — the fingerprint proves it never drifted; the scorecard
  prints it), the active `exit_style`, and the scorer-weights provenance
  line — `model` column homogeneity alone does not prove a homogeneous
  judgment policy.
- **The evaluator is `scripts/validation-scorecard.ts`** — its pinned
  definitions ARE this protocol's machine-readable form (sample filter,
  net P&L, profit factor, the drawdown scaling formula, per-trade
  Spearman with the t-approximation p-value, top/bottom bands at the
  sample's 80th/20th score percentiles with n ≥ 10 each, single-model
  purity incl. no-NULLs, ≥2 regime tags, ≥6 ISO weeks). Run it weekly
  and at completion; editing its definitions mid-sample ends the window.
- Bug fixes during the window are allowed ONLY for accounting
  correctness (a fill recorded wrong, a P&L mis-attributed), never for
  behavior, and each is logged in the validation journal
  (`docs/day2day/VALIDATION-JOURNAL.md`, one line per fix, with commit).
- A behavior change for any reason ENDS the window: new freeze tag, new
  sample, from zero.

### Prerequisites for tagging (operator checklist)

1. ✅ **VERIFIED 2026-08-21** (`scripts/verify-paper-prereqs.ts`, rerun
   any time): the provisional ×100 lot factor was WRONG — this fetch
   path returns share-denominated volume (AAPL read 3.09B/day, 100× its
   ~31M ADV, which would have let `min_avg_volume` pass almost
   anything). Factor removed, ADVs now read plausibly (AAPL 30.9M,
   NVDA 68.5M, KO 8.2M). Tick-236 field 46 (shortable) confirmed
   (AAPL/BYND true); field 49 (halted) is silent on a normal tape —
   the gate's null→note design stands. EUR.USD midpoint 1.168 ✓.
2. Live-verify the WP2 resize path and the WP11 buffered-events path
   once on paper (both are broker-event dependent and cannot be forced:
   they need a genuine partial fill / EOD-keep window). Observe
   opportunistically during paper trading, or accept on harness
   coverage — the operator's call at tag time.
   Same for the OCA-JOINED close (round-6 review): the harness verifies
   the transmitted fields, not IBKR's behavior when an order joins an
   already-working OCA group — observe one joined close cancelling its
   stop/target broker-side on paper before relying on it.
3. One clean gateway boot: YAML validation passes, calendar coverage ok,
   no adoption-sweep surprises. (The rules/calendar halves passed in the
   2026-08-21 script run; confirm on the next real gateway start.)
4. **Shadow-live in place (2026-08-22)**: operator ratifies the €10K
   revision of `risk-rules.live.yaml` (REVIEW-marked), resets the paper
   account NetLiq to ≈$11,700 in IBKR Account Management, sets
   `DEXTER_RISK_PROFILE=live` in the gateway environment, then sends
   `performance reset` — one clean epoch at the live scale. The scorecard
   fails any sample whose epoch NetLiq is not live-scale.

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

(Revised 2026-08-22, BEFORE the tag — the sample does not exist yet, so
these are still pre-registered numbers, not fitted ones.)

1. **Net expectancy > 0**: mean net P&L per trade (gross − commissions)
   strictly positive.
2. **Expectancy lower bound > 0**: the 95% one-sided lower confidence
   bound of mean net P&L per trade, from a day-block bootstrap (trading
   days resampled with replacement, 1000 replicates, seed 42 — same-day
   trades share the tape and are not independent), strictly positive. A
   sample mean carried by one fat day is not expectancy.
3. **Profit factor ≥ 1.3**: gross wins / |gross losses| on net-of-
   commission trade P&L.
4. **Drawdown inside the live math**: the sample's worst peak-to-trough
   drawdown as % of the frozen epoch NetLiq must not exceed 2× the live
   `max_daily_loss_pct`. The shadow-live sample runs at live scale, so
   this reads DIRECTLY — the former ×4 risk-ratio scaling is retired;
   an epoch NetLiq above $50K fails the criterion outright (the sample
   was not collected at the live scale).
5. **Class discipline**: every trade class that traded ≥10 times must
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
  the class needs its own ≥10-trade paper record per criterion (5).
