# Architecture

How the day2day trading extension is built, why it is built that way, and
where every moving part lives.

- [1. Design principles](#1-design-principles)
- [2. The three layers](#2-the-three-layers)
- [3. Component map](#3-component-map)
- [4. The proposal lifecycle](#4-the-proposal-lifecycle)
- [5. The safety model](#5-the-safety-model)
- [6. The feedback loop](#6-the-feedback-loop)
- [7. Scheduling](#7-scheduling)
- [8. Storage layout](#8-storage-layout)
- [9. Resilience](#9-resilience)
- [10. Model routing](#10-model-routing)
- [11. Testing strategy](#11-testing-strategy)
- [12. Known limits](#12-known-limits)

---

## 1. Design principles

1. **The LLM never runs in a loop, and the LLM never executes.**
   Continuous work is deterministic and free; LLM judgment is event- and
   schedule-driven; order placement is human-gated and passes deterministic
   safety gates. A hallucination can waste tokens; it cannot place an order
   or size a position beyond the rules.

2. **Every constraint that matters is enforced twice.** The LLM is *asked*
   to respect risk rules (advisory `risk_manager` tool in every prompt), and
   the same rules are *enforced* in code (the risk gate at creation and
   acceptance). Prompts are a soft layer; code is the hard layer.

3. **Uncertainty never trades.** If daily P&L cannot be verified, orders are
   refused. If a trade's outcome cannot be recovered, it is labeled
   `unknown`, never estimated.

4. **Everything an order does is observable and labeled.** Every executed
   proposal ends with an exit reason and (where measurable) a realized P&L.
   This is not just reporting — it is the training data for everything the
   system will learn later.

5. **Maximize reuse of Dexter.** The agent loop, tool registry, skill
   system, memory, cron runner and WhatsApp gateway are upstream Dexter;
   the trading extension adds tools and services without forking the core.

## 2. The three layers

| Layer | Nature | Cost | Cadence |
|---|---|---|---|
| **Scanning** — Opportunity Engine | Deterministic, no LLM | IBKR pacing only | Continuous (2–10 min, session-aware) |
| **Judgment** — briefs & triggers | LLM agent runs | API tokens | 4 crons/day + threshold events |
| **Execution** — proposal executor | Deterministic, human-gated | — | On explicit human accept |

```
                        ┌────────────────────────────────────────────────┐
                        │           OPPORTUNITY ENGINE (no LLM)          │
  IBKR scanners ──────> │ scan → dedupe → score (4-factor) → rank → DB   │
  (session-aware)       └───────────────┬───────────────┬────────────────┘
                                        │               │
                         snapshot (SQLite, 7d)    top-3 & rank ≥ threshold
                                        │               │
                        ┌───────────────▼───┐   ┌───────▼────────────────┐
                        │ CRON BRIEFS (LLM) │   │ EVENT TRIGGERS (LLM)   │
                        │ 08:00 pre-market  │   │ isolated agent run:    │
                        │ 09:35 open scan   │   │ catalyst? risk?        │
                        │ 12:00 midday      │   │ actionable → proposal  │
                        │ 15:30 pre-close   │   └───────┬────────────────┘
                        └───────────────┬───┘           │
                                        │   ┌───────────▼───────────┐
                                        └──>│  TRADE PROPOSALS (DB) │<── risk gate (creation)
                                            │  P-XXXX, human-gated  │
                                            └───────────┬───────────┘
                                                        │  human: "accept P-XXXX" (WhatsApp)
                                                        │  or TUI approval; optional paper-only
                                                        │  auto-exec for trigger proposals
                                            ┌───────────▼───────────┐
                                            │   PROPOSAL EXECUTOR   │
                                            │ 1 open & unexpired?   │
                                            │ 2 paper/live lock     │
                                            │ 3 daily-loss switch   │
                                            │ 4 risk gate (live ctx)│
                                            │ 5 bracket placement   │
                                            └───────────┬───────────┘
                                                        │ entry + OCA stop/target
                                            ┌───────────▼───────────┐
                                            │    OUTCOME TRACKER    │
                                            │ fills → exit reason   │
                                            │ → realized P&L        │
                                            │ → status 'closed'     │
                                            │ → WhatsApp alert      │
                                            └───────────┬───────────┘
                                                        │
                                  performance reports · pre-market recap ·
                                  calibration evidence · ML training labels
```

## 3. Component map

### Scanning layer (deterministic)

| Component | File | Role |
|---|---|---|
| Opportunity Engine | `src/services/opportunity-engine.ts` | Session-aware scan→score→rank loop; snapshots to SQLite; fires triggers; syncs the realtime stream to the top-N |
| Scanner loop | `src/services/scanner-loop.ts` | IBKR market-scanner access with per-code 5-min cache |
| Signal scorer | `src/tools/ibkr/signal-scorer.ts` | 4-factor score (momentum / mean-reversion / volume / trend), calibratable weights |
| TA indicators | `src/tools/ibkr/ta-indicators.ts` | Pure-TS RSI, MACD, VWAP, Bollinger, ATR, EMAs, RVOL, volume Z-score |
| Realtime stream | `src/services/ibkr-stream.ts` | 5-second bars for the top-N, ring buffer + SQLite, reconnect-safe |
| Market hours | `src/utils/market-hours.ts` | Sessions, holidays and half-days (through 2027), ET-anchored |

Engine phases (ET): pre-open 08:00–09:30 @5 min, open-drive 09:30–10:30
@2 min, midday 10:30–15:00 @10 min, pre-close 15:00–16:00 @5 min, idle
otherwise. Composite rank = `signalScore + min(10, 2×RVOL) + 3×(extra
scanners surfacing the symbol)`.

### Judgment layer (LLM)

| Component | File | Role |
|---|---|---|
| Trading cron jobs | `src/cron/trading-schedules.ts` | Seeds the 4 daily briefs; prompt changes re-sync to seeded jobs |
| Trigger alerts | `src/gateway/trigger-alerts.ts` | On engine trigger: isolated agent run (catalyst + risk) → proposal → WhatsApp |
| Skills | `src/skills/day-trade`, `pre-market`, `overnight` | Workflow definitions the agent follows |
| Advisory risk tool | `src/tools/ibkr/risk-manager.ts` | PASS/FAIL breakdown the LLM is instructed to consult (sizing suggestions; per-position overnight). Sector and total-overnight caps are enforced by the deterministic gate, not here |

### Execution layer (deterministic, human-gated)

| Component | File | Role |
|---|---|---|
| Proposal store | `src/services/trade-proposals.ts` | SQLite store, lifecycle, performance aggregation |
| Risk gate | `src/services/proposal-risk-gate.ts` | Mandatory rule enforcement at creation and acceptance |
| Proposal executor | `src/services/proposal-executor.ts` | The ONLY path to orders; runs all gates; optional paper-only auto-exec |
| Bracket placement | `src/tools/ibkr/bracket.ts` | Entry + take-profit + stop, OCA-linked, atomic transmit |
| Safety lock | `src/tools/ibkr/connection.ts` | Paper/live port + account-prefix lock |
| Daily-loss guard | `src/services/daily-loss-guard.ts` | Latching, fail-safe kill-switch |
| Command router | `src/gateway/proposal-commands.ts` | Deterministic WhatsApp commands (accept/reject/proposals/halt/performance) |

### Feedback layer (deterministic)

| Component | File | Role |
|---|---|---|
| Outcome tracker | `src/services/outcome-tracker.ts` | Fills → exit reason → realized P&L → `closed`; restart/reconnect-safe |
| Outcome alerts | `src/gateway/outcome-alerts.ts` | WhatsApp notification on every close |
| Archive scheduler | `src/services/archive-scheduler.ts` | Daily 16:20 ET bar archival of the day's watched universe |
| Data archive | `src/services/data-archive.ts` | IBKR historical bars → `market-archive.db` |
| Backtest engine | `src/backtest/` | Bar replay, slippage/commissions, walk-forward folds, GDELT sentiment loader |
| Calibration | `scripts/calibrate-scorer.ts` | Grid search of scorer weights by out-of-sample Sharpe |

## 4. The proposal lifecycle

```
                     create (LLM tool / cron / trigger)
                        │  ⛔ risk gate: min R/R, min price, coherent
                        │     stop/target, integer qty, entry required
                        ▼
                      ┌──────┐   expiry (default 2 h; 90 min intraday,
        ┌─────────────│ open │   45 min overnight briefs)
        │             └──┬───┘──────────────────────────────► expired
        │ human          │ human "reject"                      (terminal)
        │ "accept"       ▼
        │             rejected (terminal)
        ▼
   ┌───────────┐  atomic claim — exactly ONE concurrent accept wins;
   │ executing │  gate refusal releases back to open (retryable);
   └────┬──────┘  stuck >10 min (crash mid-placement) → failed
        ▼
   gates pass? ──no──► back to open (transient) — placement error → failed
        │yes
        ▼
   ┌──────────┐  bracket placed; orderIds + executedAt recorded
   │ executed │  outcome tracker watches entry / take-profit / stop
   └────┬─────┘
        │ entry fills → entryFillPrice, entryFilledAt
        │
        ├─ take-profit fills ────────► closed (exitReason 'target', P&L)
        ├─ stop fills ───────────────► closed (exitReason 'stop', P&L)
        ├─ entry cancelled unfilled ─► closed (exitReason 'cancelled', P&L 0)
        ├─ both exits die, entry filled ► closed ('manual', P&L unknown/null)
        └─ unrecoverable (tracker down >5 days) ► closed ('unknown')
```

Status vocabulary: `open → executing → executed → closed`, with `rejected`,
`expired`, `failed` as side exits (`executing` is the short-lived atomic
execution claim that makes double-accepts impossible). `closed` rows carry the labeled outcome:
`entryFillPrice`, `exitFillPrice`, `exitReason`, `realizedPnl` (gross),
`commissions`, `closedAt`.

**Why proposals, not direct orders?** They decouple *judgment* from
*execution* with an auditable, expiring artifact in between. The LLM's
output is a record a human can inspect; the executor's input is a record
whose numbers were already validated when it was written.

## 5. The safety model

Five independent gates, each of which alone prevents unwanted live trading.
"Independent" means: any single gate failing open still leaves the others
standing.

| # | Gate | Where | What it blocks |
|---|---|---|---|
| 1 | **Approval gating** | `src/agent/tool-executor.ts` | The LLM calling `ibkr_orders`/`accept_proposal`: interactive confirmation required, headless runs auto-denied. The LLM can never execute. Session approvals are **per-tool** — approving a file edit never pre-approves an order tool. |
| 2 | **Paper/live lock** | `connection.ts: assertOrderingAllowed` + `assertAccountsVerified` | Any order on live ports (4001/7496) or non-`D` accounts unless `IBKR_ALLOW_LIVE=true`. Risk-increasing placements refuse while the connection's account codes are still unknown (fail closed). |
| 3 | **Daily-loss kill-switch** | `daily-loss-guard.ts` | New orders once daily P&L ≤ −`max_daily_loss_pct` × NetLiquidation — on every risk-increasing path incl. direct `ibkr_orders place`. **Latching** (rest of the ET day, survives restarts via `trading-halt.json`; an unreadable halt file counts as halted) and **fail-safe** (P&L unverifiable → refuse). |
| 4 | **Risk gate** | `proposal-risk-gate.ts` | Rule-violating proposals at creation (never persisted) and at acceptance (position size vs live NetLiquidation, `max_open_positions`, `max_daily_trades`) |
| 5 | **Paper-only auto-exec** | `proposal-executor.ts: assertPaperOnly` | Auto-execution on live ports/accounts **regardless of `IBKR_ALLOW_LIVE`**. Going live always requires a human accept per trade. |

Structural guarantees on top of the gates:

- **No naked entries.** The bracket API requires stop and target; the stop
  order carries `transmit=true`, so the bracket transmits atomically —
  there is no window where the entry exists without its exits.
- **Single execution path.** Every order-creating flow (WhatsApp accept,
  TUI approval, auto-exec) funnels through `acceptProposal`. There is no
  second code path to `placeBracketOrder` outside the executor — and since
  2026-08-07 `ibkr_orders place` is **reduce-only** (it can close or trim
  an existing position, never open or increase one), so the proposal path
  is the only way to add exposure.
- **Exactly-once execution.** Accepting takes an atomic claim
  (`open → executing`, conditional UPDATE + claim token) — concurrent
  accepts cannot double-place; interrupted claims are swept to `failed`
  for manual verification, never silently retried.
- **Serialized placement.** All order placement runs under a global lock
  (`order-lock.ts`): IBKR's `nextValidId` sequence is not
  concurrency-safe and brackets assume contiguous ids. An id IBKR did
  not grant is never guessed.
- **Cancels are always allowed.** The kill-switch and gates block only
  risk-*increasing* actions.

## 6. The feedback loop

The part that makes the system *learn-capable* rather than fire-and-forget.

**Outcome tracking.** When the executor places a bracket it registers the
three order ids with the tracker. The tracker listens to three IBKR event
streams:

- `orderStatus` — primary fill signal (`Filled`, remaining 0 → record the
  average fill price; terminal statuses → cancellation logic);
- `execDetails` — collects execution ids (for commission attribution) and
  doubles as the fill source when `orderStatus` was missed (e.g. gateway
  restart: `reqExecutions` replays today's executions through this handler);
- `commissionReport` — accumulates commissions per execution id (IBKR's
  unset-sentinel values are filtered).

Finalization is debounced (2.5 s) so trailing commission reports land
before the proposal is closed. Gross P&L = (exit − entry) × qty,
sign-adjusted; net = gross − commissions. When the outcome is not
measurable (manual close outside the bracket), P&L is recorded as *null* —
principle 3: never guessed.

**What consumes the labels:**

- `performance` WhatsApp command and the `trade_proposals(action
  performance)` tool — win rate, gross/net P&L, best/worst, exit-reason
  breakdown;
- the 08:00 Pre-Market Brief opens with yesterday's recap (the prompt
  instructs the agent to call the performance action first);
- scorer calibration (today: FirstRate backtests; with enough closed
  trades: real-fill calibration);
- the ML roadmap (PLAN.md phases 6–7) — the trade-quality classifier
  requires ≥500 labeled outcomes, which only this tracker produces.

**Data archival.** Labels without features are useless: the archive
scheduler persists 1-min/5-min bars every trading day for exactly the
symbols the system was watching (snapshot symbols ∪ proposal symbols ∪
watchlist). Feature reconstruction for any historical signal is then a
local SQLite query, not an IBKR pacing battle.

## 7. Scheduling

Two mechanisms, chosen by whether the work needs an LLM:

| Mechanism | Used by | Why |
|---|---|---|
| **Cron store + runner** (`src/cron/`) | The 4 daily briefs | They are agent runs; jobs are user-tunable (schedule, active hours) and persisted in the cron store |
| **In-process croner / setTimeout loops** | Engine loop, archive scheduler (16:20 ET), tracker retries | Deterministic services; no reason to route through the agent |

Daily rhythm (ET, trading days):

```
08:00  Pre-Market Brief      performance recap + overnight + calendar + gaps
08:00  engine pre-open       gap/volume scanners every 5 min
09:30  engine open-drive     momentum scanners every 2 min
09:35  Market Open Scan      top-5 verified → ≤3 proposals (90 min expiry)
10:30  engine midday         every 10 min
12:00  Midday Check          positions + mean-reversion scan
15:00  engine pre-close      every 5 min
15:30  Pre-Close Review      hold/trim/close + ≤2 overnight proposals (45 min)
16:00  market close
16:20  archive scheduler     1-min & 5-min bars for the day's universe
all day event triggers       top-3 & rank ≥ 75 → evaluation → proposal
```

## 8. Storage layout

Everything lives under `DEXTER_DATA_DIR` (default `.dexter/data/`), all
SQLite (dual-driver: `bun:sqlite` with `better-sqlite3` fallback under
Node):

| File | Writer | Contents |
|---|---|---|
| `opportunities.db` | engine | Ranked snapshots (JSON per cycle, 7-day retention) |
| `proposals.db` | proposal store | Full proposal lifecycle incl. outcome columns |
| `market-archive.db` | archive scheduler | OHLCV bars keyed (symbol, bar_size, time) |
| `stream-bars.db` | ibkr-stream | Realtime 5-s bars for the top-N |
| `trading-halt.json` | daily-loss guard | The latched halt record (survives restarts) |
| `scorer-weights.json` | calibration `--apply` | Calibrated factor weights |

Logs: daily JSONL under `DEXTER_LOG_DIR` (default `.dexter/logs/`),
rotated, `DEXTER_LOG_KEEP` days retained. Every service logs under a
bracketed prefix (`[opportunity-engine]`, `[outcome-tracker]`, …).

## 9. Resilience

| Failure | Handling |
|---|---|
| IB Gateway disconnect | `connection.ts` reconnects with exponential backoff (1 s → 60 s, jitter, indefinitely); services re-establish per-connection state via `onReconnect` callbacks (stream re-subscribes, tracker re-attaches + replays executions) |
| Gateway daily auto-restart / weekly token invalidation (Sun 01:00 ET) | daily restart is absorbed like any disconnect; the weekly one requires a manual 2FA login — until then the kill-switch fails closed (no P&L → no orders). Operating procedure: [USER-MANUAL §3.1](USER-MANUAL.md#31-gateway-session-lifetime--auto-restart-and-the-weekly-re-login) |
| Gateway process restart | Kill-switch halt persists on disk; tracker rebuilds from `proposals.db` and replays today's executions via `reqExecutions`; cron jobs and engine restart with the gateway |
| Tracker down for days | IBKR only replays current-day executions → affected trades are swept `closed/unknown` (honest label), never guessed |
| P&L unverifiable | Kill-switch fails safe: orders refused |
| IBKR pacing | Scanner results cached 5 min per code; scoring paced at 300 ms; candidates capped (`OPP_MAX_CANDIDATES`); archive paced at 500 ms/symbol and capped |
| Informational IBKR "errors" | `isNonFatalIbkrError` filters status-channel noise (codes 2103–2169, 10090/10091/10167) |

## 10. Model routing

Providers are prefix-routed (`src/providers.ts`, `src/model/llm.ts`).
A local vLLM endpoint (`VLLM_BASE_URL`, OpenAI-compatible) serves
latency-sensitive/cheap tasks; the Anthropic/OpenAI APIs serve the briefs
where synthesis quality matters. Trigger evaluations use the session's
configured default model — point it at vLLM for cheap triage. Nothing in
the execution path depends on any model: routing choices affect cost and
quality of *judgment*, never *safety*.

## 11. Testing strategy

- **Primary runner:** `bun test`. **Secondary:** `npm run test:jest` —
  same colocated `src/**/*.test.ts` files; `bun:test` imports are bridged
  to `@jest/globals` by `test/bun-test-shim.ts` (one bun-mock-dependent
  suite is jest-excluded).
- Trading-critical modules are covered by unit tests that need no IBKR
  connection: the risk gate (pure), bracket validation (pure), the
  kill-switch's latching/fail-safe file logic (temp-dir), the proposal
  store lifecycle + performance aggregation (temp SQLite), the executor's
  refusal gates including the paper-only auto-exec lock (env-driven), the
  outcome P&L math (pure), and market-hours (fixed dates).
- The deliberate seam: anything touching a live IBKR socket is exercised
  by `scripts/smoke-ibkr.ts` against a paper Gateway, not by unit tests.

## 12. Known limits

Honest edges of the current design (refreshed 2026-08-21 — stale entries
here are a safety issue; see REMEDIATION-2026-08-20.md for what changed):

- **Kill-switch checks at order time**, not continuously — between orders a
  breach goes unnoticed (open positions still have bracket stops). A
  periodic check in the engine loop is a planned hardening.
- **The kill-switch trusts IBKR's `reqPnL` daily figure** — resets on
  IBKR's schedule, includes unrealized P&L of held positions.
- **DAY-tif brackets expiring at the close now CONVERT**: the EOD triage
  (15:52 / 12:52 half-days, with a 15:40 preview and `keep SYMBOL`
  overrides) vets keeps against the overnight caps at market value, and
  the tracker's 🌙 conversion re-protects survivors under a GTC pair. The
  conversion for a position triage MISSED still happens un-vetted with a
  warning — that residual is deliberate (the alternative was the
  orphaned-keep hole).
- **Sector and overnight exposure are hard-enforced** at acceptance (the
  UNKNOWN-sector bucket included) and at the pre-bell vet — no longer
  advisory. `min_avg_volume`, spread and ADV caps are deterministic too.
- **Auto-exec daily cap is in-memory** — a restart resets the counter
  (paper-mode courtesy, not a safety gate).
- **Trigger alerts need one prior WhatsApp session for DELIVERY** — the
  evaluation and decline ledger run regardless; only the outbound message
  is skipped until the user messages the bot once.
- **Overnight gap risk is modeled only for earnings bets** — intraday and
  swing positions held overnight are stop-distance sized, and a stop does
  not bound gap loss. A general overnight gap-risk model is open backlog.
- **Reduce-only is a point-in-time check** — a resting reduce order can
  outlive the position it reduced and open a reverse position; it is not
  broker-native reduce-only. Open backlog.
- **Broker-union exposure values positions at avgCost**, not marked value
  (appreciated positions understate); planned-risk headroom and sector
  sums are DB-side. The WP3 adoption sweep narrows, not closes, this.
- **Scanner depth** — IBKR returns ~25 rows/scan; the engine sees the
  scanners' view of the market, not the whole tape.
