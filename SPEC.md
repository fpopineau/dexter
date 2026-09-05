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
- REQ-EOD-016 (was REQ-EOD-003 in this Review-17 section; renumbered
  2026-09-05 — the number collided with the Review-16 gap-stress vet; see
  "Numbering errata 2026-09-05"): the EOD earnings guard on unfilled
  entries routes through
  `cancelEntryLeg` (broker-verified parent only — the old
  cancel-every-stored-id loop could strip a newly live stop/target if
  the parent filled mid-loop). Losing the race means the position now
  EXISTS with a print ahead: the guard closes it (exactly what it does
  to a filled position of that class), reported loudly.
- REQ-EOD-017 (was REQ-EOD-004 in this Review-17 section; renumbered
  2026-09-05 — collided with the Review-15 flat-by-close rule; see
  "Numbering errata 2026-09-05") (broker-whole-book, three gaps): (a)
  broker positions are
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
- REQ-PROP-001 (strengthened, review-17 — DB law; same requirement as
  the Review-15 definition, enforcement moved into the schema):
  one-thesis-per-symbol is DB law — partial unique index
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
| REQ-EOD-016 (was EOD-003) | sweeper FakeIb suite covers cancelEntryLegCore honesty; triage compiles against it (behavioral paper observation pending) |
| REQ-EOD-017 (was EOD-004) | vetOvernightBook suite (trimExempt/stressPctOverride); smoke-run |
| REQ-EXPO-002 | executor gate suite green under marked/uncached exposure; orphan/adopted refusals exercised at accept |
| REQ-PROP-001 | outcome-tracker-partial + executor ambiguity tests via `__dropOneThesisIndexForTests` (legacy-DB simulation) |
| REQ-VAL-019 | scorecard smoke-run prints the fingerprint line and FAILS on ABSENT (verified against the pre-migration DB) |
| REQ-BRACKET-002 | `bracket-ack.test.ts` TIF-pinning tests |

## Review-18 response (2026-08-24) — postconditions verified, marks fail closed, protection proven, fingerprint widened

- REQ-EOD-018 (was REQ-EOD-005 in this Review-18 section; renumbered
  2026-09-05 — collided with the Review-15 whole-book gap stress; see
  "Numbering errata 2026-09-05"): EOD actions have a VERIFIED
  postcondition. After every
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
- REQ-VAL-019 (amended, review-18 — widened): the fingerprint now covers every discovered
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
| REQ-EOD-018 (was EOD-005) | vetOvernightBook purity (re-vet is a second call on a rebuilt book); the rebuild glue in runEodTriageOnce is UNTESTED (integration; flagged honestly) |
| REQ-EXPO-003 | UNTESTED at the accept-path level (needs a broker fake); the max(basis, mark) floor rides unionExposure tests |
| REQ-EXPO-004 | proposal-executor.test.ts verifyAdoptedProtection suite (pass/zero-risk/short + 8 structural defects + STP LMT/other-symbol); classifyOrphanBracketRefs suite |
| REQ-PROP-001 | trade-proposals.test.ts "one-thesis DB law": same-symbol claims → exactly one survivor, loser stays open (index recreated first — legacy-simulation suites drop it) |
| REQ-VAL-019/020 | strategy-fingerprint.test.ts (12-hex, deterministic, git HEAD resolves, non-repo absent; fingerprintPurity mixed/absent/empty fail closed); scorecard smoke-run prints both new lines against the pre-migration DB |

Still untested (honest ledger): the EOD cancel-loses-to-fill close glue,
the broker-only/manual-only triage early-return glue, and the accept
path's missing-mark/orphan/adopted refusal WIRING — all are thin glue
over tested cores, and all sit behind the paper-observation phase.

## Review-19 response (2026-08-24) — the pair bug fixed, direction-aware risk, broker-truth postcondition, fail-closed identity

- REQ-EXPO-004 (amended, review-19 — CORRECTED; my review-18 implementation had two real
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
- REQ-EOD-018 (amended, review-19 — CORRECTED; was written as
  REQ-EOD-005 CORRECTED before the 2026-09-05 renumbering): the
  postcondition re-vet is rebuilt from BROKER
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
- REQ-VAL-019 (amended, review-19 — CORRECTED, fail-open → fail-closed): required identity
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
| REQ-EOD-018 (was EOD-005) | buildRevetBook suite: partial-fill counts both ways; broker TIF beats row TIF; orphan entries count; bets at own severity; unpriced returned — the wiring glue remains integration-untested (honest ledger) |
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

Full-day close (same session, operator's evening list — MU +6.1, AMD
+4.7, SMCI +4.5, INTC +4.5, ASML +4.2, ARM +3.9): the pattern held to
the bell. AMD/ASML/ARM never surfaced at all; MU appeared TWICE (best
45) on a +6.1% day; SMCI reached 65 and INTC 60 — while the vehicles
were seen 55x (SOXL) and 54x (SOXS). So on the day's cleanest sector
move, the two 3x ETFs accounted for ~109 sightings and the six
underlyings for 40, none triggering. The strongest single argument yet
for significance-ranking over percent-ranking.

## Live-loop program (2026-09-05) — WP1..WP4: the paper-rehearsed two-track loop replaces the frozen-sample gate

Ratified by the operator 2026-09-05 (discovery record:
`.claude/clarify-session.md`, section "Discovery: reaching an ONLINE system
shortly" — 48 answered questions in 12 rounds). This section SUPERSEDES the
go-live gate described earlier in this file and in
`docs/handbook/VALIDATION-PROTOCOL.md`: the `validation-freeze-1` tag,
manifest, TOFU pin and `--final` evaluation are retired (code kept dormant in
git; earlier REQ-VAL-* rows describing them stay as history — this file is
append-only). The invariant "auto-execution is never available for live
trading" (Invariants, top of this file; `proposal-executor.ts` header comment)
is superseded by REQ-LIVE-001..006 below.

### Problem

The frozen-sample gate never started and could not finish in useful time.
Measured 2026-09-05 (proposals.db, refusals, benchmark ledger): since the
2026-08-26 epoch the paper account resolved 6 trades in 8 sessions
(~0.75/day) against ~32 refusals/day; the tag prerequisites were still open
(manifest row 2), so the official sample was n = 0 and n = 100 projected to
6+ months AFTER tagging. The funnel, not the broker, is the bottleneck: four
coverage addenda (2026-08-27, 09-01, 09-03, 09-04, above) show the 4–18%
single-name mover class scoring 55–66 against the 75 trigger bar and never
reaching an LLM evaluation, while 3x sector ETFs crowd the percent-ranked
scan lists. The deterministic gates are NOT the lever: their replayed
counterfactuals since the epoch read noise-stop 37 would-stop vs 13
would-target, entry-pricing 12/12 — relaxing them raises n and sinks
expectancy.

The operator wants real-money execution with automation, daily statistics
and a refinement loop, with the machinery running on paper by 2026-09-30 and
the live switch flipped on evidence, not on a date. The design: widen the
funnel (behavior, opens paper epoch 1); simulate every proposal and a
registry of candidate variants against real bars (observability); decide
with a pre-registered sequential test in R-multiples plus a size ladder
(observability + a sizing overlay); report nightly; and make live
automation a config flip guarded by a switch only the operator can turn on.

### Sequencing constraint — behavior seams land in WP1

The strategy fingerprint stamps every row with the behavior-path tree
identity and the scorecard refuses a mixed window. WP2–WP4 must therefore
NOT touch behavior paths after WP1's restart, or paper epoch 1 ends on each
landing. Rule: **every hook a later WP needs inside a behavior path
(sizer rung overlay, epoch-stop latch check, live-switch/veto hooks in the
auto-executor, the command router's delegation to the control-plane module)
lands in WP1 as an inert, tested seam that reads a state file whose absence
means "today's behavior".** WP2–WP4 then add only observability/control-plane
code and state-file PRODUCERS. Acceptance is machine-checked: the scorecard's
printed fingerprint after WP4 lands equals the one printed at the WP1
restart (REQ-FP-001/002).

### Domain deltas

- Env defaults (code defaults change so `.env` stays unset; overrides still
  honored; all already in the fingerprint's BEHAVIOR_ENV list):
  `OPP_TRIGGER_SCORE` 75 → 60; `OPP_TRIGGER_MAX_PER_DAY` 10 → 30;
  `AUTO_EXECUTE_MAX_PER_DAY` 5 → 6 (aligned to `max_daily_trades`).
- New env (added to BEHAVIOR_ENV unless noted): `OPP_LARGECAP_LANE`
  (default true), `OPP_LARGECAP_MIN_USD` (default 10e9),
  `PREMARKET_SPREAD_HARD_MULT` (default 3), `LIVE_VETO_WINDOW_MIN`
  (default 0), `LLM_DAILY_SPEND_CAP_USD` (default 10),
  `LLM_PRICE_IN_USD_PER_MTOK` / `LLM_PRICE_OUT_USD_PER_MTOK` (no default —
  required when the cap is enabled), `SIM_COMMISSION_PER_SHARE_USD`
  (default 0.005) and `SIM_COMMISSION_MIN_USD` (default 1.00) —
  observability, NOT fingerprinted.
- `proposals` table gains `trigger_rank REAL`, `trigger_band TEXT`
  ('60-74' | '75+' | NULL), `auto_execute_at INTEGER` (veto-window due
  time; NULL = immediate/none). `refusals` gains `trigger_rank REAL`.
  Migration via the existing `OUTCOME_COLUMNS` / `REFUSAL_COLUMNS`
  add-column loop (`trade-proposals.ts`).
- New table `sim_trades` in proposals.db (observability): variant, source
  row (`proposal_id` or `refusal_id`), symbol, direction, entry_type,
  levels, rung-sized quantity, fill/exit timestamps and prices,
  `bar_source` ('stream-5s' | 'archive-1m' | 'ibkr-1m'), outcome
  ('target' | 'stop' | 'eod-flat' | 'open' | 'unfilled' | 'unknown'),
  `commissions`, `net_usd`, `net_r`, `bias_note`. Sim rows carry no
  order ids and are never read by `acceptProposal`.
- New config `src/config/vehicle-complexes.yaml`: named complexes
  (semis, crypto, broad, …) each listing leveraged/sector VEHICLES and
  CONSTITUENTS; fail-loud validated (WP0.1 pattern); fingerprinted.
- New pure module `src/utils/sequential-test.ts` holding the
  pre-registered constants (looks, confidences, ACCEPT/REJECT rules,
  drawdown stop) and the look evaluation; `scripts/validation-scorecard.ts`
  gains `--look` and calls it (the script stays the pinned evaluator).
- New state files under `DEXTER_DATA_DIR`: `ladder-state.json`
  ({rung, since, lastStepUpNetLiq, history[]}), `epoch-state.json`
  ({id, startedAt, fingerprint, status 'running'|'stopped', stopReason,
  stoppedAt}), `live-switch.json` ({enabled, changedAt, by, reason,
  challenge?}), `llm-spend.json` (per ET day: tokens in/out, USD, by lane).
- Fingerprint: `RUNTIME_PATHS` (whole `src`/`scripts`) is replaced by an
  explicit `BEHAVIOR_PATHS` allowlist (REQ-FP-001).
- Docs: VALIDATION-PROTOCOL.md gains a superseding section pointing here;
  FREEZE-MANIFEST.md gets a RETIRED banner; TRADING-POLICY.md §"How a trade
  starts" step 4 and §"Going live at all" are rewritten; USER-MANUAL
  documents the new commands; VALIDATION-JOURNAL.md carries one line per
  epoch start/stop, ladder step and promotion (control-plane appends).

### Requirements

#### WP1 — Funnel throughput + behavior seams (behavior; opens paper epoch 1)

Trigger bar and band tagging

- REQ-TRIG-001: `triggerScore()` defaults to 60 and `triggerMaxPerDay()` to
  30 (`opportunity-engine.ts`); the eligibility windows (top-3, reactor
  depth 10, deep margin, breadth relief, regime tilt, stale refusal) are
  unchanged and re-pinned by test at the new defaults.
- REQ-TRIG-002: the trigger lane's agent run carries the firing
  `compositeRank` in the lane context (`withAgentLane` gains an optional
  `triggerRank`; `currentTriggerRank()` accessor). `trade_proposals create`
  stamps `trigger_rank` and `trigger_band` from the context, never from the
  model; refusals recorded by that run stamp `trigger_rank` too. Non-trigger
  lanes stamp NULL.
- REQ-TRIG-003: `trigger_band` is '60-74' when 60 ≤ rank < 75 and '75+'
  when rank ≥ 75 (the pre-change bar), so the newly admitted class is
  measurable apart (paper-proof bar, REQ-SEQ-007) without a second column
  per future threshold.
- REQ-TRIG-004: the auto-executor's default daily cap is 6 and its log line
  names both caps; `max_daily_trades` (6) and `max_open_positions` (4) in
  `risk-rules.live.yaml` are unchanged.

Significance ranking (the registered capitalization-vs-significance debate)

- REQ-SCAN-004: the composite gains an ATR-NORMALISED significance term,
  `sig = |dayMovePct| / dailyATR%`, mapped through a capped, monotone
  function with constants in ONE config block (`opportunity-engine.ts`,
  fingerprinted), and the raw-percent `eventMoverBoost` is REMOVED from the
  composite (a +12% 3x-ETF day and a +4% chipmaker day carrying the same
  underlying information rank by their ATR multiples, not their percents).
  Secondary key inside a tie band: dollar volume (price × cumulative
  volume). `dayMovePct` is computed for every candidate (not only
  directionally-scanned ones) whenever `prevClose` is known.
- REQ-SCAN-005: the boost-suppression rule (implied extension >
  `max_extension_atr` ⇒ no boost) is kept for the significance term EXCEPT
  for reactor-watchlist symbols (fresh reporters, `reactorWatchlist()`)
  during the first 60 minutes of the regular session — the 2026-08-26
  residual (QFIN, trigger 3h late): a post-print reaction is its own
  catalyst in hour one. The creation gate's verified-earnings extension
  waiver (`recentEarnings === true`) is unchanged.
- REQ-SCAN-006: large-cap lane — when `OPP_LARGECAP_LANE` is on, every
  phase plan adds its gainer/loser scans a second time with
  `marketCapAbove = OPP_LARGECAP_MIN_USD` (source tag `LARGECAP:<code>`,
  same SCAN_FAMILY as the base code so it corroborates nothing by itself).
  Large-cap admissions get a reserved candidate slot like sentinels (never
  crowded out by `maxCandidates()`), bounded by the lane's own row count.
- REQ-SCAN-007: vehicle-vs-constituent dedupe — when a scan surfaces a
  VEHICLE of a configured complex, the complex's constituents present in the
  universe/watchlist are price-swept (prevClose) and admitted as candidates
  with source `COMPLEX:<vehicle>`; ranking then runs on significance, so an
  underlying at 2.5 ATRs outranks its 3x vehicle at the same information.
- REQ-SCAN-008: one direction per complex — at creation AND accept, a
  proposal on a vehicle or constituent is refused when a working row
  (`executing`/`executed`) exists on the SAME complex in the OPPOSITE
  direction, naming the rival (the 2026-09-04 SOXL-short-into-a-semis-rally
  case). Same-direction pairs are allowed and already bounded by the sector
  cap. Symbols outside every complex carry no constraint.

Pre-market spread (the 2026-09-04 residual)

- REQ-RISK-008: for an accept BEFORE the regular open of a DAY entry, the
  microstructure spread check becomes two-tier: spread > `max_spread_pct ×
  PREMARKET_SPREAD_HARD_MULT` refuses as today (liquidity red flag);
  otherwise the accept proceeds with a `spread-deferred` note, and a
  09:31 ET re-check (stale-entry sweeper cadence, live quote) CANCELS the
  still-unfilled entry leg through `cancelEntryLeg` (parent-only, complete
  book, broker-confirmed) when the regular-session spread exceeds
  `max_spread_pct`. A filled entry is kept (protected); the refusal ledger
  records the cancel as gate 'other' with reason `spread-deferred-cancel`.
  Regular-session accepts are unchanged. Recorded trade-off: a fill on the
  opening cross before 09:31 pays the true spread once — the operator
  accepted this over refusing every dawn accept.

Sizing seams and caps

- REQ-RISK-009: `classRiskPct()` for the intraday class returns
  `min(rules.max_risk_per_trade_pct, currentRung())`, where `currentRung()`
  reads `ladder-state.json` and returns 0.25 when the file is absent or
  malformed (fail-safe toward the SMALLER size; a warning names the cause).
  Swing/earnings-bet budgets are unaffected in WP1. The rung is NOT a
  fingerprint surface (REQ-FP-001 rationale: R statistics are rung-invariant
  by design; the ladder is expected to move inside an epoch).
- REQ-RISK-010: the accept path and the auto-executor refuse NEW ENTRIES
  while `epoch-state.json` reads `status: 'stopped'` (message names the stop
  reason and the `promote`/`epoch new` path); absent file = running.
  Exits, EOD triage, guardian cancels, the flat-exit sweeper and `close`/
  `kill` are never gated by it. Unlike the daily halt, the latch does not
  expire with the ET day.
- REQ-RISK-011: `risk-rules.live.yaml` REVIEW markers are replaced by
  "Ratified 2026-09-05 — CEILING policy; per-trade risk overlaid by the
  ladder rung (REQ-RISK-009)". `max_risk_per_trade_pct` stays 0.5 as the
  ceiling; no numeric change. One journal line records the ratification.

LLM spend cap

- REQ-LLM-001: the agent's accumulated `usage_metadata` (input/output
  tokens, `agent.ts`) is metered per ET day and per lane into
  `llm-spend.json`, priced with `LLM_PRICE_IN_USD_PER_MTOK` /
  `LLM_PRICE_OUT_USD_PER_MTOK`. When `LLM_DAILY_SPEND_CAP_USD` > 0 and the
  price knobs are missing, the gateway refuses to start (WP0.1 fail-loud).
- REQ-LLM-002: evaluation lanes (trigger, breadth, mover, `cron:*`) refuse
  to START an agent run once the day's USD ≥ cap (one WhatsApp line per day,
  refusal counted in the funnel digest); a run already in flight finishes.
  Deterministic services (exits, triage, guardian, sweepers, benchmark
  replay) do not call the LLM and are structurally outside the meter.

Live/veto seams (inert in WP1; producers land in WP4)

- REQ-LIVE-001 (seam): `assertPaperOnly()` is replaced by
  `assertAutoExecAllowed()`: on a paper account it keeps today's semantics
  (`AUTO_EXECUTE_PAPER=true`); on a live port or non-'D' account it requires
  ALL of `IBKR_ALLOW_LIVE=true`, `live-switch.json` `enabled: true`,
  verified managed accounts, the 'live' rule profile active, epoch running
  and the daily halt not latched — any missing condition refuses with the
  named reason. With no switch file the live branch refuses exactly as
  today (structural OFF).
- REQ-LIVE-002 (seam): `autoExecuteProposal` honors `LIVE_VETO_WINDOW_MIN`
  on every account type: window 0 executes immediately (today's behavior);
  window > 0 stamps `auto_execute_at = now + window`, leaves the row `open`,
  announces "executes at HH:MM ET unless `veto P-XXXX`", and a due-sweep
  (stale-entry sweeper cadence, ≤ 60 s late) executes it through the same
  gates; a due time past `expires_at` or past the intraday cutoff executes
  nothing (row expires normally).
- REQ-LIVE-003 (seam): commands `veto P-XXXX` (open row → reject; executed
  but unfilled → `cancelProposalBracket`; filled → refused with the
  `kill SYMBOL` hint), `kill SYMBOL` (= `closePosition`, all its refusals
  honored), `live on|off`, `ladder`, `epoch`, `promote` route from
  `proposal-commands.ts` and `dashboard.ts runAction` to a NEW control-plane
  module `src/gateway/loop-commands.ts` (outside BEHAVIOR_PATHS). In WP1 the
  module implements `veto` and `kill` fully and answers the others with
  "not available until WP3/WP4" — the router seam is what must land now.

#### WP2 — In-process simulator + shadow-variant registry (observability)

- REQ-SIM-001: every proposal row (executed or not) and every refusal with
  complete levels gets an INCUMBENT sim twin, settled nightly from bars, in
  `sim_trades`. Twins of executed rows are the simulator's calibration:
  the digest prints twin-vs-actual entry/exit slippage and outcome
  agreement (REQ-DIGEST-001 uses it).
- REQ-SIM-002 (fill model, pessimistic by construction): LMT fills only
  when a bar trades THROUGH the limit (long: `low < limit`, strict);
  STP_LMT follows `replayBracket`'s band logic; MKT fills at the NEXT bar's
  open; a stop fills at the worse of the stop price and the bar's open when
  the bar opens through it (gap-aware); a target needs `high > target`
  (strict); stop and target in one bar ⇒ stop; DAY/intraday sims that are
  still open at the triage mark (15:52 ET, half-day aware) close at that
  bar's close as 'eod-flat'; GTC-class sims carry overnight and settle on
  later nights. Commissions: `SIM_COMMISSION_PER_SHARE_USD` per side with
  `SIM_COMMISSION_MIN_USD` per order (IBKR fixed-tier assumption, recorded).
- REQ-SIM-003 (bars): `stream_bars` (5 s) when the symbol was streamed
  across the whole window; else 1-minute bars from `market-archive.db`,
  else `fetchBars` 1-minute (the benchmark's path, IBKR-paced); the
  `bar_source` is recorded. Missing or gapped bars over the window ⇒
  outcome 'unknown', never a fabricated fill. Regular-session bars only for
  DAY rows; GTC rows may fill in extended hours only where the real bracket
  could (recorded as an assumption pending broker observation).
- REQ-SIM-004 (registry v1, code-defined, versioned): `incumbent`;
  `funnel-75` (twins whose `trigger_band` is '75+' or whose lane is not
  trigger — what the old bar would have traded); `gate-off:<gate>` (the
  refusal replayed as proposed, one variant per deterministic gate:
  noise-stop, entry-pricing, chase, extension, risk-reward, microstructure);
  `exit-ratchet` (lock at x−1% on a pullback from peak, per REQ-EXIT-008
  geometry); `exit-x2.0` (target at 2.0 × dailyATR% within the take band);
  `stop-x/3` (stop tightened to x/3, size re-derived at the rung);
  `class-swing` and `class-earnings-bet` (the classes' proposals simulated
  regardless of the account's class flags); `weights-calibrated` (WP3
  supplies the weights; until then the variant reports "not calibrated").
  Adding a variant is an observability change (no fingerprint impact).
- REQ-SIM-005: sim quantity is re-derived at the CURRENT rung for every
  variant (so variants compare like with like), `net_r = net_usd /
  (|entry − stop| × quantity)` with the variant's own stop; `net_usd` is
  informational.
- REQ-SIM-006: the nightly pipeline order is archive (16:20 ET) → benchmark
  (16:45) → simulator settle → looks/ladder (WP3) → digest (WP3); the
  settle runs single-flight with a completed/failed stamp like triage, and
  a failed settle is reported, never silently skipped.
- REQ-SIM-007: no code path reads `sim_trades` to place, modify or cancel a
  broker order (structural: the table has no order-id columns and lives
  behind a read-only accessor for the digest and the scorecard).

#### WP3 — Sequential test, size ladder, epochs, digest, fingerprint narrowing

Pre-registered sequential test (`src/utils/sequential-test.ts`; the
constants are the protocol's machine-readable form and print in every look)

- REQ-SEQ-001: unit = R per trade, `net_r = (realized_pnl − commissions) /
  (|entry_fill − stop_at_entry| × quantity)` over the DEPLOYABLE lane
  (classes enabled in `risk-rules.live.yaml`, i.e. intraday) using the
  existing sample filter (closed, entry-filled, non-adopted, provenance
  allowlist, untrustworthy excluded); rows missing a planned-risk basis are
  integrity anomalies (freeze the look, never a silent drop).
- REQ-SEQ-002: looks fire when the epoch's closed-trade count first reaches
  n = 25, 50, 75, 100; the one-sided lower confidence bound of mean R comes
  from `dayBlockBootstrapLcb` clustered by ENTRY day (1000 replicates, seed
  42, minDays 5) at confidence 99% / 97.5% / 96% / 95% respectively
  (O'Brien-Fleming-style spending; the familywise false-ACCEPT rate stays
  near 5%). Between looks the digest prints running numbers labelled
  INFORMATIONAL — they never decide.
- REQ-SEQ-003: ACCEPT at a look = LCB > 0 AND net R > 0 AND profit factor
  ≥ 1.3; REJECT at a look = the 95% one-sided UPPER bound of mean R < 0;
  neither ⇒ CONTINUE. The first ACCEPT is the pre-registered cutover
  evidence (operator action REQ-LIVE-005); a REJECT stops the epoch
  (REQ-EPOCH-003).
- REQ-SEQ-004: hard stop — marked NetLiq (equity-series sampler, 5 min)
  ≤ 0.95 × epoch NetLiq at ANY sample stops the epoch immediately (the
  sampler evaluates it; a sampler outage is reported, never a pass).
- REQ-SEQ-005: `validation-scorecard.ts --look` prints the look table
  (n, net R, PF, LCB at the current confidence, UCB, drawdown from epoch,
  decision), the epoch fingerprint and the integrity gate, using the SAME
  module the nightly job calls; the legacy criteria (6 weeks, 2 regimes,
  n = 100 verdict, manifest, TOFU, `--final`) remain in the script but are
  labelled LEGACY and never decide.
- REQ-SEQ-006: shadow-vs-incumbent — for every variant with ≥ 30 sim trades
  over ≥ 10 trading days, the bootstrap (by day) of the DAILY difference in
  summed R (variant − incumbent) reports LCB/median; a variant whose LCB > 0
  is flagged "promotion candidate" in the digest. The flag is a
  recommendation (REQ-EPOCH-004).
- REQ-SEQ-007 (paper-proof bar for the widened funnel): the digest carries
  the '60-74' band's own line (n, net after commissions, PF, incidents); the
  bar the operator pre-registered is net ≥ 0 over its first ~20 closed
  trades, zero unresolved broker anomalies, flat by close every day — the
  first look cannot ACCEPT while this line reads negative at n ≥ 20.

Size ladder

- REQ-LADDER-001: rungs [0.25, 0.5, 0.75, 1.0] % per-trade risk; a step-UP
  becomes ELIGIBLE at epoch n ≥ 25 / 50 / 100 closed trades with net R > 0
  and no active stop; eligibility is QUEUED in the digest and applied only by
  the operator's `ladder up` (two-step confirm), which writes
  `ladder-state.json` with `lastStepUpNetLiq` = current marked NetLiq and a
  journal line.
- REQ-LADDER-002: a step-DOWN is AUTOMATIC: marked NetLiq ≤ 0.95 ×
  `lastStepUpNetLiq` moves one rung down, journals it and alerts; the
  sampler evaluates it with REQ-SEQ-004. Never below 0.25.
- REQ-LADDER-003: a new epoch resets the rung to 0.25 unless the epoch
  record carries `carryRung: true` (operator choice at `epoch new`); the
  live cutover ALWAYS restarts at 0.25 (REQ-LIVE-006).
- REQ-LADDER-004: `ladder` command/dashboard shows rung, since, eligibility,
  and the next milestone.

Epochs

- REQ-EPOCH-001: an epoch is created by `performance reset` (existing
  `setPerformanceBaseline`, USD NetLiq) PLUS `epoch-state.json` {id,
  startedAt, fingerprint (the gateway's own), status 'running'}; the
  control plane appends one VALIDATION-JOURNAL.md line
  (`epoch <id> START <iso> fp <12hex> netliq $<n> rung <r>`).
- REQ-EPOCH-002: epoch stop (REJECT look, −5% hard stop, or an unresolved
  broker anomaly: triage stamped 'failed' after its retries, the UNRESOLVED
  OVERNIGHT EXCESS alert, or a look-time integrity anomaly) writes `status:
  'stopped'` + reason, journals it, alerts on WhatsApp, and — when the
  account is live — turns the live switch OFF (REQ-LIVE-004). Intake pauses
  via REQ-RISK-010; protection, triage and the guardian keep running.
- REQ-EPOCH-003: identical semantics on paper and live (the rehearsal is
  faithful); a stopped paper epoch is not auto-restarted — Claude's
  diagnosis and candidate variant ride the next digest.
- REQ-EPOCH-004: `promote <variant>` (two-step confirm) RECORDS the operator
  decision (journal line + digest) and prints the exact config/code change
  the variant corresponds to, plus the restart + `performance reset` steps
  that start the next epoch; it changes no runtime behavior itself (a
  promotion IS a behavior change and therefore a new fingerprint/epoch).
  `epoch new` starts an epoch without a promotion (same journaling).

Daily digest (WhatsApp compact + dashboard page/JSON)

- REQ-DIGEST-001: fills and slippage — every entry/exit of the day with
  planned vs actual price, commissions, net USD and R, plus the sim twin's
  slippage line (REQ-SIM-001).
- REQ-DIGEST-002: funnel counts per lane — scanned, triggered, evaluated,
  proposed, gated (refusal split by gate), executed; spend-cap refusals;
  LLM USD for the day.
- REQ-DIGEST-003: shadow-vs-incumbent — per variant: day and cumulative
  summed R, n, days, difference LCB (REQ-SEQ-006) and the promotion-candidate
  flag; the '60-74' band line (REQ-SEQ-007).
- REQ-DIGEST-004: test status — epoch id/fingerprint, n, net R, PF, LCB/UCB
  at the current confidence, drawdown from epoch, next look, rung and
  eligibility, stop status, score-decile Spearman line.
- REQ-DIGEST-005: the WhatsApp digest is ≤ 12 lines per section with the
  full tables behind `/api/loop` and a dashboard "Loop" section; it is sent
  by the nightly pipeline's last step and re-sendable with `digest`.

Fingerprint narrowing

- REQ-FP-001: `codeIdentity()` hashes an explicit `BEHAVIOR_PATHS` list
  instead of `src`/`scripts`: the scanning/ranking modules
  (scanner-loop, opportunity-engine, breadth-detector, universe-*,
  pattern-*, market-regime, event-*, news-pulse, earnings-*), the gates and
  execution (proposal-risk-gate, proposal-executor, position-sizer,
  entry-context, trade-proposals, tools/ibkr/*, exposure-snapshot,
  broker-adopt), the exit/lifecycle services (outcome-tracker, eod-triage,
  profit-trail, stale-entry-sweeper, flat-exit-sweeper, kill-switch-guardian,
  daily-loss-guard, position-actions), the judgment surfaces (src/agent,
  src/skills, src/tools, src/model, src/providers.ts, SOUL.md,
  `.dexter/RULES.md`, cron jobs), `src/config/*.yaml`, `package.json`,
  `bun.lock`, `bunfig.toml`, `tsconfig.json`. EXCLUDED: `src/services/
  simulator/`, `benchmark.ts`, `excursion-sweeper.ts`, `equity-series.ts`,
  `dashboard*.ts`, `src/gateway/loop-commands.ts`, `src/utils/
  sequential-test.ts`, `scripts/`, tests. The list is pinned by a test that
  fails when a file under `src/services` is neither listed nor explicitly
  excluded (no silent third category). Untracked-file classification uses
  the same list.
- REQ-FP-002: a real temp-repo test proves an edit under an excluded path
  leaves the fingerprint unchanged and an edit to `proposal-risk-gate.ts`
  changes it; the scorecard still refuses mixed fingerprints inside an
  epoch and prints the epoch fingerprint.
- REQ-FP-003: VALIDATION-PROTOCOL.md gains "Superseded 2026-09-05" pointing
  here (the freeze prerequisites list is closed; broker observations
  already recorded stay as knowledge); FREEZE-MANIFEST.md gets a RETIRED
  banner; the runtime attestation additionally records `liveSwitch`,
  `vetoWindowMin`, `rung`, `epochId`.

#### WP4 — Live-automation plumbing, switched OFF (behavior seams from WP1; producers here)

- REQ-LIVE-004: `live on` returns a 6-character challenge; `live on <token>`
  within 2 minutes writes `live-switch.json` `enabled: true` (by, reason,
  changedAt) and journals; `live off` is immediate. The system itself may
  only write `enabled: false` (REQ-EPOCH-002 triggers); nothing in the
  system ever writes `true`. Dashboard buttons route through the same
  control-plane function.
- REQ-LIVE-005 (cutover evidence, operator procedure): the switch is meant
  to be turned on after the first paper ACCEPT look (REQ-SEQ-003); the
  control plane prints the latest look decision in the `live on` challenge
  message so the operator sees what they are acting on. The code does not
  block `live on` without an ACCEPT — the decision is the operator's
  (Boundary), the evidence is displayed.
- REQ-LIVE-006: on a non-paper account swing and earnings-bet proposals are
  never auto-executed or accept-able (the class flags stay false; the shadow
  forcing of REQ-SHADOW-001/002 applies to paper only — re-pinned by test);
  their rows are marked `sim-only` and settle in the simulator. The live
  cutover starts a new epoch at rung 0.25 (REQ-LADDER-003).
- REQ-LIVE-007: the veto due-sweep (REQ-LIVE-002 seam) executes due rows
  in creation order under the existing single-flight claim; a veto racing
  the sweep resolves by the claim (a claimed row cannot be vetoed —
  `cancel`/`kill` apply after).
- REQ-LIVE-008: fake-broker suites cover the live branch of
  `assertAutoExecAllowed` (every missing condition refuses, all present
  passes), the veto lifecycle (open→due→executed; open→vetoed; due past
  expiry/cutoff; claimed row veto refused), `live on` challenge expiry and
  mismatch, system-side OFF on epoch stop. No test binds a live port
  (REQ-TEST-001 isolation stands).
- REQ-LIVE-009: docs — TRADING-POLICY.md step 4 ("A human accepts the
  trade") and "Going live at all" rewritten for the switch + veto model;
  USER-MANUAL command table; `proposal-executor.ts` header comment
  rewritten (the "never available for live" doctrine is retired here).

### Invariants

- Risk-reducing and protective paths (exits, EOD triage, guardian cancels,
  flat-exit sweeper, `close`/`kill`, `protect`) are never gated by the
  spend cap, the epoch latch, the veto window, the ladder or the live
  switch.
- The paper/live ACCOUNT lock (`assertOrderingAllowed`, `IBKR_ALLOW_LIVE`)
  is untouched; the live switch is an additional condition, never a
  substitute.
- Nothing in the system writes `live-switch.json` `enabled: true`; only the
  operator's confirmed command does.
- Simulated rows never reach the broker (REQ-SIM-007, structural).
- The R metric and every look decision are rung-invariant; the rung is
  not a fingerprint surface, the behavior paths that read it are.
- Pre-registered constants (looks, confidences, rules, rungs, −5% stop)
  live in one module and print in every look. The module is outside
  BEHAVIOR_PATHS (it decides about the epoch, not which trades happen), so
  its constants are hashed SEPARATELY into `epoch-state.json` at epoch
  start; a look whose running constants differ from the epoch's refuses
  (NOT EVALUABLE) instead of deciding — the protocol's "editing the
  evaluator mid-sample ends the window" survives the narrowing.
- Every new YAML key and env knob is fail-loud validated (WP0.1 pattern).
- WP2–WP4 leave the fingerprint printed at the WP1 restart unchanged
  (REQ-FP-001/002 — acceptance-checked).

### Non-goals

Backtest-engine recalibration on FirstRate; new data sources (Polymarket,
FRED, options flow, social); options / fractional shares / a second broker
or a second IB Gateway; relaxing the deterministic gates; dashboard/digest
visual layout (PLAN); the cutover-day checklist (a separate runbook written
before `live on`); scorer-weight calibration beyond the `weights-calibrated`
shadow variant; automatic promotions.

### Risk tags

HIGH: `assertPaperOnly` replacement (live-automation safety boundary);
veto/kill/due-sweep order paths; sizer rung overlay; pre-market spread
deferral (order placement semantics); proposals/refusals schema migration
and the new `sim_trades` table; fingerprint narrowing (validation
integrity). MED: trigger defaults, significance ranking, large-cap lane,
complex dedupe (discovery behavior); epoch latch on the accept path.
LOW: simulator, digest, sequential-test module, docs. Approved in principle
by the 2026-09-05 discovery; each WP is reviewed at its boundary before
the gateway restarts on it (delivery decision R8-Q4).

### Acceptance criteria

WP1 (restart opens paper epoch 1)
- [ ] `bun test` green and `tsc --noEmit` clean; Jest suite green at 4
      workers
- [ ] Trigger defaults 60/30 pinned; eligibility windows unchanged
      (REQ-TRIG-001)
- [ ] Trigger-lane proposals and refusals carry `trigger_rank`/`trigger_band`
      from the lane context; other lanes NULL (REQ-TRIG-002/003)
- [ ] Composite uses the ATR-normalised term; raw-percent boost gone;
      reactor hour-one exemption pinned (REQ-SCAN-004/005)
- [ ] Large-cap lane adds `LARGECAP:` sources with reserved slots
      (REQ-SCAN-006); complex constituents admitted from a vehicle sighting
      (REQ-SCAN-007); opposite-direction same-complex refused at create and
      accept (REQ-SCAN-008)
- [ ] Pre-open DAY accept: hard-mult refusal, deferred note, 09:31 re-check
      cancels unfilled / keeps filled (REQ-RISK-008)
- [ ] Sizer overlay = min(yaml, rung), 0.25 default without the file
      (REQ-RISK-009); stopped epoch refuses entries, never exits
      (REQ-RISK-010); yaml ratified + journal line (REQ-RISK-011)
- [ ] Spend meter persists per day/lane; cap refuses evaluation-lane starts
      only; missing prices fail loud (REQ-LLM-001/002)
- [ ] `assertAutoExecAllowed` paper branch identical to today; live branch
      refuses with no switch file (REQ-LIVE-001); window 0 immediate,
      window > 0 due-stamped (REQ-LIVE-002); `veto`/`kill` routed and
      working, other loop commands answer "not yet" (REQ-LIVE-003)
- [ ] Scorecard printed fingerprint recorded in the journal at the restart

WP2
- [ ] Incumbent twins for every proposal/refusal with levels; twin-vs-actual
      slippage line (REQ-SIM-001)
- [ ] Fill model pinned by unit tests: strict trade-through, gap-aware
      stops, stop-first ties, eod-flat at the triage mark, commissions
      (REQ-SIM-002)
- [ ] Bar-source fallback order and 'unknown' on gaps (REQ-SIM-003)
- [ ] Registry v1 variants produce rows; rung-sized quantities; `net_r`
      (REQ-SIM-004/005)
- [ ] Nightly settle single-flight with completed/failed stamp
      (REQ-SIM-006); no broker path reads `sim_trades` (REQ-SIM-007,
      structural review)
- [ ] Fingerprint unchanged vs the WP1 restart

WP3
- [ ] `sequential-test.ts` unit-tested: look boundaries, confidences,
      ACCEPT/REJECT/CONTINUE, UCB rule, drawdown stop (REQ-SEQ-001..004)
- [ ] `--look` prints the table and matches the nightly job byte-for-byte on
      a fixture DB (REQ-SEQ-005); variant difference LCB and the '60-74'
      line (REQ-SEQ-006/007)
- [ ] Ladder: eligibility queued, `ladder up` two-step applies, automatic
      step-down on −5% from last step-up, reset per epoch
      (REQ-LADDER-001..004)
- [ ] Epoch start/stop files + journal lines; stop pauses intake and turns
      live off when live; `promote` records and prints the change
      (REQ-EPOCH-001..004)
- [ ] Digest sections 1–4 rendered on WhatsApp (compact) and `/api/loop`
      (REQ-DIGEST-001..005)
- [ ] BEHAVIOR_PATHS pinned; temp-repo test proves excluded/included edits;
      protocol/manifest docs superseded; attestation fields
      (REQ-FP-001..003)
- [ ] Fingerprint unchanged vs the WP1 restart

WP4 (switched OFF)
- [ ] `live on` challenge/confirm/expiry; system-only OFF; dashboard parity
      (REQ-LIVE-004); look decision shown in the challenge (REQ-LIVE-005)
- [ ] Non-paper account: swing/bet never executed, sim-only; cutover epoch
      at rung 0.25 (REQ-LIVE-006)
- [ ] Veto lifecycle and claim race pinned with the fake broker
      (REQ-LIVE-007/008)
- [ ] Docs rewritten (REQ-LIVE-009)
- [ ] Fingerprint unchanged vs the WP1 restart; `live-switch.json` absent

Operator actions (the code cannot do these)
- [ ] Review WP1 at its boundary; restart the gateway; send
      `performance reset`; write the epoch-1 journal line with the printed
      fingerprint (WP3 automates this from epoch 2)
- [ ] Activate CallMeBot for the watchdog (pending since 2026-09-02)
- [ ] Before `live on`: write and walk the cutover-day runbook (live IB
      Gateway on 4001, account verification, `IBKR_ALLOW_LIVE`, rollback)

### Planned harness (TDD gate — becomes the test-traceability table as tests land)

| REQ | Planned test |
|---|---|
| REQ-TRIG-001 | `opportunity-engine.test.ts` — defaults 60/30, `triggerEligibility` matrix re-pinned |
| REQ-TRIG-002/003 | `lane-context.test.ts` (triggerRank), `tools/proposals/index.test.ts` (stamps from context, NULL off-lane), `trade-proposals.test.ts` (migration columns) |
| REQ-TRIG-004 | `proposal-executor.test.ts` — cap default 6 |
| REQ-SCAN-004/005 | `opportunity-engine.test.ts` — significance term monotone/capped, boost removed, reactor hour-one exemption; snapshot replay fixture from retained `opportunities.db` days where available |
| REQ-SCAN-006 | `opportunity-engine.test.ts` — large-cap scans requested with `marketCapAbove`, reserved slots |
| REQ-SCAN-007/008 | `vehicle-complexes.test.ts` (yaml validation, lookup), `proposal-risk-gate.test.ts` + `proposal-executor.test.ts` (opposite-direction refusal at create/accept) |
| REQ-RISK-008 | `proposal-executor.test.ts` (two-tier pre-open spread), `stale-entry-sweeper.test.ts` (09:31 re-check select/cancel/keep) |
| REQ-RISK-009 | `position-sizer.test.ts` — overlay, absent/malformed file → 0.25 |
| REQ-RISK-010 | `proposal-executor.test.ts` — stopped epoch refuses entries; `position-actions-close.test.ts` — close unaffected |
| REQ-LLM-001/002 | `llm-spend.test.ts` (meter, pricing, day roll), `agent-runner.test.ts` (lane refusal at cap), `risk-rules-validation`-style startup check |
| REQ-LIVE-001/002/003 | `proposal-executor.test.ts` (assertAutoExecAllowed matrix, window 0 vs >0), `loop-commands.test.ts` (veto/kill routing), `proposal-commands.test.ts` (delegation) |
| REQ-SIM-001..005 | `simulator/fill-model.test.ts`, `simulator/registry.test.ts`, `simulator/settle.test.ts` (bar-source fallback, unknown on gaps) |
| REQ-SIM-006 | `simulator/settle.test.ts` — single-flight + stamps |
| REQ-SIM-007 | structural review + grep guard test (no import of the sim accessor from order paths) |
| REQ-SEQ-001..004 | `sequential-test.test.ts` — R unit, looks, confidences, ACCEPT/REJECT/CONTINUE, UCB, −5% stop |
| REQ-SEQ-005 | scorecard `--look` smoke-run against a fixture DB, compared to the nightly job's output |
| REQ-SEQ-006/007 | `sequential-test.test.ts` — paired daily difference bootstrap; band line |
| REQ-LADDER-001..004 | `ladder.test.ts` — eligibility, two-step up, auto down, epoch reset |
| REQ-EPOCH-001..004 | `epoch.test.ts` — start/stop files, journal lines, live-off on stop, promote/epoch-new recording |
| REQ-DIGEST-001..005 | `digest.test.ts` — section builders on fixtures; `dashboard.test.ts` `/api/loop` |
| REQ-FP-001/002 | `strategy-fingerprint.test.ts` — allowlist completeness pin; real temp-repo included/excluded edits |
| REQ-FP-003 | doc change + `runtime-attestation.test.ts` new fields |
| REQ-LIVE-004..008 | `loop-commands.test.ts` (challenge lifecycle, system-only off), `proposal-executor.test.ts` (non-paper class refusal, due-sweep order, claim race), fake-broker suites |
| REQ-LIVE-009 | doc change, no test |

## Numbering errata 2026-09-05 — duplicate REQ identifiers resolved

Six identifiers were defined more than once in this append-only file
(found by a definition grep while authoring the live-loop section; no
code, test, script, doc or discovery file outside SPEC.md referenced any
of them — verified 2026-09-05 with `grep -r` over `src`, `test`,
`scripts`, `docs`, `.claude`). Operator decisions (2026-09-05): a genuine
collision renumbers the LATER definition to the next free number in its
domain, keeping an inline "was" note; a deliberate refinement of one
requirement keeps its ID with a normalized prefix.

Convention from here on:
- `- REQ-X-NNN:` (colon right after the id) DEFINES a requirement — once.
- `- REQ-X-NNN (amended, review-N — …):` or `(strengthened, …):` REFINES an
  existing requirement under the same id; the original bullet stands as
  history.
- The definition grep is `^- REQ-[A-Z]+-[0-9]+:`; it must return each id
  exactly once.

Renumbered (collisions — two different requirements under one id):
- REQ-EOD-003 (Review-17, EOD earnings guard cancels via `cancelEntryLeg`)
  → **REQ-EOD-016**. REQ-EOD-003 stays the Review-16 gap-stress vet.
- REQ-EOD-004 (Review-17, broker-whole-book three gaps) → **REQ-EOD-017**.
  REQ-EOD-004 stays the Review-15 flat-by-close rule.
- REQ-EOD-005 (Review-18, verified EOD postcondition) and its Review-19
  CORRECTED amendment → **REQ-EOD-018**. REQ-EOD-005 stays the Review-15
  whole-book gap stress + GTC-acceptance stress.
- The traceability rows of the Review-17/18/19 sections were re-labelled
  `(was EOD-00x)` to match; the Review-15/16 rows are untouched.

Kept under one id (refinements, prefix normalized, text unchanged):
- REQ-PROP-001 — Review-17 "DB law" marked `(strengthened, review-17)`.
- REQ-EXPO-004 — Review-19 CORRECTED marked `(amended, review-19)`.
- REQ-VAL-019 — Review-18 widened marked `(amended, review-18)`;
  Review-19 CORRECTED marked `(amended, review-19)`.

Domain counters after this errata: EOD max = 018; every other domain
unchanged. New ids in the live-loop section above (TRIG, SIM, SEQ, LADDER,
EPOCH, DIGEST, FP, LIVE, LLM; SCAN-004..008; RISK-008..011) were allocated
after this check and do not collide.

## Live-loop WP1 landed (2026-09-05) — funnel throughput + behavior seams

Implements REQ-TRIG-001..004, REQ-SCAN-004..008, REQ-RISK-008..011,
REQ-LLM-001..002 and the REQ-LIVE-001..003 seams from the live-loop section.
Harness at landing: `bun test` 947/0 (80 files), `tsc --noEmit` clean, Jest
green at 4 workers. The ephemeral `docs/day2day/WP1-PLAN.md` carries the
task graph for the review and is deleted once the operator has read it.

### Precisions recorded at landing (append-only; they refine, not change, the requirements above)

- REQ-SCAN-006 precision: large-cap (and complex) admissions take at most
  `OPP_LARGECAP_RESERVE` reserved candidate slots each (default 5, best scan
  rank first) — "bounded by the lane's own row count" would have queued up
  to 100 sequential scorings per cycle and starved the cadence. The knob is
  a fingerprint surface.
- REQ-SCAN-007 precision: constituent admission uses the ATR bar
  `|move| ≥ max(1%, 1.0 × dailyATR%)` (`complexAdmission`), not the
  sentinel's 5% raw bar — a +4% chipmaker on a +4% sector day is the case.
  A constituent may belong to several complexes; a vehicle to exactly one.
- REQ-SCAN-004 precision: the significance term is
  `min(25, round(8 × dayMove% / dailyATR%))`, zero under one ATR, aligned
  moves only (`SIGNIFICANCE` constants block in `event-mover.ts`); the
  raw-percent `eventMoverBoost` is deleted. Dollar volume = price × the
  session's cumulative bar volume (`sessionVolumeFromBars`), a new field
  on the scorer snapshot, used only as the tie-breaker inside a rank band.
- REQ-RISK-009 precision: the risk GATE enforces the effective budget too
  (`classRiskPct` is shared by sizer and gate), so an explicit quantity
  above the rung, or a row whose rung stepped down between creation and
  accept, is refused rather than waved through at the yaml ceiling. The
  rung is injectable (`RiskGateContext.rungPct`, sizer third argument) so
  pure tests pin the arithmetic; production reads `ladder-state.json`.
- REQ-LIVE-001 precision: `AUTO_EXECUTE_PAPER=true` stays the master
  auto-exec switch on every account type (renaming it is a WP4 concern);
  the live branch adds its conditions on top. Verdict order on a live port
  names the static arms (IBKR_ALLOW_LIVE, live switch) before the
  connection-dependent identity, so the boot-time refusal reason is
  actionable without a connection.
- REQ-LIVE-003 precision: `live status`, `ladder` and `epoch` answer
  read-only from the state files already in WP1 (observability); `live
  on|off`, `ladder up`, `epoch new`, `promote` are recognised and answer
  "not available until WP3/WP4".
- REQ-LLM-001 precision: the meter hooks the agent runner's `DoneEvent.
  tokenUsage` (one write per run, error-path runs included); the boot check
  refuses to start with a cap > 0 and missing prices. OPERATOR ACTION before
  the WP1 restart: set `LLM_PRICE_IN_USD_PER_MTOK` and
  `LLM_PRICE_OUT_USD_PER_MTOK` in `.env`, or `LLM_DAILY_SPEND_CAP_USD=0`.
- Refusal ledger gains gates `spend-cap` and `complex`
  (`classifyRefusalGate`).

### Test traceability (WP1)

| REQ | Test |
|---|---|
| REQ-TRIG-001 | `opportunity-engine.test.ts` — "trigger defaults" (60/30, env override, garbage) |
| REQ-TRIG-002 | `lane-context.test.ts` — trigger rank in the lane context; `tools/proposals/index.test.ts` — stamp from context, NULL off-lane; `trade-proposals.test.ts` — refusal row carries the rank |
| REQ-TRIG-003 | `trade-proposals.test.ts` — `triggerBand` mapping + proposal rank/band round-trip |
| REQ-TRIG-004 | `proposal-executor.test.ts` — auto-exec cap default 6 |
| REQ-SCAN-004 | `event-mover.test.ts` — `significanceTerm` (chipmaker vs 3x ETF, monotone, capped, aligned-only); `session-volume.test.ts` — `sessionVolumeFromBars` |
| REQ-SCAN-005 | `event-mover.test.ts` — `significanceSuppressed` matrix incl. the reactor hour-one exemption |
| REQ-SCAN-006 | `opportunity-engine.test.ts` — `largeCapScansFor`, `scanFamilyOf`, `selectReservedAdmissions`, lane knobs (the scan wiring in `runCycleInner` is IBKR-bound glue over these pure parts) |
| REQ-SCAN-007 | `vehicle-complexes.test.ts` — parse/validate, lookups, `complexAdmission`, shipped config loads (the constituent sweep is IBKR-bound glue) |
| REQ-SCAN-008 | `vehicle-complexes.test.ts` — `oppositeDirectionConflict`; the create/accept wiring reuses `listExposure` (integration glue, honest ledger) |
| REQ-RISK-008 | `proposal-risk-gate.test.ts` — two-tier pre-open spread; `spread-recheck.test.ts` — decision matrix + one full pass with injected deps |
| REQ-RISK-009 | `position-sizer.test.ts` — rung overlay, bottom-rung default; `ladder-state.test.ts` — parse/read/fail-safe; `proposal-risk-gate.test.ts` headroom suite pins the gate at an explicit rung |
| REQ-RISK-010 | `epoch-state.test.ts` — parse/read/verdict (absent = running, corrupt = stopped); `proposal-executor.test.ts` — stopped epoch refuses the accept, row stays open |
| REQ-RISK-011 | yaml + journal (doc/config, no test) |
| REQ-LLM-001 | `llm-spend.test.ts` — pricing, price knobs, cap default, boot check, ledger roll/accumulate, persistence |
| REQ-LLM-002 | `llm-spend.test.ts` — evaluation lanes, verdict at/under the cap, cap 0; the runner/bridge wiring is glue over the tested verdict |
| REQ-LIVE-001 | `proposal-executor.test.ts` — `autoExecVerdict` matrix (paper identity; live: each condition named; non-D account on the paper port) |
| REQ-LIVE-002 | `proposal-executor.test.ts` — window default 0, 5-min window stamps `auto_execute_at` and announces the veto; `veto-window.test.ts` — due sweep executes oldest first, failures isolated |
| REQ-LIVE-003 | `loop-control.test.ts` — `vetoDecision` + `vetoProposalWith` routing; `loop-commands.test.ts` — grammar, read-only status, "not available" answers, fall-through |

## Live-loop WP2 landed (2026-09-05) — in-process simulator, shadow-variant registry, fingerprint narrowing

Implements REQ-SIM-001..007 and — pulled forward from WP3 — REQ-FP-001/002.
The ephemeral `docs/day2day/WP2-PLAN.md` carries the task graph for the
review and is deleted once read.

### Sequencing decision recorded at landing

The identity still hashed the whole `src` tree, so a WP2 landing without
the narrowing would have moved the epoch-1 fingerprint on the very restart
that opens epoch 1. The WP1 restart has not happened yet (the operator must
set the LLM price knobs first), so the first restart carries WP1 + WP2 +
the narrowed identity together: epoch 1 opens on an identity WP3/WP4 cannot
move. REQ-FP-003 (protocol/manifest docs, attestation fields) stays in WP3;
the protocol's fingerprint paragraph carries a dated amendment already.

### Precisions recorded at landing (append-only; they refine the requirements above)

- REQ-SIM-001 precision: `sim_trades` lives in its OWN `simulator.db` (same
  data dir), not in `proposals.db` — the behavior store's schema stays
  untouched, two writers never contend on one file, and REQ-SIM-007 is
  structural (a different database, no order-id columns, no path into
  `acceptProposal`). Same REQ-TEST-001 temp-dir guard.
- REQ-SIM-002 precision: all simulator times use the codebase's ET-frame
  convention (`barTimeFrameMs` / `etFrameMs`). Ratchet exits are classed
  `target` when the exit is above the fill and `stop` otherwise (the
  outcome set has no ratchet label), with a note. The ratchet stop for a
  bar is the stop as it stood ENTERING the bar — the peak that lifts it
  prints during the bar and the same bar's low may precede it.
- REQ-SIM-003 precision: coverage = first bar within one gap tolerance of
  the window start, last within one of the end, no internal gap over the
  tolerance (60 s for 5-second stream bars, 5 min for 1-minute bars),
  judged on session-filtered bars. The IBKR fallback is paced (300 ms) and
  bars are memoized per (symbol, window, session) per run.
- REQ-SIM-004 precision: `funnel-75` = trigger rows in the '75+' band plus
  every non-trigger lane; `gate-off:microstructure` recognises the gate
  from the refusal reason (the classifier files it under 'other');
  `exit-ratchet` / `exit-x2.0` / `stop-x/3` need the row's x (stamped
  `take_pct` or the ATR formula) and skip rows without it; entry deadline =
  proposal expiry + the sweeper's 30-min grace (GTC: the 3-day zombie
  horizon).
- REQ-SIM-005 precision: the sizing base is the epoch NetLiq
  (`performance-epoch.json`, fallback $11,700) at the current rung; R uses
  the planned entry (the fill for MKT) and the variant's stop.
- REQ-SIM-006 precision: settle runs at 17:10 ET with a boot catch-up when
  today's stamp is not `completed` after the slot on a trading day; open
  GTC rows re-settle nightly for 28 calendar days, then `unknown`
  ("horizon expired"); a DAY row created at or after its flat bar is
  skipped (post-cutoff, nothing to replay). The nightly report goes to
  WhatsApp through the outcome-alerts bridge.
- REQ-FP-001 precision: `src` + root runtime configs + SOUL.md are INCLUDED
  by default; `BEHAVIOR_EXCLUDE` names observability (simulator, benchmark,
  excursion sweeper, equity series, dashboard, attestation, scan health),
  control plane (`loop-control`, `loop-commands`), alert delivery
  (`outcome-alerts`, `mover-alerts`, `health-alerts`, `debug-log`),
  evaluator math (`day-bootstrap`, `equity-series-math`, the future
  `sequential-test`), TUI/CLI paths and every `*.test.ts(x)`; `scripts/`
  left the identity. A new file is behavior unless excluded (fail-loud
  default). The identity is per-BLOB (`git ls-tree -r`, filtered), status
  and diff scoped to behavior paths only.
- REQ-FP-002 finding fixed at landing: the shared git runner trimmed
  stdout, so a porcelain entry for a modified file (` M path`) lost its
  leading space and the path parsed one character short. The old identity
  never noticed because any non-untracked entry counted as dirty. NUL-
  delimited outputs are now consumed raw; the temp-repo test pins it.

### Test traceability (WP2)

| REQ | Test |
|---|---|
| REQ-SIM-001 | `simulator/store.test.ts` (own DB, upsert keyed on variant+source, filters); `simulator/settle.test.ts` (incumbent twin per proposal); `simulator/report.test.ts` (`twinCalibration`) |
| REQ-SIM-002 | `simulator/fill-model.test.ts` — strict trade-through LMT, STP_LMT band, MKT next open, gap-aware stop, target strict, tie → stop, eod-flat, GTC open, deadline, ratchet arm/lock/trail, MFE/MAE, commissions, R |
| REQ-SIM-003 | `simulator/bars.test.ts` — `coverageOk`, `sessionFilter` (half-day), `frameToEpochMs` round trip, loader order with fakes (loader failure = no data) |
| REQ-SIM-004 | `simulator/variants.test.ts` — registry names, `weights-calibrated` inactive, per-variant applies/geometry |
| REQ-SIM-005 | `simulator/variants.test.ts` (`sizeAtRung`); `simulator/settle.test.ts` (rung-sized quantity, commissions, R) |
| REQ-SIM-006 | `simulator/settle.test.ts` — settled rows untouched, open GTC re-settled, unknown on missing bars, future flat bar waits, post-cutoff row skipped, failure isolated; the cron/stamp/catch-up wiring in `simulator/index.ts` is lifecycle glue (honest ledger) |
| REQ-SIM-007 | structural: `simulator.db`, no order-id columns, no import from the simulator into any order path (`grep -r "simulator" src/services/proposal-executor.ts src/tools/ibkr` is empty) |
| REQ-FP-001 | `strategy-fingerprint.test.ts` — classification pin (behavior included / excluded named), every exclusion exists |
| REQ-FP-002 | `strategy-fingerprint.test.ts` — REAL temp repo: excluded edits (dirty and committed) leave the identity, a behavior edit moves it, an untracked behavior file dirties it, a test file does not; legacy suites re-pinned (`scripts/` no longer dirties) |

## Live-loop WP3 landed (2026-09-05) — sequential test, size ladder, epochs, nightly digest

Implements REQ-SEQ-001..007, REQ-LADDER-001..004, REQ-EPOCH-001..004,
REQ-DIGEST-001..005 and REQ-FP-003. The ephemeral `docs/day2day/WP3-PLAN.md`
carries the task graph for the review and is deleted once read.

### Fingerprint discipline recorded at landing

Every WP3 module lives on an excluded path: `src/utils/sequential-test.ts`
(pre-registered exclusion) and the new `src/services/loop/` directory
(`epoch-control`, `ladder-control`, `journal`, `sample`, `looks`, `digest`,
`nightly`, `operator`, `promote`, `alerts`). The ONE behavior-path edit is
the `'src/services/loop'` entry in `BEHAVIOR_EXCLUDE`; it lands before the
first gateway restart, so epoch 1 opens on an identity WP4's live-switch
writer (also under `src/services/loop/`) cannot move. `gateway.ts` is not
touched: the nightly looks + digest run as the tail of the simulator's
17:10 ET job (settle → looks → digest; `SIMULATOR` must stay on), the
equity guards hook into the excluded `equity-series.ts` sampler, and the
behavior readers (`epoch-state`, `ladder-state`, `live-switch`) stay in the
identity untouched.

### Precisions recorded at landing (append-only; they refine the requirements above)

- REQ-EPOCH-001 precision: `epoch new` is the epoch-creating command. It
  performs the performance reset itself (`setPerformanceBaseline` with the
  USD NetLiq), writes `epoch-state.json` (a superset record: `netLiq`,
  `constantsHash`, `looksDone`, `looks`, `firstAcceptAt`, `stepUpEligible`,
  `promotionPending`, `carryRung`), appends `epochs.jsonl` (ids count up:
  `epoch-N`), resets the ladder (unless `carry`) and journals one line. The
  legacy `performance reset` keeps resetting only the baseline (its router
  is a behavior path). Refused, fail closed, when IBKR cannot report the USD
  NetLiq (the hard stop needs the denominator) or the identity is
  unresolved (an epoch must record the fingerprint it trades). Two-step
  confirm while an epoch is RUNNING; immediate when none or stopped.
- REQ-EPOCH-002 precision: anomaly-driven stops are detected at the nightly
  look from the EOD triage run stamp (`eod-triage-run.json` status `failed`
  for today — the UNRESOLVED OVERNIGHT EXCESS alarm stamps the same run);
  the triage service is a behavior path and is not hooked. A stop writes
  `live-switch.json` `{enabled:false, by:'system', reason}` unless the
  switch already reads false (the operator's own record is kept). Stops are
  idempotent: the first reason stands.
- REQ-SEQ-001 precision: the sample mirrors the scorecard's SAMPLE_WHERE
  (closed, proposed at/after the epoch start, entry filled, realized P&L
  known, not cancelled, source not adopted/test/smoke, note free of the
  untrustworthy marker); deployable = classes NOT disabled in the raw live
  config (`liveDisabledClasses`); shadow-only classes are reported apart.
  A row whose planned-risk basis or commissions are missing is an
  integrity anomaly: the looks are FROZEN that night (no decision, the
  anomaly named in the digest), never a zero.
- REQ-SEQ-002/003 precision: a look is evaluated over the whole in-epoch
  sample on the night its count first reaches the boundary (several trades
  may close the same day: the look is labelled by the boundary, computed
  on n). Each boundary is evaluated once (`looksDone`). [SUPERSEDED the
  same day by the audit response below (AUD-12): the look evaluates the
  PREFIX of the first `lookN` trades in close order.] Under 5 entry days
  the look is NOT-EVALUABLE and is still recorded (it will not re-fire).
  The constants hash of the running module must equal the epoch's — a
  mismatch makes every look NOT EVALUABLE until a new epoch.
- REQ-SEQ-003 precision (UCB): the REJECT bound reuses the day-block
  bootstrap by negation (UCB(x) = −LCB(−x) at 95%); `day-bootstrap.ts` is
  unchanged.
- REQ-SEQ-004 precision: the hard stop and the ladder step-down are
  evaluated by the equity sampler on every 5-minute mark (the letter of the
  requirement) AND re-checked at the nightly look from the marked series
  since the epoch start (belt and braces); a guard failure never loses the
  sample.
- REQ-SEQ-005 precision: `--look` runs the SAME `runNightlyLooks` the
  nightly job runs — a boundary reached at run time is recorded then (the
  nightly finds it done); alerts have no transport in the script context,
  journal lines are written. The legacy scorecard header and verdict are
  labelled LEGACY.
- REQ-SEQ-006 precision: the difference is DAILY summed R over the
  incumbent's trading days; a variant day without rows contributes 0
  (variants are subsets or re-geometries of the same sources). Promotion
  candidate = ≥ 30 settled sim trades over ≥ 10 days AND difference LCB > 0.
- REQ-SEQ-007 precision: the band line is judged on the deployable sample's
  `trigger_band = '60-74'` rows; `barMet` is null under 20 trades, else
  net USD ≥ 0. An ACCEPT computed at a look while `barMet === false` is
  downgraded to CONTINUE with the reason recorded.
- REQ-LADDER-001 precision: eligibility is recomputed every night and
  QUEUED in the epoch record (`stepUpEligible`); `ladder up` shows the
  evidence and arms a 10-minute confirm; `ladder up confirm` applies it
  with `lastStepUpNetLiq` = the marked NetLiq at confirm time (refused when
  IBKR cannot report it — the step-down mark must be anchored). A stopped
  epoch is never eligible.
- REQ-LADDER-002 precision: after a step-down the mark re-anchors at the
  current NetLiq (one drawdown costs one rung; the next needs another −5%).
- REQ-EPOCH-004 precision: `promote <variant>` shows the variant's shadow
  evidence and the exact change (`funnel-75` → `OPP_TRIGGER_SCORE=75`,
  `exit-ratchet` → `exit_style: ratchet`, `exit-x2.0` → `take_atr_mult:
  2.0`, `class-*` → the live class flag with its own ≥30-trade bar,
  `weights-calibrated` → the calibrator's `--apply`); `stop-x/3` and every
  `gate-off:*` variant print "needs a SPEC change" — they are evidence
  about a rule, not a switch. `promote … confirm` journals and stamps
  `promotionPending` on the epoch; the next `epoch new` labels its policy
  with that variant.
- REQ-DIGEST-002 precision: "scanned" = distinct snapshot symbols today;
  "triggered" = trigger-events.json entries today (single + breadth);
  "evaluated" = triggered − spend-cap refusals; lanes = proposal `source`.
- REQ-DIGEST-005 precision: each WhatsApp section keeps its first 11 lines
  plus a "… N more line(s) on the dashboard /api/loop" line; `/api/loop`
  returns the last nightly result or a fresh build (cached 60 s); the
  dashboard "Loop" panel renders the four sections in full and refreshes
  every 5 minutes.
- REQ-FP-003 precision: the attestation records `liveSwitch` (null = no
  state file), `vetoWindowMin`, `rung`, `epochId` and `epochStatus`
  (`stopped` for a corrupt latch, matching the gate's fail-closed read).
- Journal lines (REQ-EPOCH-001/002, REQ-LADDER-001/002, REQ-EPOCH-004) are
  appended to `docs/day2day/VALIDATION-JOURNAL.md` (override:
  `DEXTER_JOURNAL_PATH`) as `- <date> — <line>`; a failed append is logged
  as an error and never blocks the act it records.

### Test traceability (WP3)

| REQ | Test |
|---|---|
| REQ-SEQ-001 | `sequential-test.test.ts` (`netRForRow`: null on a missing basis/commissions); `loop/looks.test.ts` (anomaly freezes the looks) |
| REQ-SEQ-002 | `sequential-test.test.ts` (`lookBoundaryReached`, confidences per look, NOT-EVALUABLE under 5 days); `loop/looks.test.ts` (boundary evaluated once, informational between looks, constants mismatch) |
| REQ-SEQ-003 | `sequential-test.test.ts` (ACCEPT / REJECT / CONTINUE, UCB by negation); `loop/looks.test.ts` (ACCEPT recorded + alert, REJECT stops the epoch) |
| REQ-SEQ-004 | `sequential-test.test.ts` (`hardStopDue`); `loop/epoch-control.test.ts` (`evaluateEquityGuards` hard stop); `loop/looks.test.ts` (nightly re-check) |
| REQ-SEQ-005 | smoke-run `bun run scripts/validation-scorecard.ts --look` against the paper ledger (no epoch: prints the constants and "epoch: NONE"); same module as `nightly.ts` by construction |
| REQ-SEQ-006 | `sequential-test.test.ts` (`dailyDifferenceBounds`); `loop/looks.test.ts` (`shadowLines`: candidate flag, incumbent has no diff, inactive named) |
| REQ-SEQ-007 | `sequential-test.test.ts` (`bandLine`); `loop/looks.test.ts` (ACCEPT withheld while the band reads negative at n ≥ 20) |
| REQ-LADDER-001 | `sequential-test.test.ts` (`ladderEligibility`); `loop/operator.test.ts` (evidence, two-step, refused when not eligible / NetLiq missing / no pending); `loop/looks.test.ts` (eligibility queued) |
| REQ-LADDER-002 | `sequential-test.test.ts` (`stepDownDue`); `loop/epoch-control.test.ts` (step-down, re-anchor, never below 0.25) |
| REQ-LADDER-003 | `loop/epoch-control.test.ts` (reset vs carry); `loop/operator.test.ts` (`epoch new carry`) |
| REQ-LADDER-004 | `loop-commands.test.ts` (`ladder` routes to the status line); `loop-control.ts` status text |
| REQ-EPOCH-001 | `loop/epoch-control.test.ts` (baseline reset + record + ladder + journal; the behavior reader accepts the record); `loop/operator.test.ts` (refusals, two-step while running) |
| REQ-EPOCH-002 | `loop/epoch-control.test.ts` (stop once, live switch OFF by system, idempotent); `loop/looks.test.ts` (triage failed → stop) |
| REQ-EPOCH-003 | same code path on both profiles (no account branch in `src/services/loop/`); `loop/looks.test.ts` (a stopped epoch is not restarted by the looks) |
| REQ-EPOCH-004 | `loop/operator.test.ts` (evidence + change text, confirm records journal + `promotionPending`, unknown variant refused) |
| REQ-DIGEST-001..004 | `loop/digest.test.ts` (fills with bps/twin, funnel counts and gates, shadow + band line, status lines) |
| REQ-DIGEST-005 | `loop/digest.test.ts` (`truncateSection`, WhatsApp format); `loop-commands.test.ts` (`digest`); `/api/loop` and the Loop panel verified by the digest smoke-run over the live ledgers |
| REQ-FP-003 | `strategy-fingerprint.test.ts` (loop paths excluded; every exclusion exists); `runtime-attestation.test.ts` (new fields present); doc changes |

## Live-loop WP4 landed (2026-09-05) — live-automation plumbing, switched OFF

Implements REQ-LIVE-004..009. The ephemeral `docs/day2day/WP4-PLAN.md`
carries the task graph for the review and is deleted once read.

### Sequencing recorded at landing

The first gateway restart had still not happened (the operator killed the
pre-WP1 gateway on 2026-09-05 after setting `SIMULATOR` and the LLM cap),
so WP4 lands BEFORE epoch 1 opens: the restart carries WP1..WP4 together
and the identity WP4 establishes is the one epoch 1 records. The two
behavior-path edits (`proposal-executor.ts`: the REQ-LIVE-006 sim-only
branch and the REQ-LIVE-009 header doctrine) are therefore deliberate and
pre-epoch; the acceptance item "fingerprint unchanged vs the WP1 restart"
is moot and replaced by "epoch 1 opens on the WP1..WP4 identity".
Everything else lives on excluded paths (`src/services/loop/
live-switch-control.ts`, `loop-control.ts`, `loop-commands.ts`,
`dashboard*.ts`, docs, tests). `live-switch.json` is absent in the data
dir (verified at landing: the switch reads OFF).

### Precisions recorded at landing (append-only; they refine the requirements above)

- REQ-LIVE-004 precision: the challenge token is 6 characters from an
  unambiguous alphabet (no 0/O/1/I), compared case-insensitively, valid
  2 minutes, consumed on success. A mismatch refuses and KEEPS the pending
  challenge until it expires (a typo should not force a new evidence
  read); expiry and `live off` clear it; a consumed challenge cannot be
  replayed. The ON record is `{enabled:true, changedAt, by:'operator',
  reason:'live on (challenge confirmed)'}`; `live off` writes
  `by:'operator'`, the epoch stop writes `by:'system'` (the only system
  writer, `false` only). The dashboard `live on` / `live off` buttons post
  `live-on` (token absent = challenge, present = confirm) and `live-off`
  through the same control object as the WhatsApp grammar.
- REQ-LIVE-005 precision: the challenge shows the epoch id/status, the
  last look (n, decision, LCB, UCB95, net R, PF), whether an ACCEPT is
  recorded, the rung, the account kind as the process sees it, the
  `IBKR_ALLOW_LIVE` state, the profile and the veto window; on a non-live
  account it says the switch has no effect until the gateway connects to
  one. `live status` prints the switch line plus the last two evidence
  lines. `live on` never starts an epoch: the confirmation instructs
  `epoch new` (no carry).
- REQ-LIVE-006 precision: on the live profile the class gate already
  refuses a disabled-class proposal at CREATION (pinned:
  `risk-rules-profile.test.ts` — a live account never gets the shadow
  forcing; `proposal-executor.test.ts` — creation throws). The sim-only
  marking covers rows that exist from before the account verified as live
  (the boot window under the default paper profile, or the paper era
  before a cutover restart): the live auto-exec branch marks such a row
  `rejected` with a `sim-only:` note and a refusal-ledger row before the
  veto window or the accept path. The simulator replays every proposal
  and every refusal with levels, so both paths settle in the class
  variants. `epoch new carry` is refused on a live account (REQ-LADDER-003
  letter); plain `epoch new` opens the live epoch at 0.25%.
- REQ-LIVE-007 precision: `listDueAutoExecutions` orders by `created_at`
  and lists only `open` rows whose due time has passed and whose expiry
  has not; a row rejected (vetoed) or claimed between listing and
  execution is refused by the executor's claim and counted `failed` by the
  sweep, which continues with the next row. A veto of a row in `executing`
  returns `refuse-claimed`, naming `cancel P-XXXX` / `kill SYMBOL` as the
  controls that apply after placement.
- REQ-LIVE-008 precision: no placement-path fake broker exists for the
  executor, so "open → due → executed" is pinned as far as the gates: the
  due path (`skipVetoWindow`) is proven not to re-defer and to reach the
  accept gates (a deterministic kill-switch refusal without IBKR); the
  live verdict matrix, the challenge lifecycle and the system-side OFF
  are unit-pinned. No test binds a live port (the live-port tests set the
  env and never connect).
- REQ-LIVE-009 precision: TRADING-POLICY step 4 is "A human holds the
  switch and the veto"; "Going live at all" describes the sequential test,
  the layered live act and the class doctrine; the executor header
  retires the "never available for live" doctrine in place.
- Harness note: the WP3 commit carried a `tsc` error in
  `runtime-attestation.test.ts` (an `unknown` passed to `toContain`),
  introduced after WP3's type-check ran; fixed here.

### Test traceability (WP4)

| REQ | Test |
|---|---|
| REQ-LIVE-004 | `loop/live-switch-control.test.ts` — challenge → confirm writes ON by operator + journal; expiry, mismatch (challenge kept), no pending, replay all refused; `live off` immediate; token alphabet. `loop-commands.test.ts` — `live on` / `live on <token>` / `live off` routing |
| REQ-LIVE-005 | `loop/live-switch-control.test.ts` — no-epoch message; epoch + last look + ACCEPT + rung + cold arm + veto window shown |
| REQ-LIVE-006 | `risk-rules-profile.test.ts` — live account: no shadow forcing, both classes disabled; `proposal-executor.test.ts` — creation refused on live, pre-existing swing row marked sim-only (rejected + note + refusal row), paper control unmarked; `loop/operator.test.ts` — `epoch new carry` refused on live |
| REQ-LIVE-007 | `trade-proposals.test.ts` — due listing in creation order, not-yet-due / rejected / expired excluded, cleared stamp; `veto-window.test.ts` — refused rows counted, sweep continues; `loop-control.test.ts` — claimed row → `refuse-claimed` naming cancel/kill |
| REQ-LIVE-008 | `proposal-executor.test.ts` — live verdict matrix (WP1), due path does not re-defer and reaches the gates; `loop/live-switch-control.test.ts` — system-side OFF after `live on` on an epoch stop |
| REQ-LIVE-009 | doc change, no test; smoke: `live status` and the challenge rendered from the real data dir (no switch file → OFF; no epoch → says so) |

## Audit 2026-09-05 response — point-by-point verdicts, fixes landed, plan for the rest

The operator's `AUDIT-2026-09-05.md` (dated 2026-09-05, reference `dacaa63`) examined
strategy coherence, instructions, selection, sizing, protection, exits and
the new validation path. Each finding was verified against HEAD before this
response; verdicts below are evidence-based, fixes are pre-epoch (epoch 1
has not opened — `epoch new` was refused on 2026-09-05 for a weekend FX
gap), so the identity moves once more at the next restart and nothing
retroactive is claimed.

### Verdicts

| Finding | Verdict | Disposition |
|---|---|---|
| AUD-01 take formula vs "structural target" (P1) | VALID — `take_atr_mult 1.5 / floor 3 / cap 10` with `max_target_atr 1.5` and `min_stop_atr_fraction 0.4` make a 3 % target reachable only for ATR% ∈ [2, 3.75]; the day-trade skill still says "target at a real objective" while the gate enforces the formula (override allowed only inside the band) | PLAN — WP5 exit policy per lane (the intraday exit was an operator decision 2026-08-22; a per-lane policy needs a SPEC change and shadow evidence: the simulator already carries `exit-x2.0`, `exit-ratchet`) |
| AUD-02 target ignores time remaining (P1) | VALID — `checkTakeTarget` receives ATR, basis, target, earnings context; no clock | PLAN — WP5 research item (empirical remaining-excursion by hour/setup/regime; labels start after an executable entry) |
| AUD-03 overnight = swing by default (P1) | VALID — the Pre-Close cron asked for GTC overnight proposals without `tradeClass`; the default is intraday and the gate refuses an intraday GTC | FIXED — the cron registers overnight setups as `tradeClass "swing"` and states the flat-by-close rule; a distinct overnight class with its own J+1 contract stays in WP5 |
| AUD-04 skill promises keeps the triage does not make (P0) | VALID — `overnight/SKILL.md` said the 15:52 triage "keeps winners and stabilizing losers by default"; REQ-EOD-004 closes every DAY position | FIXED — skill text rewritten to the flat-by-close contract and the operator-only `keep` |
| AUD-05 `keep` bypasses the overnight caps (P0) | PARTLY — true that overrides hold their excess in `vetOvernightBook`; but that is the ratified REQ-EOD-003 ("operator overrides hold their excess loudly"), the earnings guard still runs AFTER the override, and `keep` is a WhatsApp operator command (`KEEP_RE` in proposal-commands) with no tool — the model cannot grant it. Kept positions stay in the book the acceptance-time headroom gate sums | DECISION — the operator may re-ratify keep as "a candidacy under the caps" (then the vet trims overrides too); until then P0 is downgraded to a documented policy choice |
| AUD-06 sizer does not compose the overnight budget (P1) | VALID — `computeQuantity` sizes by stop then position cap; the gap-stress (7.5 % of NetLiq book at 20 % stress vs 1.5 % daily loss) binds only at acceptance, so a swing sized at 15 % is refused later | PLAN — WP6 "sizer composes every budget at creation"; on live the swing class is disabled anyway, on paper it shows as accept-time refusals |
| AUD-07 cup-and-handle is a detector, not a lane (P1) | VALID — best pattern per symbol, top 25 overall, heuristic thresholds | PLAN — WP5 lane (detector version, pivot/breakout/retest states, own cohort) |
| AUD-08 generic score mixes hypotheses (P2) | VALID — flat 0.25 weights; RVOL bonus `min(10, 2×rvol)` on top of the volume component; the day-trade skill named a "sentiment" component the scorer does not compute | FIXED (text) — the skill names the real fourth component (trend alignment); PLAN — conditional scoring per lane (research, after WP5) |
| AUD-09a SOUL "runners" vs `exit_style: target` | VALID — trail arms at 2.5 ATR, target at 1.5 ATR: the trail never arms first under 'target' | FIXED — SOUL states the active take policy and that the runner exit is a shadow variant |
| AUD-09b ladder rungs 0.75/1.0 inert under the 0.5 % ceiling | VALID — `classRiskPct = min(rung, ceiling)` | FIXED — eligibility never offers a rung above the ceiling; `ladder`, the digest and `ladder up` show requested vs effective risk (REQ-LADDER-001/004 amended below) |
| AUD-10a doctrine texts promise a hand-accept per live trade (P0) | VALID — SOUL §"Protecting the operator" and AGENTS.md predated WP4 | FIXED — both aligned with the switch + veto model (REQ-LIVE-009 completed) |
| AUD-10b absent epoch counted as running for live auto-exec (P0) | VALID — `epochGateVerdict` treats an absent file as intake-open (the WP1 paper seam) and the live verdict reused it | FIXED — the live verdict requires a PRESENT `running` epoch (REQ-LIVE-001 amended); paper semantics unchanged |
| AUD-11a cohort identity not verified (P0) | VALID — the epoch sample checked the constants hash, not the rows' fingerprints or model | FIXED — fingerprint absent/mismatched and >1 distinct model are anomalies that freeze the look (REQ-SEQ-001 amended) |
| AUD-11b unknown outcomes silently dropped (P0) | VALID — `realizedPnl === null` rows were skipped before the anomaly checks | FIXED — an executed, closed row with unknown P&L is an anomaly ("cohort incomplete") |
| AUD-12a "≈5 % familywise" unproven (P0) | VALID — measured 10.3 % (see below) | FIXED (claim) + DECISION (schedule) — the module and the SPEC state the measured rate; the operator chooses the schedule before epoch 1 |
| AUD-12b looks not evaluated on a reproducible prefix (P0) | VALID | FIXED — prefix of the first `lookN` trades in close order (REQ-SEQ-002 amended) |
| AUD-12c 1000 replicates thin at 1 %; 5-day minimum | VALID as a limit | DECISION — folded into the schedule choice (replicates are a constant too) |
| AUD-13 benchmarks/simulator scope (P1) | VALID — the benchmark treats the opening gap as uncapturable; the simulator replays proposals and refusals, not never-admitted candidates | PLAN — WP7 overnight benchmark + eligible-candidate archive per lane |
| §5 empirical figures | VERIFIED read-only on 2026-09-05: 49 intraday + 24 unclassed legacy rows = 73, net −44,986.81 USD; earnings-bet 2 (+113.46); 18 closed-filled rows with unknown P&L (17 `agent`, 2026-07-14..08-06; 1 `adopted`) | The 17 legacy rows predate every epoch and never enter a look; their reconciliation is a broker-statement task for the operator, recorded as open |

### Sequential-test calibration (AUD-12; `scripts/calibrate-sequential-test.ts`)

Whole procedure simulated (same `evaluateLook`, same bootstrap, prefix
rule) under a zero-mean null with a shared daily shock (σ 0.3 R, 1–4
trades/day, p 0.4 of +1.5 R else −1.0 R), 2,000 epochs per cell, and under
+0.25 R per trade for power. A heavier-clustering null (σ 0.5, up to 6
trades/day, 1,000 epochs) in brackets.

| Schedule (look confidences) | False ACCEPT under H0 | Power at +0.25 R | Mean stop n (H1) |
|---|---|---|---|
| A pre-registered 99 / 97.5 / 96 / 95 | 10.3 % [12.3 %] | 66 % [60 %] | 75 |
| B uniform 98.75 (Bonferroni 5 %) | 5.3 % [7.7 %] | 46 % [43 %] | 80 |
| C O'Brien-Fleming-like 99.96 / 99.33 / 97.76 / 95.87 | 7.0 % [8.7 %] | 60 % [51 %] | 85 |
| D 99.5 / 99 / 97.5 / 95 | 8.4 % [10.0 %] | 64 % [56 %] | 80 |

The REJECT rule (UCB95 < 0) fires on 15.7 % of zero-edge epochs under H0
and on 1.4 % under H1. Reading: the pre-registered schedule buys the most
power at roughly twice the advertised false-ACCEPT rate; B halves the false
accepts at a 20-point power cost; C sits between. The schedule is a
pre-registered constant: changing it before `epoch new` is free (a new
constants hash), changing it later ends the epoch.

### Requirements amended by this response (append-only)

- REQ-SEQ-001 (amended, audit-2026-09-05): the epoch sample is an integrity
  anomaly — the look is FROZEN, never decided — when a closed, entry-filled
  row outside 'cancelled' has no realized P&L; when a sample row's strategy
  fingerprint is absent or differs from the epoch's; when the epoch recorded
  no fingerprint; or when more than one distinct non-null model appears
  across the sample. A missing model stamp is reported (count) and not an
  anomaly. `TradeProposal` now exposes `strategyFingerprint`.
- REQ-SEQ-002 (amended, audit-2026-09-05): each look evaluates the PREFIX of
  the first `lookN` trades in close order (close time, then id) — several
  boundaries crossed between two runs evaluate distinct prefixes; the
  `n` of a look is `lookN` once reached. The "familywise ≈ 5 %" wording is
  withdrawn; the realised rate is the calibration table above.
- REQ-LIVE-001 (amended, audit-2026-09-05): the live auto-execution verdict
  requires a PRESENT epoch record with status `running`; an absent file is
  intake-open for the paper accept path only (REQ-RISK-010 seam).
- REQ-LADDER-001 (amended, audit-2026-09-05): a rung above the ratified
  per-trade ceiling (`max_risk_per_trade_pct` of the active profile) is
  never eligible; the effective risk is min(rung, ceiling). REQ-LADDER-004:
  `ladder`, the digest and the `ladder up` evidence show rung, ceiling and
  effective risk.
- REQ-EOD-004 precision: the overnight skill and the Pre-Close cron state
  the flat-by-close contract and the operator-only `keep`; overnight
  setups are registered as `tradeClass "swing"`.
- REQ-LIVE-009 completed: SOUL.md and AGENTS.md carry the switch + veto
  doctrine; the day-trade skill names the scorer's real components.

### Plan for the rest (SPEC work, each a WP with its own REQs; none started)

| Lot (audit) | WP | Scope | Gate |
|---|---|---|---|
| R0 contract + integrity | done here | AUD-04/05(decision)/10/11/12 | this commit |
| R1 four lanes | WP5 | `StrategyContract` (strategyId, holdingHorizon, setupId, exitPolicyId, exitDeadline) as ADDED columns; overnight class with J+1 contract and calendar rules; cup-and-handle lane with detector version and pivot/breakout/retest states; one-idea-per-symbol arbitration; legacy rows marked `legacy` | AUD-01/02/03/07; SPEC + operator decisions on horizons, budgets, exits |
| R2 sizing + exits | WP6 | sizer composes stop, gap-stress, exposure, sector, book and liquidity at creation (whole shares, net viability); per-lane exit policy versioned; no silent post-accept resize | AUD-06/01; the live limits do not move |
| R3 discovery | WP5/WP8 | overnight-continuation and pullback lanes; multi-pattern archive per symbol; conditional scoring per lane | AUD-07/08; point-in-time only |
| R4 statistical proof | done (calibration) + WP5 | schedule decision; per-lane cohorts and verdicts; multi-session clustering review when swing/cup lanes trade | AUD-12/13 |
| R5 rehearsal + promotion | WP3/WP4 machinery | unchanged: paper rehearsal, human `promote`, human `live on` | — |
| Overnight benchmark + candidate archive | WP7 | observable-universe benchmark before the prior close; eligible candidates per lane with timestamps, levels, rejection reasons | AUD-13 |

### Operator decisions this response needs

1. Sequential-test schedule before `epoch new`: keep A (66 % power, ~10 %
   false ACCEPT) or move to B/C (≈5–7 % false ACCEPT, 46–60 % power). Also
   whether to raise replicates to 4,000 (a constant; cost trivial).
2. `keep` semantics: keep REQ-EOD-003 as ratified (overrides hold their
   excess, loudly) or re-ratify keep as a candidacy under the caps.
3. Whether the four-lane program (WP5–WP8) enters the September scope
   fence or follows the paper rehearsal.
4. The 17 legacy rows with unknown outcomes: reconcile from broker
   statements or mark `legacy/unreconciled` (they never enter a look).

### Operator decisions 2026-09-05 (audit response)

1. Sequential-test schedule: **A kept** (99 / 97.5 / 96 / 95, replicates
   1000). The measured 10.3 % false-ACCEPT rate (12.3 % under heavier
   clustering) is accepted for the power it buys (66 % at +0.25 R); the
   constants hash is unchanged.
2. `keep`: **REQ-EOD-003 stands as ratified** — operator overrides hold
   their excess, loudly; AUD-05 is closed as a policy choice, not a defect.
3. Scope: **WP5–WP8 enter the September fence** (four-lane contract, sizer
   composition, overnight benchmark + candidate archive, lane-conditional
   discovery). The discovery's scope fence (no backtest recalibration, no
   new data sources, no options/fractional/second broker) is unchanged.
4. Legacy unknown outcomes: the 17 `agent` rows (2026-07-14..08-06) are
   **marked** `legacy/unreconciled` in `proposals.db` (note appended by
   `scripts/ops/mark-legacy-unknown.ts`, idempotent); they never enter a
   look and are not reconstructed.

The audit document is committed as `AUDIT-2026-09-05.md` with the cleared
points struck through and the open ones pointed at their WP.

## Four-lane contract (2026-09-05) — WP5: strategy identity separate from the risk horizon

Direction confirmed by the operator (AUDIT-2026-09-05.md §3/§10, decision
2026-09-05: WP5–WP8 enter the September fence): expose four strategies —
intraday, overnight, swing, cup-and-handle — with separate evidence, while
the risk machinery stays common. Earnings bets remain a separate experiment.

### Problem

`TradeClass` conflates the strategy with its risk horizon: an overnight
continuation has no contract of its own (it was "a swing"), a cup-and-handle
is a detector output filed under swing, the exit policy is implicit in the
class, and no row records when its thesis expires. The looks therefore
cannot separate lanes, and a horizon violation (a swing held for a month,
an overnight that never leaves) is invisible.

### Domain deltas

- `StrategyId = 'intraday' | 'overnight' | 'swing' | 'cup-and-handle' | 'earnings-bet'`
  (the lane identity); `HoldingHorizon = 'same-session' | 'next-session' |
  'multi-session'`; `ExitPolicyId = 'take-x' | 'ratchet' | 'bracket+deadline'
  | 'structural+deadline' | 'bracket'`. `TradeClass` keeps its meaning: the
  RISK class the sizer, gate, triage and caps operate on.
- Proposal columns (ADDED, never rewritten): `strategy_id`, `setup_id`,
  `holding_horizon`, `exit_policy_id`, `exit_deadline` (epoch ms),
  `deadline_closed_at`, `detector_version`. NULL `strategy_id` = a legacy
  row (pre-WP5), reported apart and never in a lane cohort.
- `src/services/lane-contract.ts`: the deterministic table lane → risk
  class / tif / horizon / exit policy / budget / hold limit, the exit
  deadline calendar math, the stress-composed notional cap.
- Risk-rule keys: `overnight_risk_pct`, `max_overnight_lane_positions`,
  `overnight_entry_window_min`, `overnight_exit_minutes_et`,
  `swing_max_hold_days`, `cup_max_hold_days` — research parameters, ratified
  as such (AUDIT §1: "paramètres de recherche à valider").

### Requirements

- REQ-LANE-001: every proposal carries the contract at creation
  (`strategy_id`, `setup_id`, `holding_horizon`, `exit_policy_id`,
  `detector_version` when a detector produced the setup). The model may name
  `strategyId`/`setupId`; the mapping strategy → risk class → horizon →
  exit policy → budget is DETERMINISTIC (`resolveLaneContract`) and a
  combination that dodges a gate is refused at creation
  (`[lane-contract] REFUSED …`). Omitted `strategyId` derives from the
  class: intraday → intraday, swing → swing, earnings-bet → earnings-bet.
- REQ-LANE-002 (the table):
  | strategy | risk class | tif | horizon | exit policy | deadline | budget |
  |---|---|---|---|---|---|---|
  | intraday | intraday | DAY | same-session | take-x (or ratchet per `exit_style`) | none — the 15:52 triage owns the close | min(rung, ceiling) |
  | overnight | swing | GTC | next-session | bracket+deadline | next trading session at `overnight_exit_minutes_et` (10:00 ET) | `overnight_risk_pct`, stress-composed |
  | swing | swing | GTC | multi-session | structural+deadline | fill + `swing_max_hold_days` trading days at 15:50 ET | `swing_risk_pct`, stress-composed |
  | cup-and-handle | swing | GTC | multi-session | structural+deadline | fill + `cup_max_hold_days` trading days at 15:50 ET | `swing_risk_pct`, stress-composed |
  | earnings-bet | earnings-bet | GTC | next-session | bracket | none | gap-sized (unchanged) |
  Overnight, swing and cup-and-handle share the swing risk pool
  (`max_swing_positions`, `swing_enabled` — disabled on live until each lane
  earns its record; the shadow forcing on paper applies); overnight is
  additionally capped at `max_overnight_lane_positions`. The TIF is an
  execution property: the contract fixes it, the model does not choose it.
- REQ-LANE-003 (deadlines): an overnight proposal is created only at or
  after `overnight_entry_window_min` (15:00 ET) and expires no later
  than the session close (`expiresMinutes` clamped), so an unfilled entry
  dies with the day — the expiry sweep cancels a resting GTC parent past
  `expires_at`; it never arms the next day. The exit deadline is stamped at
  ENTRY FILL (`markEntryFilled`) from the lane's rule and the market
  calendar (weekends, holidays, half-days: a half-day deadline moves to
  12:50 ET). A deadline sweeper (`lane-deadline-sweeper.ts`, every 60 s in
  the regular session) closes a still-open position at or after its
  deadline through the safe close path (`closePosition`), stamps
  `deadline_closed_at`, and reports; a close that does not confirm flat is
  an incident line, never a conversion to a longer lane. Friday → Monday is
  one "next session" with a longer calendar duration, measured as such.
- REQ-LANE-004 (sizing composes the overnight budget, AUD-06 partial): for
  the swing risk class the sizer caps the notional at BOTH
  `max_overnight_position_pct` and the gap-stress budget
  (`max_daily_loss_pct / overnight_gap_stress_pct` × NetLiq, minus the
  stress already carried by the existing overnight book supplied
  server-side), rounds to whole shares and refuses below one share with the
  reason. The accept-time gate and the 15:52 vet are unchanged in force;
  sector/liquidity composition stays in WP6.
- REQ-LANE-005 (cup-and-handle lane): the detector stamps
  `detectorVersion 'v1'` and a `state` — `pivot-ready` (close below the
  pivot) or `breakout-confirmed` (close at/above the pivot, within the
  detector's 2 % ceiling); the nightly scan keeps EVERY match per symbol
  (`matches[]`) while ranking by the strongest; a cup-and-handle proposal
  carries `strategyId 'cup-and-handle'`, `setupId 'cup-and-handle'`,
  `detectorVersion`, the swing risk class and `cup_max_hold_days`. Detection
  quality and trade performance are evaluated apart (the lane cohort vs the
  scan archive).
- REQ-LANE-006 (per-lane cohorts): the epoch sample carries `strategyId`;
  the deployable verdict stays the deployable lane set (the classes enabled
  in the live yaml — today intraday); every other lane is reported with its
  own running stats in the digest and `/api/loop`; the simulator adds
  `lane-overnight`, `lane-cup-and-handle` (by strategy) and `exit-fixed-3`
  (intraday rows: target at +3 % from entry, stop unchanged — the AUD-01
  comparison against the formula and the structural target); `class-swing`
  keeps the swing lane and legacy swing rows.
- REQ-LANE-007 (legacy): rows without `strategy_id` are `legacy`; they are
  never reclassified from current settings and never enter a lane cohort.
- REQ-LANE-008 (surfaces): the `trade_proposals` tool exposes `strategyId`
  and `setupId`; the Pre-Close cron registers overnight setups as
  `strategyId "overnight"` (swing class, GTC, expiry before the bell,
  quantity omitted) and the Pre-Market cron labels cup-and-handle
  candidates; `swing_patterns` returns states and the detector version;
  RULES.md, the overnight skill, USER-MANUAL and AUTOMATION describe the
  lanes and the deadline sweeper.
- REQ-LANE-009 (AUD-02 research, no runtime change):
  `scripts/remaining-excursion.ts` tabulates post-entry MFE/MAE by entry
  hour, class and lane from the closed ledger — the evidence a
  time-remaining target rule would be built on.

### Invariants

- The lane never loosens a gate: every lane passes the same risk gate,
  kill-switch, epoch latch, vet and guard as before; the contract only adds
  refusals (window, horizon, TIF) and deadlines.
- No silent post-accept resize; a deadline close is a close, never a
  reclassification; a keep never changes `strategy_id`.
- Exits, triage, guardian and `close`/`kill` are never gated by a lane.

### Non-goals (WP5)

Sector/liquidity composition in the sizer (WP6); an overnight benchmark and
the eligible-candidate archive (WP7); lane-conditional scoring (WP8);
retest-state detection for cup-and-handle (needs archived breakout history);
a distinct `overnight` risk class (the swing class is the overnight-capable
class; a separate class would duplicate caps and triage paths for no
evidence gain).

### Acceptance criteria

- [ ] `resolveLaneContract` table pinned; overnight outside its window,
      overnight with expiry past the close, intraday GTC, cup/overnight on a
      non-swing class all refused (REQ-LANE-001/002/003)
- [ ] deadlines: Friday fill → Monday 10:00 ET; holiday skipped; half-day
      → 12:50 ET; swing fill + 10 trading days at 15:50 ET (REQ-LANE-003)
- [ ] deadline sweeper: due rows selected, closed via the safe path, stamped;
      not-yet-due and already-flat rows untouched (REQ-LANE-003)
- [ ] sizer: swing-class notional capped by the stress budget minus the
      existing book; overnight lane uses `overnight_risk_pct` (REQ-LANE-004)
- [ ] detector states and versions; scan keeps all matches (REQ-LANE-005)
- [ ] sample/digest/simulator lanes; legacy NULL apart (REQ-LANE-006/007)
- [ ] tool schema, crons, skills, docs (REQ-LANE-008); research script runs
      read-only (REQ-LANE-009)

### WP5 landed (2026-09-05) — precisions and traceability

Landed before epoch 1 opened (the restart carries WP1..WP5; the identity
moves once more). The ephemeral `docs/day2day/WP5-PLAN.md` carries the task
graph for the review.

Precisions recorded at landing (append-only):

- REQ-LANE-001 precision: the contract is resolved in `createProposal`
  AFTER the risk gate and before persistence; the tool derives the class
  from the lane (`laneClassOf`) so the model may omit `tradeClass`; an
  explicit class that contradicts the lane is a tool error, never an
  override. `detectorVersion` is filled server-side from the latest pattern
  scan for a cup-and-handle proposal.
- REQ-LANE-002 precision: no new `TradeClass` — overnight and cup-and-handle
  ride the swing class, so `swing_enabled: false` on live disables all three
  lanes together and the shadow forcing on paper enables them together.
  The overnight lane counts in `max_swing_positions` AND
  `max_overnight_lane_positions`.
- REQ-LANE-003 precision: the deadline is stamped by `markEntryFilled` on
  the FIRST fill only (a cumulative re-fill never moves it); the sweeper
  stamps `deadline_closed_at` BEFORE issuing the close, so a crash mid-close
  cannot re-fire it; a row already flat at its deadline is stamped without
  an order (the bracket exit owns the close). The half-day pull is to close
  − 10 min (12:50 ET). The overnight entry expiry is refused, not silently
  clamped, when it passes the close (the message names the maximum
  `expiresMinutes`).
- REQ-LANE-004 precision: the stress cap is per NEW position against the
  budget minus the stress the existing overnight book already carries
  (server-side from `listExposure`: swing/earnings-bet rows and kept
  intraday rows, at fill or planned entry). The per-position overnight cap
  binds alongside; both apply with the 0.5 % cap-drift margin. Earnings
  bets keep their gap sizing (the stress cap does not apply to that class).
- REQ-LANE-005 precision: `state` is 'breakout-confirmed' when the last
  close is at/above the pivot (the detector's own 2 % ceiling excludes
  extended breakouts), else 'pivot-ready'; the snapshot carries
  `detectorVersion` and every candidate its `matches[]`.
- REQ-LANE-006 precision: the epoch sample marks a row without a lane
  `legacy` and files it with the shadow rows (never deployable, never a
  lane cohort); lane stats run over deployable AND shadow rows; the digest
  adds one "Lanes:" line. The simulator rebuilds a reopened row's lane from
  the variant that opened it.
- Exit attribution: a deadline close is tracked like every deliberate close
  (`manual` at the tracker) with `deadline_closed_at` as the distinguishing
  stamp — no new `ExitReason`.

| REQ | Test |
|---|---|
| REQ-LANE-001 | `lane-contract.test.ts` (derivation, class/TIF refusals, setup normalisation); `tools/proposals/index.test.ts` (`laneClassOf`, `coherent`); `trade-proposals.test.ts` (contract persisted, cup lane) |
| REQ-LANE-002 | `lane-contract.test.ts` (table pin, exit policies); `trade-proposals.test.ts` (overnight lane cap) |
| REQ-LANE-003 | `lane-contract.test.ts` (window, expiry clamp, deadlines: Fri→Mon, Labor Day, half-day, +10/+15 trading days); `trade-proposals.test.ts` (deadline at first fill, due listing, one attempt); `lane-deadline-sweeper.test.ts` (select, close, already flat, incidents, throw) |
| REQ-LANE-004 | `lane-contract.test.ts` (`stressNotionalCapUsd`); `position-sizer.test.ts` (stress and overnight caps bind, book eats the budget, overnight budget key, intraday untouched, stress 0) |
| REQ-LANE-005 | `pattern-detectors.test.ts` (version, state); scan shape by type (`matches[]`, `detectorVersion`) |
| REQ-LANE-006 | `loop/sample.test.ts` (lane on rows, legacy apart); `loop/digest.test.ts` (Lanes line); `simulator/variants.test.ts` (`exit-fixed-3`, `lane-overnight`, `lane-cup-and-handle`, `class-swing` scope, overnight entry deadline) |
| REQ-LANE-007 | `loop/sample.test.ts` (NULL lane → legacy) |
| REQ-LANE-008 | doc/cron/skill/rule changes; `risk-rules-validation.test.ts` (the six keys load) |
| REQ-LANE-009 | `scripts/remaining-excursion.ts` smoke-run read-only |

### Bootstrap upgrade (2026-09-05, operator: "add bootstrap if it helps") — REQ-SEQ-002 amended

- Replicates 1,000 → **10,000** (`SEQ_CONSTANTS.bootstrap.replicates`): the
  99 % look's 1 % tail now rests on 100 draws instead of 10 (AUD-12c). The
  constants hash changes; epoch 1 has not opened, so no epoch is affected.
- `dayBlockBootstrapLcb` gains `blockDays` (moving session blocks over
  chronologically ordered days; L = 1 is byte-identical to the previous
  behaviour). **Kept at 1** for the pre-registered test: the calibration
  (`--block 5 --reps 10000 --sims 1000`, iid daily shocks) shows 5-session
  blocks RAISE the false-ACCEPT rate of schedule A from 11.0 % to 19.1 %
  (9.6 points at the n = 25 look alone) and of schedule B from 5.5 % to
  15.2 %: a 10-day sample yields two blocks and the bootstrap degenerates.
  Blocks are the right tool for long cohorts (the swing and cup lanes at
  100+ sessions), not for the early looks; the option stays available and
  is re-evaluated when those lanes reach their looks.
- Informational alongside every look and lane line: **net USD with variable
  costs doubled** (`RunningStats.netUsdCostsDoubled`, commissions counted
  twice) — never a criterion, always printed in the digest.
- Not adopted: daily marked returns including flat days as the test unit
  (the pre-registered unit stays R per trade, paired by entry day —
  discovery decision), Bonferroni 98.75 % (schedule A kept by operator
  decision), and the exploratory-then-confirmation redesign.

## Sizer composition (2026-09-05) — WP6: every budget composed at creation

Completes AUD-06 and adds the cost dimension of AUD-01. WP5 taught the sizer
the overnight budget; the remaining caps the acceptance gate enforces were
still unknown to the sizer, so a correctly-budgeted proposal could be
refused later for a constraint knowable at creation, and nothing priced the
round trip against the target.

### Domain deltas

- `src/services/book-context.ts`: `buildBookContext` — the pure book sums
  both paths use (open positions, class counts, per-symbol notional,
  planned stop-out risk with unpriceable rows LISTED, overnight notional and
  class-aware stressed loss, same-sector notional).
- `src/services/trade-costs.ts`: the cost model (commissions per side,
  spread crossing, slippage) and `costToTargetPct`.
- `SizeInput.book` + `SizeInput.target`; `SizeResult.binding`
  ('risk' | 'position-cap' | 'symbol-aggregate' | 'headroom' | 'overnight' |
  'sector' | 'adv' | 'costs') and `caps` (the share count each constraint
  allowed).
- Proposal column `cost_to_target_pct` (REAL): the estimate at creation.
- Rules keys: `commission_per_share_usd` (0.005), `commission_min_usd`
  (1.0), `slippage_bps` (5), `max_cost_to_target_pct` (20).

### Requirements

- REQ-SIZE-001: at creation the tool assembles the book context from the
  proposals store (working + filled rows priced at the worst entry basis),
  today's realized losses, the symbol's sector (live resolution; UNKNOWN
  bucket on a miss; skipped in tests), the 20-day ADV and the live spread
  when a quote exists. No broker call at creation.
- REQ-SIZE-002: the sizer's quantity is the minimum over risk budget,
  position cap, per-symbol aggregate room, daily-loss headroom (planned
  stop-outs of the open book plus today's realized losses), overnight
  position cap, overnight book cap and class-aware stress room (swing class),
  sector room and ADV (`max_adv_pct`), floored to whole shares; below one
  share it refuses naming the binding constraint; the result names the
  binding constraint and every cap's share count.
- REQ-SIZE-003 (net viability): the estimated round-trip cost (two
  commissions at the IBKR fixed model, one spread crossing, slippage both
  sides) must not exceed `max_cost_to_target_pct` of the gross gain at the
  target, else the proposal is refused with the numbers; the estimate is
  stamped on the proposal (`cost_to_target_pct`).
- REQ-SIZE-004 (parity): the creation-time gate receives the same context
  the sizer used, so a sized proposal passes `checkProposalRisk` by
  construction; the acceptance gate re-checks with fresh marks and the
  broker union (REQ-EXPO-*), and a drift refuses.
- REQ-SIZE-005 (no silent resize): acceptance never changes `quantity`; the
  only quantity change after acceptance is the partial-fill downgrade with
  `planned_quantity` preserved (existing). Pinned by test.
- REQ-SIZE-006: the accept path computes its four pure book sums through
  `buildBookContext` (adopted-row verification and the broker union stay in
  the executor), so the two paths cannot drift in formula.

### Invariants

- Sizing never loosens a cap: every constraint the accept gate enforces is
  either composed at creation or re-checked at acceptance, and the stricter
  binds.
- An unpriceable open row never counts as zero risk: creation skips the
  headroom cap WITH a note; acceptance refuses.

### Non-goals (WP6)

Broker-marked exposure at creation (accept-time only); realized-slippage
calibration of the cost model (the observed twin slippage feeds it later);
liquidity-adjusted ADV per session.

### Acceptance criteria

- [x] each cap binds and names itself; refusal reasons carry the binding constraint (REQ-SIZE-002)
- [x] costs above the ratio refuse; the ratio is stamped (REQ-SIZE-003)
- [x] a sized proposal passes the creation gate with the same context (REQ-SIZE-004)
- [x] the accept path's sums equal the builder's on the same rows (REQ-SIZE-006)
- [x] yaml keys load; docs name the composition (REQ-SIZE-001)

### Landed (2026-09-05) — WP6 precisions and traceability

- REQ-SIZE-001 precision: the tool prices the creation-time book with
  `worstEntryNotional` (fill, else max(entry, limit)); realized losses come
  from `sumRealizedPnlSince(etDayStartMs())`, the daily count from
  `countExecutedSince`; NetLiq from the daily-loss guard (live only) feeds
  both the sizer and the creation gate's account caps. Sector resolution is
  live-only (`getSectorInfo`, 'UNKNOWN' bucket); in tests sectors are
  unknown and the sector cap skips.
- REQ-SIZE-002 precision: the binding constraint is the smallest cap, ties
  broken in the order risk, position-cap, symbol-aggregate, headroom,
  overnight, sector, adv. Headroom uses the raw stop distance (no drift
  margin: risk, not notional); the notional rooms apply the 0.5 % cap-drift
  margin like the position cap. A missing book field skips its cap (never a
  fake zero): the planned-risk field is omitted when the builder lists an
  unpriceable row. The overnight composition supersedes WP5's
  `overnightBookNotionalUsd` when `book.overnightStressedLossUsd` is
  supplied (the old input remains as a fallback).
- REQ-SIZE-003 precision: `estimateRoundTrip` rounds each component to
  cents and the ratio to 0.1 %; an unknown spread counts commissions and
  slippage only and is flagged `spreadKnown: false` in the refusal text.
  `max_cost_to_target_pct: 0` disables the check. With an EXPLICIT quantity
  the ratio is stamped but not enforced (the operator chose the size).
  Refusals are recorded in the refusal ledger as `sizer refused [<binding>]`.
- REQ-SIZE-004 precision: the creation gate now receives `netLiquidation`
  (when known), `openPositions`, `executedToday`, `openSwingPositions`,
  `openEarningsBets`, `existingSymbolExposure`, `openPlannedRiskUsd` (when
  priceable), `realizedLossTodayUsd`, `overnightExposureUsd`,
  `overnightStressedLossUsd`, `sector` + `sameSectorExposureUsd` (when
  resolved) — so the slot, daily-trade, headroom, overnight and sector caps
  refuse at CREATION for an explicit quantity too, where before they first
  bit at accept.
- REQ-SIZE-006 precision: the accept path keeps the broker union maxes
  (symbol notional, distinct-symbol count), the fresh marks and the adopted
  protection verification; it passes `adoptedRiskUsd` into the builder and
  turns the builder's `unpriceableRows` into the two pre-existing refusals
  ("missed protection verification", "no usable price basis"). The
  `sameSectorExposureUsd` it reads is the builder's (0 when null).
- Test infrastructure: `__rebindStoreForTests()` — Bun runs every test file
  in one process and the proposals store caches its handle, so a file that
  isolates its own `DEXTER_DATA_DIR` inherited the first file's DB. The
  tool test now rebinds; without it the WP6 creation-time daily-trade cap
  sees other files' executed rows (46 > 20) and refuses.
- Rules keys land in `risk-rules.yaml` (the live profile layers on top and
  inherits them; identical values on both profiles).

| REQ | Test |
|---|---|
| REQ-SIZE-001 | `book-context.test.ts` (counts, aggregate, planned risk, overnight + class-aware stress, sector; unpriceable rows listed, adopted override); `tools/proposals/index.test.ts` (creation still passes with the book wired, isolated store) |
| REQ-SIZE-002 | `position-sizer.test.ts` "WP6" block (binding named, caps listed; headroom incl. realized losses and no expansion on wins; symbol/sector/ADV rooms; swing class stress + book cap) |
| REQ-SIZE-003 | `trade-costs.test.ts` (per-side commission floor, round trip, ratio, unknown spread, viability, cap 0); `position-sizer.test.ts` (2-share refusal at +3 %, viable size reports the ratio, no target → no check) |
| REQ-SIZE-004 | `sizer-gate-parity.test.ts` (intraday crowded book: sized quantity passes `checkProposalRisk`, one more share refuses; swing GTC stress-composed quantity passes the overnight checks) |
| REQ-SIZE-005 | `outcome-tracker-partial.test.ts` (partial-fill downgrade keeps `plannedQuantity`; the only `quantity = ?` UPDATE in `trade-proposals.ts` is that downgrade) |
| REQ-SIZE-006 | executor refactor covered by `book-context.test.ts` formulas + the existing executor suites (`proposal-executor*.test.ts`) — same refusal texts |
| rules | `risk-rules-validation.test.ts` (both profiles load with the four keys; schema bounds) |

Acceptance criteria above: all checked at landing (`bun test` 1083 pass,
`tsc --noEmit` clean, Jest 1064 pass under Node).

Plan decisions 1–5 (`docs/day2day/WP6-PLAN.md`) are implemented as written
and await ratification at the review.

### Block-bootstrap sensitivity under regime streaks (2026-09-05, note to REQ-SEQ-002)

Second calibration run, daily shocks autocorrelated at ρ = 0.5 (`--rho 0.5
--block 5 --reps 10000 --sims 1000`): schedule A false-ACCEPT 11.0 % → 14.1 %
(blocks of 5: 20.9 %), schedule B 5.5 % → 8.8 % (blocks of 5: 17.6 %); power
at +0.25 R unchanged (A 65.5 %, B 47.6 %). Streaky tapes inflate every
schedule's false-ACCEPT by roughly three points; 5-session blocks still hurt
at the early looks for the same degeneracy reason. Decision unchanged:
`blockDays` stays 1, schedule A stays. Where the realised false-ACCEPT rate is
quoted (VALIDATION-JOURNAL), 11–14 % is the honest range, not 11 % alone.

## Overnight benchmark and candidate archive (2026-09-05) — WP7

Closes AUD-13. The intraday benchmark treats the opening gap as
uncapturable and the simulator replays proposals and refusals only; an
overnight selection is a bet on the gap, and the candidates the judgment
never admitted leave no trace. WP7 archives the observable universe
point-in-time before the close, gives every eligible overnight candidate a
mechanical twin under the lane contract, joins each candidate to what the
system did with it, and reports the common perimeter nightly. It first
fixes the bar loader whose coverage check read the overnight gap as a hole
(every GTC twin settled before this date is 'unknown' for that reason).

### Domain deltas

- `src/services/simulator/bars.ts`: `sessionSegments(fromT, toT, cal)` and
  `coverageOkAcross` — coverage is judged per regular-session segment
  intersecting the window; the gap between sessions is not a hole.
- `src/services/candidate-archive.ts`: `candidate-archive.db` table
  `candidates` (UNIQUE(day, lane, symbol)); `CandidateRow` (capture,
  eligibility + reasons, versioned levels, disposition, replay outcome);
  pure `overnightEligibility`, `overnightLevels`, `cupEligibility`,
  `cupLevels`, `candidatesFromSnapshot`, `candidatesFromPatternScan`,
  `disposeCandidates`; `captureCandidatesOnce(deps)`; cron 15:35 ET.
- `src/services/overnight-benchmark.ts`: `runOvernightBenchmarkOnce(deps)`,
  `formatOvernightReport`.
- `CANDIDATE_LEVELS_VERSION = 'v1'`; env `CANDIDATE_ARCHIVE` (default on).

### Requirements

- REQ-SIM-003 amended: bar coverage is judged per regular-session segment
  (09:30–16:00 ET, 13:00 on a half-day; weekends and holidays skipped)
  intersecting the window — every segment must be covered without a gap
  over the tolerance, the space between segments is not a hole. GTC rows
  replay on regular-session bars only (Dexter's brackets never set
  `outsideRth`; the gap-aware stop already prices an open through the
  stop). The earlier "GTC rows may fill in extended hours" assumption is
  withdrawn.
- REQ-BENCH-001 (point-in-time archive): once per trading day at 15:35 ET
  the candidate archive captures, per lane, the observable universe — the
  overnight lane from the latest pre-close opportunity snapshot (every
  scored candidate, with the snapshot timestamp as source), the
  cup-and-handle lane from the latest nightly pattern scan (cup matches
  only, with detector version and state). Each row carries the capture
  time, the observed price, daily ATR, day move, rank, the lane's mechanical
  levels and their version. The first capture of a (day, lane, symbol)
  stands; later captures the same day are ignored. A day without a capture
  has no universe (reported, never backfilled).
- REQ-BENCH-002 (deterministic eligibility): a row is `eligible` when the
  deterministic subset of the lane's rules holds, else `ineligible` with
  the reasons listed: overnight — `stale-data`, `price-missing`,
  `min-price`, `atr-missing`, `day-move-unknown`, `counter-move`,
  `earnings-within-2d` (calendar unknown → eligible with `note:earnings-unknown`);
  cup — `stale-scan` (last bar older than the prior session), `not-cup`.
  LLM reasons are never reconstructed.
- REQ-BENCH-003 (disposition): at replay each overnight row is joined to
  the day's ledger for its symbol — `proposed` (an overnight-lane proposal
  created that day, ref = proposal id), `refused` (a refusal recorded that
  day in the pre-close window, ref = gate), else `not-admitted`.
- REQ-BENCH-004 (mechanical twin v1, pessimistic): entry MKT at the first
  bar after capture (fill-model semantics), stop = price ∓
  `stop_atr_multiplier` × daily ATR, target = price ± take-x % of price
  (`formulaTakePct` on ATR %), flat at the overnight lane deadline
  (`laneExitDeadline('overnight', capturedAt)`); bars through the
  simulator loader (stream → archive → IBKR), no covered source → `unknown`;
  sized at the current rung against the epoch NetLiq, simulator
  commissions, `netR` against |price − stop| × quantity; gap % = the next
  session's first bar open vs the capture price, signed toward the
  direction. Outcomes persist on the candidate row; a row is replayed once
  (status `settled` / `unknown`), pending rows older than 5 days are
  marked `unknown: expired`.
- REQ-BENCH-005 (report): after the nightly settle, one line block per
  capture day replayed: eligible / seen counts with the ineligibility
  reasons tallied; the universe's n, mean R, W/L/F, gap median and the
  count of adverse gaps beyond the overnight stress; the top-5-by-rank
  mean R; the judgment's proposed rows with their twin R; refused rows by
  gate; the not-admitted mean R; unknowns. Delivered through the simulator
  report callbacks (WhatsApp).
- REQ-BENCH-006 (observability only): the candidate archive and the
  overnight benchmark never write `sim_trades` or `proposals`, hold no
  order ids, and no look, ladder or verdict reads `candidates`.
- REQ-BENCH-007 (archive universe): the nightly bar archive adds the
  symbols of OPEN GTC rows (multi-session twins need every session) and the
  prior day's eligible candidates (their next-session bars), after the
  watchlist and today's proposal symbols, before the snapshot symbols; the
  cap and its warning are unchanged.

### Invariants

- Nothing archived is ever re-priced: a candidate's price, ATR, levels and
  version are the values observed at capture.
- The mechanical twin never flatters: the same fill model as the simulator
  (trade-through, stop-first ties, gap-aware stops, MKT at the next bar).
- The benchmark never feeds a look; the lane verdicts read the epoch
  sample only.

### Non-goals (WP7)

Replaying cup-and-handle candidates (15-session horizon — with the swing
benchmark, later); reconstructing the judgment's reasons; a portfolio
simulation with budgets and competition among candidates (the common
perimeter is per candidate, R per unit risk); a retroactive universe for
days before the archive existed.

### Acceptance criteria

- [x] a two-session GTC window is covered by two session blocks; a hole inside a session still fails; weekends and half-days are honoured (REQ-SIM-003)
- [x] capture builds rows with eligibility reasons and v1 levels; the first capture of a day stands (REQ-BENCH-001/002)
- [x] disposition join names proposed / refused:<gate> / not-admitted (REQ-BENCH-003)
- [x] the twin replays with the pessimistic model, computes the gap and R, and persists once (REQ-BENCH-004)
- [x] the report lists universe / top-5 / judgment / not-admitted / unknown (REQ-BENCH-005)
- [x] the archive universe adds open-GTC symbols and prior-day candidates within the cap (REQ-BENCH-007)

### Landed (2026-09-05) — WP7 precisions and traceability

- REQ-SIM-003 precision: `sessionSegments` builds one segment per trading
  day of the window (ET-frame day arithmetic; weekend by day-of-week,
  holiday and half-day from the market calendar); a segment's end is the
  earlier of the window end and the session close — the window-end bar
  (the deadline bar) is inside the segment, a bar stamped at the close is
  not. `loadSimBars` with `rth: true` judges every segment; `rth: false`
  keeps the legacy single-window judgement (no production caller). The
  settle passes `rth: true` for every row. Evidence of the defect: every
  GTC twin in `simulator.db` before this date carries "no covered bar
  source" (the only GTC rows are unknown).
- REQ-LANE-006 precision: the `lane-overnight` variant now flattens at the
  lane deadline (`VariantContext.overnightFlatAtFor`, 10:00 ET next
  session) as the sweeper closes the real row; before, its twin stayed
  open until a level was hit.
- REQ-BENCH-001 precision: the capture reads the engine's in-memory latest
  snapshot and requires phase `pre-close` with today's date; the cup lane
  reads the persisted pattern-scan file. Daily ATR comes from
  `fetchDailyRiskContext` per candidate (fail → `atr-missing`); earnings
  from `findUpcomingEarnings(symbols, 2)` (an unknown calendar day →
  `null` for every symbol → `note:earnings-unknown`). A capture on a
  market holiday is skipped.
- REQ-BENCH-002 precision: `levels-invalid` marks a row whose mechanical
  geometry is impossible (stop through zero); it replaces the earnings
  note. Duplicate symbols in a snapshot keep the higher rank.
- REQ-BENCH-003 precision: the disposition join runs every night over the
  rows of the days replayed (including rows not yet due), so a proposal
  registered after the capture is still credited; the cup lane also
  accepts a cup-lane proposal created within the next two calendar days
  (the Pre-Market Brief proposes the morning after the scan).
- REQ-BENCH-004 precision: the MKT entry window is one hour after capture
  (a capture after the close finds no bar and settles `unfilled`, honest);
  `open` at the end of the bars (the deadline bar missing) is `unknown`
  with the note "bars ended before the deadline bar"; 0 shares at the rung
  settles with the outcome and `netR` null ("R undefined"); `gapPct` is
  computed even when the twin does not fill.
- REQ-BENCH-005 precision: mean R over settled rows with a defined R; the
  adverse-gap count uses `overnight_gap_stress_pct`; the report is sent
  once per capture day replayed that night, through the simulator
  callbacks, after the settle report and before the looks.
- REQ-BENCH-007 precision: "open GTC rows" = `listExposure()` rows with
  `tif = 'GTC'` (executing/executed); "prior day" = the most recent
  overnight capture day strictly before today. The cap warning now states
  how many symbols were dropped.
- Not touched: the intraday benchmark (`benchmark.ts`) and its ledger.

| REQ | Test |
|---|---|
| REQ-SIM-003 (amended) | `simulator/bars.test.ts` (segments: two-session window, weekend/holiday/half-day, outside-session; coverage across; segment filter; `loadSimBars` two-session archive covered, legacy judgement refuses) |
| REQ-LANE-006 (precision) | `simulator/variants.test.ts` fixture (`overnightFlatAtFor`); `settle.ts` context |
| REQ-BENCH-001 | `candidate-archive.test.ts` (snapshot → rows, dedupe, levels + deadline, cup lane archived not replayed, first capture stands, capture skips) |
| REQ-BENCH-002 | `candidate-archive.test.ts` (every reason named; earnings note; levels v1 long/short/impossible; cup levels) |
| REQ-BENCH-003 | `candidate-archive.test.ts` (proposed / refused in the pre-close window / not admitted; another lane does not count); `overnight-benchmark.test.ts` (join at replay, credited in the report) |
| REQ-BENCH-004 | `overnight-benchmark.test.ts` (twin spec, gap signed, eod-flat at 10:00 with R at the rung, stop through the open at the open, no bars → unknown, not due untouched, horizon expiry) |
| REQ-BENCH-005 | `overnight-benchmark.test.ts` (`formatOvernightReport`: tallies, universe, top-5, judgment, gaps) |
| REQ-BENCH-006 | structural: `candidate-archive.db` has no order-id columns; no import of `candidate-archive.js` outside `overnight-benchmark.ts`, `simulator/index.ts`, `archive-scheduler.ts`, `gateway.ts` and the script |
| REQ-BENCH-007 | `archive-scheduler.test.ts` (`orderArchiveUniverse` priority, case-fold, cap, dropped count) |

Plan decisions 1–6 (`docs/day2day/WP7-PLAN.md`) are implemented as written
and await ratification at the review.

Harness at landing: `bun test` 1102 pass (101 files), `tsc --noEmit` clean, Jest 1083 pass under Node. The read-only script runs without an archive ("no candidate archive yet").

## Lane-conditional discovery and scoring (2026-09-05) — WP8

Closes AUD-08 and the discovery half of AUD-07. One generic composite
ranked every candidate for every consumer; the pre-close overnight
selection read a list built for intraday momentum; the digest pooled the
model's confidence scores across lanes; no chronological harness validated
a ranking against outcomes independently of any weight choice. The
intraday composite and the trigger bar are unchanged (ratified funnel).

### Domain deltas

- `src/services/lane-rankers.ts`: `RANKER_VERSIONS` (intraday
  `composite-v1`, overnight `eod-continuation-v1`, cup `detector-v1`),
  `scoreOvernight` / `rankOvernight` (pure), `buildSnapshotLanes`,
  `laneRankFor(strategyId, symbol, sources)`.
- `Opportunity.dailyAtrPct` (additive); `OpportunitySnapshot.lanes`
  (additive, persisted in the snapshot JSON).
- `opportunities` tool: `lane: "overnight"` returns the lane view.
- Proposal columns `lane_rank REAL`, `ranker_version TEXT`; `RTrade.laneRank`
  / `rankerVersion`; `LoopStatus.rankByLane` replaces `decile`.
- `candidates.ranker_version` (WP7 archive) — the overnight row's rank is
  the lane score when the snapshot carries lanes.
- `scripts/validate-lane-ranker.ts`.

### Requirements

- REQ-DISC-001 (lane rankers, pure and versioned): the overnight ranker
  `eod-continuation-v1` scores 0–100 = significance (0–40, |day move| /
  daily ATR %, linear to 3×) + closing strength (0–20, price vs VWAP toward
  the direction, linear to +2 %) + liquidity (0–20, log10 dollar volume,
  $1M → 0, $100M → 20) + RVOL (0–20, linear to 3×); a stale, unpriced,
  ATR-less, move-unknown or counter-move candidate is excluded (score
  null) with the reason; a missing optional input scores 0 with a `note:`.
  The intraday ranking is the engine's composite unchanged, named
  `composite-v1`; the cup lane's is the detector score, `detector-v1`;
  swing and earnings-bet have none.
- REQ-DISC-002 (snapshot lanes): every snapshot carries `lanes.overnight`
  (ranker version + the ranked rows, excluded rows last) over the same
  scored candidates; the `opportunities` tool exposes it with `lane:
  "overnight"` (factors, reasons, the composite as context only), and the
  Pre-Close Review and the overnight skill read that view.
- REQ-DISC-003 (provenance on proposals): at creation the tool resolves
  the lane rank SERVER-SIDE — intraday: the trigger rank, else the latest
  snapshot's composite; overnight: the latest snapshot's lane score; cup:
  the pattern scan's cup score — and stamps `lane_rank` and
  `ranker_version`; a symbol the ranker never saw gets a null rank with
  the version recorded. The model cannot pass either. The epoch sample
  carries both; the candidate archive's overnight rows take the lane score
  and its version (the composite, labelled, when the snapshot predates
  WP8 or the row was excluded).
- REQ-DISC-004 (cohort-only comparability): the pooled "score deciles"
  line is retired; the nightly status reports Spearman(lane rank, R) PER
  LANE over the sample rows carrying a rank (the legacy lane from the
  model's score, its only rank), with the ranker version, omitting lanes
  with fewer than 5 pairs; never pooled across lanes.
- REQ-DISC-005 (chronological validation): `scripts/validate-lane-ranker.ts`
  gathers per lane every ranked outcome (closed ledger rows with a lane
  rank; the settled overnight twins of the candidate archive), splits the
  DAYS chronologically (first 60 % selection, last 40 % validation) and
  reports on each half n, Spearman rank→R and the top-tercile-by-rank mean
  R against the rest, with the ranker versions and the composite's weight
  provenance; under 20 rows per half it says "insufficient"; it writes
  nothing. A reweighting is earned only when the validation half agrees
  with the selection half.
- REQ-DISC-006 (flat sizing confidence): `sizing_half_mult` and
  `sizing_low_mult` stay 1.0 on both profiles until REQ-DISC-005 shows a
  lane's rank→R holds out of sample; the word "probability" is not used
  for any lane score.

### Invariants

- A lane score is never compared to another lane's score, and never
  enters a look, a ladder or a verdict.
- The intraday composite and the trigger bar are unchanged by WP8 (the
  fingerprint changes only through the additive `dailyAtrPct` field).
- Provenance is stamped by the server; the model's inputs cannot set it.

### Non-goals (WP8)

New discovery scans (an intraday pullback lane needs its own scan family —
the WP7 archive is where to measure it first); reweighting the scorer or
the overnight ranker (the harness comes first); calibrated probabilities;
a lane ranking for swing or earnings-bet.

### Acceptance criteria

- [x] factor pins, exclusions, ordering and per-lane provenance resolution (REQ-DISC-001/003)
- [x] the snapshot carries the overnight lane and the tool exposes it (REQ-DISC-002)
- [x] lane rank + ranker version persisted on proposals and carried into the sample (REQ-DISC-003)
- [x] rank→R per lane, never pooled, in the digest and the scorecard (REQ-DISC-004)
- [x] the harness runs read-only against the live data directory (REQ-DISC-005)
- [x] sizing multipliers flat on both profiles (REQ-DISC-006)

### Landed (2026-09-05) — WP8 precisions and traceability

- REQ-DISC-001 precision: factor points are rounded to 0.1 and the score to
  the unit; a short's closing strength is measured BELOW the VWAP (the
  mirror). The ranker reads `Opportunity.dailyAtrPct`, the engine's own
  significance denominator, so the lane score and the composite's move
  term rest on one measure.
- REQ-DISC-002 precision: `lanes` is built on every cycle whatever the
  phase (cheap, pure) — the pre-close capture (WP7) reads the pre-close
  snapshot's lane. A snapshot persisted before WP8 has no `lanes`; the
  tool answers "call with action refresh" rather than ranking by the
  composite under the lane's name.
- REQ-DISC-003 precision: the trigger rank wins over the snapshot
  composite for the intraday lane (a trigger-lane run knows the rank that
  fired it); the cup lane reads the cup match's score even when a stronger
  other pattern ranks the symbol (REQ-LANE-005 multi-match archive). The
  candidate archive's `ranker_version` column is added to the WP7 table
  with an idempotent ALTER (no archive exists yet in production).
- REQ-DISC-004 precision: `rankByLane` runs over deployable AND shadow
  rows (per lane), reports the most frequent ranker version among the
  lane's ranked rows, and omits a lane under 5 pairs; the digest line
  reads "Rank→R per lane (never pooled): …" or "n/a (fewer than 5 ranked
  rows per lane)". `LoopStatus.decile` no longer exists (the scorecard's
  print follows).
- REQ-DISC-005 precision: R for ledger rows is (realized − commissions) /
  (|fill − stop| × quantity); rows without a fill or a lane rank are out;
  a ledger written before the WP8 migration is reported as such. Smoke-run
  today: "no ranked outcomes yet", weight provenance printed from
  `scorer-weights.json` (flat 0.25 ×4 with the rejected 2026-07-07
  calibration on record).
- REQ-DISC-006: verified by inspection — `sizing_half_mult` and
  `sizing_low_mult` are 1.0 in `DEFAULT_RULES` and in the live profile.
- Consumers: the Pre-Close Review message and `src/skills/overnight/SKILL.md`
  § 4.1 read `opportunities` with lane "overnight". The Pre-Market Brief
  and the trigger lane are unchanged.

| REQ | Test |
|---|---|
| REQ-DISC-001 | `lane-rankers.test.ts` (factor pins at 2× ATR / +1 % VWAP / $100M / RVOL 2 → 70; caps → 100; short mirror; every exclusion reason; missing optional inputs) |
| REQ-DISC-002 | `lane-rankers.test.ts` (`rankOvernight` order, excluded last; `buildSnapshotLanes` version); tool view by type |
| REQ-DISC-003 | `lane-rankers.test.ts` (`laneRankFor`: trigger rank, composite fallback, lane score, cup score, swing/bet none, unseen symbol → null with version); `candidate-archive.test.ts` (lane score + version on the row, composite labelled for excluded/pre-WP8, cup `detector-v1`) |
| REQ-DISC-004 | `loop/looks.test.ts` (`rankByLane`: +1 intraday, −1 overnight, legacy from score, swing omitted, < 5 pairs omitted); `loop/digest.test.ts` (the line) |
| REQ-DISC-005 | `scripts/validate-lane-ranker.ts` smoke-run read-only |
| REQ-DISC-006 | inspection (`DEFAULT_RULES`, `risk-rules.live.yaml`) |

Plan decisions 1–6 (`docs/day2day/WP8-PLAN.md`) are implemented as written
and await ratification at the review.

Harness at landing: `bun test` 1110 pass (102 files), `tsc --noEmit` clean, Jest 1091 pass under Node; `scripts/validate-lane-ranker.ts` and `scripts/overnight-benchmark.ts` smoke-run read-only against the live data directory.
