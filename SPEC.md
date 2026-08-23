# SPEC — take-at-x% exit policy, €10K shadow-live, and the pre-freeze fix set

Ratified by the operator 2026-08-22 (discovery record:
`.claude/clarify-session.md`, section "Discovery: profit-taking policy +
€10K live account" — 14 answered questions). Everything here lands BEFORE
the `validation-freeze-1` tag; the frozen sample validates this policy.

## Problem

Two empirical audits (2026-08-18) showed the exit geometry was manufactured:
81% of planned R:R pinned at ~2:1 with targets a median 6% from entry, 10%
hit rate. The operator's ruling: targets are hard to evaluate, so the take
level IS the target — "better now than later", banked at an
instrument-scaled x%, with the benefit tracked instead of assumed. Separately
the live target account changed to €10,000 and the validation must run the
exact live policy (shadow-live), retiring the ×4 drawdown extrapolation.
A set of independently verified defects (2026-08-21 review challenge) rides
along because all behavior changes must precede the freeze tag.

## Domain deltas

- `RiskRules` gains: `take_atr_mult` (1.5), `take_floor_pct` (3),
  `take_cap_pct` (10), `exit_style` ('target'|'ratchet', default 'target'),
  `earnings_bet_min_verified` (4). All WP0.1 fail-loud validated.
- `proposals` table gains: `take_pct REAL`, `take_pct_source TEXT`
  ('formula'|'model'), `post_exit_mfe_pct REAL`, `post_exit_mae_pct REAL`,
  `take_counterfactual TEXT` ('target-first'|'stop-first'|'neither').
- Risk-profile selection gains an env override (`DEXTER_RISK_PROFILE`) that
  can only escalate a paper account onto the live rules (shadow-live).

## Requirements

### WP-EXIT — the take target

- REQ-EXIT-001: For intraday-class proposals the required target is
  `entry ± x%` (direction-aware, tick-aligned), where
  `x = take_pct` when the proposal supplies it, else
  `clamp(take_atr_mult × dailyATR%, take_floor_pct, take_cap_pct)`.
- REQ-EXIT-002: A supplied `take_pct` outside
  `[take_floor_pct, take_cap_pct]` is refused at creation naming the band.
  Accepted values are stored (`take_pct`, `take_pct_source`).
- REQ-EXIT-003: The creation gate refuses an intraday target deviating from
  the required take target by more than max(one tick, 0.05% of entry); the
  refusal prescribes the exact required target (refuse→correct→place).
- REQ-EXIT-004: `max_target_atr` is evaluated first and WINS: when the
  required x-target exceeds `max_target_atr × dailyATR`, the refusal states
  the symbol is intraday-ineligible (daily ATR too low for the take band)
  and prescribes no target — no contradictory prescriptions.
- REQ-EXIT-005: Missing `dailyATR` at creation ⇒ fail-closed refusal for
  intraday proposals (no formula fallback).
- REQ-EXIT-006: `min_risk_reward` stays 2.0, judged at the worst permitted
  fill against the take target — so stop distance ≤ x/2 by composition
  (regression-pinned, no new gate code).
- REQ-EXIT-007: `exit_style: 'target'` keeps current bracket semantics (the
  LMT leg sits at the take target, broker-side).
- REQ-EXIT-008: `exit_style: 'ratchet'`: profit-trail arms at +x% (the
  row's `take_pct`, formula fallback when absent), locks ≈x−1%, then
  releases the target leg into the existing runner machinery. Inert when
  `exit_style: 'target'`.
  **Recorded deviation (2026-08-22):** the x−1 lock is enforced by the
  trail's own close (giveback geometry, 60s poll, RTH) rather than by
  modifying the broker STP leg; the original bracket stop stays as the
  disaster backstop. Broker-side stop ratcheting is order-mutation
  machinery a config-off mode does not yet justify — revisit with
  operator approval before any freeze that runs `exit_style: ratchet`.
- REQ-EXIT-009: Swing, earnings-bet, and adopted rows are exempt from
  take-target enforcement and ratchet arming.
- REQ-EXIT-010: EOD conversion keeps the take target (the protect pair uses
  the proposal's stop/target — regression pins the x-target survives).
- REQ-EXIT-011: Chase continuation builds its levels under the same policy
  (target = x from the limit cap; impossible geometry ⇒ no continuation).
- REQ-EXIT-012: The nightly excursion sweeper records post-exit same-day
  MFE/MAE (vs exit fill, exit→session close) on closed intraday rows.
- REQ-EXIT-013: Take-target exits get a bounded counterfactual: would the
  legacy geometry (stop 1×dailyATR, target 2×dailyATR from entry) have hit
  target-first / stop-first / neither within 3 trading days. Research
  instrument, never a gate; constants live here.
- REQ-EXIT-014: The scorecard prints a take-vs-target line: n takes, mean
  realized net, mean post-exit MFE (left on the table), counterfactual
  tally.

### WP-SHADOW — €10K shadow-live

- REQ-SHADOW-001: `DEXTER_RISK_PROFILE` overrides the account-derived
  profile only when the account derives 'paper'; on a live account it is
  ignored with a loud error. Boot logs shadow mode loudly.
- REQ-SHADOW-002: In shadow mode `earnings_bet_enabled` is forced true —
  the single documented deviation from `risk-rules.live.yaml` — and the
  rules provenance line says so.
- REQ-SHADOW-003: `risk-rules.live.yaml` re-derived for €10K, REVIEW-marked
  per line; operator ratifies before the paper reset ($11,700).
- REQ-SHADOW-004: The scorecard's ×4 drawdown scaling is removed: drawdown
  is judged directly as % of the frozen epoch NetLiq against
  2 × live `max_daily_loss_pct`; epoch NetLiq > $50K ⇒ "not live scale"
  warning in the verdict.

### Fix set (2026-08-21 review challenge, all verified against `faee97f`)

- REQ-TRAIL-001: Profit-trail target selection filters to OUR_REF-owned
  orders; foreign exit-side LMTs are never cancelled (warned once).
- REQ-TRAIL-002: Target release requires a surviving OUR_REF STP leg;
  absent ⇒ no release, loud warning, LMT kept.
- REQ-ORD-001: `ibkr_orders place` proves reduce-only (fresh position
  snapshot) BEFORE the daily-loss gate; confirmed reductions skip
  `assertDailyLossOk`. Non-reducing orders remain refused by reduce-only.
- REQ-ENTRY-001: Unfilled intraday-class entries are cancelled once
  `now > expires_at` (sweeper cadence), with notification; swing and
  earnings-bet entries keep only the 3-day sweep.
- REQ-ENTRY-002: The trigger-alerts pre-market guidance says DAY brackets
  rest until the open (matching `market-hours.ts` doctrine); GTC reserved
  for setups meant to outlive the day.
- REQ-EOD-001: A keep-override on an unpriceable position enters the
  overnight vet at avgCost notional (never 0), loudly warned.
- REQ-EOD-002: An earnings-lookup failure marks every DAY keep candidate
  earnings-unknown ⇒ close unless a keep-override exists; the report says
  the guard failed and which overrides were honored.
- REQ-EXPO-001: The accept-path notional for unfilled STP_LMT rows uses the
  worst basis `max(entry, entryLimit)` (larger notional), consistent with
  the worst-fill doctrine.
- REQ-VAL-001: Scorecard decile buckets clamp scores >100 into the top
  bucket and print how many were clamped (no silent escape).
- REQ-VAL-002: `EarningsBetEvidence` carries `nVerified`; the deterministic
  gate requires `nVerified ≥ earnings_bet_min_verified`. An empty verified
  calendar refuses by construction.
- REQ-VAL-003: Scorecard adds a day-block bootstrap (resample trading days
  with replacement, 1000 iterations, seedable): 95% lower confidence bound
  of mean net per trade must be > 0 — a verdict criterion.
- REQ-VAL-004: Scorecard prints the SHA-256 of `performance-epoch.json`;
  the journal records it at tag time.
- REQ-VAL-005: USER-MANUAL §19 becomes a pointer to VALIDATION-PROTOCOL.md;
  the handbook README indexes the protocol.

### Review 2026-08-23 response (append-only)

- REQ-ENTRY-003: The stale-entry sweep cancels ONLY the proposal's parent
  entry leg, identified on a fresh, COMPLETE broker book by its
  `<id>:entry` orderRef, under the global order lock, broker-confirmed
  (`confirmCancel`); a 'filled' / 'not-cancellable' outcome leaves the
  children (the position's protection) untouched and the tracker owns the
  position; an incomplete book cancels nothing; expiry and zombie
  candidates are deduplicated so a row is never raced against itself.
- REQ-TRAIL-003: Runner-mode release candidates are Dexter-owned LMTs whose
  ref names a TARGET leg (`:tp` / `:tp2`); a Dexter-owned `reduce-`/`close-`
  limit is never a candidate; the protection check requires a Dexter-owned
  STOP leg (`:stop` / `:stop2`).
- REQ-VAL-006: The gateway persists a marked NetLiq series (15-minute
  samples, `equity-series.jsonl`); the scorecard's drawdown criterion is
  the peak-to-trough of that series over the window, ≤ 2 × live
  `max_daily_loss_pct`, NOT EVALUABLE unless every trade-close day carries
  a sample. Closed-trade drawdown becomes informational.
- REQ-VAL-007: The frozen epoch NetLiq must sit inside ±10% of the
  $11,700 live target; outside the band the verdict fails (a generic
  upper bound accepted $49K or $4K samples).
- REQ-VAL-008: Every verdict criterion is computed over the DEPLOYABLE
  classes (intraday + swing); shadow-only earnings bets are reported in
  their own section and never carry the aggregate.
- REQ-VAL-009: The expectancy bootstrap clusters trades by ENTRY cohort
  (entry-filled day), falling back to close day only for rows without an
  entry stamp (reported).

## Invariants

- No change weakens the paper/live locks: `assertPaperOnly` and
  `assertOrderingAllowed` key on the ACCOUNT, never on the rule profile.
- No Dexter service cancels a broker order without an OUR_REF match.
- Risk-reducing paths are never blocked by risk-increase gates.
- Every new YAML key is fail-loud validated (WP0.1 pattern).
- All of this precedes `validation-freeze-1`; from the tag, behavior is
  frozen and only journaled accounting fixes are allowed.

## Non-goals

Overnight gap-stress sizing model, kill-switch guardian tick, official
macro calendar, backtester investment, options module — all remain on the
recorded live-gate backlog, none gate the paper validation.

## Risk tags

HIGH: proposals schema migration; creation-gate refusal logic; profit-trail
order cancellation; `ibkr_orders` gate ordering; sweeper cancellations.
Approved by the operator via the 2026-08-22 clarify session and the explicit
"go ahead" instruction.

## Acceptance criteria

- [x] `bun test` green and `tsc --noEmit` clean after every phase
      (748/0 at completion)
- [x] Intraday proposal with wrong target refused with exact prescription;
      corrected proposal passes (REQ-EXIT-001..003)
- [x] Low-ATR symbol refused as intraday-ineligible, no prescription
      (REQ-EXIT-004)
- [x] Missing ATR refuses intraday creation (REQ-EXIT-005)
- [x] Ratchet mode arms at x%, locks ≈x−1% (trail-enforced, recorded
      deviation), inert under 'target' (REQ-EXIT-008)
- [x] Foreign LMT survives runner activation; missing STP blocks release
      (REQ-TRAIL-001/002)
- [x] Non-reduce refused by checkReduceOnly; the daily-loss gate no longer
      guards the structurally reduce-only path (REQ-ORD-001 — the gate
      call is REMOVED, verified by review; a latched-halt integration
      test would need a FakeIb seam this tool lacks)
- [x] Expired unfilled intraday entry selected for cancellation with
      accept-grace honored (REQ-ENTRY-001; the broker cancel + tracker
      notification reuse the proven zombie-sweep path)
- [x] Unpriceable keep-override counted at cost basis; lookup failure
      closes unoverridden keeps (REQ-EOD-001/002)
- [x] Shadow profile: paper→live escalation only; earnings deviation
      applied and logged (REQ-SHADOW-001/002)
- [x] Scorecard: no ×4 scaling + live-scale guard, clamped deciles,
      bootstrap LCB criterion, epoch hash, take-vs-target line
      (REQ-SHADOW-004, REQ-VAL-001/003/004, REQ-EXIT-014 — smoke-run
      against the real DB, degrades honestly pre-migration)
- [x] Test traceability table appended below

Operator actions still open (the code cannot do these):
- [ ] Ratify the €10K `risk-rules.live.yaml` revision (REVIEW-marked)
- [ ] Reset the paper account to ≈$11,700; set `DEXTER_RISK_PROFILE=live`;
      send `performance reset`; restart the gateway (migrates the DB)
- [ ] Remaining freeze prerequisites, then tag `validation-freeze-1`

## Test traceability

| REQ | Test |
|---|---|
| REQ-EXIT-001..006 | `proposal-risk-gate.test.ts` — "take-at-x% policy" suite |
| REQ-EXIT-007 | `risk-rules-validation.test.ts` exit_style enum + cross-field; gate "ratchet mode leaves targets free" |
| REQ-EXIT-008 | `profit-trail.test.ts` — "ratchet mode geometry" |
| REQ-EXIT-009 | gate suite "swing and earnings-bet classes are exempt" |
| REQ-EXIT-010 | `trade-proposals.test.ts` EOD-keep conversion (target column untouched by `convertToOvernightHold` — structural) |
| REQ-EXIT-011 | `proposal-executor.test-continuation.test.ts` — take-policy suite |
| REQ-EXIT-012/013 | `excursion-sweeper.test.ts` — `legacyCounterfactual`, `endOfEtDayFrame` (sweep wiring rides the proven WP0.9 loop) |
| REQ-EXIT-014, REQ-SHADOW-004, REQ-VAL-001/004 | `scripts/validation-scorecard.ts` smoke-run (pinned evaluator; script, not unit-tested) |
| REQ-SHADOW-001/002 | `risk-rules-profile.test.ts` — shadow-live suite |
| REQ-SHADOW-003 | operator gate (REVIEW-marked yaml), no test by design |
| REQ-TRAIL-001/002 | `profit-trail.test.ts` — release-decision suites |
| REQ-ORD-001 | `orders.test.ts` (checkReduceOnly) + structural gate-call removal |
| REQ-ENTRY-001 | `trade-proposals.test.ts` — `listExpiredUnfilledEntries` |
| REQ-ENTRY-002 | prompt text change, no test (doc surface) |
| REQ-EOD-001/002 | `eod-triage.test.ts` — REQ-EOD suites |
| REQ-EXPO-001 | `proposal-executor.test.ts` — `worstEntryNotional` |
| REQ-VAL-002 | gate suite "record carried by gap-snap inference is refused" |
| REQ-VAL-003 | `src/utils/day-bootstrap.test.ts` |
| REQ-VAL-005 | doc change (USER-MANUAL §19, handbook README), no test |
| REQ-ENTRY-003 | `stale-entry-sweeper.test.ts` — `selectEntryLegToCancel` (parent-only, identity, incomplete-view refusal); cancel/lock/confirm wiring reuses proven primitives |
| REQ-TRAIL-003 | `profit-trail.test.ts` — "Dexter-owned LMT that is not a TARGET leg" |
| REQ-VAL-006 | `equity-series.test.ts` (`portfolioDrawdown`, parse); scorecard smoke-run (criterion + coverage) |
| REQ-VAL-007/008/009 | scorecard smoke-run (pinned evaluator) |

Open items recorded 2026-08-23 (operator decisions / backlog, not code
defects): broker-side GTD entry deadline (the safe sweeper stands in;
GTD needs a live-verified `goodTillDate` format); continuous kill-switch
guardian; EOD keep-by-default vs flat-by-close (a strategy decision the
operator ratified 2026-08-22 and may wish to revisit under the "profit as
surely as possible" lens); `take_atr_mult` sits at the reachability cap by
design — tune only from the sample's MFE evidence.
