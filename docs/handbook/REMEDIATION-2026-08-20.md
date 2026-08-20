# Remediation plan — closing AUDIT-2026-08-20

The upgrade program that takes every B/[LIVE-GATE] item in
[AUDIT-2026-08-20.md](AUDIT-2026-08-20.md) to closed. Method: each work
package (WP) is harness-first (its verifier lands red before the fix), ships
as one commit with tests, and is independently revertable. The audit doc is
the spec; WP items cite its sections. No live switch and no new strategy
rules while the program runs — the rule freeze (WP-VAL) starts only after
Phase 2 lands.

Risk classes per ADF: **HIGH** = touches order placement, risk gates, or
schema (approval before implementation); **MED** = behavior change behind
existing gates; **LOW** = additive/observability.

```
Phase 0  quick hardening          (LOW/MED, no dependencies, 1–2 sessions)
Phase 1  broker truth             (HIGH, the critical path, 3–5 sessions)
Phase 2  policy integrity        (HIGH/MED, depends on Phase 1, 2–4 sessions)
Phase 3  research validity       (MED, parallel to 1–2, 2–4 sessions)
Phase 4  frozen validation       (process, calendar time, ≥100 trades)
```

Dependency spine: WP1 → WP2 → WP3 → WP4 → (WP5, WP7) → WP-VAL.
Everything else hangs off the spine or runs parallel.

---

## Phase 0 — quick hardening (audit: "cheap" items)

**STATUS: LANDED 2026-08-20** (commits b6181ec…e2b57f6, one per WP; suite
590 green). Closes audit items: crit. 13 (YAML), the gateway-section cheap
items (null-risk contract, gate symmetry, calendar cliff, log redaction,
trigger causality + decline-ledger decoupling, source lanes, MFE/MAE
coverage) and the weights-provenance leak. Next: Phase 1 (WP1, broker
truth) — starts with the fake-IBApi ack harness in bracket.test.ts.

- **WP0.1 Risk-YAML validation** (audit crit. 13) — `risk-rules.ts`:
  schema check per key (finite number in range, booleans strictly
  true/false), cross-field (`plannedBookWorstCasePct ≤ max_daily_loss_pct`),
  fail LOUD: a malformed file refuses to start the gateway rather than
  silently running defaults; live profile missing its overrides file is a
  startup error when `IBKR_ALLOW_LIVE=true`. Harness: unit tests feeding
  NaN/string/missing-file cases, asserting throw not fallback.
- **WP0.2 Weights provenance** (backtester §, cheap) — `signal-scorer.ts`:
  `_meta.note`-aware label; a reset file prints "equal weights (reset
  2026-08-11)", never "calibrated". Harness: weights-label unit test.
- **WP0.3 Null-risk contract** (gateway §, cheap) — `proposal-executor.ts`:
  an unpriceable in-flight row (`plannedWorstLossUsd` null) fails the
  accept closed with a named refusal instead of `?? 0`; unify per-symbol
  exposure valuation on fill-price-then-entry (same formula both places).
- **WP0.4 Ordering-gate symmetry** (gateway §, cheap) —
  `position-actions.ts`: both paths call `assertAccountsVerified()`.
  Risk: these are risk-REDUCING paths; verify the tracker's auto-protect
  cannot deadlock on a slow managedAccounts event (keep the 5s timeout).
- **WP0.5 Calendar expiry alarm** (gateway §, cheap) — `market-hours.ts`:
  startup assertion warns ≥30 days before the holiday table's last year
  ends, fails loud once past it. Also delete the dead half-day ternary.
- **WP0.6 Log redaction** (gateway §) — `inbound.ts`, `gateway.ts`: JIDs
  and phone numbers masked (`…last4`), allowlist logged as count not
  content, previews truncated to 40 chars, debug log size-capped with
  rotation (reuse `DEXTER_LOG_KEEP`). One-time: rotate the existing
  `gateway-debug.log` out.
- **WP0.7 Trigger causality** (gateway §, cheap) — `trigger-alerts.ts`:
  drop the freshest-proposal fallback entirely; auto-execution happens only
  via the creation tool's own id (that path already exists). Decouple:
  evaluation runs even with no WhatsApp target (deliver-if-possible), so
  the decline ledger always records.
- **WP0.8 Source lanes** (gateway §) — `tools/proposals/index.ts`,
  `trade-proposals.ts`: thread a `lane` through the create tool (trigger /
  cron:<name> / tui / breadth / mover), stamp `source` with it; benchmark
  and performance report group by it. Additive, no migration (column
  exists).
- **WP0.9 MFE/MAE sweep** (gateway §) — new `excursion-sweeper.ts` (or a
  benchmark step): nightly pass over closed rows with null `mfe_pct`,
  filled entry, and a bar history — fills them retroactively. Turns 4/112
  coverage into full coverage without touching the finalize path.

## Phase 1 — broker truth (audit crit. 6, 7, 8; the live blocker)

The invariant this phase installs: **the broker is the source of truth for
order and position state; the DB is a view.** All four WPs are HIGH.

**STATUS: WP1 LANDED 2026-08-21** (commit 27e397f; suite 597 green).
Recorded deviation: an unconfirmed placement is marked 'executed' with a
loud `placement-unconfirmed` note instead of staying 'executing' — an
'executing' row is invisible to the tracker and releasable by the claim
sweeper, and a released claim over live orders invites double placement.

**STATUS: WP2 LANDED 2026-08-21** (commit c55082d; suite 602 green).
Entry recorded on first partial; terminal partial → quantity downgrade
(planned_quantity preserved) + resized GTC OCA pair replacing the
full-size exits (re-point before cancel); manual-exit fills allocated by
the close order's shares — starved rows get P&L unknown, never invented.
HTH/BBT ledger rows annotated untrustworthy.

**STATUS: WP3 LANDED 2026-08-21** (commit 3ce7fac; suite 611 green).
Reverse sweep at attach + every 15 min: orderRef-matched orders re-attach
to their proposal legs; unknown verified-account positions become
'adopted' rows (synthetic labeled levels, cap-visible, triage-excluded,
never managed); orphans and foreign-account positions flagged once.

**STATUS: WP4 LANDED 2026-08-21 — PHASE 1 COMPLETE** (commit ab8e0b6;
suite 616 green). Acceptance caps take max(DB, broker snapshot) per
symbol, fail closed on snapshot failure. Planned-risk headroom stays
DB-side (broker-only positions have no stop until adoption prices them —
recorded design note). Next: Phase 2 (WP5 overnight vetting) and/or
Phase 3 (WP9 backtester, WP10 scorer) — Phase 3 can run parallel.

- **WP1 Acknowledged placement + identity** (crit. 6)
  Files: `bracket.ts`, `orders.ts`, new `src/tools/ibkr/order-ack.ts`,
  `proposal-executor.ts`, `position-actions.ts`.
  Design: every order gets `order.account` (the single verified managed
  account — refuse multi-account connections until explicitly supported)
  and `orderRef = "<proposalId>:<leg>"` (entry/tp/stop; close/protect get
  synthetic ids). `placeBracketOrder` then awaits, per leg, the first of
  openOrder / orderStatus / error(id) with a bounded timeout (~4s);
  captures `permId` into a new `order_perm_ids` column (additive
  migration). Timeout is NOT failure: status goes to a new
  `'placing'`-in-note state — row stays 'executing' with
  `note='placement-unconfirmed'` and the reconciler resolves it (avoids a
  ProposalStatus enum migration; revisit if it proves confusing).
  Executor marks 'executed' only after entry-leg ack; broker rejection
  inside the window → 'failed' with the broker's reason (the catch branch
  becomes reachable for the case it was written for). The user-facing
  message stops claiming "WORKING" until ack.
  Harness FIRST: extend `bracket.test.ts` with a fake IBApi event emitter —
  ack path, reject path, timeout path, permId capture, account/orderRef on
  every leg. The fake-API harness built here is the fixture for WP2/WP3.
- **WP2 Partial-fill truth** (crit. 7)
  Files: `outcome-tracker.ts`, `trade-proposals.ts`, `bracket.ts`.
  Design: stop discarding `filled` — track `cumQty`/`avgPrice` per entry
  order; record the entry on FIRST partial fill (`markEntryFilled` gains a
  quantity); on terminal entry status with `0 < cum < planned`, resize both
  exit legs to `cumQty` (cancel/replace; do not rely on TWS's
  child-adjust setting — verify and document it regardless), update
  `quantity` to filled (new `planned_quantity` column preserves the
  original for analytics), and the row is a normal live trade — never
  'cancelled'. P&L everywhere uses filled quantity. `finalize('cancelled')`
  hard-codes 0 only when cumQty is genuinely 0. Backfill: one-off script
  flags the two known bad rows (HTH, BBT) in `note` rather than rewriting
  history. The manual-exit fan-out (one close fill attributed to every
  tracked trade on the symbol) allocates by quantity, refusing to
  over-attribute beyond the broker fill.
  Harness: outcome-tracker scenario tests through the fake API — partial
  then cancel, partial then fill-out, partial then stop-triggered (exit
  resized), zero-fill cancel.
- **WP3 Reverse reconciliation** (crit. 6 second half)
  Files: `outcome-tracker.ts` (reconciler), new `broker-adopt.ts`.
  Design: on startup and every N minutes, diff broker openOrders+positions
  against DB. Unknown broker ORDER on a symbol Dexter tracks → adopt into
  the trade's `orderIds` (by orderRef when ours, else flagged). Unknown
  broker POSITION → create an `adopted` proposal row (source='adopted',
  entry=avgCost, no score) so caps see it, and notify the operator loudly.
  Deliberately conservative: adoption never places or cancels orders by
  itself. Harness: reconciler tests over fake snapshots (orphan order,
  manual position, account mismatch).
- **WP4 Broker-canonical exposure** (crit. 8)
  Files: `proposal-executor.ts`, `trade-proposals.ts`, new
  `exposure-snapshot.ts`.
  Design: acceptance-time exposure = union(DB rows, broker snapshot
  ≤10s old) taking the MAX per symbol; open-position count = distinct
  symbols in the union; failure to fetch the snapshot within timeout fails
  the accept CLOSED (a proposal can wait; unknown exposure cannot).
  Depends on WP3 (adopted rows make the union mostly redundant — the
  snapshot is the backstop). Harness: gate tests where broker and DB
  disagree in each direction.

## Phase 2 — policy integrity (audit crit. 9–12)

**STATUS: WP5 LANDED 2026-08-21** (commit e7d17c7; suite 623 green).
Fail-open keep branches flipped to close; conversion book vetted against
overnight caps at market value with worst-first trims; 15:40 preview +
same-day `keep SYMBOL` override (never the earnings guard); 🌙 notice
honest about vet status. Recorded deviations: NetLiq-unavailable warns
loudly instead of mass-closing; conversion-time sector re-check defers
to WP6.

**STATUS: WP6 LANDED 2026-08-21** (commit b7e82ca; suite 629 green).
Accept refetches and REQUIRES daily ATR/EMA10/live quote (context-gate
refusal names every starved check); noise-stop, target-reach, extension
and chase run unconditionally at accept; UNKNOWN sector bucket (D3)
capped like any sector. Scope notes: buy-now stays creation-only per its
documented design; recentEarnings=null stays strict (never waives).

**STATUS: WP7 LANDED 2026-08-21** (commit 8fd4313; suite 637 green).
Spread (max_spread_pct) and ADV (max_adv_pct, min_avg_volume now
deterministic) hard-gate at accept, fail-closed on missing data; shorts
require confirmed borrow (tick 236); known halt refuses, unknown notes.
⚠ LIVE-VERIFY before the freeze (E2E checklist): the IBKR daily-volume
lot factor (×100) and the tick-236 field-46/49 value semantics.

**STATUS: WP8 LANDED 2026-08-21 — PHASE 2 COMPLETE** (commit 0a91ffd;
suite 640 green). NetLiq currency tag captured; exported figure converts
to USD at the boundary (IDEALPRO midpoint, 1h cache, fail-safe refusal
when a non-USD base has no rate); internal halt math stays base
(internally consistent). Direction pinned by test. Remaining phases:
3 (WP9 backtester, WP10 scorer, WP11 residuals) and 4 (frozen
validation).

- **WP5 Overnight conversion vetting** (crit. 9, HIGH)
  Files: `eod-triage.ts`, `outcome-tracker.ts`, `proposal-risk-gate.ts`.
  Design: triage's keep decisions run through a real overnight gate before
  the bell — same checks a deliberate GTC accept gets (overnight per-name
  and book caps at MARKET value, sector cap, earnings, macro), fail-closed
  on missing data (a keep the gate cannot price becomes a close). Cap
  breach trims: close keeps worst-first (lowest P&L%) until the book fits.
  The 🌙 conversion then only ever fires on gate-passed positions; its
  notification stops apologizing. `decideEodAction` fail-open branches
  (no price / no momentum → keep) flip to fail-closed (→ close) — a
  decision the operator can override per-symbol via a `keep SYMBOL` reply
  window before the bell (decision point D2 below).
  Harness: extend eod-triage decision tests — cap-trim ordering, gate-fail
  close, missing-data close, override path.
- **WP6 Fail-closed acceptance context** (crit. 10, HIGH)
  Files: `proposal-executor.ts`, `daily-atr.ts`, `proposal-risk-gate.ts`.
  Design: accept refetches daily ATR, EMA10, last price, earnings window;
  any fetch failure refuses the accept (transient — gates re-run on retry,
  matching the existing refusal philosophy). Noise-stop, target-reach,
  extension, and chase checks become unconditional at accept. Unknown
  sector stops skipping the cap: it counts into an 'UNKNOWN' bucket with
  its own cap (decision point D3). Creation-time checks stay best-effort
  (creation is advisory; acceptance is the contract).
  Harness: executor tests with each context fetch failing → named refusal.
- **WP7 Microstructure gates** (crit. 11, HIGH)
  Files: `proposal-risk-gate.ts`, new `src/tools/ibkr/microstructure.ts`.
  Design: at accept, fetch quote + 20-day ADV once: hard-refuse when
  spread% > cap (config `max_spread_pct`), order notional > `max_adv_pct`
  of ADV, price < min_price (exists), or — for shorts — contract not
  shortable (reqContractDetails/shortable tick). SSR/halt/LULD detection is
  best-effort v1: refuse on `halted` tick when available, log otherwise.
  `min_avg_volume` moves from advisory to this gate. New YAML keys ride
  WP0.1 validation.
  Harness: gate unit tests + one paper-session e2e checking refusal copy.
- **WP8 One currency** (crit. 12, MED)
  Files: `daily-loss-guard.ts`, `position-sizer.ts`, new `fx.ts`.
  Design: `fetchNetLiquidation` stops discarding the currency tag; a
  non-USD base converts via IBKR's own `ExchangeRate` account value
  (fallback: EUR.USD snapshot, cached 1h, hard-refuse sizing if
  unavailable and base ≠ USD). Every cap/budget/headroom compares USD to
  USD. The audit's "conservative today" direction is verified in a test
  that would fail if the direction ever flips.

## Phase 3 — research validity (parallel; audit backtester + scorer §)

**STATUS: WP9 LANDED 2026-08-21** (commit bd9411b; suite 654 green, the
first tests src/backtest ever had). Next-bar fills (anchor), per-symbol
advance, gap-aware exits, warm-up preload, risk-based sizing on marked
equity, 2R defaults, inert train pass deleted, sentiment behind an
explicit look-ahead flag, archive end-bound fixed, real monthly metrics.
ENGINE_VERSION 'wp9-honest-replay-1'; calibrate-scorer refuses any
other. Backtest outputs stay UNTRUSTED until recalibrated under the new
engine per protocol.

**STATUS: WP10 LANDED 2026-08-21** (commit 267f247; suite 663 green,
ta-indicators' first tests). Session VWAP, time-of-day RVOL excluding
the bar under test, ATR-normalized MACD, coverage-capped composite,
in-progress bar dropped, zero-vs-missing fixed; engine: direction by
votes (conflicts dropped), activity scans resolve by day-move sign or
better-of-both, family-based multi-scan bonus, boost suppressed past
the extension gate's ceiling, staleness trigger-ineligible, real cycle
mutex, honest trigger prompt. NOTE: scorer semantics changed — the
score distribution shifts; the validation freeze must postdate this.

**STATUS: WP11 LANDED 2026-08-21 — PHASE 3 COMPLETE** (commit ad80fe5;
suite 667 green). Double-close guard (D4 first-wins), timestamp hourAgo,
finalize event buffer + resurrect re-dispatch, closePosition orphan-GTC
sweep by orderRef (closes 2026-08-06 finding 10).

**PHASE 4 STATUS: protocol PRE-REGISTERED 2026-08-21**
([VALIDATION-PROTOCOL.md](VALIDATION-PROTOCOL.md)); the freeze tag
`validation-freeze-1` is the OPERATOR'S to place after its prerequisites
(WP7 lot-factor + tick-semantics live-verify, WP2/WP11 paper-path
verify, one clean boot). All code phases of this remediation are
complete.

- **WP9 Backtester: honest replay** (MED — decision point D1)
  Recommended scope (rebuild-lite, ~1 session): process bar i BEFORE
  signals from bar i (kills the same-bar look-ahead); per-symbol bar
  advance via the existing index map (kills first-ticker pricing);
  gap-aware stop fills (`min(stop, open)` long / `max` short); warm-up
  preloaded from before startDate; risk-based sizing matching the live
  sizer; 2R defaults matching the live gate; per-symbol metrics from
  per-symbol curves or dropped; delete the inert walk-forward train pass
  until a fitting step exists; archive date-bound fix; day-level sentiment
  behind an explicit `lookaheadOk` flag. `src/backtest/*.test.ts` lands
  FIRST: "order submitted on bar i fills at bar i+1 open" is the anchor
  test the whole file hangs on. Until this WP is merged the UNTRUSTED
  stance stays in force; calibrate-scorer refuses to run against the old
  engine (version stamp).
- **WP10 Scorer statistics** (MED)
  `ta-indicators.ts` + `signal-scorer.ts` + `opportunity-engine.ts`, in
  slices, each with the currently-missing `ta-indicators.test.ts`:
  session-reset VWAP; RVOL vs same-time-of-day mean over N sessions
  (excluding current bar); MACD slope normalized by ATR; missing data
  yields a `coverage` field consumed as a score CAP not a neutral fill;
  drop the in-progress bar; fix `|| null` zero coercions. Engine: scan
  direction becomes per-scan votes (conflict → no direction, no bonus);
  nondirectional scans stop defaulting long (direction from day-move sign
  when known, else scored both ways and the better side proposed);
  freshness verdict lands on `Opportunity` and stale candidates are
  refused at trigger eligibility; multi-scan bonus only for AGREEING
  scans; event-mover boost capped at the extension gate's ceiling so the
  engine stops promoting candidates the gate must refuse; fix the cycle
  mutex and the "top-3" prompt claim. NOTE: these change discovery
  behavior — land BEFORE the freeze, never during (they are part of what
  gets frozen).
- **WP11 EOD/tracker residuals** (MED) — same-symbol double-close guard
  (one close per symbol per run; broker-position close caps at the
  proposals' summed quantity, decision point D4); `hourAgo` by timestamp
  not index; `finalize` re-dispatches order events that arrived during its
  await window instead of dropping them; persist auto-protect GTC ids from
  the non-keep branch onto the row (closes the orphan-pair hole).

## Phase 4 — frozen validation (WP-VAL; audit "Live gate" §3)

Prereq: Phases 0–2 landed; WP10 landed or explicitly deferred WITH its
items frozen as-is. Then:

1. Tag the freeze (`validation-freeze-1`). From the tag: no rule, gate,
   scorer, or sizing changes. Bug fixes allowed only for accounting
   correctness, each logged in the validation journal.
2. Pre-register `docs/handbook/VALIDATION-PROTOCOL.md` BEFORE the first
   frozen trade: sample ≥100 correctly-accounted filled trades spanning
   ≥2 regime labels; acceptance = net expectancy > 0 after costs AND
   profit factor ≥ 1.3 AND max drawdown within the live daily-loss math
   AND score-decile monotonicity (Spearman > 0 with p < 0.05) if
   confidence sizing is ever to turn on. Failing any → no live, new
   iteration, new freeze.
3. Weekly automated scorecard (extends benchmark.ts) so drift from the
   protocol is visible, not remembered.

## Decisions (resolved by the operator, 2026-08-20)

- **D1 RESOLVED: rebuild.** WP9 rebuild-lite proceeds as specced;
  calibrate-scorer stays version-gated until the new engine lands.
- **D2 RESOLVED: fail-closed WITH override.** WP5 flips EOD fail-open
  branches to close, and adds a pre-bell `keep SYMBOL` reply window: the
  triage report lists gate-failed keeps, the operator may reply
  `keep SYMBOL` before the bell to override (logged as an explicit
  operator decision on the row).
- **D3 RESOLVED: capped UNKNOWN bucket.** Unresolvable sectors count into
  a shared 'UNKNOWN' bucket with its own cap (same percentage as a named
  sector). Rationale: hard refusal would blanket-block ETFs and Nasdaq
  metadata misses; the bucket keeps them tradeable while bounding the
  concentration a blind spot can accumulate.
- **D4 RESOLVED: close everything.** closePosition keeps closing the full
  broker position, manually-held shares included — one `close SYMBOL`
  means flat, no residue. WP11's double-close guard therefore dedupes by
  symbol per run (first close wins, second becomes a no-op) rather than
  capping quantity.
- **D5 RESOLVED: single-account.** WP1 refuses multi-account connections;
  revisit only if a second account materializes.

## Traceability

| Audit item | WP | | Audit item | WP |
|---|---|---|---|---|
| crit. 6 ack/idempotency | WP1, WP3 | | backtester § | WP9 |
| crit. 7 partial fills | WP2 | | scorer § | WP10 |
| crit. 8 exposure truth | WP4 | | gateway § cheap | WP0.3–0.7 |
| crit. 9 overnight vetting | WP5 | | observability | WP0.8, WP0.9 |
| crit. 10 fail-open context | WP6 | | logging | WP0.6 |
| crit. 11 microstructure | WP7 | | EOD residuals | WP11 |
| crit. 12 currency | WP8 | | validation | WP-VAL |
| crit. 13 YAML | WP0.1 | | | |

Estimated calendar: Phases 0–3 ≈ 8–14 working sessions; Phase 4 is
calendar-bound (~5–10 trading weeks for 100 filled trades at recent fill
rates). `IBKR_ALLOW_LIVE` stays false throughout.
