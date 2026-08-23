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

### Review-14 response (2026-08-23 evening, append-only)

- REQ-TEST-001 (P0): test runs can NEVER bind the production DB — a
  runner preload (`test/test-env.ts`, wired in bunfig.toml and
  jest.config.js) unconditionally redirects `DEXTER_DATA_DIR` to a fresh
  temp dir; the store's guard refuses ANY non-temp path under
  `NODE_ENV=test` (`assertTestDataDirIsTemp`); the three `??=` suites now
  assign plainly. The 14 synthetic rows the reviewer's run inserted were
  backed up (`proposals.db.bak-20260823-contamination`) and deleted; a
  full suite run is proven to leave proposals.db untouched.
- REQ-VAL-010: sample provenance — `test`/`smoke`/`adopted` sources are
  excluded by the query; unknown sources and rows without WP1 permIds
  are integrity anomalies (evaluation freezes, never silently counts).
- REQ-VAL-011: class enablement is enforceable — `swing_enabled` rule key
  (gate-refused when false, like the earnings switch); the scorecard
  derives its deployable scope from the live yaml flags and FAILS the
  verdict for any enabled class below its own floor (≥30 trades, net>0).
- REQ-VAL-012: portfolio drawdown is epoch-SEEDED (a loss before the
  first sample cannot vanish) and coverage-proved per EXPOSURE interval
  (`exposureCoverageGaps`: first/last-sample and 60-min max-gap inside
  each exposed RTH window, weekend-aware, clipped to actual entry/exit);
  the sampler runs at 5 minutes. Recorded caveat: account NetLiq includes
  shadow-bet P&L (bounded by the 1-bet/1%-budget cap).
- REQ-ACK-001: `confirmCancelDetailed` preserves the broker's filled
  quantity; the entry sweep treats Cancelled+filled>0 as a LIVE partial
  position (exits standing, tracker resizes — WP2), never a clean sweep.
- REQ-GUARD-001: continuous kill-switch guardian — `getDailyLossStatus`
  every 60s (observation latches by construction); a LATCH transition
  alerts and cancels unfilled entry parents via the REQ-ENTRY-003 safe
  primitive, once per ET day; halted-but-unlatched (unverifiable P&L)
  never cancels. `KILL_SWITCH_GUARDIAN=false` disables.
- REQ-EOD-003: gap-stress vet — the conversion book is trimmed
  worst-first until `overnight_gap_stress_pct` (20) × surviving notional
  fits one daily-loss budget; operator overrides hold their excess
  loudly. Sector/index correlation shocks stay on the backlog.
- REQ-TRAIL-004: release is bracket-atomic — a target releases only when
  ITS OWN pair's stop (same base ref, same generation) survives, on a
  COMPLETE book view, and never with stacked pairs (the multi-OCA book
  `closePosition` refuses must not be built).

| REQ | Test |
|---|---|
| REQ-TEST-001 | `trade-proposals.test.ts` guard suite; full-run DB-mtime check (manual, recorded) |
| REQ-VAL-010/011/012 | scorecard smoke-run; `equity-series.test.ts` (`exposureCoverageGaps`); `risk-rules-validation.test.ts` (swing_enabled bool) |
| REQ-ACK-001 | `stale-entry-sweeper` partial branch (pure decision via CancelResult shape; FakeIb path pending) |
| REQ-GUARD-001 | `kill-switch-guardian.test.ts` (`decideGuardianStep`) |
| REQ-EOD-003 | `eod-triage.test.ts` — gap-stress suite |
| REQ-TRAIL-004 | `profit-trail.test.ts` — bracket-atomic suite |

### Review-15 response (2026-08-23 night, append-only)

Operator-directed policy (the conversion question, "profit as surely as
possible"):
- REQ-EOD-004: intraday is FLAT BY CLOSE — `decideEodAction` closes every
  DAY position at 15:52; the momentum-keep is deleted. The only overnight
  path is the explicit pre-bell `keep SYMBOL` (earnings guard, whole-book
  vet and gap-stress still apply); a planned overnight is a swing.
- REQ-PROP-001: ONE ACTIVE THESIS PER SYMBOL — any working row (entry
  working or filled, adopted included) refuses a new proposal on the
  symbol; amendments replace (`cancel` then re-propose). Replaces the 2%
  duplicate tolerance.
- Chase continuation defaults OFF (`CHASE_CONTINUATION=true` re-enables).
- First-tranche live risk halved in the REVIEW-marked yaml: 0.5%
  intraday / 0.75% swing / 0.5% bet budgets, 1.5% daily stop.

Review findings:
- REQ-GUARD-002 (P1): guardian cleanup repeats EVERY tick until the
  working-entry book is empty (alert stays once/day); startup tick;
  overlap guard; a fail-safe halted state persisting ≥5 min cleans up too
  (a transient hiccup never strips orders).
- REQ-EOD-005 (P1): the gap-stress vet covers the WHOLE surviving book —
  conversions AND deliberate GTC positions (market-marked, cost-basis
  fallback on a data hiccup, never fail-closed-closing a swing on missing
  bars); earnings bets counted at max(own worst gap, base stress), never
  trimmed. The same stress also gates GTC ACCEPTANCE.
- REQ-LOCK-001 (P1): snapshot→decision→mutation hold the global order
  lock in the trail release AND in closePosition (probe + OCA-join +
  placement inside one lock; refusals surface from the closure).
- REQ-VAL-013 (P1): every ENABLED class — bets included the day their
  flag flips — is scored in the main loop against n≥30, net>0, PF≥1.3
  and a positive entry-cohort LCB; shadow-only classes report PER CLASS
  against the same bar; the '~10-trade' texts are gone.
- REQ-VAL-014 (P1): cohort completeness — the verdict refuses while any
  in-cohort trade remains open (right-censoring).
- REQ-VAL-015 (P1): coverage spans the EXTENDED session (04:00–20:00 ET)
  with a 20-min max gap; the drawdown curve is epoch-seeded and adjusted
  by realized shadow-class P&L.
- REQ-VAL-016 (P1): `swing_enabled: false` in the live config — every
  class beyond intraday is fail-closed until its own shadow record
  passes; the shadow deviation force-enables BOTH classes on paper so the
  records accrue.
- REQ-TRAIL-005 (P2): release requires the ENTIRE Dexter exit book to be
  exactly one coherent pair — same ref base/generation, same OCA group,
  same account, stop quantity covering the position (unknowns fail
  closed); ANY foreign exit-side order blocks (round-10 close doctrine).

| REQ | Test |
|---|---|
| REQ-EOD-004 | `eod-triage.test.ts` — flat-by-close suite |
| REQ-PROP-001 | `trade-proposals.test.ts` — one-active-thesis test |
| REQ-GUARD-002 | `kill-switch-guardian.test.ts` — decideGuardianStep matrix |
| REQ-EOD-005 | `eod-triage.test.ts` gap-stress (trimExempt/stress-override paths); `proposal-risk-gate.test.ts` acceptance-stress |
| REQ-LOCK-001 | close-lifecycle suite green under the restructure (lock composition is structural) |
| REQ-VAL-013..016 | scorecard smoke-run; `equity-series.test.ts` extended-session coverage; `risk-rules-profile.test.ts` dual deviation |
| REQ-TRAIL-005 | `profit-trail.test.ts` — pair-identity suites |

### Review-16 response (2026-08-23 late, append-only)

Open-items ledger executed with the reviewer's corrections:
- REQ-GATE-001: intraday requires `tif: DAY` (gate rule, creation AND
  acceptance) — closes the GTD open item structurally: DAY parents die at
  the bell broker-side, gateway or no gateway. Legacy unfilled intraday
  GTC rows are swept at boot regardless of expiry (criterion 0), and the
  sweeper runs a boot pass 5s after start (post-reconciliation by gateway
  ordering).
- REQ-BRACKET-001: protective exits are ALWAYS GTC — a filled DAY
  position no longer loses its stop at the bell when the gateway is down
  at the close (children attached by parentId die with an unfilled
  parent, so GTC children add protection only after a fill). This closes
  the reviewer's "important limitation" rather than documenting it.
- REQ-VAL-017: the equity sampler marks open shadow-class positions
  (classes from the RAW live flags via `liveDisabledClasses`) and records
  `shadowUnrealized` + `shadowMarkComplete` per sample; the scorecard
  subtracts realized AND recorded-unrealized shadow P&L and fails closed
  on incomplete-mark samples. Recorded residuals: quote-`last` marks vs
  IBKR's NetLiq marks; open-trade commissions accrue at close. Manual
  trading in the validation account is PROHIBITED (protocol).
- REQ-VAL-018: coverage is calendar-aware (`SessionWindow` adapter over
  the market-hours holiday table: closed holidays owe nothing, half-days
  end 17:00 ET, days beyond the table refuse certification) with
  DST-safe noon-anchored day iteration.
- REQ-TEST-002: `cancelEntryLegCore` FakeIb path tests (clean cancel /
  partial-fill honesty / parent-gone).
- Omissions 1-7, all fixed: scorecard reads the daily-loss bar FROM the
  merged yaml (the 3.0 pin had doubled the bar); the shadow class bar
  includes the cohort LCB; symbol-level accept exclusion (claim +
  `listWorkingForSymbol` re-check, creation guard covers 'executing');
  the close neutralizes working entry parents and re-reads the position
  INSIDE the order lock (foreign entries refuse); the EOD stress book
  includes adopted/manual positions and failed closes (counted, never
  trimmed) and resting GTC entries (trims CANCEL the entry); acceptance
  stress is class-aware (`overnightStressedLossUsd`, bets at their own
  gap); the guardian enumerates BROKER entry parents
  (`selectEntryParents` over a complete snapshot, under the lock).
- Item 5 re-scoped pre-freeze per the reviewer: broker-only union
  symbols REFUSE accepts (was a warn) until the adoption sweep gives
  them rows; foreign working orders refuse accepts (complete snapshot
  required).
- Item 7 renamed: correlation aggregation CLOSED (the uniform whole-book
  shock is full correlation in loss space); the remaining research item
  is **stress-severity and factor calibration** (a high-beta or
  event-concentrated book may deserve MORE than 20%).
- Protocol: OCA-joined close observation is a REQUIRED pre-tag
  prerequisite (WP2/WP11 need observation or an explicit waiver); the
  freeze-manifest template exists (`docs/day2day/FREEZE-MANIFEST.md`);
  the research backlog is explicitly frozen mid-sample; the shadow swing
  record is EXPLORATORY (enabling swing needs a swing-specific sample
  after any macro-calendar addition).

| REQ | Test |
|---|---|
| REQ-GATE-001 | gate suite "intraday requires DAY"; `listUnfilledIntradayGtc` rides the sweeper suite |
| REQ-BRACKET-001 | bracket suites green under GTC exits (leg tif structural) |
| REQ-VAL-017 | `parseEquitySeries` field tests; scorecard smoke-run |
| REQ-VAL-018 | `equity-series.test.ts` calendar-aware suite |
| REQ-TEST-002 | `stale-entry-sweeper.test.ts` FakeIb suite |
| Omissions 1-7 | scorecard smoke-run; guardian `selectEntryParents` test; close-lifecycle suite green under the entry-neutralization restructure; gate acceptance-stress test |

Remaining open items: dedicated account/process for shadow classes
(operationally impractical for now; the realized+unrealized ledger is
the working answer, residuals recorded); stress-severity and factor
calibration (post-validation research); official macro calendar (gates
the swing-enable decision, not this sample); `take_atr_mult` tunes only
from the sample's MFE evidence.

## Review-17 response (2026-08-24) — two order races closed, broker-whole-book EOD, item 5 finished, machine-verifiable freeze

The reviewer's verdict "do not tag yet" was CORRECT on every blocking
finding; all are implemented.

- REQ-CLOSE-001: the close's entry-neutralization treats ONLY
  'cancelled' and 'filled' as settled — 'not-cancellable' refuses (per
  the confirmCancel contract the order may be inactive/held and still
  able to execute; no position reread can prove otherwise). After the
  cancels the COMPLETE entry-side book is re-enumerated: ANY remaining
  order (incl. a Dexter-owned entry-side order not ending `:entry`)
  refuses the close. Empty book or no close.
- REQ-EOD-003: the EOD earnings guard on unfilled entries routes through
  `cancelEntryLeg` (broker-verified parent only — the old
  cancel-every-stored-id loop could strip a newly live stop/target if
  the parent filled mid-loop). Losing the race means the position now
  EXISTS with a print ahead: the guard closes it (exactly what it does
  to a filled position of that class), reported loudly.
- REQ-EOD-004 (broker-whole-book, three gaps): (a) broker positions are
  enumerated BEFORE the no-work early return — an account holding only
  adopted/manual positions is vetted; (b) resting earnings-bet entries
  count in the stress book at their own gap severity, trimExempt (gap
  exposure-in-waiting; never trimmed — the guard loop reports them);
  (c) the whole-book candidate additions and the final holds footer use
  FRESH position snapshots taken after the mutation loops, not the
  boot-of-run snapshot.
- REQ-EXPO-002 (item 5 finished): acceptance exposure is UNCACHED
  (`fetchBrokerExposure({fresh:true})`) and MARKED — every sum
  (union, sector, same-symbol, overnight, stress) prices at
  max(basis, |qty|×last); a missing mark falls back to basis, never
  shrinks a sum. Orphan Dexter refs refuse: a `P-XXXX:*` order whose id
  is not the accepted proposal or a live exposure row — and any legacy
  `BRKT-` ref — is unreconciled exposure-in-waiting. An adopted position
  with NO working `protect-` stop broker-side refuses the accept: its
  synthetic ±5% stop prices headroom but bounds nothing.
- REQ-PROP-001: one-thesis-per-symbol is DB law — partial unique index
  `ux_one_working_thesis` on proposals(symbol) WHERE status IN
  ('executing','executed'); the claim UPDATE catches the constraint and
  loses gracefully, so simultaneous same-symbol accepts leave exactly
  one survivor (the app-level claim + rival-exclusion could race with
  both releasing). Index creation over a legacy DB with pre-existing
  duplicates fails LOUDLY and the code-level guards remain; tests
  simulate that DB via `__dropOneThesisIndexForTests`.
- REQ-VAL-019 (machine-verifiable freeze): every proposal row and equity
  sample carries a strategy fingerprint — 12-hex digest of the effective
  risk rules + SOUL.md + `.dexter/RULES.md`
  (`src/services/strategy-fingerprint.ts`). The scorecard REFUSES a
  window with mixed or absent fingerprints. The manifest identity model
  is de-self-referenced: behavioral baseline SHA (last runtime commit) +
  docs-only manifest commit the tag points at (empty non-docs diff
  verified) + the fingerprint. Code drift = git's job; model drift = the
  `model` column; config/judgment drift = the fingerprint.
- REQ-BRACKET-002: the three transmitted bracket TIFs are pinned in the
  harness (DAY parent → ['DAY','GTC','GTC']; GTC parent → all GTC).
  Broker-side mixed-TIF behavior is NOT documented by IBKR beyond
  "children held until the parent fills" — three paper observations
  (unfilled-expiry, filled-overnight, partial-at-expiry) are REQUIRED
  pre-tag prerequisites in the protocol and manifest.
- Jest/ESM: the FakeIb suite's CommonJS `require` calls replaced with
  top-level imports — Jest fallback 63/63 suites, 769 tests.

| REQ | Test |
|---|---|
| REQ-CLOSE-001 | close-lifecycle suite green under the stricter refusals (not-cancellable path exercised via confirmCancel contract tests) |
| REQ-EOD-003 | sweeper FakeIb suite covers cancelEntryLegCore honesty; triage compiles against it (behavioral paper observation pending) |
| REQ-EOD-004 | vetOvernightBook suite (trimExempt/stressPctOverride); smoke-run |
| REQ-EXPO-002 | executor gate suite green under marked/uncached exposure; orphan/adopted refusals exercised at accept |
| REQ-PROP-001 | outcome-tracker-partial + executor ambiguity tests via `__dropOneThesisIndexForTests` (legacy-DB simulation) |
| REQ-VAL-019 | scorecard smoke-run prints the fingerprint line and FAILS on ABSENT (verified against the pre-migration DB) |
| REQ-BRACKET-002 | `bracket-ack.test.ts` TIF-pinning tests |
