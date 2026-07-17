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
| Judgment | LLM, event/schedule-driven | API tokens | Trigger evaluations, 09:35/15:30 cron briefs |
| Execution | Human-gated, deterministic | — | Proposal executor (bracket orders) |

```
IBKR scanners ──> filter ──> signal scorer ──> composite ranking ──> snapshot (SQLite)
   (multi-code, session-aware cadence, no LLM)            │
                                                          ├──> cron briefs 09:35 / 15:30 ──> LLM ──> proposals ──> WhatsApp
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
| midday | 10:30–15:00 | 10 min | TOP_PERC_GAIN, MOST_ACTIVE, TOP_PERC_LOSE (short) |
| pre-close | 15:00–16:00 | 5 min | TOP_PERC_GAIN, MOST_ACTIVE, HOT_BY_VOLUME |
| idle | otherwise | sleeps | — |

Each cycle: parallel scans (per-code 5-min cache) → dedupe (multi-scanner
symbols prioritized) → multi-factor scoring via the `signal_scorer` pipeline
(sequential, 300 ms pacing, capped at `OPP_MAX_CANDIDATES`) → composite rank
(`signalScore + min(10, 2×RVOL) + 3×(extra scanners)`) → snapshot persisted to
`.dexter/data/opportunities.db` (7-day retention) → top-N subscribed to the
realtime stream (`ibkr-stream`, reconnect-safe).

Starts/stops with the gateway when IBKR is configured; opt-out with
`OPPORTUNITY_ENGINE=false`.

### Agent tools (registered when IBKR is configured)
- **`opportunities`** — `latest` (cached snapshot) / `refresh` (run a cycle,
  ~30–60 s). Advisory; snapshots taken while the market is closed carry
  `marketOpen=false`.
- **`trade_proposals`** — `create` / `list` / `get` / `reject` /
  `performance`. Creating a proposal NEVER trades: it persists a record in
  `.dexter/data/proposals.db` (`P-XXXX` ids, statuses
  open/executed/closed/rejected/expired/failed, default expiry 2 h).
  Creation passes the **deterministic risk gate** (below); the entry price
  is required even for MKT proposals (indicative, anchors the risk math).
  `performance` returns closed-trade outcomes over the last N days.
- **`accept_proposal`** — executes an open proposal. Listed in
  `TOOLS_REQUIRING_APPROVAL`: interactive confirmation in the TUI,
  **auto-denied in headless runs** (cron, gateway, triggers).

### Risk gate — `src/services/proposal-risk-gate.ts`
Deterministic enforcement of `risk-rules.yaml` (the `risk_manager` tool is
advisory; this gate is mandatory):
- at **creation** (`createProposal`): coherent stop/target, min price,
  min risk/reward, integer quantity, and the **noise-stop filter** (stop
  distance must be ≥ `min_stop_atr_fraction` × the daily ATR(14), fetched
  server-side — a tighter stop sits inside intraday noise and fills on
  randomness), and the **extension guard** (entry further than
  `max_extension_atr` × daily ATR beyond the 10-day EMA is chasing a move
  that mean-reverts — the first live week lost on exactly this pattern) —
  violating proposals are never persisted;
- at **acceptance** (executor): position value vs `max_position_pct` of the
  live NetLiquidation, `max_open_positions` (executed-not-closed count),
  `max_daily_trades` (executed today, ET), and the **per-trade risk budget**
  (quantity × stop distance ≤ `max_risk_per_trade_pct` of NetLiq — every
  trade loses the same amount when wrong).

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
`UNIVERSE_CAP_MIN..MAX` band (default $1–5B). Substrate for the planned
swing / cup-and-handle pattern scanners. The engine's intraday scans can
be restricted to the same band via `OPP_MARKET_CAP_MIN/MAX` (unset =
unchanged behavior), and the `ibkr_scanner` tool accepts `maxMarketCap`.

### Scheduled briefs — `src/cron/trading-schedules.ts`
Seeded at gateway startup (prompt changes in code are re-synced to already
seeded jobs; schedules stay user-tunable):
- **Pre-Market Brief** (08:00) — overnight recap, calendar, gaps.
- **Market Open Scan** (09:35) — consumes the snapshot, verifies catalysts
  (web_search) and risk (risk_manager), registers ≤ 3 intraday proposals
  (90 min expiry) with accept instructions.
- **Midday Check** (12:00) — positions + mean-reversion scan.
- **Pre-Close Review** (15:30) — positions hold/trim/close, then ≤ 2 overnight
  proposals (45 min expiry) validated against overnight risk limits.

### Event triggers — engine + `src/gateway/trigger-alerts.ts`
When a candidate enters the **top 3** with `compositeRank ≥ OPP_TRIGGER_SCORE`
(default 75) during loop cycles: debounce per symbol
(`OPP_TRIGGER_COOLDOWN_MIN`, default 30) and daily cap
(`OPP_TRIGGER_MAX_PER_DAY`, default 10). A focused, isolated agent run checks
the news catalyst and risk; if actionable it registers a proposal and the
alert lands on WhatsApp. Non-actionable evaluations are suppressed.

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
| `close SYM` | market-close the full position (risk-reducing) |
| `cancel P-XXXX` / `cancel SYM` | cancel an executed-but-unfilled bracket (symbol resolves to its proposal; ambiguity → cancel by id) |
| `halt status` | kill-switch state and daily P&L headroom |
| `performance` (or `perf`, `performance 30`) | closed-trade P&L summary (default 7 days) |

The explicit human message IS the approval — execution still passes every
safety gate below.

### Execution path — `src/services/proposal-executor.ts` + `src/tools/ibkr/bracket.ts`
Single code path to orders: proposal open & unexpired → **paper/live safety
lock** → **daily-loss kill-switch** → **risk gate with live account
context** → **chase gate** (live quote vs proposal levels: refuses when the
price has consumed >25% of the entry→target edge or traded through the
stop — stale accepts on fast movers stay open for re-evaluation) → bracket
placement (entry LMT/MKT + take-profit + stop linked by
`parentId` and an OCA group; the stop carries `transmit=true` so the
bracket transmits atomically). The executed proposal is handed to the
outcome tracker.

## 3. Safety model (layered, independent gates)

1. **Approval gating** — `ibkr_orders` and `accept_proposal` require
   interactive approval; headless agent runs are auto-denied
   (`src/agent/tool-executor.ts`). The LLM cannot execute, ever.
2. **Paper/live safety lock** — order placement refused on live ports
   (4001/7496) and non-`D` accounts unless `IBKR_ALLOW_LIVE=true`
   (`connection.ts: assertOrderingAllowed`).
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
   `clearTradingHalt()`.
4. **Risk gate (deterministic)** — `src/services/proposal-risk-gate.ts`
   enforces `risk-rules.yaml` at proposal creation (min R/R, min price,
   coherent stops, quantity sanity) and again at acceptance with the live
   account numbers (position size vs NetLiquidation, max open positions,
   max daily trades). The `risk_manager` tool remains available to the LLM
   for richer advisory checks (sector exposure, overnight limits).
5. **Auto-execution (optional) is paper-only by construction** — see §5.

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
  (default 80) execute unattended — lower scores stay open for manual accept.
- Daily cap: `AUTO_EXECUTE_MAX_PER_DAY` (default 5).
- All standard gates still apply (kill-switch included).
- Every auto-execution is reported on WhatsApp (`🤖 AUTO-EXECUTE (paper, score S, n/cap)`).

## 6. Configuration reference (env)

| Variable | Default | Role |
|---|---|---|
| `OPPORTUNITY_ENGINE` | true | gateway auto-start of the engine |
| `OPP_TOP_N` | 8 | ranked candidates kept/streamed |
| `OPP_MAX_CANDIDATES` | 20 | symbols scored per cycle (pacing) |
| `OPP_TRIGGER_SCORE` | 75 | composite threshold for event triggers |
| `OPP_TRIGGER_COOLDOWN_MIN` | 30 | per-symbol trigger debounce |
| `OPP_TRIGGER_MAX_PER_DAY` | 10 | trigger cap per ET day |
| `AUTO_EXECUTE_PAPER` | false | paper-only auto-execution of proposals (all sources) |
| `AUTO_EXECUTE_MAX_PER_DAY` | 5 | auto-execution cap per ET day |
| `AUTO_EXECUTE_MIN_SCORE` | 80 | auto-exec confidence floor (score) |
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
