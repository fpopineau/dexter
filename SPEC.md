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

## Review-18 response (2026-08-24) — postconditions verified, marks fail closed, protection proven, fingerprint widened

- REQ-EOD-005: EOD actions have a VERIFIED postcondition. After every
  mutation loop the book is reconstructed from the fresh broker snapshot
  (positions at market-or-cost with classes re-attached; entries still
  resting after non-confirmed cancels) and `vetOvernightBook` re-runs
  REPORT-ONLY: residual trim demand emits a 🚨 UNRESOLVED OVERNIGHT
  EXCESS line + error log naming the symbols — a failed close or a
  cancel that lost to a fill can no longer ride the night silently.
  (No second blind close loop: re-firing could double an in-flight
  close; adopted/manual and bets stay counted-but-exempt so only failed
  actions on managed rows alarm.)
- REQ-EXPO-003: a missing market mark REFUSES the accept. Cost basis is
  a FLOOR under a live mark (max(basis, |qty|×mark)), never the answer
  for an unknown one — a $100-cost position at $150 was understated 33%
  through a quote outage. Unpriced exposure never passes.
- REQ-EXPO-004: adopted protection is VERIFIED, not pattern-matched.
  `verifyAdoptedProtection` (pure): exactly one same-symbol `protect-`
  order, verified account, exit side, STP-family type, quantity covering
  the whole position, priced stop — unknown fields fail closed
  (snapshot now carries action/orderType/auxPrice). On success the REAL
  broker stop prices the adopted row's planned risk in the headroom sum
  (zero for a profit-locked stop); the synthetic ±5% level never grants
  headroom again. An adopted row with no broker position behind it also
  refuses (stale reconciliation).
- REQ-VAL-019 widened: the fingerprint now covers every discovered
  skill's SKILL.md (built-in + project), the configured provider:model
  pair, and the RUNNING CODE COMMIT (git HEAD read from the checkout —
  bun executes the TS in place, so HEAD is the running code; packed and
  detached refs handled, non-repo = 'absent'). Manifest diff-check
  narrowed to exclude ONLY the manifest file (`:!docs/day2day/
  FREEZE-MANIFEST.md`) — excluding all Markdown could hide SOUL.md and
  skill edits between baseline and tag.
- REQ-VAL-020: the scorecard verifies `ux_one_working_thesis` exists via
  `PRAGMA index_list` — migration deliberately survives a legacy DB
  where creation failed, so the evaluator must check, not assume.
  `fingerprintPurity` extracted pure into equity-series-math.
- Traceability CORRECTIONS (review-18 F6 — the review-17 table
  overstated): the not-cancellable and re-probe close paths were NOT
  then exercised (now they are, below); "orphan/adopted refusals
  exercised at accept" was false (the pure decision cores are now
  tested; the accept-path WIRING still has no broker-fake test).

| REQ | Test |
|---|---|
| REQ-CLOSE-001 | position-actions-close.test.ts "entry-side neutralization": clean neutralization proceeds; 'Inactive'→not-cancellable refuses with no close placed; non-`:entry` Dexter order survives the loop and the re-probe refuses |
| REQ-EOD-005 | vetOvernightBook purity (re-vet is a second call on a rebuilt book); the rebuild glue in runEodTriageOnce is UNTESTED (integration; flagged honestly) |
| REQ-EXPO-003 | UNTESTED at the accept-path level (needs a broker fake); the max(basis, mark) floor rides unionExposure tests |
| REQ-EXPO-004 | proposal-executor.test.ts verifyAdoptedProtection suite (pass/zero-risk/short + 8 structural defects + STP LMT/other-symbol); classifyOrphanBracketRefs suite |
| REQ-PROP-001 | trade-proposals.test.ts "one-thesis DB law": same-symbol claims → exactly one survivor, loser stays open (index recreated first — legacy-simulation suites drop it) |
| REQ-VAL-019/020 | strategy-fingerprint.test.ts (12-hex, deterministic, git HEAD resolves, non-repo absent; fingerprintPurity mixed/absent/empty fail closed); scorecard smoke-run prints both new lines against the pre-migration DB |

Still untested (honest ledger): the EOD cancel-loses-to-fill close glue,
the broker-only/manual-only triage early-return glue, and the accept
path's missing-mark/orphan/adopted refusal WIRING — all are thin glue
over tested cores, and all sit behind the paper-observation phase.

## Review-19 response (2026-08-24) — the pair bug fixed, direction-aware risk, broker-truth postcondition, fail-closed identity

- REQ-EXPO-004 CORRECTED (my review-18 implementation had two real
  defects the reviewer caught): (a) it rejected the NORMAL
  protectPosition output — the `protect-SYM:stop` + `protect-SYM:tp` OCA
  pair counted as "2 protect- orders, incoherent", so every correctly
  protected adopted position blocked all new accepts; (b) it accepted an
  OVERSIZED stop (quantity > position), which REVERSES the position on
  trigger. Now: the `:stop` leg is selected specifically (exactly one),
  must be plain STP (an STP LMT's fill is not assured through a gap),
  quantity EQUAL to the position, account/side/price verified; a `:tp`
  leg, when present, must mirror the stop (account/side/size) and share
  its OCA group; unrecognized `protect-` refs refuse.
- REQ-EXPO-005: the planned-risk basis is DIRECTION-AWARE
  (`directionalBasis`): long → max(cost, mark), short → min(cost, mark).
  max() for both hid a profitable short's current-to-stop downside as
  zero risk (short from $100 marked $80 with a $90 stop = $10/share of
  real risk the old basis erased).
- REQ-EOD-005 CORRECTED: the postcondition re-vet is rebuilt from BROKER
  TRUTH, not the DB's unfilledGtc list — `buildRevetBook` (pure) takes
  fresh positions plus the actual working `P-XXXX:entry` parents from a
  COMPLETE open-order snapshot, so a partial fill counts BOTH ways (the
  position and the still-working remainder), at the order's full
  totalQuantity (conservative: the snapshot cannot see remaining).
  Broker TIF decides bell-death; the row only fills broker silence;
  fully unknown counts. Fresh marks are fetched for held symbols the run
  has not priced (adopted/manual books). An INCOMPLETE snapshot, an
  unpriceable symbol, or residual trim demand each emit the 🚨
  UNRESOLVED OVERNIGHT EXCESS alert — the postcondition can no longer
  pass on missing data.
- REQ-VAL-019 CORRECTED (fail-open → fail-closed): required identity
  surfaces — effective rules, code identity, provider:model — no longer
  hash as the string 'absent' into a valid-looking digest. Any of them
  unresolvable → `strategyFingerprint()` returns NULL → the row/sample
  is stamped NOTHING → the scorecard reads ABSENT and refuses the
  window. Code identity is now `git rev-parse HEAD` + a digest of
  `git status --porcelain` via the git BINARY (worktrees/submodules
  where `.git` is a file resolve correctly; a DIRTY checkout is a
  distinct suspect identity, `<sha>+dirty.<hash>`, not "clean").
  SOUL.md/RULES.md/skills stay optional-by-design: absence hashes as a
  sentinel so appearance/disappearance still moves the digest.
  `fingerprintPurity` is STRICT: only 12-hex values count; malformed
  stamps normalize to ABSENT. Residual gap (recorded): the fingerprint
  pins the CONFIGURED provider:model; a per-run model override is
  caught by the per-trade `model` column, not the sampler-side stamp.

| REQ | Test |
|---|---|
| REQ-EXPO-004 | executor suite: the standard :stop+:tp OCA pair PASSES; oversized stop, STP LMT, un-joined/wrong-size/wrong-account/wrong-side targets, stray protect- refs all refuse |
| REQ-EXPO-005 | directionalBasis suite incl. the reviewer's exact short case (riskUsd 100, was 0) |
| REQ-EOD-005 | buildRevetBook suite: partial-fill counts both ways; broker TIF beats row TIF; orphan entries count; bets at own severity; unpriced returned — the wiring glue remains integration-untested (honest ledger) |
| REQ-VAL-019 | fingerprintFromSurfaces (each required null → null; optional absence changes digest, never nulls it); codeIdentity (sha or sha+dirty in a checkout, null outside); readGitHeadSha follows a `.git` FILE; fingerprintPurity strict-format (malformed → ABSENT) |

## Review-20 response (2026-08-24) — proven-working protection, race-ordered snapshots, honest run lifecycle, content-true identity

Claim corrections first (the reviewer was right that review-19's SPEC
text overstated): "broker truth" had a positions-then-orders fill race
that could VANISH exposure, and "dirty identity" hashed file NAMES, not
content. Both now hold as written below.

- REQ-EXPO-006: protection must be a PROVEN WORKING order. The snapshot
  now captures `OrderState.status` (the openOrder event's fourth
  argument, previously ignored) and `ocaType`; verifyAdoptedProtection
  accepts only broker-acknowledged statuses (PreSubmitted/Submitted) on
  BOTH legs — an Inactive/held/cancelled stop with a perfect
  ref/type/price is not protection — and requires the pair to use
  BLOCKING OCA (ocaType 1 on both, what protectPosition places); any
  other mode can overfill in a race. A lone stop needs no OCA mode.
- REQ-EOD-006: postcondition snapshots are RACE-ORDERED — open orders
  FIRST, positions SECOND, so an entry filling between the two appears
  in BOTH (double-counted, conservative) instead of NEITHER (the old
  order let filled exposure vanish from the re-vet). Both fetches are
  caught: a failed positions snapshot degrades to the pre-action view
  AND alarms as unresolved excess.
- REQ-EOD-007: the triage run has an honest LIFECYCLE. The old
  stamp-'ran'-at-start meant a mid-run broker throw was only logged —
  no alert, and boot catch-up refused to retry behind the stamp. Now:
  in-memory single-flight (same-process double-fires), three-state
  stamp 'running' → 'completed' | 'failed', `stampCountsAsRan` treats
  only completed (+ legacy 'ran', + missed-alerted) as ran-today —
  a crash ('running') or failure retries before the bell — and a
  mid-run failure notifies 🚨 "the book was NOT fully vetted".
- REQ-VAL-021: code identity is CONTENT-TRUE. `+dirty.<digest>` now
  digests `git diff --binary HEAD` (tracked changes — further edits to
  an already-dirty file change the identity) plus the CONTENTS of
  runtime-relevant untracked files (src/, scripts/, root configs,
  SOUL.md — `classifyWorkingTree`, pure). Identity-irrelevant untracked
  noise (.claude/, docs) no longer dirties the checkout; unprovable
  content (unreadable file, untracked runtime directory) → null → the
  fingerprint fails closed. The scorecard REQUIRES a clean checkout:
  dirty or unresolvable code identity fails the evaluation — the tag
  must be able to reconstruct the sampled behavior.
- P2 recorded (provider/model): the fingerprint pins the EXPLICIT
  settings.json provider+modelId (implicit defaults → null → refused;
  protocol now instructs setting them before the freeze); per-run
  model overrides are caught by the per-trade `model` column. Using the
  run context for proposal stamps was considered and rejected: mixing
  identity SOURCES between rows and samples manufactures false mixed
  windows; the model column already proves per-trade purity.

| REQ | Test |
|---|---|
| REQ-EXPO-006 | executor suite: Inactive/PendingSubmit/null-status stops refuse; dead target refuses; non-blocking and unknown ocaType pairs refuse; lone stop passes without OCA |
| REQ-EOD-006 | ordering + failure-degrade is glue (integration-untested, honest ledger); the alarm paths ride the problems[] assembly |
| REQ-EOD-007 | stampCountsAsRan suite (running/failed retry; completed/ran/missed-alerted hold); the wrapper glue is integration-untested |
| REQ-VAL-021 | classifyWorkingTree suite (.claude noise clean; src/scripts/SOUL.md/package.json count; staged+rename tracked); codeIdentity format; scorecard smoke-run printed `+dirty` on this very uncommitted tree and FAILED — the check demonstrably bites |

## Review-21 response (2026-08-24) — intraday-entry cutoff, placement barrier, three-way freeze identity

- REQ-GATE-002: intraday entries CLOSE with the triage window. The accept
  path (auto-execution shares it) refuses DAY proposals from close − 8
  minutes (half-day aware, `intradayEntryCutoffReached`, latched from
  the CLOCK — never from whether triage ran or succeeded): an accept at
  15:54 could fill after the triage's final snapshot and be 🌙-converted
  at the bell into exactly the unvetted overnight hold flat-by-close
  forbids. GTC swing/bet proposals stay governed by their overnight
  gates. Complementary closure (flat-by-close, entry side): triage now
  CANCELS resting DAY entries (new `unfilledDay` lane) — an entry still
  unfilled at 15:52 can only produce a position in the final minutes; a
  cancel that loses to a fill closes the position on the spot (print-
  guard doctrine).
- REQ-EOD-008: the postcondition snapshots run UNDER THE GLOBAL ORDER
  LOCK (no Dexter placement can slip between them) and take a SECOND
  open-order snapshot after positions, unioned with the first
  (`unionOrderSnaps`, pure: union by orderId; complete only when both
  halves completed) — an order placed mid-sequence from OUTSIDE Dexter
  lands in one view or the other, never in neither.
- REQ-VAL-022: freeze identity is a THREE-WAY comparison
  (`fingerprintFreezeCheck`, pure). Internal window purity was not
  identity: a sample collected on a dirty tree and committed afterwards
  evaluated clean with a pure historical fingerprint. The sample's one
  surviving fingerprint must equal the EVALUATING runtime's
  `strategyFingerprint()`, and the manifest's recorded fingerprint once
  filled (parsed mechanically from FREEZE-MANIFEST.md; '_pending_' is
  reported, not failed — the tag does not exist yet).
- REQ-VAL-023: working-tree parsing is NUL-delimited
  (`--porcelain=v1 -z --untracked-files=all`): the newline form QUOTED
  paths with spaces into invisibility, and =all lists files inside
  untracked directories individually and overrides config that
  suppresses untracked output. Rename/copy origin tokens are consumed,
  never misread as paths.
- P2 integration additions: a REAL temporary-repository test proves the
  review-20 content property end-to-end (clean → dirty → edit-again
  changes the digest; a spaced filename is seen; irrelevant noise leaves
  identity untouched). Remaining glue (snapshot-failure alert wiring,
  crash-restart catch-up, OrderState propagation through a live
  fetchOpenOrderSnaps) stays on the honest untested ledger.

| REQ | Test |
|---|---|
| REQ-GATE-002 | `intradayEntryCutoffReached` suite (15:51 open / 15:52 latched / 15:59 the named hole / half-day 12:52); splitTriageCandidates unfilledDay lane test; the executor/triage wiring is test-gated (wall clock) |
| REQ-EOD-008 | `unionOrderSnaps` suite (either-view survival, half-blind incomplete); lock wiring integration-untested (honest ledger) |
| REQ-VAL-022 | `fingerprintFreezeCheck` via scorecard smoke-run: prints sample/current/manifest and FAILS the impure pre-migration window; pure-fn covered by the purity suites |
| REQ-VAL-023 | classifyWorkingTree NUL-delimited suite (spaces, renames, noise); real-repo codeIdentity test |

## Review-22 response (2026-08-24) — placement-atomic cutoff, no fail-open DAY parents, self-reference resolved, mandatory final manifest

- REQ-GATE-003: the intraday cutoff is ATOMIC with placement.
  `placeBracketOrder` re-checks the cutoff INSIDE the global order lock
  — the same lock the triage snapshots hold — immediately before the
  first placeOrder: an accept that passed the executor's early check at
  15:51 and spent minutes in its gates either places before the triage
  lock section (the snapshots see the order) or is refused by the
  in-lock recheck. Central, so every bracket caller is covered; the
  executor's early check survives as the friendly fast refusal.
- REQ-EOD-009: a DAY `:entry` still working in the FINAL postcondition
  snapshot no longer fails open. `buildRevetBook` RETURNS such orders as
  `dayEntryViolations` (they stay out of the overnight stress book —
  they die at the bell — but they can fill UNTIL the bell); the
  postcondition retries the cancel once through the safe primitive,
  closes a fill that won the race, and anything still unresolved raises
  the 🚨 unresolved-excess alarm — triage can no longer stamp
  'completed' over a working late-fill risk.
- REQ-VAL-024: the manifest self-reference is resolved BY CONSTRUCTION.
  Code identity is now `tree.<digest>` over the git TREE/BLOB hashes of
  the runtime paths (src/, scripts/, root configs, SOUL.md) at HEAD —
  not the commit SHA — with the dirty overlay scoped to the same paths
  (`git status/diff -- <runtime paths>`): a docs-only manifest commit
  leaves the fingerprint it records unchanged (proven by a real
  temp-repo test: baseline → docs-only commit → identity IDENTICAL →
  runtime commit → identity changes). Bonus: filling docs no longer
  dirties the runtime identity at all.
- REQ-VAL-025: the freeze manifest is MANDATORY for an authoritative
  verdict. `fingerprintFreezeCheck` gains `requireManifest`; the
  scorecard sets it when the `validation-freeze-1` tag exists OR
  `--final` is passed — a missing/unfilled/malformed manifest then
  FAILS instead of passing as pre-tag diagnostics (both modes verified
  in smoke runs).

| REQ | Test |
|---|---|
| REQ-GATE-003 | in-lock recheck is test-gated wall-clock glue; the decision fn `intradayEntryCutoffReached` carries the suite (honest ledger for the lock wiring) |
| REQ-EOD-009 | buildRevetBook violation suite (broker-DAY and row-DAY both returned, orphan-GTC still counted); the retry wiring is integration-untested (honest ledger) |
| REQ-VAL-024 | real-repo docs-only invariance test + tree.<12hex> format tests; this checkout's smoke-run printed tree.…+dirty on the uncommitted tree and clean after commit |
| REQ-VAL-025 | fingerprintFreezeCheck requireManifest suite (pre-tag null passes, final null FAILS, filled-match passes, mismatch fails); both scorecard modes smoke-verified |

## Review-23 response (2026-08-24) — tag-authoritative manifest, env in the identity, honest triage completion, lockfile identity

- REQ-VAL-026: the FINAL evaluation trusts only the TAGGED manifest.
  `--final` (or the tag existing) requires `refs/tags/validation-freeze-1`
  to exist, reads the manifest via `git show <tag>:docs/day2day/
  FREEZE-MANIFEST.md` (the working-tree copy is mutable after tagging —
  docs edits deliberately do not dirty runtime identity — and now serves
  only labelled pre-tag diagnostics), and verifies the manifest's
  declared behavioral baseline SHA is an ancestor of the tag. Missing
  tag on --final, unreadable tagged manifest, undeclared baseline and
  non-ancestor baseline each fail the verdict.
- REQ-VAL-027: behavior-affecting ENVIRONMENT is part of the strategy
  identity. `behaviorEnvInput()` (pure) snapshots ~55 policy variables
  (trigger thresholds, auto-execution selection, chase/EOD/guardian
  switches, universe overrides, data-feed type, expiry windows) as raw
  values with an 'unset' sentinel, plus capability PRESENCE flags for
  API keys and model endpoints — secret VALUES never enter the digest
  (tested). Raw-value hashing is deliberately over-sensitive (explicitly
  setting a default ends a window) and never under-sensitive; deriving
  defaults in the fingerprint would drift from the real ones. Editing
  .env mid-sample now ends the window.
- REQ-EOD-010: an unresolved flat-by-close violation can no longer
  stamp 'completed'. The postcondition retries on a bounded cadence
  toward the bell (up to 8 rounds × 45s, re-snapshotting first each
  round so a leg that vanished stops counting); anything still working
  after the last round alarms AND makes the wrapper stamp the run
  'failed' — a gateway restart before the bell retries (stampCountsAsRan
  already treats 'failed' as not-ran).
- REQ-VAL-028: `bun.lock` joins RUNTIME_PATHS and the untracked matcher
  — a lockfile-only dependency change moves the code identity (proven
  in the real-repo test).
- P2: a session-gate refusal at PLACEMENT (the in-lock cutoff recheck)
  now has gate-refusal semantics — claim released (proposal stays
  open), refusal ledgered — instead of marking the proposal 'failed';
  no order exists at that point (the gate throws before the id grant).

| REQ | Test |
|---|---|
| REQ-VAL-026 | scorecard smoke both modes: pre-tag prints [working tree (pre-tag diagnostics)]; --final without the tag FAILS with "requires the validation-freeze-1 tag" + manifest-REQUIRED; tag-read/ancestry glue exercised at tag time |
| REQ-VAL-027 | behaviorEnvInput suite (unset sentinel, presence-only for secrets, threshold/switch/universe changes move the digest, secret value never in the input); every-surface loop includes behaviorEnv |
| REQ-EOD-010 | test-gated to 1 round in suites; stampCountsAsRan already pins 'failed'→retry; the cadence loop is wall-clock glue (honest ledger) |
| REQ-VAL-028 | real-repo test: lockfile-only commit changes codeIdentity |

## Review-24 response (2026-08-24) — fills are not resolutions, bell-bounded retries, judgment config in the identity, full manifest audit

- REQ-EOD-011: an ABSENT parent is not a resolution.
  `classifyViolationResolution` (pure): a parent gone from a COMPLETE
  order view with a position behind it FILLED between snapshots — close
  it; resolution requires positive proof (confirmed cancel, confirmed
  close-to-flat, or paired observations: complete order view without
  the parent AND successful positions fetch without the symbol);
  anything unprovable stays pending. The old order-ID filter treated a
  vanished (possibly filled) parent as resolved and could stamp
  'completed' over a live position.
- REQ-EOD-012: the retry cadence is bounded by the ACTUAL bell — each
  round checks the real ET clock against close − 1 min (half-day aware)
  and caps its sleep to what remains, so a delayed run stops retrying
  while a close can still fill and the alarm goes out BEFORE the last
  actionable moment, not after. The 8-round cap survives as a backstop.
- REQ-VAL-029: mutable judgment configuration is in the fingerprint.
  `judgmentConfigInput()` (pure): canonical cron-job behavior fields
  (name, enabled, schedule, active hours, fulfillment, prompt message,
  model/provider, iteration budget — bookkeeping timestamps and random
  ids excluded, sorted for order-independence; a missing/corrupt store
  canonicalizes to zero jobs, exactly what the runtime loads) plus the
  web-search provider preference. CAPABILITY_ENV gains
  PERPLEXITY/TAVILY/LANGSEARCH keys (presence only) — the web-search
  registry exposes providers by their presence. Editing a cron job
  mid-sample now ends the window.
- REQ-VAL-030: the final evaluation audits the WHOLE tagged manifest.
  `auditFreezeManifest` (pure): every `_pending_`/`_REQUIRED`/
  `_observation or explicit waiver_` placeholder fails with its count;
  the recorded freeze-tag name must equal the tag; the recorded
  deployable scope must name exactly the enabled classes (both
  directions checked); fingerprint and baseline parsed for the git-side
  checks. The scorecard additionally verifies the baseline→tag diff
  touches ONLY the manifest file — ancestry proves order, the diff
  proves content.

| REQ | Test |
|---|---|
| REQ-EOD-011 | classifyViolationResolution table suite (filled-between-snapshots → close; paired-proof → resolved; anything unprovable → pending); the loop wiring is wall-clock glue (honest ledger) |
| REQ-EOD-012 | deadline math is wall-clock glue over the tested cutoff/catch-up constants (honest ledger) |
| REQ-VAL-029 | judgmentConfigInput determinism/shape; behaviorEnvInput presence flags for the three new keys with the secret value asserted absent |
| REQ-VAL-030 | auditFreezeManifest suite: filled manifest audits clean; template fails on every placeholder type, missing identity fields, wrong tag, both scope mismatch directions; the git diff/ancestry glue fires at tag time |

## Review-25 response (2026-08-24) — position outranks cancellation, schema-audited manifest, memory in the identity, fail-closed diff proof

- REQ-EOD-013 (corrects REQ-EOD-011's precedence): POSITION EVIDENCE
  OUTRANKS CANCELLATION. A working parent beside a non-zero position is
  a PARTIAL FILL — the old retry-cancel-first ordering let a clean (or
  order-not-found) cancel of the remainder discard the violation while
  the filled shares stayed open. classifyViolationResolution now routes
  any known non-zero position to close-position (closePosition
  neutralizes the working parent inside its own order lock and ends in
  a confirmed-flat check); retry-cancel survives only for a working
  parent with a proven-flat or unknown position, where a clean cancel
  (filledQty 0 on a complete book) IS positive proof of no fill.
- REQ-VAL-031 (corrects REQ-VAL-030): the manifest audit is a NAMED-
  FIELD SCHEMA, not substring counting. All 13 identity rows must exist
  (a deleted row is its own failure) with per-field validators (40-hex
  baseline, 12-hex fingerprint, 64-hex digests, target|ratchet, numeric
  epoch); all 6 broker-observation rows must exist and carry an
  ANCHORED status — `observed …` (never `not observed`, and a waiver
  reason mentioning 'observed' cannot masquerade) or `WAIVED …` only
  where the protocol allows (WP2/WP11; the partial-expiry row only with
  the WP2 row itself observed). The template documents the grammar; the
  parenthesized waiver placeholder variant is matched by prefix. The
  test fixture is a genuinely COMPLETE manifest (the review-25 finding:
  the old "filled" fixture omitted most rows and audited clean), and
  the real template is asserted to fail on all three placeholder types.
- REQ-VAL-032: MEMORY POLICY is in the identity. judgmentConfigInput
  carries the raw `memory` settings (context budget, temporal decay,
  MMR, indexing, embedding provider/model) as sorted-key canonical JSON
  ('unset' = runtime defaults); OPENAI_API_KEY and GOOGLE_API_KEY join
  the capability presence flags (automatic embedding-provider selection
  depends on them). Memory CONTENTS remain operational state, never
  fingerprinted.
- REQ-VAL-033 (P2): the baseline→tag proof FAILS CLOSED — unresolvable
  tag commit, baseline == tag (no manifest-only commit exists), a
  failed diff, and an EMPTY diff each fail; the changed set must be
  exactly [docs/day2day/FREEZE-MANIFEST.md].

| REQ | Test |
|---|---|
| REQ-EOD-013 | classifier suite: {working parent, qty 10} → close-position (the review-25 case); {working, flat}/{working, unknown} → retry-cancel; close-with-working-parent safety rides the closePosition entry-neutralization suite |
| REQ-VAL-031 | audit suite vs a COMPLETE fixture: clean pass; deleted row, 'not observed', non-waivable waiver, WP2-dependency, malformed fingerprint, wrong tag, both scope directions each fail; the real template fails all three placeholder types |
| REQ-VAL-032 | memory-policy suite (presence flags, secret value absent, memory section always present in the judgment surface); every-surface digest loop covers judgmentConfig |
| REQ-VAL-033 | fail-closed branches are git glue at tag time (honest ledger) — each failure string is distinct and named |

## Review-26 response (2026-08-24) — tag-anchored window, scorer weights in the identity, evidence-grade observations

- REQ-VAL-034: the FINAL sample window is anchored to the GIT TAG CLOCK,
  the one timestamp nothing post-tag can move. Once the tag exists:
  sinceMs = the tag's commit time (resolved BEFORE any query runs); a
  conflicting explicit `--since` is rejected; an epoch file stamped
  AFTER the tag fails ("post-tag reset excludes tagged-sample history");
  an unresolvable tag time poisons the window (sinceMs = MAX_SAFE_INT)
  and fails. The tagged manifest's epoch hash must EQUAL the live
  `performance-epoch.json` hash (a `performance reset` after losses can
  no longer move the window forward under the same tag), and the
  manifest's 'Tagged at (UTC)' must agree with the git tag time within
  24h. auditFreezeManifest now returns epochSha and taggedAtMs for
  these comparisons.
- REQ-VAL-035: SCORER WEIGHTS are a required identity surface. The
  fingerprint carries `getActiveWeightsInfo()` — the scorer's OWN
  resolution (in-process override > scorer-weights.json > defaults),
  with source, calibratedAt and reset provenance — as sorted-key
  canonical JSON. Editing scorer-weights.json and restarting is a
  different selection policy and now a different fingerprint;
  unresolvable weights fail the fingerprint closed. (The manifest's
  provenance ROW remains human context; the machine check is the
  fingerprint surface.)
- REQ-VAL-036 (P2): observation rows require EVIDENCE, not a status
  word. Observed rows must match `observed YYYY-MM-DD SYMBOL <details>`
  with broker order ids (#123) required on the OCA and all three
  mixed-TIF rows; waivers must match `WAIVED <initials>: <reason>`.
  Bare 'observed'/'WAIVED' fail with the grammar in the message.

| REQ | Test |
|---|---|
| REQ-VAL-034 | window/epoch-hash/tagged-at branches are git glue at tag time (honest ledger; each failure string distinct); auditFreezeManifest epochSha/taggedAtMs parsing rides the complete-fixture suite |
| REQ-VAL-035 | scorer suite: resolution sums to 1; an in-process override MOVES the digest (restored in finally); required-null → fingerprint null; every-surface loop covers scorerWeights |
| REQ-VAL-036 | audit suite: complete fixture (dates+symbols+ids) passes; the review-25 negative cases still fail; grammar teeth exercised via the fixture's own values |

## Review-27 response (2026-08-24) — the tagger clock, evidence-grade grammar v2

- REQ-VAL-037 (corrects REQ-VAL-034's clock): the final window anchors
  to the ANNOTATED tag's TAGGER timestamp, never the tagged commit's
  time. `git log -1 --format=%ct <tag>` returns the COMMIT clock — the
  manifest commit can precede the tag by hours and that interval's
  trades would leak into "since the tag"; a lightweight tag has no
  creation time at all. `resolveFreezeTagTime`: `git cat-file -t` must
  say `tag` (lightweight → rejected by name), the window comes from
  `for-each-ref %(taggerdate:unix)`, and the manifest's 'Tagged at
  (UTC)' must agree with the tagger clock within 10 MINUTES (was 24h —
  wide enough to re-open the same hole). The manifest instructs: tag
  immediately after committing the manifest, with `git tag -a`.
- REQ-VAL-038 (grammar v2): observation dates must be REAL calendar
  dates (2026-99-99 and 2026-02-30 fail via ISO round-trip), the symbol
  must be ticker-shaped (`^[A-Z][A-Z0-9.\-]{0,9}$`), the OCA and all
  three mixed-TIF rows need at least TWO broker order ids (every
  interaction there involves multiple orders — one lone id is
  under-specified), and waivers anchor on exactly `WAIVED` (uppercase;
  'waived'/'waives' read as invalid).

| REQ | Test |
|---|---|
| REQ-VAL-037 | REAL temp-repo test: commit at 10:00, annotated tag at 14:00 → resolver returns 14:00 (the tagger clock) and provably not 10:00; lightweight tag rejected with LIGHTWEIGHT named; missing tag unresolvable |
| REQ-VAL-038 | grammar suite: two impossible dates, lowercase symbol, single order id, 'waived'/'waives' each fail with the specific message; the full grammar passes |

## Review-28 response (2026-08-24) — pinned tag object, distinct-id evidence, protocol tagging procedure

- REQ-VAL-039: the freeze anchor is TAMPER-EVIDENT against a moved tag.
  The annotated OBJECT is immutable but the tag NAME is a movable ref —
  `git tag -af` over a fresh manifest commit would move the window while
  keeping every fingerprint and diff check green. resolveFreezeTagTime
  now returns the tag-OBJECT sha (via `for-each-ref %(objectname)` —
  `rev-parse <tag>^{tag}` loses its braces to Git-for-Windows' MSYS
  globbing, discovered by the test); the scorecard pins it OUTSIDE the
  repo (`.dexter/data/freeze-tag-pin.json`) on first sighting
  (trust-on-first-use, loudly instructing the remote push + journal
  record), and every later evaluation fails on a mismatch: "the tag was
  FORCE-MOVED; the freeze anchor is broken". The true immutable anchor
  is the REMOTE tag — the protocol now instructs pushing it; the pin
  makes a local retag detectable even before that. Recorded residual:
  the pin is TOFU — an adversary deleting the pin AND retagging before
  any evaluation defeats it locally; the remote copy is the answer.
- REQ-VAL-040: broker evidence counts DISTINCT order ids (`#101/#101`
  proved nothing), and the four bracket/OCA rows require THREE distinct
  ids — parent/close + target + stop, matching what bracket.ts places.
- Protocol 3b: the exact tagging procedure — commit manifest → annotated
  tag within 10 min → push to origin → record the tag-object sha →
  first scorecard run pins it. Never retag.

| REQ | Test |
|---|---|
| REQ-VAL-039 | real-repo test extended: force-retag (`-af`) yields a DIFFERENT tag-object sha — the exact signal the pin detects; the pin file glue is first-sighting scorecard logic (honest ledger) |
| REQ-VAL-040 | grammar suite: #101/#101/#101 (3 occurrences, 1 distinct) fails; 3-distinct fixtures pass |

## Review-29 response (2026-08-24) — tag last, fail-closed pin, mandatory remote anchor, numeric ids

- Protocol REORDERED (P1): the tagging procedure is now step 5, the
  LAST prerequisite — after the account reset, `performance reset`,
  configuration, observations and the completed manifest. The old
  ordering (tag at 3b, reset at 4) produced a post-tag epoch the
  scorecard itself rejects; the manifest's epoch SHA-256 row must hash
  the FINAL post-reset epoch file.
- REQ-VAL-041 (corrects REQ-VAL-039's fail-open): the TOFU pin FAILS
  CLOSED. Only a genuine ENOENT is a first sighting; a corrupt or
  unreadable pin refuses to re-pin ("restore it from the journal or
  remote") — delete-and-retag can no longer mint a fresh trusted
  anchor — and the pin is written with flag 'wx' (exclusive create,
  no overwrite). The REMOTE tag is now MANDATORY and machine-compared:
  `git ls-remote origin refs/tags/<tag>` must return the same tag
  object sha as the local ref; an unreachable remote, a missing remote
  tag, and a differing remote object each fail the final evaluation.
- REQ-VAL-042 (P2): order-id distinctness is NUMERIC — ids normalize
  via BigInt before the Set, so `#1/#01/#001` counts as ONE order
  (adversarial case the reviewer reproduced), while `#1/#02/#003`
  counts as three.
- Template synchronized (P2): the manifest grammar section now says
  THREE DISTINCT ids with a `#100/#101/#102` example and names the
  numeric-normalization rule — an operator following the template can
  no longer produce a failing manifest.

| REQ | Test |
|---|---|
| REQ-VAL-041 | pin/remote branches are final-evaluation git+fs glue (honest ledger; each failure string distinct and named); exclusive-create semantics are the 'wx' flag's contract |
| REQ-VAL-042 | grammar suite: #1/#01/#001 fails as one distinct id; #1/#02/#003 passes as three |

## Review-30 response (2026-08-24) — configure-then-boot, executable anchor branches, unambiguous journal

- Protocol 3/4 REORDERED (P1): shadow-live is CONFIGURED first (ratify
  yaml, reset account NetLiq, set DEXTER_RISK_PROFILE=live), and only
  THEN the clean gateway restart — environment changes do not reach a
  running gateway; the old order could have collected the "frozen"
  sample under the paper profile until the fingerprint mismatch
  surfaced. The restart step now requires CONFIRMING the active live
  profile (boot log / the scorecard's deployable-classes line) before
  `performance reset` creates the epoch.
- REQ-VAL-043 (P2): the freeze-anchor logic is EXTRACTED behind
  injected operations (`verifyFreezeAnchor(tag, localSha, deps)` with
  readPin/writePinExclusive/lsRemoteTag; `makeFreezeAnchorDeps` binds
  the real sync fs+git) and every fail-closed branch is executable:
  happy path, ENOENT-first-sighting + exclusive-write race, corrupt
  pin, wrong-shape pin, non-ENOENT IO error, moved tag (with a trap
  asserting laundering never re-pins), remote unreachable/missing/
  differing — plus an INTEGRATION test running the REAL deps against a
  temp repo with a BARE origin: pre-push the remote requirement bites,
  post-push the anchor is clean, and a force-retag makes both the pin
  AND the remote scream. The scorecard block is now pure wiring.
- Journal fixed (P3): "Tag SHA" → "Annotated tag OBJECT SHA" with the
  exact for-each-ref command and the note that this value restores a
  lost pin; the stale risk-pin numbers (1.0/3.0) corrected to the
  first-tranche 0.5/1.5.

| REQ | Test |
|---|---|
| REQ-VAL-043 | verifyFreezeAnchor fake-deps suites (all 10 branches) + bare-origin integration (pre-push bite, post-push clean, retag double-scream) |

## Review-31 response (2026-08-24) — the gateway attests its own profile

- REQ-VAL-044: the scorecard's deployable-classes line prints the YAML —
  it cannot know what the RUNNING process loaded (the review-31 hole:
  an operator sees the expected line while the gateway still trades
  paper rules; the fingerprint would catch it only after mis-collected
  sample days). The gateway now writes a RUNTIME ATTESTATION
  (`.dexter/data/runtime-attestation.json`) at boot, again ~90s later
  once the account verifies, and hourly as a liveness heartbeat:
  profile env as the process sees it, verified account + type, the
  EFFECTIVE daily-loss and per-trade bars it trades under, and its own
  strategy fingerprint. `auditRuntimeAttestation` (pure) fails a
  missing, stale (>2h — the heartbeat died), non-paper-account,
  non-live-env, wrong-rules or fingerprint-mismatched record; the
  scorecard prints CONFIRMED only when the running gateway itself
  proves shadow-live. Protocol step 4 now points at this line instead
  of the yaml-derived one.

| REQ | Test |
|---|---|
| REQ-VAL-044 | auditRuntimeAttestation suite (pass + all seven failure modes incl. the exact review-31 scenario: env unset, paper bars, yaml looks right); writeRuntimeAttestation smoke (well-formed record, honest 'unverified' account pre-IBKR); gateway start/stop wiring is boot glue (honest ledger) |

## Review-32 response (2026-08-24) — matched fingerprint context, unconditional attestation, real liveness

- REQ-VAL-045 (corrects REQ-VAL-044's comparison): the evaluator
  computes its expected fingerprint in the SAME resolution context as
  the gateway. The connection layer calls setAccountProfile('paper')
  when the paper account verifies and DEXTER_RISK_PROFILE=live
  escalates on top; a standalone evaluator never sees the account event,
  resolved the PAPER rules, and computed a fingerprint no correct
  gateway could match (the reviewer reproduced the divergence). The
  scorecard now mirrors verified-paper through the SHARED
  setAccountProfile before hashing — one resolution path, no duplicate.
- The attestation audit runs UNCONDITIONALLY (review-32 P2): it sat
  inside the fingerprint block and was skipped on a clean pre-sample
  run — the exact moment the protocol requires runtime confirmation.
  currentFp is hoisted; the audit is top-level.
- REQ-VAL-046 (liveness): a fresh FILE is not a running PROCESS. The
  scorecard probes the attested PID (signal 0; EPERM = alive), the
  audit fails a dead PID, an undeterminable PID (fail closed), and an
  ORDERLY-STOP record (stopRuntimeAttestation now clears BOTH timers —
  the 90s post-connect timeout used to survive shutdown and could
  refresh the record — and writes a stopped-marked attestation). The
  heartbeat tightens to 15 min with a 45-min staleness bar (3×), so a
  crashed gateway is caught within ~45 min instead of 2h.
- REQ-VAL-047 (fail-closed comparison): a null EVALUATOR fingerprint is
  its own failure — the old code disabled the comparison and let an
  arbitrary attested fingerprint reach CONFIRMED (reviewer-reproduced).

| REQ | Test |
|---|---|
| REQ-VAL-045 | context wiring is scorecard glue over the profile suite's tested setter (honest ledger); the divergence closes by construction — one shared resolution path |
| REQ-VAL-046/047 | audit suite: stopped record, dead PID, unknown-PID fail-closed, null-currentFp each named; pass path requires pidAlive; writer test unchanged (stopped absent by default); timer cleanup is the stop function's contract |

## Review-33 response (2026-08-24) — serialized shutdown, two-sided freshness, PID shape

- REQ-VAL-048 (corrects REQ-VAL-046's race): attestation writes are
  SERIALIZED through a promise chain, `stoppedFinal` latches BEFORE the
  stopped write is enqueued (an in-flight running write — async
  fingerprint hashing — no-ops at run time instead of burying the
  marker; one already past the check is simply overwritten by the
  chained stopped write), a running write enqueued after the stop
  returns null, and `stopRuntimeAttestation()` is AWAITED by the
  gateway shutdown — the caller returns only once `stopped: true` is
  on disk. The exact reproduced race (immediate missing record, then a
  late running record over the marker) is now a test.
- REQ-VAL-049: freshness is TWO-SIDED — a future-dated record (clock
  rollback or malformed timestamp) stayed "fresh" indefinitely under
  the one-sided age check. Non-finite timestamps fail as unusable;
  future skew beyond 2 minutes fails as FUTURE-dated; ≤1 min skew
  passes.
- REQ-VAL-050: PID shape precedes liveness — pid 0 targets the
  caller's own process group and `process.kill(0, 0)` succeeds on
  Windows, so a malformed record could satisfy the probe. The audit
  fails non-positive/non-safe-integer PIDs on shape; the scorecard
  probes only valid ones. Recorded residual: PID reuse inside the
  45-min window can alias a recycled process — the stopped marker and
  15-min heartbeat bound the ambiguity; a process-start-time identity
  would close it fully and stays on the backlog.
- Docs synchronized: the module header, protocol step 4 and scorecard
  comments all state the 15-min heartbeat / 45-min bar and enumerate
  the stopped/PID/future-dated checks.

| REQ | Test |
|---|---|
| REQ-VAL-048 | writer suite: in-flight write racing stop never buries the marker (awaited stop → stopped on disk), post-stop running write no-ops, restart re-arms |
| REQ-VAL-049 | audit suite: +24h fails FUTURE, +1min passes, NaN fails as unusable |
| REQ-VAL-050 | audit suite: pid 0 / 1.5 / −4 each fail on shape |

## Review-34 response (2026-08-24) — surfaced stop-write failure, stops-before-persistence

- REQ-VAL-051 (corrects REQ-VAL-048's blind spot): the stop-marker
  write's nullable result is CHECKED, not swallowed.
  `writeRuntimeAttestation` catches persistence errors into null, so
  the awaited-but-void stop returned "successfully" with NO marker on
  disk (reviewer-reproduced with an invalid data path) — the record
  kept claiming a running gateway. `stopRuntimeAttestation()` now
  returns whether the marker is CONFIRMED on disk, with the verdict
  latched so a second stop reports the first attempt's truth instead
  of vacuous success (never-started remains vacuously true — that
  process wrote no running record to retract). The gateway surfaces a
  false as an ERROR after the rest of shutdown has completed, naming
  the consequence (record reads as running until stale, ~45 min).
- REQ-VAL-052: every SYNCHRONOUS stop signal fires before the slow
  metadata write. The shutdown awaited the attestation stop —
  fingerprint hashing spawns git subprocesses and can take seconds —
  while order-capable timers (EOD triage places market orders,
  kill-switch guardian, excursion sweeper) stayed scheduled behind it.
  All sync stops now precede the await; the await stays ahead of
  `manager.stopAll()` so the stopped record can still resolve the
  verified account.
- Corrects review-33's "docs synchronized" overclaim: one scorecard
  comment still said "hourly; 2h" — now states the 15-min heartbeat /
  45-min bar and the full failure enumeration (P3).

| REQ | Test |
|---|---|
| REQ-VAL-051 | writer suite: invalid data dir → stop returns false twice (latch honest on double-stop), restart re-arms, healthy stop confirms true; clean-stop path asserts true in the race test |
| REQ-VAL-052 | ordering is gateway shutdown glue — integration-untested (honest ledger); the property (no order-capable timer scheduled during the await) holds by construction in the reordered sequence |

## Review-35 response (2026-08-24) — no timer survives its stop, one shared stop verdict

- REQ-VAL-053 (P1; corrects REQ-VAL-052's "holds by construction"
  overclaim — it was FALSE): EOD triage's 15s boot catch-up was an
  UNTRACKED setTimeout that survived stopEodTriage() and could fire
  runEodTriageOnce (market close orders) after gateway shutdown. The
  timer is now tracked and cleared, and a LIFECYCLE GENERATION guards
  the dispatched-callback window clearTimeout cannot recall: the
  callback captures the generation at scheduling, stop increments it,
  and checkMissedTriage re-checks before acting — the check is
  synchronous-atomic with entering the order-capable run (and also
  suppresses post-stop alerts/stamps). In-flight runs remain bounded
  by their own postconditions, as before.
- REQ-VAL-054 (class sweep): the same defect existed in FIVE more
  services — kill-switch guardian's 5s startup tick and the
  stale-entry sweeper's 5s boot sweep (both CANCEL broker orders),
  equity-series' boot sample (post-stop series writes), the excursion
  sweeper's 45s boot catch-up (market-data + DB writes), and the
  dashboard's EADDRINUSE retry (which could RESURRECT the server after
  stopDashboard). Each timer is now tracked, cleared by its stop, and
  self-guarded at callback entry (timer-identity check covers a
  callback already queued when stop ran). outcome-tracker and
  opportunity-engine were audited clean (tracked timers + lifecycle
  flags).
- REQ-VAL-055 (P2; corrects REQ-VAL-051's concurrency hole):
  concurrent stops share ONE verdict. The completed-boolean latch
  raced — caller A cleared the timer and awaited the failing write
  while caller B saw timer null with no verdict latched and returned
  vacuous true; Promise.all([stop, stop]) yielded [false, true] for
  one failed marker (reviewer-reproduced). stopRuntimeAttestation is
  now deliberately non-async: the shared stopPromise is assigned
  before any suspension point, every caller awaits the same promise,
  and only startRuntimeAttestation (a new lifecycle) resets it.

| REQ | Test |
|---|---|
| REQ-VAL-053 | eod-triage suite: stop bumps the generation, invalidating every dispatched catch-up (the invalidation property); timer clearing + gen wiring are stop glue (honest ledger) |
| REQ-VAL-054 | pattern-identical stop glue across five services — integration-untested (honest ledger); the guard shape (tracked timer + identity check at entry) is uniform and reviewed per site |
| REQ-VAL-055 | writer suite: Promise.all double-stop → [false, false] on a failed write and [true, true] on the healthy path |

## Review-36 response (2026-08-24) — sync-throw settlement, harness flake closed

- REQ-VAL-056: an IBKR request that throws SYNCHRONOUSLY settles its
  wrapper immediately and leaves nothing armed. fetchPositions and
  fetchOpenOrdersFor installed a 10s timeout plus listeners and then
  called api.reqPositions()/api.reqAllOpenOrders() unprotected — a
  synchronous throw (disconnect mid-shutdown; a test fake without the
  method) rejected through the executor with the timer and listeners
  still alive. Reviewer-isolated as the Jest worker force-exit root
  cause (three leaked 10s timers in outcome-tracker-partial). Now:
  the request call is try/caught; on sync failure the timeout is
  cleared, listeners detached, and the wrapper settles per its own
  contract — fetchPositions REJECTS with the cause, fetchOpenOrdersFor
  RESOLVES {orders, complete: false} (fail-closed partiality, never
  rejection).
- Review-35's comment overclaim corrected (P3): the generation check
  gates ENTERING the order-capable run; a run already past it is an
  in-flight run and may finish after stop, bounded by its own
  postconditions — the comment now says exactly that.
- Harness reliability closed with the leak: the four fingerprint-
  writing attestation tests carry 30s timeouts — the cold fingerprint
  (git subprocesses) crested Jest's 5s default only under full-parallel
  load (measured: 1.4–3.9s isolated, >5s contended). Timeout
  calibration only; no assertion changed. Five consecutive full
  parallel Jest runs: 837/837, zero failures, zero force-exit
  warnings.
- Recorded residuals: (a) other api.req* wrapper sites share the
  sync-throw wart but self-heal through their own timeout paths —
  sweep on backlog; (b) jest 29.7 / babel-jest 30.3 version alignment
  on backlog (reviewer-instrumented: not implicated in this warning).
  Deviation from the reviewer's item 5 (recorded): the partial-fill
  fake deliberately KEEPS throwing — that path is now the immediate-
  settlement contract under test, and teaching the fake happy-path
  emissions would change what the partial-fill scenarios exercise.

| REQ | Test |
|---|---|
| REQ-VAL-056 | position-actions-fetch suite: on a throwing api, fetchPositions rejects immediately with the cause and fetchOpenOrdersFor resolves incomplete immediately; zero residual listeners asserted on every event; five clean full-parallel Jest runs are the end-to-end evidence |

## Review-37 response (2026-08-24) — re-entrant cleanup closed

- REQ-VAL-057 (corrects REQ-VAL-056's cleanup): fetchPositions' cleanup
  is IDEMPOTENT and detaches listeners BEFORE calling
  api.cancelPositions(). The old order called cancel with listeners
  still attached — a cancellation that synchronously emits positionEnd
  re-entered cleanup (stack overflow) and resolved [] through onEnd
  even though reqPositions() had thrown (reviewer-reproduced: the
  rejection flipped into an empty resolve). Now: a `cleaned` latch, off
  first, cancel last inside try/catch — the re-emitted event finds no
  listeners, cancellation executes exactly once, and the settled
  outcome is the request's own.
- Wording corrected per reviewer: the remaining unswept api.req*
  wrapper sites are BOUNDED TEMPORARY LEAKS UNTIL TIMEOUT (not
  "not leaks") — each sync-throw arms its ~10s timer and listeners
  until the wrapper's own timeout path fires. The account.ts position/
  summary/PnL wrappers additionally share the cancel-with-listeners-
  attached shape fixed here; the backlog sweep must apply BOTH the
  sync-throw settlement and this idempotent detach-before-cancel
  cleanup.
- Recorded residual (reviewer, non-blocking): the fetch tests prove
  immediate settlement and listener cleanup but do not directly prove
  clearTimeout ran — fake/injected timers would pin that; deferred
  (cross-harness fake timers under bun AND Jest are not worth the
  machinery for a path whose end-to-end evidence is the clean parallel
  runs).

| REQ | Test |
|---|---|
| REQ-VAL-057 | position-actions-fetch suite: ReentrantCancelApi (reqPositions throws, cancelPositions synchronously emits positionEnd) — the wrapper still REJECTS, cancellation executes exactly once, zero residual listeners |

## Review-38 response (2026-08-24) — Jest worker cap (harness calibration, no runtime change)

- jest.config.js caps maxWorkers at 4 (reviewer-bisected): default
  one-worker-per-core parallelism oversubscribes the machine, and
  suites that shell out (git-based strategy fingerprints) or hammer
  sqlite crest the 5s default test timeout purely from contention —
  two proposal-creation suites failed at default parallelism and
  passed both isolated and at 4 workers, with the capped run FASTER
  than the failing default one. Capping addresses the cause
  systematically instead of scattering 30s timeouts over every test
  that indirectly computes a fingerprint. Verified 3× at the cap:
  838/0, ~14s, no force-exit — under a concurrent compute-heavy
  background workload on the host. No REQ: harness configuration
  only; the bun harness (primary) is untouched.

## Scan-coverage slice A (2026-08-25) — session-aware pre-market breadth

Operator-verified gap (independent screener, 2026-08-25 pre-market): 1 of
21 movers visible to the pre-open scan. Root cause: a session-blind
cumulative-volume floor. Slice B (PM feature enrichment: gap/from-open
separation, range position, PMRVOL, earnings-population join) is the
recorded first post-sample work package — NOT built now.

- REQ-SCAN-001: the scan volume floor is SESSION-AWARE — pre-open scans
  use a floor sized to pre-market volumes (default 100K), every regular
  phase keeps 500K. Env knobs OPP_SCAN_VOLUME_FLOOR /
  OPP_SCAN_VOLUME_FLOOR_PREMARKET are in the fingerprint's behaviorEnv
  list (editing them mid-sample ends the window); garbage or negative
  values fall back to defaults.
- REQ-SCAN-002: scanner rows default to 50 (IBKR's maximum) — 25 across
  four overlapping codes yielded ~25 distinct symbols per cycle.
- REQ-SCAN-003: the 16:20 archive job stores intraday bars WITH extended
  hours (useRTH: false) so PMRVOL history accrues from 2026-08-25.
  Daily-bar consumers (pattern scanner) untouched; bars are keyed
  (symbol, bar_size, time) so extended-hours rows coexist.

| REQ | Test |
|---|---|
| REQ-SCAN-001 | opportunity-engine suite: pre-open 100K vs all regular phases 500K; env overrides bind per session; garbage/negative fall back |
| REQ-SCAN-002 | wrapper default — config change, honest ledger (asserted by the subscription builder's default path, not separately tested) |
| REQ-SCAN-003 | scheduler glue over archiveBars' tested useRTH pass-through — integration-untested (honest ledger); first accrual verifiable in market-archive.db after today's 16:20 ET run |

## Incident 2026-08-25 — silent triage miss, post-bell watchdog (REQ-EOD-014)

The 15:52 ET main triage job silently never fired on 2026-08-25: the
process was provably alive (5-min equity samples bracket the slot at
19:48:06Z and 19:53:07Z), the 15:40 preview job fired, the half-day
calendar is correct for the date, the single-flight guard logs when it
skips and logged nothing — zero trace at the slot. P-6C90 (BZ, +1.94%
at preview) rode overnight against flat-by-close with only its GTC
bracket as protection. Root cause not reproducible from logs (croner
9.1.0 job death is the leading hypothesis); the defense assumes any
job can die silently.

- REQ-EOD-014: a post-bell WATCHDOG re-runs the boot catch-up decision
  at 16:10 ET (13:10 half days) — a completed stamp is a silent no-op;
  a missing/failed/still-running stamp raises the 🚨 TRIAGE MISSED
  alert the same evening instead of at the next reboot. 10 min past
  the bell so a legitimately long main run stamps first. All triage
  cron jobs now carry a croner catch handler that logs a thrown
  callback loudly (the silent-death mode this incident exposed).

| REQ | Test |
|---|---|
| REQ-EOD-014 | decision core is triageCatchUpAction (existing suite: post-close + not-ran → alert-missed; ran → none; missed-alerted stamps once/day via stampCountsAsRan); watchdog cron wiring + catch handler are start/stop glue (honest ledger) — first live proof is the 16:10 ET no-op line after a completed triage |

## Currency incident 2026-08-25 — the epoch denominator is USD (REQ-VAL-058)

Operator reported a phantom +$2,085 NetLiq jump. Diagnosis: no jump ever
existed — the equity series read ~$14,299 continuously while the epoch
froze 12,257 three minutes after a 14,298 sample. The account's BASE
currency is EUR: setPerformanceBaseline copied netliq-baseline.json,
which the daily-loss guard DELIBERATELY keeps base-currency for its
same-currency P&L proxy (WP8), so the epoch froze €12,257 labeled as
dollars. Every consumer assumes USD: the live-scale band check passed
on a unit coincidence (€12,257 sits inside the USD band) while the
account is really ~$14.3K — 22% above the shadow-live target — and the
drawdown curve was seeded with a mixed-unit denominator.

- REQ-VAL-058: the performance epoch freezes a USD-CONVERTED NetLiq
  supplied by the caller ('performance reset' fetches
  getNetLiquidation(), which FX-converts at the boundary). No USD value
  → the epoch is written WITHOUT a denominator (the scorecard reports
  that gap loudly); zero/negative refused. The reset reply now prints
  the frozen dollar figure so the operator sanity-checks it against
  the band at reset time, not at tag time.
- Operator actions recorded: re-size the paper account to the true
  live target (base currency EUR → €10,000), then 'performance reset'
  again — the current epoch (12257.11, EUR mislabeled) is invalid and
  the account is above target; both must be corrected before the tag.

| REQ | Test |
|---|---|
| REQ-VAL-058 | trade-proposals suite: caller-supplied USD stored; null → no denominator (loudly absent); zero refused; command wiring (fetch + reply) is router glue over getNetLiquidation's tested conversion (honest ledger) |

## False-halt operability 2026-08-26 (REQ-RISK-001..002)

The predicted false halt fired: the €10K paper resize landed between the
04:00 ET baseline capture (€12,461) and the first gate check — the
proxy read −15% and latched. Correct latch behavior on stale input, but
the operator had NO sanctioned way out: clearTradingHalt() existed with
zero callers, clearing without re-anchoring would re-trip on the next
check, and the latched dashboard echoed the trip record's BASE-currency
figures labeled as dollars (€10,589 shown as $10,589 beside a $12,347
epoch).

- REQ-RISK-001: `halt clear` (WhatsApp) is the deliberate operator
  override for a FALSE halt: clears the latch via clearTradingHalt()
  AND re-anchors today's baseline at current equity
  (reanchorNetLiqBaseline — base currency, WP8-consistent); a failed
  re-anchor is reported with the re-trip warning. Real-loss halts are
  the operator's judgment to leave standing.
- REQ-RISK-002: the halt record stores its currency; the latched
  status converts figures to USD for display using the stored tag —
  no broker round-trip in the latched branch (latch reads must never
  block on IBKR), records without a tag are USD, and an unavailable
  rate hides the figure rather than mislabeling it.

| REQ | Test |
|---|---|
| REQ-RISK-001 | command wiring is router glue over clearTradingHalt (logs 'manually cleared') + reanchorNetLiqBaseline — integration-untested (honest ledger); first live proof is the operator clearing today's false halt |
| REQ-RISK-002 | latch suite unchanged and green (records without currency stay broker-free and immediate — the timeout regression during development proved the branch stays offline); EUR conversion path is display glue (honest ledger) |

## Incident 2026-08-26 — the BZ naked short, flat-account exit sweep (REQ-RISK-003)

An IBKR paper-account reset wiped the LONG 134 BZ position but left its
GTC exits armed at the broker. Six hours later (the boot reconciliation
had timed out; nothing else watched) the target leg filled against the
flat account at the opening print and OPENED A NAKED SHORT — no human
and no gate decided that trade. Downstream machinery behaved correctly:
OCA cancelled the sibling, the tracker closed the row (economically
fictional +$183.58 — the real long's value was already banked into the
reset), reconciliation adopted the unexplained short, alerted, and
blocked accepts pending protection; the operator closed it manually
(realized cost ≈ −$208). The missing defense was upstream.

- REQ-RISK-003: a flat-account exit sweep runs every 5 min: COMPLETE
  broker order snapshot, then verified positions (orders-first race
  order — an entry fill between snapshots lands in positions and
  vetoes), select dexter exit orders (:tp/:stop, P-XXXX and protect-
  refs) on symbols with NO position and NO working dexter entry
  parent, and cancel them broker-confirmed — only after the SAME
  orphan (identical id set) is seen on two consecutive ticks.
  Fail-closed: incomplete snapshot or failed positions fetch skips the
  tick AND resets the latch. Foreign orders are never touched (a
  manually staged TWS bracket must survive). A leg that FILLED before
  cancel triggers a 🚨 check-positions-now alert. FLAT_EXIT_SWEEP=false
  disables; the flag is in the fingerprint's behaviorEnv list.
- Also: getDailyLossStatus's healthy branch exports dailyPnL and
  limitDollars USD-converted (they were raw base currency beside a
  converted netLiquidation — 'halt status' printed a € limit with $
  framing). Internal halt math stays base-consistent (WP8).

| REQ | Test |
|---|---|
| REQ-RISK-003 | flat-exit-sweeper suite: BZ scenario orphaned; BNS dormant-children-under-parent vetoed; held position either sign keeps exits (zero-qty row = flat); foreign/close- refs never selected; protect- refs sweep; per-symbol isolation; two-tick latch (arm → confirm, changed ids re-latch, key order-insensitive). Broker glue (lock, snapshots, confirmCancelDetailed) reuses guardian-tested primitives — wiring integration-untested (honest ledger) |

## Recorded residual 2026-08-26 — reaction movers are extension-muted in the entry window

Operator-observed (QFIN, one data point — deliberately NOT patched
pre-tag): a post-earnings reaction short first appeared 6 min after the
open at 10.14 with price at VWAP (the ideal bounce-entry zone,
9.90-10.00) scoring 61, but the extension gate's anti-chase boost
suppression (>3x ATR) muted the score below the trigger bar precisely
while the entry was best; the trigger fired 3 hours later at ~9.4x and
the (correctly rule-11-built) proposal could only rest 9.55 into the
bounce — ~0.40/share of geometry lost upstream of judgment. The
anti-chase policy and the bounce rule are compatible in principle (a
resting limit into the bounce is not chasing), but the scorer cannot
distinguish a fresh post-print reaction from a mid-day runner.

Decision (operator, 2026-08-26): record, do not patch before the tag —
a scoring change calibrated on n=1 days before the freeze is overfit
risk. The refusal ledger and the counterfactual replay accumulate the
policy's real cost during the sample; slice B's earnings-reaction
population features (recorded post-sample WP) are the structural home
for the fix (e.g. exempting fresh post-print reactions from extension
muting in the first hour, gated on the earnings-calendar join).

Addendum 2026-08-26 (same residual, second data point): SNAP — operator
confirms the reaction short was right but LATE; first surfaced in the
breadth movers at 09:36 ET, proposed 12:07 ET at 5.50 into the bounce;
the bounce never came and the entry expired unfilled. Same root cause
(extension-muted reaction movers), same disposition: quantify in the
refusal ledger, fix structurally in slice B.

## Recorded residual 2026-08-27 — FD data plan restored; snapshot rewire queued post-freeze

Verified live (2026-08-27, direct probes): the Financial Datasets plan
limitation behind the 403 circuit breaker (tripped live 2026-07-31) is
gone — insider-trades, income-statements, and price-snapshot endpoints
all return 200, with full typed Form 4 rows (transaction code/type,
shares, price, value, holdings before/after, officer title,
board-director flag) and midcap-band coverage (KTOS filing of
2026-08-26; CALX). The tools need no code change to benefit: the
breaker only trips on a live 4xx and re-probes hourly. The breaker
STAYS — the plan has flipped once already.

Queued change (deliberately NOT landed mid-sample): company-snapshot
Step 3 switches from the free-form Nasdaq web_fetch interpretation to
the typed get_insider_trades tool (1h cache), with the Nasdaq endpoint
retained as the documented fallback; Step 4's "fundamental snapshot
unavailable" branch becomes the exception path now that get_financials
works. Rewiring an agent-visible research input during the freeze /
burn-in window would muddy the observation sample — same pre-tag
discipline as the extension-muting residual above.

Scope notes: the FD endpoint is per-ticker only (tickerless date query
→ 400 "Ticker is required") and reports filing_date at day granularity
with no acceptance timestamp or 10b5-1 indicator — the restore does
not change any universe-wide insider discovery-lane design (the SEC
Form 4 feed remains the right backbone for that; FD serves per-symbol
research checks).

## Coverage note + incident 2026-08-27 — six operator winners, warning-399 rejections (REQ-RISK-004)

Operator-supplied winners (intraday, ~14:00 ET): PLTR +4.7, COIN +4.7,
NET +7.1, NVDA +8.7, FTNT +9.0, MSTR +12.0. Dexter's attitude, traced:

- NVDA: caught at DAWN (04:06 ET, score 71, RVOL 8 — the slice-A dawn
  scan working), triggered rank 81, proposal P-12AE created 04:08 —
  and KILLED by the warning-399 defect below. NVDL identically
  (P-1C92). Two more triggers intraday (LLM not-actionable at 10:43;
  take-level geometry refusals at 13:35, "tape faster than quotes").
- COIN/NET/FTNT: seen 16-17x, best scores 58-63 — below the 75 trigger
  bar all day. Third/fourth/fifth data points on the sub-threshold
  modest-mover class (slice B).
- PLTR/MSTR: never surfaced — extremes-list blindness (even +12% MSTR
  missed the saturated top-50 gainer lists on an NVDA-gap day). More
  slice-B large-cap-lane evidence.

- REQ-RISK-004: IBKR code 399 ("Order Message" — the generic order
  WARNING wrapper, e.g. "your order will not be placed at the exchange
  until 09:30" on every pre-market DAY placement) is NON-FATAL. The
  ack path read it as a rejection, so auto-exec marked every dawn
  proposal 'failed' at placement — structurally, every morning.
  Genuine refusals are unaffected: they arrive as their own codes
  (201, 110, …) or as Inactive/Cancelled statuses, which the ack
  watches independently of the error event.

| REQ | Test |
|---|---|
| REQ-RISK-004 | order-ack suite: 399 before PreSubmitted → acked, no rejection, permId kept; real code 201 still rejects; Inactive AFTER a 399 still rejects (the status path is untouched) |

## Registered debate 2026-08-27 — capitalization vs significance in candidate surfacing

Operator position (MSTR/PLTR case): very large caps should have a way
to surface among smaller caps even when the expected gain is smaller —
a +2.5% move in a $100B name can matter more than +15% in a $100M name.

Analysis registered for the next iteration (slice B):
- Percent-change extremes lists are implicitly cap-INVERSE: they
  surface the highest-volatility names, which the spread/extension
  gates then refuse — the funnel is biased toward candidates the
  policy cannot trade while the deep-book names it prefers stay
  invisible.
- Proposed core metric: ATR-NORMALIZED move (dayMove% / dailyATR%) —
  cap-blind, self-calibrating, and it ranks a 2.5-ATR megacap day
  above a 1.2-ATR smallcap lottery. Secondary key: dollar volume (or
  cap x RVOL), which captures both size and today's participation.
- Interplay with the reaction-mover residual: significance decides
  what SURFACES; entry geometry (rule 11 bounce logic) decides WHEN to
  act; the anti-chase extension mute belongs to entry timing, not to
  surfacing. The two residuals merge into this one principle.
- Tempering fact: the take-policy floor (intraday needs dailyATR >~2%)
  already excludes quiet megacaps at the gate — the beneficiary tier
  is big AND volatile (MSTR/NVDA/COIN/PLTR class).
- Cheap interim candidate: a dedicated large-cap scan lane
  (marketCapAbove $10B, lower move threshold) via the existing
  cap-band plumbing; the full fix is the significance-ranked composite.

Decision: registered only — no behavior change before the tag.

## Incident 2026-08-31 — close-window data-farm outage, bounded triage re-run (REQ-EOD-015)

IBKR's account-data/positions services went unresponsive ~15:50-15:57
ET — exactly the close window — while the ORDER channel stayed healthy
(SLB's exit cancels confirmed normally). Every consumer failed the same
way in the same minutes: the triage's positions fetch (10s timeout),
four profit-trail cycles, six reqPnL calls, the equity sampler (skipped
— never faked), the guardian's snapshots, SLB's post-close
verification (exit #26 unconfirmed, reconciliation retried), and the
MNSO close (aborted in-lock before placing — refused to act on an
unverifiable position). Every path failed CLOSED and LOUD: the run
stamped 'failed', the 🚨 book-not-vetted alert fired, the 16:10
watchdog independently flagged the stamp, and MNSO rode overnight
under its GTC bracket — an unplanned but protected hold. The exposed
gap: a mid-flight run failure only alarmed, while six usable minutes
remained for a second attempt.

- REQ-EOD-015: a mid-flight triage run failure earns ONE bounded
  re-run after a 45s backoff — only the first failure, and only while
  at least 2 minutes remain before today's close (half-day aware); a
  successful re-run stamps 'completed' and says so; a failed one (or
  no time) falls through to the existing failed-stamp + 🚨 alert path
  unchanged. The single-flight latch is held across the backoff, so
  cron double-fires still skip.

| REQ | Test |
|---|---|
| REQ-EOD-015 | eod-triage suite: shouldRetryTriageRun matrix — attempt 1 with ≥2 min retries (boundary exact), attempt 2 never, ≤1 min / past-bell never, half-day close honored; the loop wiring is run-lifecycle glue over the tested decision (honest ledger) |

Coverage addendum 2026-09-01 (operator-supplied losers: DELL -7.0, NET
-6.4, MSTR -6.1, COIN -6.0, FTNT -5.3): ALL FIVE SEEN — the Aug-27
blindness class is gone post-slice-A (MSTR seen 12x from 09:40 ET,
best 62; DELL 9x/58; FTNT 13x/56; COIN 7x/46; NET 4x/44) — but all
sub-threshold against the 65-75 trigger bar, short side this time.
The complex was partially monetized by design: crypto-breadth vehicle
IBIT short closed +$14.35 (rule 6), SOXL breadth-triggered 2x. The
slice-B question sharpens: the trigger bar filters out the entire
5-7% single-name mover class in BOTH directions; the vehicle policy
captures a sliver. Threshold calibration vs deliberate policy — to be
answered from the accumulated ledger, not patched pre-tag.

## Observed residual 2026-09-03 — account-summary subscription leak (error 322)

During flaky IBKR stretches the guard's NetLiq fetches leak account-
summary subscriptions server-side (the cancel does not always land),
until IBKR's cap returns error 322 ("maximum account summary requests
exceeded") and summary requests fail — self-inflicting the
"NetLiquidation unavailable" fail-safe until the nightly disconnect
clears the subscriptions. Self-healing daily, fail-closed throughout;
recorded for the chartered wrapper-hardening sweep (idempotent
cleanup + confirmed desubscription belong to the same family as the
sync-throw and detach-before-cancel fixes).

## Ops note 2026-09-03 — API-staged observation bracket

The operator has no TWS and a Client Portal web login bumps the IB
Gateway session (single-session credentials) — so the row-2 staging
bracket is placed through the already-authenticated Gateway on a
transient third client id: scripts/ops/stage-bell-expiry.ts, OPERATOR-
RUN only. Paper-account-only gate (refuses non-D accounts), 1 share,
DAY parent at an unfillable limit, GTC children, no dexter refs (the
sweeps see it as foreign), --cancel mode for the children-survive
contingency. The observation's evidentiary value is unchanged: it
witnesses BROKER behavior at the bell; the placement channel is
irrelevant.

## Fix 2026-09-03 — account-summary subscription leak (REQ-RISK-005)

Measured: the IB Gateway process grew 718 MB → 9,323 MB over three days
(~2.9 GB/day) and wedged TWICE — data services dead while the process
kept holding port 4002, surviving operator restarts because the old
process never exited. IBKR's own memory growth is part of it, but
dexter was feeding it: error 322 ("maximum number of account summary
requests exceeded; desubscribe to previous request first") proves
account-summary subscriptions were accumulating server-side. Two
independent implementations (the daily-loss guard polling NetLiq every
~60 s, and the account tool behind the dashboard overview / positions /
pnl) each allocated their own reqId, and under a slow Gateway each held
its subscription for the full 10 s timeout — so the pollers overlapped,
stacked, and exhausted the cap.

- REQ-RISK-005: one shared requester
  (src/tools/ibkr/account-summary.ts) owns the subscription lifecycle:
  SINGLE-FLIGHT per tag set (concurrent callers share one live
  subscription — the cap-exhaustion fix), EXACTLY-ONCE settle (cancel +
  listener detach run once, on whichever of end/error/timeout arrives
  first, detaching BEFORE cancelling so a synchronously-emitted end
  cannot re-enter), and a cancel that is always attempted — including
  when the request throws synchronously. Both call sites now only
  interpret rows; their observable contracts are unchanged (guard
  rejects on missing NetLiq; the tool reports partial on empty).

| REQ | Test |
|---|---|
| REQ-RISK-005 | account-summary suite: 3 concurrent callers → ONE request + ONE cancel; sequential calls open fresh subscriptions; timeout still cancels and detaches every listener; sync throw rejects with nothing armed; error settles once (handler detached, no double-settle); different tag sets do not share |

Coverage addendum 2026-09-03 (operator-supplied movers: MSTR +17.6,
COIN +10.1, PLTR +7.7 — the SAME crypto-complex names that fell 5-6%
on 09-01, reversing hard): MSTR seen 33x, best score 66 (long, at
+16%) — the closest any single name has come to the trigger bar in
this class; PLTR seen 4x, best 55; COIN never surfaced (third
consecutive miss for COIN specifically — its moves are large in
percent but its scan-list presence is thin). Vehicles tracked the
complex: IBIT 22x (best 63), BMNR 28x (best 60). Two-sided evidence
now: the same names, sub-threshold in BOTH directions across a 5-6%
fall and a 8-18% rally — the trigger bar, not the scanner, is what
excludes this class. Feeds the slice-B threshold-calibration question
and the registered capitalization-vs-significance debate (MSTR at
+17.6% with 2.7x RVOL scoring 66 is the sharpest single data point
yet).

## Fix 2026-09-04 — positions-subscription contention (REQ-RISK-006)

Sibling of REQ-RISK-005, found the morning after: with the
account-summary leak fixed, NetLiq reads recovered while `positions`
requests still timed out 27 times consecutively, keeping the
reconciliation sweep INCOMPLETE and the close gate shut. Cause: IBKR
supports ONE positions subscription per client — `reqPositions` opens a
stream ended by `cancelPositions`, not a request/response pair — so
overlapping callers (adoption sweep, profit trail, EOD triage, the
dashboard, the close path) tore down each other's streams, and the
loser timed out.

- REQ-RISK-006: fetchPositions is SINGLE-FLIGHT — concurrent callers
  share one live subscription; the shared slot clears on settle
  (success or failure), so a later call always opens a fresh snapshot
  and a failed fetch never poisons the next caller. The per-request
  hardening from review-36/37 (sync-throw settlement, idempotent
  detach-before-cancel cleanup) is unchanged underneath.

| REQ | Test |
|---|---|
| REQ-RISK-006 | position-actions-fetch suite: 3 concurrent callers → ONE reqPositions + ONE cancel with identical results; a later call opens a fresh subscription; a failed fetch clears the slot and the next caller succeeds |

## Fix 2026-09-04 (corrects REQ-RISK-006) — ONE positions subscriber (REQ-RISK-007)

REQ-RISK-006 single-flighted the services-side fetch but missed that a
SECOND implementation existed in the account tool: two subscribers on
one client, and `reqPositions` opens a per-client stream that
`cancelPositions` tears down for everyone. The evidence that forced the
correction: after a FRESH IB Gateway (844 MB) and a restarted dexter,
positions still timed out every 60 s — every adoption sweep failing,
reconciliation never completing, the close gate shut all morning —
while a probe on a separate client id fetched positions in 17 ms.
Gateway memory (the earlier hypothesis) was disproven; the contention
was ours.

- REQ-RISK-007: exactly one positions subscriber exists
  (src/tools/ibkr/positions.ts). Both call sites delegate to it;
  concurrent callers share one stream (correctness, not optimisation);
  the snapshot carries `complete` so callers that must not act on a
  partial book can tell a timeout from an empty account —
  fetchPositions still throws on an unconfirmed empty book, preserving
  "never mistake unverifiable for flat".

| REQ | Test |
|---|---|
| REQ-RISK-007 | positions suite: 3 concurrent callers → ONE stream + ONE cancel, ghost rows dropped; timeout reports complete:false and still cancels/detaches; sync throw rejects with nothing armed; slot clears on settle; broker error settles once. position-actions-fetch suite unchanged and green (the throw-on-unconfirmed-empty contract preserved) |

## Operator decision 2026-09-04 — sector cap 20% → 35% (shadow-live profile)

Raised on the operator's instruction after the constraint bound
repeatedly on a tech-led tape. At 15% × 4 slots the base 20% cap
allowed ~1.3 positions per sector; 35% allows ~2.3. Recorded as a
deliberate risk-appetite change, not a fix: correlated names make
"four trades" closer to one bet, so the remaining guards carry more
weight — the acceptance-time daily-loss HEADROOM gate (4 × 0.5% =
2.0% worst case vs the 1.5% stop) still binds first intraday, and the
20%-gap overnight stress still caps what may ride a night. Set in
risk-rules.live.yaml only; the base profile keeps 20%. Fingerprint
surface — it lands BEFORE the tag and is frozen with it. Revisit if
the sample shows correlated stop-outs clustering.

Residual observed the same morning (recorded, not patched): the
microstructure spread gate tests the LIVE quote at acceptance, but a
DAY limit accepted pre-market does not execute until the open, where
the governing spread is the regular-session one. Pre-market accepts
are therefore refused on a quote that will not price the fill (P-0EED
PL: 0.69% vs the 0.5% cap at 08:35 ET, expiring 09:20 ET — before the
open). This works against the IBKR-399 fix that deliberately enabled
pre-market placement. Slice-B item: use the session-appropriate spread
(or defer the check to the execution session) for orders queued into
the open.

Coverage addendum 2026-09-04 (operator: chipmakers bid — ARM +4.6,
SMCI +4.2, ASML +4.1, MU +4.1): NONE of the four single names was ever
seen; only the LEVERAGED VEHICLES were (SOXL 26x best 65 long, SOXS 32x
best 64 short, NVDA 20x best 66). This is a sharper version of the
extremes-list bias than the earlier addenda: on a +4% sector day the
scan lists are dominated by 3x ETFs whose moves are mechanically ~3x
the sector's, so the vehicles crowd out every underlying single name —
and the vehicle scores (65/64) sat at the trigger bar while the real
sector move went untraded. Compounding it, the previous session
breadth-triggered SOXL SHORT into what became a semis rally, i.e. the
vehicle lane traded the sector on the wrong side while the single names
were invisible.

Slice-B implication (joins the registered capitalization-vs-significance
debate): ATR-normalised significance would rank a +4% MU/ASML above a
+12% 3x ETF move that carries the same underlying information, and a
same-underlying dedupe (vehicle vs constituents) is needed so a lane
does not both crowd out and mistrade its own sector.
