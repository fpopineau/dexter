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

## Review 2 triage (2026-08-21, reviewed at abae294)

A second external review confirmed the no-go disposition (shared) and
surfaced new items. **Fixed same day** (commit refs in git log):
confidence sizing FLATTENED to 1.0/1.0 in defaults + live yaml (the
protocol's own mandate — the 80+ band is 0-for-5 on the ledger);
ack-window terminal statuses (Inactive/Cancelled) now classify as
rejection; closePosition gained a per-symbol in-flight mutex + a
recently-closed refusal + ACK-GATED protection removal (rejected close →
exits untouched; unconfirmed → exits left standing, operator resolves);
protectPosition and the WP2 resize pair are broker-acked (rejection →
sweep + honest NOT-protected report / old exits kept); STP_LMT risk,
R/R, position value, sizing and headroom all judge at the LIMIT CAP (the
worst permitted fill); proposals record the proposing MODEL (judgment-
purity for the frozen sample); the live ledger migrated cleanly and
MFE/MAE backfilled 4/86 → 69/86 (15 horizon-expired marked);
ARCHITECTURE.md known-limits rewritten to current behavior.

**Accepted/recorded (not fixed)**: no demonstrated edge (the protocol IS
the answer); backtest validates a proxy of the live policy (recorded in
WP9 — the paper sample is the real validation); D2 keep-override and the
NetLiq-unavailable warn are deliberate decisions; avgCost-valued broker
union, DB-side sector/planned-risk, qty/direction drift reconciliation,
exposure-in-waiting for unknown orders, general overnight gap-risk
model, broker-native reduce-only, regime-conditioned scorer routing,
RVOL double-counting, scanner depth, simulator microstructure (queue/
partial/latency/borrow) and stale FirstRate/GDELT archives → open
backlog, none gate the PAPER validation.

**D6 RESOLVED (2026-08-21): auto-exec floor 0 + fresh statistics.** The
ledger has NO positive score band (50–75 would give 22% wins at
−$812/trade; 76–79 is 0-for-9; 80+ is 0-for-5), and the historical
scores came from the pre-WP10 scorer, which no longer exists —
band-shopping that record is post-hoc selection. The burn-in is an
experiment ON the score: `AUTO_EXECUTE_MIN_SCORE` defaults to 0 (env
set to 0; the guard now accepts 0), so every band accrues samples for
the decile-monotonicity test. All deterministic gates and the daily cap
still apply; sizing is flat. Performance baseline reset 2026-08-21
13:03Z ("fresh statistics") — history stays queryable, reports start
clean.

**PHASE 4 STATUS: protocol PRE-REGISTERED 2026-08-21**
([VALIDATION-PROTOCOL.md](VALIDATION-PROTOCOL.md)); the freeze tag
`validation-freeze-1` is the OPERATOR'S to place after its prerequisites
(WP7 lot-factor + tick-semantics live-verify, WP2/WP11 paper-path
verify, one clean boot). All code phases of this remediation are
complete.

## Review 3 triage (2026-08-21, reviewed at 0709eef)

Core finding accepted: the code still confused "the broker emitted an
event" with "the position is flat/protected". **Fixed same day**:

- **Fill-gated flatness.** `order-ack` now tracks `filled`
  (Filled + remaining 0 + filled > 0) and `settle(ms, 'filled')` waits
  for it; `closePosition` returns a tri-state outcome
  (`filled`/`working`/`unconfirmed`/`rejected`), only cancels the
  protective exits AFTER the close FILLS (`cleanupExitsAfterClose`,
  which also runs the WP11 orphan-GTC sweep), refuses when a manual
  exit is already working (`hasWorkingManualExit`), and on
  working/unconfirmed leaves the exits standing with an honest message.
  The tracker's `handleManualExitFill` triggers the same cleanup when
  the fill event lands later.
- **EOD triage** counts a symbol closed only on `state === 'filled'` —
  an unconfirmed close no longer reports "closed" to the operator.
- **Resize fail-closed both ways**: the new pair must BOTH ack inside
  the window; timeout → sweep the new pair, KEEP the old full-size
  exits (test codifies broker-silence now, not the old unsafe path).
- **protectPosition** treats unconfirmed like rejected: sweep + "NOT
  protected".
- **Continuation geometry** rebuilt at the LIMIT CAP so the 2R floor
  holds at the worst permitted fill (my own regression from the
  review-2 STP_LMT basis change); continuation inherits the parent's
  `model` stamp.
- **VIABLE-GEOMETRY guidance** rebased on the same worst-fill basis as
  the gate that rejects (no more self-contradictory hints).
- **D6 surfaces aligned**: `autoExecMinScore()` exported and used by
  the gateway boot display; env.example and USER-MANUAL say 0; manual
  carries the honest sampling caveat (floor 0 removes the LAST
  selection stage, upstream shaping remains).
- **Regime recorded per proposal** (`regime` column, migrated + stamped
  at creation) — the protocol's ≥2-regime breadth is now measurable.
- **`scripts/validation-scorecard.ts` exists** — the pinned evaluator
  the protocol names; smoke-run on history correctly FAILs (n=67,
  expectancy −671, PF 0.29, DD 18.1% vs 6% bar) and reads the fresh
  epoch (`performance-epoch.json`) for the real window (n=0 today).

**Accepted/recorded (not fixed)**: cancellations are still not
confirmed-by-event before the tracker forgets an order id (the WP3
adoption sweep + `cleanupExitsAfterClose` re-sweep heal stragglers);
kill-switch counts risk at order time only; `risk_manager` tool schema
still previews entry as a single price (advisory display only — the
authoritative gate judges at the cap); plus the review-2 backlog
(drift reconciliation, gap model, broker-native reduce-only, simulator
microstructure, stale archives). None gate the paper validation.

## Review 4 triage (2026-08-21, reviewed at 9a354e3)

The round-3 close-lifecycle work itself carried two defects; both
confirmed and **fixed same day, with the previously-missing direct
tests** (`position-actions-close.test.ts`, 5 scenarios):

- **Filled closes now return `state:'filled'`** — the success branch
  omitted it, so EOD triage (which gates on exactly that) never counted
  a successful close as closed: stale overnight exposure, double-close
  prompts, no "Closed" in the report.
- **Manual-exit registration precedes placement** — registering after
  the up-to-8s fill wait let the tracker's permanent listener consume
  and DISCARD the fill of an order it did not know: P&L lost AND the
  late-registered entry stayed "working" forever, refusing every later
  close of the symbol. `trackManualExit` is now called before
  `placeOrder` (with `untrackManualExit` on throw/rejection), and it
  registers even with zero attributable rows so adopted/manual
  positions get the order-lifetime duplicate-close guard too.
- **Cancellation is broker-confirmed** (`confirmCancel` in order-ack):
  post-close exit cleanup, profit-trail target release, EOD unfilled-
  entry cancels and BOTH resize sweeps now wait for the Cancelled
  event (or gone-codes 10147/10148) and report three honest outcomes —
  confirmed, FILLED-during-cancel (loud: unintended position), or
  unconfirmed (loud: do not assume gone). Reports count confirmed
  cancels, not requests.
- **Scorecard hardened**: dual sqlite driver (bun + node/tsx — it
  failed on the gateway's runtime), drawdown denominator from
  `netliq-baseline.json` (hardcoded 1M vs 249k real understated DD
  4×), integrity gate queried (stale placement-unconfirmed, P&L holes,
  missing commissions — anomalies make the verdict NOT-EVALUABLE),
  ISO-8601 weeks, NULL/'unknown' regimes excluded from breadth, and a
  single aggregated VERDICT line.
- **Attribution completed**: TUI runs wrapped in `withAgentLane('tui',
  …, provider:model)`; chase continuations inherit the original's
  `regime`; `docs/day2day/VALIDATION-JOURNAL.md` skeleton created with
  the tag-time fingerprint checklist (model+provider, RULES.md SHA-256,
  scorer-weights provenance).
- **D6 doc stragglers**: env.example's "default 80 / burn-in 1 /
  banded sizer" block and the manual's "burn-in runs at 1" sentence
  rewritten to floor-0 + flat sizing.

**Accepted/recorded (not fixed)**: over-close race at a gap open (DAY
close and triggered GTC stop can both fill — the OCA group does not
span the close order; mitigations: fill-gated cleanup + duplicate-close
guard + loud FILLED-during-cancel detection; the real fix is
broker-native reduce-only/OCA-joined closes, backlog); ack contract
covers the window only (a post-window rejection reaches the tracker,
not the acker); the duplicate-close guard is process-memory (restart
forgets a resting close — WP3 adoption sweep + the 10-minute window are
the net); weekly scorecard execution is operator-manual (journal
entries enforce cadence; a gateway cron spawning the script is
backlog); pre-stamping rows carry NULL model/regime until they drain
(the purity check flags them; the freeze tag postdates the drain).

## Review 5 triage (2026-08-21, reviewed at 363a37a)

**Fixed same day:**

- **10148 ≠ cancelled** (the round's P1, confirmed): IBKR 10148 is
  "cannot be cancelled, state: X" — most often because the order
  FILLED. `confirmCancel` now classifies by the STATE TOKEN
  (locale-tolerant: Filled/Rempli, Cancelled/Annulé; the sentence
  always contains "cancelled", so whole-message matching was the trap)
  with a new `not-cancellable` outcome, plus first tests of the helper
  (14 scenarios incl. both locales and the PendingCancel non-terminal).
  Post-close cleanup classifies per order id: the tracked ENTRY id
  answering filled/not-cancellable is benign (the position we just
  closed); an EXIT id answering that stays an alarm.
- **Bracket rejection sweep broker-confirmed**: `sweepResidues` on the
  ack; the executor only says "nothing is working" when every leg
  confirmed dead, otherwise it names the residues. The generic cancel
  tool no longer reports success on `PendingCancel`.
- **Gap-open over-close race**: the close now JOINS the exits' OCA
  group (ocaType 1) when exactly one distinct group exists among OUR
  exit orders — close-vs-stop mutual exclusion happens at the broker,
  atomically. Stacked positions (two pairs, two groups) fall back to
  fill-gated cleanup with a logged warning.
- **Duplicate-close guard survives restarts** via broker truth: the
  WP3 adoption sweep re-registers any working `close-<SYM>` order it
  finds (idempotent), so a resting pre-market close re-arms
  `hasWorkingManualExit` on boot — no new persistence file.
- **Frozen-sample boundary**: the scorecard requires `created_at >=`
  window start (a pre-freeze trade that merely closes inside the
  window was judged by the OLD policy — ROST dropped from the fresh
  sample on this fix); explicit CLI windows accept the tag's full
  timestamp, not just midnight.
- **Frozen drawdown denominator**: `setPerformanceBaseline` captures
  the day's NetLiq into `performance-epoch.json` (current epoch
  backfilled with 249,176.45, same-day capture); the scorecard uses
  the frozen value and treats the daily file as a loud, verdict-
  failing fallback.
- **Integrity widened**: in-window adopted rows (reconciliation
  events) and sample rows missing model/regime stamps are anomalies —
  the verdict is NOT-EVALUABLE until resolved.
- **Profit-trail keeps its peak** unless the close confirmed
  `filled` — a rejected/ambiguous close no longer restarts trailing
  from a worse basis.
- **AUTOMATION.md** floor references (§5 text + §6 table) now say 0.

**Accepted/recorded (still open)**: ack contract covers the window
only (post-window rejection reaches the tracker, not the acker);
weekly scorecard execution stays operator-manual (the script is not
gateway-importable; a spawn-based cron is backlog); tag-time
fingerprint fields fill at the tag by hand (journal has the
checklist). NOTE for the freeze: the OCA-join and every round-5 change
are behavior changes — they land BEFORE `validation-freeze-1`, which
is exactly why the tag has not been placed yet.

## Review 6 triage (2026-08-21, reviewed at 807f239)

**Fixed same day:**

- **Residue brackets stay TRACKED** (the round's P1): a rejected
  placement whose sweep left residues is no longer marked 'failed'
  (invisible to exposure caps and the tracker while a leg might be
  live) — the row stays 'executed' with a `rejected-with-residues`
  note, consumes the slot, and enters outcome tracking so
  reconciliation finalizes the truth. Clean sweeps still fail
  terminally. (The executor branch itself has no direct test — the
  accept pipeline has no seam; residue production is tested in
  bracket-ack. Recorded gap.)
- **`Inactive` no longer confirms a cancel** — IBKR uses it for
  invalid, rejected AND HELD orders; it now classifies
  `not-cancellable` (verify), with a test.
- **The book is the post-condition**: `cleanupExitsAfterClose` re-reads
  the open-orders snapshot after all cancels — any requested id still
  working overrides its event classification with a loud error. This
  is also the answer to the 10147 cross-client caveat: the event can
  lie, the book cannot.
- **Stop-only protection now carries an OCA group** (one-member groups
  are legal), extending close-join coverage to the auto-protect path.
- **Boot-atomic guard rehydration**: `attach()` AWAITS the first
  adoption sweep, so a close request cannot race the guard's
  restoration; `selectManualExitRehydrations` is pure + tested, and a
  close-* order on a FLAT symbol is flagged as a reversal order
  (notify) while still guarding.
- **Reconciliation is provable**: every sweep persists
  `reconciliation-status.json` (orphans, leg/position adoptions,
  stale closes, timestamp); the scorecard requires a fresh (<24h)
  clean report — missing/stale/orphaned → NOT-EVALUABLE.
- **Adoptions block only while UNRESOLVED** (protocol: at evaluation
  time): open adopted rows are anomalies; resolved ones informational.
- **Explicit-timestamp scorecard windows keep the frozen NetLiq**
  denominator (previously they silently fell back to the daily file
  and could never pass).

**Accepted/recorded (still open)**: 10147 remains classified
cancelled-for-working-ness on own-client ids (the book re-read is the
guard against the foreign-id lie; execDetails replay owns earlier
fills); stacked multi-group positions and legacy ungrouped exits still
fall back to fill-gated cleanup (the OCA-join covers single-group
books only); IBKR's dynamic add-to-working-OCA-group behavior is
harness-unverified — added to the freeze prerequisites as a paper
observation; weekly scorecard execution remains operator-manual.

## Review 7 triage (2026-08-21, reviewed at 4098dd7)

**Fixed same day:**

- **Residue-fill replay** (P1): after a rejected-with-residues bracket
  registers with the tracker, the executor immediately replays today's
  executions (`replayMissedExecutions` → `reqExecutions`) — a leg that
  filled DURING the multi-second cancel sweep, before its ids were
  known, now lands instead of waiting for a reconnect. Idempotent by
  the WP2 cumulative-quantity accounting.
- **Boot gate on closes** (P1): `closePosition` refuses while the
  tracker's first replay+reconcile+sweep is still `pending` (waits up
  to 10s, then refuses honestly) — an inbound WhatsApp `close` can no
  longer race the guard rehydration regardless of gateway boot order.
  `'idle'` (tracker never started — TUI/standalone) keeps the old
  semantics. Tri-state exported + tested.
- **Book truth overrides the COUNT** (P1/P2): cleanup no longer counts
  an order the post-condition snapshot shows STILL WORKING as
  cancelled — it is excluded from the operator-facing count and stays
  a loud error (the round-6 fix logged the lie but repeated it in the
  message).
- **Snapshot completeness is recorded**: `fetchOpenOrderSnaps` reports
  whether `openOrderEnd` arrived; an incomplete snapshot and every
  adoption/repoint failure land in `reconciliation-status.json` as
  failures, and the scorecard treats them (and a report older than 2h —
  was 24h) as integrity anomalies. Leg/position adoptions and resolved
  rows print as informational context.
- **Adopted rows now have a resolution lifecycle**: the sweep calls
  `resolveAdoptedFlat(heldSymbols)` — an adopted row whose symbol the
  broker no longer holds closes as exit `unknown` with an honest note
  (exit happened outside Dexter), notified, reported, tested. No more
  phantom exposure or permanent unresolved-adoption anomalies.
- **Mixed exit books do not OCA-join**: a grouped pair next to a
  legacy ungrouped exit previously joined the one group while the
  ungrouped order kept racing — the join now requires the book to be
  WHOLLY one group; tested.

**Accepted/recorded (still open)**: stacked multi-group books remain
unjoined by design (fallback: fill-gated cleanup + book-truth
post-condition); the executor residue branch still has no direct test
(no pipeline seam; residue production and replay are covered at their
own layers); OCA dynamic-join paper observation stays a freeze
prerequisite; weekly scorecard execution stays operator-manual.

## Review 8 triage (2026-08-21, reviewed at 3c3c2e5)

**Fixed same day:**

- **The close gate arms only on a PROVEN sweep** (P1): reconciliation
  reaches 'done' only when the boot sweep verified the account AND saw
  the complete open-orders book (`runBrokerAdoption` returns
  completeness; skipped/partial → the gate stays CLOSED, retried every
  60s, and any later complete sweep — including the 15-min periodic —
  arms it). Previously a failed sweep armed the gate without the
  guard rehydrated.
- **Order views carry completeness everywhere** (P1):
  `fetchOpenOrdersFor` returns `{orders, complete}`. On a partial view
  the OCA join is refused (a hidden ungrouped exit is exactly the
  partial-coverage trap; tested), the double-protection check FAILS
  CLOSED (a hidden pair would oversell), the post-close verification
  says loudly that its counts are event-based only, and the orphan
  sweep notes it swept a partial view.
- **Foreign-account positions are integrity anomalies**: the scorecard
  reads `foreignPositions` from the reconciliation report — D5
  single-account violations can no longer sit inside a CLEAN verdict.

**Accepted/recorded (still open, with rationale)**: the stacked
multi-group over-close race stays a design fallback — joining ONE of
two OCA pairs is worse than joining none (a partial stop fill would
OCA-cancel the full-size close and leave the remainder unprotected;
cancelling a pair pre-close opens an unprotected window). Full-size
protection with fill-gated cleanup + book-truth post-condition is the
chosen trade-off. OCA dynamic-join paper observation remains a freeze
prerequisite; weekly scorecard run remains operator-manual.

## Review 9 triage (2026-08-21, reviewed at 06e8b9a)

**Fixed same day — the fallback became a refusal:**

- **Non-atomic closes REFUSE** (P1): an automated close now goes out
  only when every working Dexter exit shares ONE atomic exclusion
  scheme with it — complete book view with either no Dexter exits
  (nothing to race) or a wholly-single OCA group (joined). Multi-group,
  ungrouped-exit, incomplete-view and probe-failure books all REFUSE
  with instructions ('cancel <SYM>' the extra pair, or retry on a
  transient view) instead of submitting the racy unjoined close. The
  three tests that codified the old fallback now codify the refusal,
  including snapshot-recovers-then-join. EOD triage and profit-trail
  already handle non-filled outcomes (report + keep state).
- **Unverified cleanup certifies nothing** (P1):
  `cleanupExitsAfterClose` returns a typed result — confirmed cancels
  are counted ONLY when the post-condition snapshot completed; an
  unverified pass reports "treat no cancellation as confirmed". And
  "the position is flat" became a POSITION claim: after any cleanup
  incident (exit filled during the race, unverified view, orders still
  working) the close re-reads the position book and reports FLAT /
  NOT-flat / could-not-verify honestly.
- **Boot-gate transitions have regression cover** (P2):
  `__armAfterSweepForTests` + a test pinning pending→(false)→pending→
  (true)→done→(false)→done — an unconditional-arm regression now fails
  a test, not a paper review.

**Residual**: the IO loop around the arming (real sweep → retry timer)
remains exercised only at boot on paper; the transition semantics are
what the test pins. OCA dynamic-join paper observation stays a freeze
prerequisite; weekly scorecard run stays operator-manual.

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
