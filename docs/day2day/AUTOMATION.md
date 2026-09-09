# Day2Day Automation — Architecture & Operations

System reference for the quasi-automatic trading extension built on top of
Dexter (`day2day` branch). Covers the Opportunity Engine, trade proposals,
event triggers, the safety model, calibration, and day-to-day operations.

Companion to [PLAN.md](PLAN.md) (original architecture plan).

---

## 1. Design principle

**The LLM never runs in a loop, and the LLM never executes.**

The pipeline is split into three layers:

| Layer | Nature | Cost | Components |
|---|---|---|---|
| Continuous scanning | Deterministic, no LLM | IBKR pacing only | Opportunity Engine |
| Judgment | LLM, event/schedule-driven | API tokens | Trigger evaluations, 09:35 / pre-close (close − 30 min) cron briefs |
| Execution | Human-gated, deterministic | — | Proposal executor (bracket orders) |

```
IBKR scanners ──> filter ──> signal scorer ──> composite ranking ──> snapshot (SQLite)
   (multi-code, session-aware cadence, no LLM)            │
                                                          ├──> cron briefs 09:35 / close−30 ──> LLM ──> proposals ──> WhatsApp
                                                          └──> threshold triggers ─────────> LLM ──> proposals ──> WhatsApp
                                                                            (risk gate at creation) ──┐
                                                  human "accept P-XXXX" (WhatsApp) or TUI approval ───┘
                                                          │
        safety lock ──> daily-loss kill-switch ──> risk gate (live account) ──> paper bracket order (entry + OCA stop/target)
                                                          │
                             outcome tracker: fills ──> exit reason + realized P&L ──> proposal 'closed' ──> WhatsApp
                                                          │
                                   'performance' command / pre-market recap / archive scheduler (16:20 ET)
```

## 2. Components

### Opportunity Engine — `src/services/opportunity-engine.ts`
Session-aware loop (US Eastern, holidays/half-days handled by
`utils/market-hours.ts`):

| Phase | Window (ET) | Cadence | Scanners |
|---|---|---|---|
| pre-open | 08:00–09:30 | 5 min | HIGH_OPEN_GAP, TOP_OPEN_PERC_GAIN, TOP_OPEN_PERC_LOSE (short), MOST_ACTIVE |
| open-drive | 09:30–10:30 | 2 min | TOP_PERC_GAIN, HOT_BY_VOLUME, TOP_PERC_LOSE (short), TOP_TRADE_RATE |
| midday | 10:30 → close − 60 min | 10 min | TOP_PERC_GAIN, MOST_ACTIVE, TOP_PERC_LOSE (short) |
| pre-close | last hour before the close (15:00–16:00; 12:00–13:00 on a half-day) | 5 min | TOP_PERC_GAIN, MOST_ACTIVE, HOT_BY_VOLUME |
| idle | otherwise | sleeps | — |

Each cycle: parallel scans (per-code 5-min cache) → dedupe (multi-scanner
symbols prioritized) → multi-factor scoring via the `signal_scorer` pipeline
(sequential, 300 ms pacing, capped at `OPP_MAX_CANDIDATES`) → composite rank
(`signalScore + min(10, 2×RVOL) + 3×(extra scanners)`) → snapshot persisted to
`.dexter/data/opportunities.db` (7-day retention) → top-N subscribed to the
realtime stream (`ibkr-stream`, reconnect-safe).

Starts/stops with the gateway when IBKR is configured; opt-out with
`OPPORTUNITY_ENGINE=false`.

**Lane rankings (WP8, 2026-09-05).** The composite is the INTRADAY lane's
ranking (`composite-v1`; weight provenance = the scorer's `weightsSource`).
Every snapshot also carries the overnight lane's own ranking
(`src/services/lane-rankers.ts`, `eod-continuation-v1`: significance of the
day move in daily-ATR units 0–40, closing strength vs VWAP toward the
direction 0–20, liquidity by dollar volume 0–20, RVOL 0–20; stale, unpriced,
ATR-less, counter-move or move-unknown names are excluded with the reason).
The cup lane keeps the detector score (`detector-v1`). Every proposal gets its
lane rank and ranker version stamped SERVER-SIDE at creation (`lane_rank`,
`ranker_version`; intraday = the trigger rank); the nightly digest reports
rank→R per lane, never pooled; `scripts/validate-lane-ranker.ts` is the
chronological (selection / validation days) pass any reweighting must clear.

### Agent tools (registered when IBKR is configured)
- **`opportunities`** — `latest` (cached snapshot) / `refresh` (run a cycle,
  ~30–60 s); `lane: "overnight"` returns the overnight lane's own ranking
  with factors and exclusion reasons (the Pre-Close Review reads it).
  Advisory; snapshots taken while the market is closed carry
  `marketOpen=false`.
- **`trade_proposals`** — `create` / `list` / `get` / `reject` /
  `performance`. Creating a proposal NEVER trades: it persists a record in
  `.dexter/data/proposals.db` (`P-XXXX` ids, statuses
  open/executing/executed/closed/rejected/expired/failed, default expiry 2 h).
  Creation passes the **deterministic risk gate** (below); the entry price
  is required even for MKT proposals (indicative, anchors the risk math).
  `performance` returns closed-trade outcomes over the last N days.
- **`earnings_calendar`** — keyless (Nasdaq public data): who reports on a
  date, and whether given symbols report within N days. The Pre-Market
  Brief names the day's big reporters and checks positions/watchlist; the
  Pre-Close Review refuses to hold through a report by ACCIDENT (every
  position checked, withinDays 2). Unavailable days are reported as
  "could not verify", never as "no earnings".
- **`accept_proposal`** — executes an open proposal. Listed in
  `TOOLS_REQUIRING_APPROVAL`: interactive confirmation in the TUI,
  **auto-denied in headless runs** (cron, gateway, triggers).

### Risk gate — `src/services/proposal-risk-gate.ts`
## Dawn watch + pre-market mover alerts

**Watchlist sentinel** (2026-08-19): watchlist names ABSENT from the
scans get a price-vs-prior-close check every `OPP_SENTINEL_CADENCE_MIN`
(10); an aligned move ≥ `OPP_SENTINEL_MOVE_PCT` (5%) admits them into
the candidate pool with a guaranteed scoring slot — declared names can
no longer be invisible just because small caps out-percented them
(COIN +10%/MSTR +12% on a BTC rally never cracked a 25-row scan
window). The regime snapshot also watches IBIT: a move ≥
`REGIME_CRYPTO_PCT` diverging from QQQ by `REGIME_CRYPTO_SPREAD_PCT`
flags the tape `crypto-led` and pre-arms the crypto vehicle
(`OPP_BREADTH_VEHICLE_CRYPTO`, IBIT) long or short by the IBIT sign,
through the same pre-arm cap/cooldown; scan-driven breadth days with a
crypto-majority mover set route to the same vehicle.

The engine's pre-open phase starts at `OPP_DAWN_START_ET` (default 04:00
ET, was 08:00 — MRNA 2026-08-19 ran +110% at 06:45–07:50 inside the old
blind window) at a slow cadence (`OPP_DAWN_CADENCE_MIN`, default 15). A
directionally-scanned candidate whose aligned day move reaches
`OPP_MOVER_ALERT_PCT` (default 15%) with real volume fires ONE
deterministic WhatsApp line per symbol per day — no LLM, no gates, no
orders; notification is deliberately decoupled from tradability. The
same day-move feeds the **event-mover boost**: +1 compositeRank point
per aligned % from `OPP_EVENT_BOOST_MIN_PCT` (10%), capped at +25, so a
multi-sigma mover cannot rank below an index ETF while the proper
scorer recalibration waits for archive depth.

## Market regime (deterministic tape context)

`market-regime.ts` classifies the tape from four ETF proxies vs the prior
close (QQQ direction, SPY confirmation, SMH for semis, TLT for rates —
plain stocks, entitled pre-market from 04:00): `risk-off` / `risk-on` /
`neutral` / `unknown`, with `semis-led` and `yield-driven` flavors. Cached
5 min; transitions logged. Consumers: on risk-off the single-name trigger
bar rises `REGIME_LONG_PENALTY` for longs and drops `REGIME_SHORT_RELIEF`
for shorts; every trigger/breadth evaluation prompt carries the TAPE line;
and a semis-led risk-off tape pre-arms the breadth SHORT-vehicle
evaluation — pre-market included (the tape prints from 04:00; the
evaluation prompt teaches the GTC STP_LMT-below-the-pre-market-low
pattern). Pre-arm firings carry their own cooldown and daily cap
(`REGIME_PREARM_*`), and scan-confirmed breadth fires ignore pre-arm
stamps entirely — a tape-only look never delays scan evidence. The full
breadth-day state (cap bonus, threshold relief) stays scan-earned.
`unknown` (quotes unavailable) applies zero tilt everywhere. Prices are
the signal; headlines remain visibility-only. Suppressed trigger/breadth
evaluations ledger their one-line decline reason as `judgment`-gate
refusal rows, so the nightly replay scores the judgment layer the same
way it scores the deterministic gates.

Deterministic enforcement of `risk-rules.yaml` (the `risk_manager` tool is
advisory; this gate is mandatory):
- at **creation**, the sizer first composes EVERY budget from the proposals
  store (WP6, 2026-09-05): risk budget, position cap, per-symbol aggregate
  room, daily-loss headroom (planned stop-outs of the open book plus today's
  realized losses), the overnight position/book caps and the class-aware
  gap-stress room (swing class), the sector room, the ADV cap — the smallest
  binds and is named in the result — then the **cost-to-target** check
  refuses a trade whose estimated round trip (two commissions, one spread
  crossing, slippage) exceeds `max_cost_to_target_pct` of the gross gain at
  the target. The same context is handed to the creation gate, so a sized
  proposal passes it by construction; acceptance re-checks with fresh
  broker marks and refuses on drift, never resizing;
- at **creation** (`createProposal`): coherent stop/target, min price,
  min risk/reward, integer quantity, and the **noise-stop filter** (stop
  distance must be ≥ `min_stop_atr_fraction` × the daily ATR(14), fetched
  server-side — a tighter stop sits inside intraday noise and fills on
  randomness), the **extension guard** (entry further than
  `max_extension_atr` × daily ATR beyond the 10-day EMA is chasing a move
  that mean-reverts — the first live week lost on exactly this pattern),
  the **target-reachability cap** (intraday targets further than
  `max_target_atr` × daily ATR from entry are fantasy — the 82-trade audit
  2026-08-18 found ratio-manufactured targets reached 10% of the time;
  swing/earnings-bet and post-print repricing days exempt; executed trades
  now record their held MFE/MAE so the cap can be tuned from evidence),
  the **buy-now entry-pricing filter** (intraday entries must rest a
  pullback LMT at least max(0.1%, 0.25× the stop distance) beyond the live
  price, or trigger a STP_LMT the same margin past it — 72/79 executed
  entries were limits at the quote, median 47s to fill, 12% wins; each
  proposal also records its entry context: extension ×ATR, VWAP distance,
  day move, minutes since open),
  and the **duplicate-setup guard** (entry within 2% of an existing
  working bracket on the same symbol) — violating proposals are never
  persisted. ATR/EMA references use **completed daily bars only**, so a
  gap day's giant in-progress bar cannot inflate ATR and license its own
  chase;
- at **acceptance** (executor): position value vs `max_position_pct` of the
  live NetLiquidation, `max_open_positions` (executed-not-closed count),
  `max_daily_trades` (executed today, ET), the **per-trade risk budget**
  (quantity × stop distance ≤ `max_risk_per_trade_pct` of NetLiq — every
  trade loses the same amount when wrong), and the **per-symbol aggregate
  cap** (notional committed across ALL working/filled proposals on one
  symbol ≤ `max_position_pct` — two individually-passing proposals cannot
  stack into an oversized single-name bet).

### Outcome tracker — `src/services/outcome-tracker.ts`
Closes the feedback loop on executed proposals. Watches the bracket's three
orders via `orderStatus`/`execDetails`/`commissionReport` and writes back:
entry fill price/time, exit fill price, exit reason (`target` / `stop` /
`cancelled` / `manual` / `unknown`), gross realized P&L and commissions —
then flips the proposal to `closed` and pushes a WhatsApp close alert.
Survives restarts (state rebuilt from the DB, today's executions replayed
via `reqExecutions`) and reconnects (listeners re-attach). Trades whose
outcome is unrecoverable (executed while tracking was down for days) are
swept as `unknown`, never guessed.

### Archive scheduler — `src/services/archive-scheduler.ts`
Daily post-close data collection (16:20 ET, holidays skipped): archives
1-min (1 day) and 5-min (2 days) bars for today's snapshot symbols ∪
proposal symbols ∪ `DATA_ARCHIVE_SYMBOLS` watchlist (capped by
`DATA_ARCHIVE_MAX_SYMBOLS`, watchlist never dropped) into
`DATA_ARCHIVE_PATH`. This is the training corpus for the ML phase.
Disable with `DATA_ARCHIVE=false`. Historical ranges are backfilled with
`scripts/backfill-bars.ts` (chunked, paced, resumable).

### Universe sweep — `src/services/universe-sweep.ts` (OPT-IN)
`UNIVERSE_SWEEP=true` adds a nightly job (18:00 ET): US common-stock
directory (nasdaqtrader) + shares outstanding (SEC EDGAR, no key) →
market caps → ~400 days of daily bars archived for names in the
`UNIVERSE_CAP_MIN..MAX` band (default $1–5B). The engine's intraday scans
can be restricted to the same band via `OPP_MARKET_CAP_MIN/MAX` (unset =
unchanged behavior), and the `ibkr_scanner` tool accepts `maxMarketCap`.

### Swing pattern scan — `src/services/pattern-{detectors,scanner}.ts`
After each sweep, pure detectors run over every symbol with ≥120 archived
daily bars (local SQLite, no IBKR requests): **pullback-in-uptrend** (rising
EMA50 trend, orderly 3–12% pullback to the EMA20 on contracting volume),
**flat-base** (20–35d range ≤10% near highs after a +25% advance), and
**cup-and-handle** (12–35% rounded cup, rims within 10%, short shallow
handle in the upper half, volume dry-up). All three trigger on pullbacks
and pivots — never on vertical extension. The top 25 (with pivot,
suggested STP_LMT trigger, structure stop, daily ATR, measured evidence)
persist to `.dexter/data/pattern-scan.json`; the agent reads them via the
`swing_patterns` tool (`latest`/`refresh`), and the Pre-Market Brief
verifies news on the top candidates and registers GTC STP_LMT swing
proposals through the normal gates. Manual run:
`bun run scripts/pattern-scan.ts`.

### Position guardians (deterministic, no LLM)
Three services watch every position the executor creates:
- **Profit trail** — `src/services/profit-trail.ts`: RTH 60 s poll over
  intraday positions (swing/earnings-bet exempt); once a position's
  unrealized gain reaches `profit_trail_arm_atr_mult` × daily ATR
  (risk-rules, 2.5×; absolute `profit_trail_arm_pct` 5% when ATR is
  unavailable) it ARMS and tracks the peak; a
  `profit_trail_pullback_atr_mult` × ATR (0.75×; fallback 1.5%)
  giveback closes at market via `closePosition` (exits cancelled,
  auto-protect suppressed). Peaks persist across restarts; armed stays
  armed; shorts mirrored. `PROFIT_TRAIL=false` to disable.
- **Auto-protect** — in the outcome tracker: a `manual` close with a
  filled entry (DAY exits died at the bell) re-attaches a GTC stop/target
  OCA pair at the proposal's levels and alerts (`🛡️`); no-ops when flat;
  refuses when GTC exits already exist. `AUTO_PROTECT=false` to disable.
- **EOD triage** — `src/services/eod-triage.ts`: 15:52 ET, each filled
  DAY-bracket position is triaged: CLOSED before the bell only when it is
  losing vs its entry fill AND the last hour still runs against it
  ('the horizon is fading'); winners and stabilizing losers KEEP their
  overnight chance — the bell expires the DAY exits and auto-protect
  converts to a 🌙 GTC-protected hold. Doubt (missing prices/momentum)
  always keeps. `EOD_TRIAGE=false` to disable.
- **Stale-entry sweeper** — `src/services/stale-entry-sweeper.ts`: every
  10 min, two lanes — cancels intraday entries still unfilled past their
  stamped expiry (+`ENTRY_EXPIRY_GRACE_MIN`, 30) and the orders of executed
  proposals whose ENTRY never filled after `STALE_ENTRY_MAX_DAYS` (3) —
  the tracker closes them as `cancelled`, freeing `max_open_positions`
  slots from zombie brackets. Parent leg only, broker-confirmed.

### Earnings calendar — `src/services/earnings-calendar.ts`
Keyless Nasdaq public data, 6 h cache, 7-day lookahead, pure parser.
Consumed by the `earnings_calendar` tool, the Pre-Market Brief (today's and
tomorrow's reporters vs the book) and the Pre-Close Review (every position
checked `withinDays 2`). An unfetchable day is "could not verify", never
"no earnings". The legacy Financial Datasets client sits behind a circuit
breaker: the first 401/402 short-circuits further calls for an hour.

### Local dashboard — `src/services/dashboard{,-page}.ts`
`http://127.0.0.1:8484/` served by the gateway from its own data (no
second IBKR session — external viewers steal the Gateway's brokerage
session). Book sidebar (positions, working orders, proposals, trail
peaks, swing candidates), candlestick chart with entry/stop/target/peak
lines (live 1-min over the existing session, archive fallback), and
action buttons routed through the SAME executor paths as WhatsApp,
CSRF-protected by a per-startup token. Resizable splitter; EADDRINUSE
bind retries survive restart overlap.

### Scheduled briefs — `src/cron/trading-schedules.ts`
Seeded at gateway startup (prompt changes in code are re-synced to already
seeded jobs; schedules stay user-tunable):
- **Pre-Market Brief** (08:00) — overnight recap, calendar, gaps.
- **Market Open Scan** (09:35) — consumes the snapshot, verifies catalysts
  (web_search) and risk (risk_manager), registers ≤ 3 intraday proposals
  (90 min expiry) with accept instructions.
- **Midday Check** (12:00) — positions + mean-reversion scan.
- **Pre-Close Review** (30 min before the session close — 15:30 ET, 12:30 ET
  on a half-day; schedule kind `session-close`, market calendar) — positions
  hold/trim/close, then ≤ 2 overnight proposals (expiry clamped to the bell)
  validated against overnight risk limits. The executor never runs a
  session-close job past the day's close.

### Event triggers — engine + `src/gateway/trigger-alerts.ts`
When a candidate enters the **top 3** with `compositeRank ≥ OPP_TRIGGER_SCORE`
(default **60** since the live-loop WP1, 2026-09-05 — was 75) during loop
cycles: debounce per symbol (`OPP_TRIGGER_COOLDOWN_MIN`, default 30) and
daily cap (`OPP_TRIGGER_MAX_PER_DAY`, default **30** — was 10), split by
session window (`OPP_TRIGGER_BUDGET`, default **8/10/12/0** for pre-open /
open-drive / midday / pre-close, REQ-TRIG-005): the quotas are cumulative
allowances, so unused quota rolls forward and a later window may use
whatever the day left; the breadth bonus widens the current window. Before
the split the dawn watch spent the whole cap before the bell (2026-09-08:
cap reached 08:16 ET, INTC's +10 % session blind). The pre-close quota is 0
since 2026-09-09: new intraday entries are refused inside the last hour
(`intraday_entry_cutoff_min`, REQ-LANE-010 — DOCN 2026-09-08 was placed
15:10 and flattened 15:52), so a late trigger could only buy an evaluation
whose proposal the contract refuses. A focused,
isolated agent run checks the news catalyst and risk; if actionable it
registers a proposal and the alert lands on WhatsApp. Non-actionable
evaluations are suppressed (and ledgered). The firing rank rides the run
and is stamped on the proposal (`trigger_rank`, `trigger_band` '60-74' or
'75+') so the class the lower bar admitted stays measurable apart. The
composite's move term is ATR-normalised (significance, REQ-SCAN-004); a
large-cap scan lane and vehicle-complex constituent admission widen what
reaches the ranking (REQ-SCAN-006/007); a vehicle is never traded against
its own constituents (REQ-SCAN-008). Evaluation lanes stop for the day once
the LLM spend cap is reached (`LLM_DAILY_SPEND_CAP_USD`, REQ-LLM-002).

### Nightly simulator settle — `src/services/simulator/` (live-loop WP2)
At 17:10 ET (after the 16:45 benchmark), every proposal created in the last
three days and every refusal with complete levels is replayed against real
bars for each active shadow variant — `incumbent` (the as-traded twin),
`funnel-75`, `gate-off:<gate>`, `exit-ratchet`, `exit-x2.0`, `stop-x/3`,
`entry-confirm` (the intraday row re-entered as a STP_LMT breakout of the
first 15 min after the open, +0.3 % band, stop distance kept, take-x from the
trigger — 2026-09-08), `class-swing`, `class-earnings-bet` — sized at the
current ladder rung, with
IBKR-tier commissions, into `.dexter/data/simulator.db`. Fills are
pessimistic by construction (trade-through entries and targets, gap-aware
stops, stop-first ties, market at the next open); bars come from the 5-second
stream when the symbol was streamed, else the 1-minute archive, else one
paced IBKR request; no covered source → `unknown`, never a fabricated fill.
Open GTC rows re-settle nightly. A WhatsApp report lists each variant's n,
summed and mean R, and the twin-vs-actual slippage line; a failed settle is
reported, never skipped. The simulator can never reach the broker (its own
database, no order ids).

### Candidate archive + overnight benchmark — `src/services/candidate-archive.ts`, `src/services/overnight-benchmark.ts` (WP7)
On EVERY pre-close opportunity snapshot the archive captures the observable
universe, point-in-time and per lane, into `.dexter/data/candidate-archive.db`:
the overnight lane from the snapshot (every scored candidate with its price,
daily ATR, day move, lane rank — a symbol's first sighting of the day stands),
the cup-and-handle lane from the nightly pattern scan (cup matches, detector
version, state). Each proposal records the snapshot it was created against
(`snapshot_ts`). Each row gets a
deterministic eligibility verdict with reasons (stale data, min price, ATR
missing, day move unknown or against the direction, earnings within 2 days)
and versioned mechanical levels — overnight v2: MKT at the next bar, target at
take-x, stop at min(`stop_atr_multiplier` × ATR, take distance / `min_risk_reward`)
so the twin meets the gate's R:R (a stop inside the noise filter voids the
row), flat at the 10:00 ET deadline. Nothing archived is ever re-priced;
"eligible" means eligible for the benchmark, not admissible by Dexter. After
the nightly settle, the overnight benchmark replays every due eligible row
with the simulator's pessimistic fill model against next-session bars, records
the gap (next open vs capture price), fill, exit, gross R (size-invariant label)
and net R at the overnight budget (informational), joins each
row to what the system did with it (proposed / refused by gate / not admitted),
and sends one 🌙 block per capture day: the whole universe, the top-5 by rank,
the judgment's picks, the not-admitted rest, unknowns. Cup rows are archived,
not replayed (later WP). Since WP7 bar coverage is judged per regular-session
segment (the overnight gap is not a hole) and GTC twins replay on regular-session
bars — before that every GTC twin settled 'unknown'. The bar archive's universe
gains the symbols of open GTC rows and the prior day's eligible candidates.
Read-only table: `bun run scripts/overnight-benchmark.ts --day YYYY-MM-DD`.
Disable the capture with `CANDIDATE_ARCHIVE=false`. Nightly order: archive
16:20 → benchmark 16:45 → settle 17:10 → overnight benchmark → looks → digest.

### Lane deadline sweeper — `src/services/lane-deadline-sweeper.ts` (four-lane WP5)
Every proposal carries a lane contract (`strategyId`: intraday / overnight /
swing / cup-and-handle / earnings-bet; `src/services/lane-contract.ts`). The
lanes beyond the session get an exit deadline stamped at entry fill from the
market calendar — overnight: 10:00 ET of the next trading session; swing and
cup-and-handle: 15:50 ET 10 / 15 trading sessions AFTER the fill session (the
11th / 16th session counting the fill day), pulled to 12:50 ET on a half-day. Every 60 s during the regular session the sweeper
closes a still-open position at or past its deadline through `closePosition`
(cancel exits, market-close, confirm flat). An ATTEMPT is recorded before the
order (`deadline_attempted_at`, `deadline_attempts`); `deadline_closed_at` is
stamped only when the broker confirms flat (or the bracket already exited); a
close that does not confirm is retried after 5 min, at most 3 times, then
handed to the operator (review 2026-09-06). A close that does not confirm
flat is an incident (WhatsApp alert, `kill SYMBOL`). An overnight entry that
never filled dies with its expiry (clamped to the close) through the
stale-entry sweep. The lanes ride the swing risk class at the 15:52 triage:
the earnings guard and the whole-book vet apply; flat-by-close does not.

### Nightly looks + digest — `src/services/loop/` (live-loop WP3)
The tail of the nightly pipeline (settle → LOOKS → DIGEST) runs right after
the simulator settle, whether or not the settle succeeded. The looks rebuild
the epoch sample (closed, entry-filled, production lanes, deployable classes,
proposed inside the epoch), check integrity (pre-registered constants hash,
planned-risk anomalies, an EOD triage stamped `failed` today) and evaluate
every look boundary n has newly reached — once each, recorded in
`epoch-state.json`: ACCEPT (LCB > 0, net R > 0, PF ≥ 1.3 at 99 / 97.5 / 96 /
95 % for n = 25 / 50 / 75 / 100) is the pre-registered cutover evidence
(alert + journal); REJECT (UCB95 < 0) STOPS the epoch (status `stopped`,
journal, alert, live switch OFF); an ACCEPT is withheld while the '60-74'
band reads negative at n ≥ 20. Between boundaries the numbers are
INFORMATIONAL. Ladder step-up eligibility (n ≥ 25 / 50 / 100, net R > 0, no
stop) is QUEUED for the operator; the equity sampler applies the automatic
step-down (−5 % from the step-up mark) and the −5 % hard stop on every
5-minute mark. The digest (four sections, ≤ 12 lines each on WhatsApp; full
tables at `/api/loop` and the dashboard's Loop panel) then goes out through
the outcome-alerts bridge; `digest` re-sends it. `bun run
scripts/validation-scorecard.ts --look` runs the same module on demand.

### WhatsApp command router — `src/gateway/proposal-commands.ts`
Inbound DMs are pre-routed **before** the agent (deterministic, no LLM):

| Message | Effect |
|---|---|
| `accept P-XXXX` (or `ok`, `go`) | execute through the proposal executor |
| `reject P-XXXX` (or `no`) | reject the proposal |
| `proposals` | list open proposals |
| `positions` | current holdings + daily P&L from IBKR |
| `orders` | working (unfilled) orders at IBKR |
| `protect SYM STOP [TGT]` | attach GTC protective exits to an open position |
| `close SYM [SYM…]` | market-close position(s), cancelling their exits (risk-reducing) |
| `cancel P-XXXX` / `cancel SYM` | cancel an executed-but-unfilled bracket (symbol resolves to its proposal; ambiguity → cancel by id) |
| `halt status` | kill-switch state and daily P&L headroom |
| `performance` (or `perf`, `performance 30`) | closed-trade P&L summary (default 7 days) |
| `veto P-XXXX` / `kill SYM` | live-loop per-trade controls (cancel an unfilled auto-execution / close at market) |
| `live status` / `ladder` / `epoch` / `digest` | live-loop state and the day's digest (read-only) |
| `live on` → `live on <token>` / `live off` | the live switch: challenge + evidence, confirm within 2 min (ON, journaled); OFF is immediate (WP4) |
| `ladder up` → `ladder up confirm` | apply a queued size-ladder step-up (two-step; the step-down mark is set at the current NetLiq) |
| `epoch new [carry]` (→ `… confirm` while one runs) | start the next epoch: USD NetLiq frozen, record + journal, rung reset to 0.25 % unless `carry` |
| `promote <variant>` → `promote <variant> confirm` | record a ratified promotion and print the exact change + restart + `epoch new` steps |

The explicit human message IS the approval — execution still passes every
safety gate below.

### Execution path — `src/services/proposal-executor.ts` + `src/tools/ibkr/bracket.ts`
Single code path to orders: proposal open & unexpired → **atomic execution
claim** (`open → executing` via a conditional UPDATE + claim token: exactly
one concurrent accept wins; the loser is refused instead of placing a
second bracket) → **paper/live safety lock** → **daily-loss kill-switch** →
**risk gate with live account context** → **chase gate** (live quote vs
proposal levels: refuses when the price has consumed >25% of the
entry→target edge or traded through the stop — stale accepts on fast
movers stay open for re-evaluation) → bracket placement (entry
LMT/MKT/STP_LMT + take-profit + stop linked by `parentId` and an OCA
group; the stop carries `transmit=true` so the bracket transmits
atomically). Gate refusals release the claim back to `open` (retryable);
claims stuck >10 min (crash mid-placement) are swept to `failed` with a
verify-manually note. All order placement — brackets, direct orders,
protect, close — runs under a **global order lock**
(`src/tools/ibkr/order-lock.ts`): IBKR's `nextValidId` sequence is not
concurrency-safe and brackets assume contiguous ids N/N+1/N+2. The
executed proposal is handed to the outcome tracker.

## 3. Safety model (layered, independent gates)

1. **Approval gating** — `ibkr_orders` and `accept_proposal` require
   interactive approval; headless agent runs are auto-denied
   (`src/agent/tool-executor.ts`). The LLM cannot execute, ever.
   A session-level approval ("allow for this session") applies to the
   ONE tool approved — approving a file edit never pre-approves orders.
2. **Paper/live safety lock** — order placement refused on live ports
   (4001/7496) and non-`D` accounts unless `IBKR_ALLOW_LIVE=true`
   (`connection.ts: assertOrderingAllowed`). Risk-increasing placements
   additionally require the connection's account codes to have been
   RECEIVED (`assertAccountsVerified`) — an empty account list refuses
   (fail closed) instead of silently passing the prefix check.
3. **Daily-loss kill-switch** — `src/services/daily-loss-guard.ts`. New orders
   blocked once IBKR daily P&L ≤ −`max_daily_loss_pct` × NetLiquidation
   (risk-rules.yaml, default 2 %). **Latching** (rest of the ET day, stored in
   `.dexter/data/trading-halt.json`, survives restarts) and **fail-safe**
   (nothing verifiable → refuse). IBKR's `reqPnL` is flaky on paper
   accounts, so when it fails the guard falls back to a **NetLiq proxy**:
   current NetLiquidation − the session baseline captured at gateway
   startup (`netliq-baseline.json`); only when NetLiquidation itself is
   unavailable does the guard refuse. Gate refusals leave the proposal
   OPEN for retry. Inspect with `halt status`; deliberate reset via
   `clearTradingHalt()`. The kill-switch applies to EVERY risk-increasing
   order path — proposal acceptance AND direct `ibkr_orders place`
   (protect/close/cancel stay exempt: they only reduce risk) — and a
   halt file that exists but cannot be parsed counts as HALTED (fail
   closed), never as "no halt".
4. **Risk gate (deterministic)** — `src/services/proposal-risk-gate.ts`
   enforces `risk-rules.yaml` at proposal creation (min R/R, min price,
   coherent stops, quantity sanity) and again at acceptance with the live
   account numbers (position size vs NetLiquidation, max open positions,
   max daily trades). The `risk_manager` tool remains available to the LLM
   for richer advisory checks (sector exposure, overnight limits).
5. **Auto-execution (optional) is paper-only by construction** — see §5.

### Security review record (2026-07-17)

An external code review was verified finding-by-finding and fixed in
five commits. What changed, and what was deliberately deferred:

| Finding | Fix | Commit |
|---|---|---|
| Double-accept race (TOCTOU between status read and placement) | atomic `open → executing` claim + release-on-refusal + stuck-claim sweep | `efbb3c1` |
| Order-id collisions (`nextValidId` + contiguous N/N+1/N+2 assumption) | global order lock on every placement path; guessed-id fallback now fails | `efbb3c1` |
| `allow-session` approved ALL sensitive tools | approval is per-tool | `0487439` |
| Browser singleton declared concurrency-safe | `concurrencySafe: false` | `0487439` |
| Shell injection in the privileged rebase workflow (`head_ref` interpolation) | values via `env` only + character allowlist | `3fbea38` |
| Direct `ibkr_orders place` bypassed the kill-switch | `assertDailyLossOk` on every risk-increasing path | `e4c6b99` |
| Paper check silently passed on an empty account list | `assertAccountsVerified` — refuse until codes received | `e4c6b99` |
| Corrupt halt file treated as "no halt" | unreadable halt file counts as HALTED | `e4c6b99` |
| SSRF: any scheme/host fetchable (incl. `127.0.0.1:4002`); browser unvalidated | http(s)-only + private/reserved/local ranges blocked, browser uses the same validator | `970291e` |

Deferred (revisit before live trading / multi-user):
- cron results deliver to the most-recent WhatsApp session (single-user
  assumption — bind jobs to an owner before adding users);
- DNS-rebinding-resistant fetching (resolve-and-pin);
- `gateway-debug.log` rotation/PII scrubbing, cron-store write locking,
  `tsconfig` coverage of `scripts/`, a linter.

## 4. Calibration (walk-forward grid search)

The scorer's four factor weights (momentum / mean-reversion / volume / trend,
default 0.25 each) are calibratable:

```bash
bun run scripts/calibrate-scorer.ts AAPL NVDA MSFT 2024-01-02 2024-12-30
bun run scripts/calibrate-scorer.ts AAPL --fine     # 0.10-step grid (286 sets — long)
bun run scripts/calibrate-scorer.ts AAPL --apply    # write the winner
```

Method: for each weight set on the simplex, a walk-forward backtest
(default 180-day train / 30-day test folds) on FirstRate data; ranking by
**average out-of-sample Sharpe**, with penalties for configurations that
barely trade. `--apply` refuses to overwrite the defaults unless the winner
beats the equal-weight baseline by more than 0.05 Sharpe, and writes
`.dexter/data/scorer-weights.json` — picked up by the live scorer, the
engine, and future backtests (restart running processes).

Resolution order of weights: explicit argument > in-process override
(calibration) > `scorer-weights.json` > equal defaults.

## 5. Paper-only auto-execution (off by default)

`AUTO_EXECUTE_PAPER=true` lets proposals from every source (briefs, scans,
triggers) execute without a human reply, under STRICTER conditions than
manual acceptance:

- **Hard paper assertion**: refuses live ports/accounts **regardless of
  `IBKR_ALLOW_LIVE`**. Auto-execution cannot be enabled for live trading by
  any configuration — going live always requires explicit human acceptance
  per trade.
- **Confidence floor**: only proposals with score ≥ `AUTO_EXECUTE_MIN_SCORE`
  execute unattended — lower scores stay open for manual accept. Default
  **0** since D6 (2026-08-21): the validation burn-in samples every score
  band with FLAT sizing; unscored proposals still never auto-execute.
- Daily cap: `AUTO_EXECUTE_MAX_PER_DAY` (default 6, aligned with
  `max_daily_trades` since 2026-09-05).
- All standard gates still apply (kill-switch included), plus the epoch
  latch (a stopped epoch pauses new entries) and the per-complex direction
  gate.
- Live accounts (live-loop WP1/WP4, REQ-LIVE-001/004/006/007):
  auto-execution additionally requires `IBKR_ALLOW_LIVE=true`, the
  operator's live switch (`live-switch.json` — written ON only by the
  challenge-confirmed `live on <token>`; `live off` and every epoch stop
  write OFF; nothing in the system writes ON), verified account identity,
  the live rule profile, a running epoch and no latched halt. Swing and
  earnings-bet rows are never auto-executed on a live account: they are
  marked sim-only (rejected + refusal row) and settle in the simulator.
  `LIVE_VETO_WINDOW_MIN` > 0 announces and defers each auto-execution so
  `veto P-XXXX` can stop it (default 0 = immediate); the due-sweep executes
  oldest first through every gate, and a row the executor has claimed
  cannot be vetoed (`cancel`/`kill` apply after placement).
- Every auto-execution is reported on WhatsApp (`🤖 AUTO-EXECUTE (paper|live, score S, n/cap)`).

## 6. Configuration reference (env)

| Variable | Default | Role |
|---|---|---|
| `OPPORTUNITY_ENGINE` | true | gateway auto-start of the engine |
| `OPP_TOP_N` | 8 | ranked candidates kept/streamed |
| `OPP_MAX_CANDIDATES` | 20 | symbols scored per cycle (pacing) |
| `OPP_TRIGGER_SCORE` | 60 | composite threshold for event triggers (75 before 2026-09-05) |
| `OPP_TRIGGER_COOLDOWN_MIN` | 30 | per-symbol trigger debounce |
| `OPP_TRIGGER_MAX_PER_DAY` | 30 | trigger cap per ET day (10 before 2026-09-05) |
| `OPP_TRIGGER_BUDGET` | 8/10/12/0 | session-window split of the cap (pre-open/open-drive/midday/pre-close), cumulative with roll-over (REQ-TRIG-005); pre-close 0 since the intraday cutoff (REQ-LANE-010) |
| `OPP_LARGECAP_LANE` / `_MIN_USD` / `_RESERVE` | true / 1e10 / 5 | large-cap scan lane and its reserved candidate slots (REQ-SCAN-006) |
| `PREMARKET_SPREAD_HARD_MULT` | 3 | pre-open DAY accepts: spread over the cap but under cap × this is deferred to the 09:31 ET re-check (REQ-RISK-008) |
| `LIVE_VETO_WINDOW_MIN` | 0 | minutes an announced auto-execution waits for `veto P-XXXX` (REQ-LIVE-002) |
| `LLM_DAILY_SPEND_CAP_USD` | 10 | evaluation lanes stop for the day at this spend; 0 disables; needs both price knobs (REQ-LLM-001/002). The meter is cache-aware since 2026-09-09 (reads 10 %, writes 200 % of the input price; the agent's system-prompt cache lives 1 h) and logs one `[llm-spend]` line per run with the hit rate (REQ-LLM-004/005) |
| `LLM_SPEND_CRON_RESERVE_USD` | 2 | USD of the cap kept for the cron lanes: trigger/breadth/mover stop at cap − reserve, `cron:*` at the cap (REQ-LLM-003) |
| `LLM_PRICE_IN_USD_PER_MTOK` / `LLM_PRICE_OUT_USD_PER_MTOK` | — | USD per million input/output tokens; required while the cap is on |
| `SIMULATOR` | true | nightly shadow-variant settle at 17:10 ET into `simulator.db` (REQ-SIM-006); observability only |
| `SIM_COMMISSION_PER_SHARE_USD` / `SIM_COMMISSION_MIN_USD` | 0.005 / 1.00 | the simulator's per-side commission assumption (IBKR fixed tier) |
| `DEXTER_JOURNAL_PATH` | `docs/day2day/VALIDATION-JOURNAL.md` | where the loop appends its epoch/ladder/promotion lines (WP3) |

Lane parameters live in the risk yamls, not env (WP5, research parameters):
`overnight_risk_pct` (0.5 base / 0.75 live), `max_overnight_lane_positions`
(2), `overnight_entry_window_min` (60 → from 15:00 ET on a full day), `overnight_exit_minutes_et`
(600 = 10:00), `swing_max_hold_days` (10), `cup_max_hold_days` (15),
`intraday_entry_cutoff_min` (60 → no new intraday entry from 15:00 ET on a
full day, 12:00 on a half-day, at creation and at acceptance; REQ-LANE-010).
| `OPP_HEALTH_EMPTY_CYCLES` | 3 | consecutive zero-scan cycles (market open) before a degraded-scanner WhatsApp alert |
| `UNIVERSE_EXTRA_SYMBOLS` | — | watchlist archived nightly + swing-pattern-scanned regardless of the cap band |
| `AUTO_EXECUTE_PAPER` | false | paper-only auto-execution of proposals (all sources) |
| `AUTO_EXECUTE_MAX_PER_DAY` | 6 | auto-execution cap per ET day (aligned with `max_daily_trades`) |
| `AUTO_EXECUTE_MIN_SCORE` | 0 (D6) | auto-exec confidence floor (score); unscored never auto-executes |
| `AUTO_PROTECT` | true | GTC exits auto-reattached when DAY exits die on an open position |
| `EOD_TRIAGE` | true | 15:52 ET losing-and-fading DAY positions closed; rest kept overnight |
| `PROFIT_TRAIL` | true | auto-close winners: arm at `profit_trail_arm_atr_mult`×ATR (2.5), close on `profit_trail_pullback_atr_mult`×ATR (0.75) pullback from peak; 5%/1.5% absolute fallback when ATR unknown; swing/earnings-bet exempt |
| `DASHBOARD` / `_PORT` / `_HOST` | true / 8484 / 127.0.0.1 | local charts+book dashboard served by the gateway (no second IBKR session) |
| `STALE_ENTRY_MAX_DAYS` | 3 | cancel executed-but-unfilled entries after N days (0 = off) |
| `IBKR_ALLOW_LIVE` | false | manual-acceptance live unlock (never affects auto) |
| `DATA_ARCHIVE` | true | daily post-close bar archival (16:20 ET) |
| `DATA_ARCHIVE_SYMBOLS` | — | always-archived watchlist (comma-separated) |
| `DATA_ARCHIVE_MAX_SYMBOLS` | 30 | per-day archival cap (IBKR pacing) |
| `max_daily_loss_pct` (risk-rules.yaml) | 2 | kill-switch threshold |

Data files (under `DEXTER_DATA_DIR`, default `.dexter/data/`):
`opportunities.db`, `proposals.db`, `trading-halt.json`,
`scorer-weights.json`, `stream-bars.db`, plus the market archive at
`DATA_ARCHIVE_PATH` (default `.dexter/data/market-archive.db`).
Logs: `.dexter/logs/dexter-<date>.jsonl`.

## 7. Operations

```bash
bun run gateway                              # full system (engine + crons + triggers + WhatsApp)
bun run scripts/demo-opportunities.ts        # one engine cycle, printed (no LLM)
bun run scripts/demo-backtest.ts AAPL        # backtest with walk-forward folds
bun run scripts/calibrate-scorer.ts AAPL     # weight grid search (dry run)
bun run scripts/smoke-ibkr.ts AAPL           # IBKR wiring check (read-only)
```

Monitoring: `tail` the JSONL logs (`[opportunity-engine]`, `[trigger-alerts]`,
`[proposal-executor]`, `[outcome-tracker]`, `[archive-scheduler]`,
`[daily-loss-guard]` prefixes); `proposals`, `halt status` and `performance`
over WhatsApp; `opportunities` / `trade_proposals` tools in the TUI.

Tests: `bun test` (primary) or `npm run test:jest` on machines without bun
(same colocated files; `bun:test` imports are bridged to jest).

See also the extensive handbook: [docs/handbook/](../handbook/README.md).

Known limits: IBKR scanners require a real-time US equity market-data
subscription (shared to the paper account; Gateway re-login to load the
entitlement) and pacing bounds cycle depth (~25 rows/scan); the
kill-switch trusts IBKR's `reqPnL` daily figure; trigger evaluations use the
default configured model (point a local vLLM via the model picker for cheap
triage — launch vLLM with `--enable-auto-tool-choice --tool-call-parser …`);
calibration requires proprietary FirstRate data.
