# User Manual

Operating the day2day trading system: setup, daily use, commands,
maintenance, troubleshooting, and the road to live trading.

- [1. Prerequisites](#1-prerequisites)
- [2. Installation](#2-installation)
- [3. IB Gateway setup](#3-ib-gateway-setup)
- [4. WhatsApp pairing](#4-whatsapp-pairing)
- [5. Configuration reference](#5-configuration-reference)
- [6. Running the system](#6-running-the-system)
- [7. A trading day, hour by hour](#7-a-trading-day-hour-by-hour)
- [8. WhatsApp command reference](#8-whatsapp-command-reference)
- [9. Working with proposals](#9-working-with-proposals)
- [10. The kill-switch](#10-the-kill-switch)
- [11. Paper-only auto-execution](#11-paper-only-auto-execution)
- [12. Performance tracking](#12-performance-tracking)
- [13. Scorer calibration](#13-scorer-calibration)
- [14. Backtesting](#14-backtesting)
- [15. Data archival](#15-data-archival)
- [16. Monitoring and logs](#16-monitoring-and-logs)
- [17. Running the tests](#17-running-the-tests)
- [18. Troubleshooting](#18-troubleshooting)
- [19. Going live — checklist](#19-going-live--checklist)

---

## 1. Prerequisites

- **bun** (primary runtime; Node ≥ 20 works for the gateway via `tsx` and
  for the jest test runner)
- **IB Gateway** (or TWS) with a paper account — paper accounts start
  with `D` (e.g. `DU1234567`)
- **One LLM API key** (Anthropic recommended for briefs) and/or a local
  vLLM endpoint
- **One web-search key** (Exa / Perplexity / Tavily / LangSearch) —
  catalyst verification depends on it
- **A WhatsApp account** on your phone for pairing

## 2. Installation

```bash
git clone <your-fork> dexter && cd dexter
git checkout day2day
bun install
cp env.example .env     # then edit — see §5
```

## 3. IB Gateway setup

1. Install IB Gateway, log in with the **paper** account.
2. Configure → API → Settings:
   - Enable *ActiveX and Socket Clients*
   - Socket port **4002** (paper convention; the safety lock treats
     4001/7496 as live)
   - Trusted IP `127.0.0.1`; *Read-Only API* **off** (orders must pass)
3. No real-time market-data subscription? Set
   `IBKR_MARKET_DATA_TYPE=3` (delayed ~15 min) — fine for paper.
4. Verify the wiring end-to-end (read-only, no LLM):

```bash
bun run scripts/smoke-ibkr.ts AAPL
```

### 3.1 Gateway session lifetime — auto-restart and the weekly re-login

IB Gateway sessions do not live forever
([IBKR auto-restart considerations](https://www.ibkrguides.com/traderworkstation/auto-restart-considerations.htm)):

- **Daily**: with *Auto restart* enabled (Configure → Lock and Exit —
  choose Auto restart, NOT Auto logoff), the Gateway restarts itself once
  a day at the configured time without needing a login.
- **Weekly**: security tokens are invalidated every **Sunday 01:00 ET**.
  The first restart after that CANNOT re-authenticate itself — a **manual
  login with 2FA (IB Key)** is required, or the Gateway stays down.
- **Silent killers**: the nightly restart also fails if the machine is
  asleep/hibernating, or if a Windows Update reboots the box.

How to run dexter around this:

1. **Pick a quiet restart time** — recommended ~**03:00 ET** (09:00
   Paris): after the 16:20 ET archive job and the 18:00 ET universe
   sweep, before the 08:00 ET Pre-Market Brief, and at an hour when
   you're awake to notice a failure.
2. **Dexter absorbs the daily restart automatically**: the connection
   manager reconnects with backoff indefinitely, the realtime stream
   re-subscribes, and the outcome tracker re-attaches and replays the
   day's executions. A job interrupted mid-restart (archival chunk)
   fails that attempt and is retried/resumed on the next run — all
   archival writes are idempotent.
3. **Make the Sunday login a ritual**: log into the Gateway manually on
   **Sunday evening (Paris time)**, before Monday's pre-market. Miss it
   and Monday runs blind — no scans, no briefs with data, and the
   kill-switch fail-safe refusing orders (see below).
4. **Failure is safe but silent-ish**: a dead Gateway cannot cause harm —
   the daily-loss guard fails closed ("P&L could not be verified"), so
   nothing trades. Detection: send `halt status` on WhatsApp in the
   morning — a connection problem shows up in the reply; the JSONL log
   shows `[IBKR] Scheduling reconnect attempt N` climbing.
5. **Machine hygiene**: disable sleep/hibernation on this box and set
   Windows Update active hours so forced reboots don't land in the
   trading day or the restart window.
6. **Full automation (advanced, optional)**: [IBC](https://github.com/IbcAlpha/IBC)
   (or the ib-gateway Docker images built on it) automates the login and
   restart dialogs. Trade-offs: credentials stored on disk, and the
   weekly 2FA still needs an IB Key approval on your phone — it reduces
   clicks, it does not remove the Sunday ritual. Revisit when the system
   earns unattended live operation; for the paper phase, the manual
   Sunday login is simpler and safer.

## 4. WhatsApp pairing

```bash
bun run gateway:login    # scan the QR code with WhatsApp → Linked devices
```

Access control (who may talk to the bot, DM policy, group policy) lives in
the gateway config; unknown senders get a pairing-code flow. **Message the
bot once after pairing** — trigger and outcome alerts are delivered to the
most recent session, which exists only after a first message.

## 5. Configuration reference

Minimal `.env` for paper trading:

```bash
# IBKR
IBKR_HOST=127.0.0.1
IBKR_PORT=4002
IBKR_CLIENT_ID=0
IBKR_MARKET_DATA_TYPE=3        # if no real-time subscription
IBKR_ALLOW_LIVE=false          # leave false

# Judgment
ANTHROPIC_API_KEY=...          # or another provider / VLLM_BASE_URL
EXASEARCH_API_KEY=...          # or another search provider
```

Everything else has sensible defaults:

| Variable | Default | Meaning |
|---|---|---|
| `OPPORTUNITY_ENGINE` | true | engine auto-start with the gateway |
| `OPP_TOP_N` | 8 | candidates kept in the snapshot & streamed |
| `OPP_MAX_CANDIDATES` | 20 | symbols scored per cycle (pacing) |
| `OPP_TRIGGER_SCORE` | 75 | composite rank for event triggers |
| `OPP_TRIGGER_COOLDOWN_MIN` | 30 | per-symbol trigger debounce |
| `OPP_TRIGGER_MAX_PER_DAY` | 10 | trigger cap per ET day |
| `OPP_MARKET_CAP_MIN` / `_MAX` | unset | restrict engine scans to a cap band (USD), e.g. 1e9–5e9 for midcaps; unset = unchanged behavior |
| `UNIVERSE_SWEEP` | false | **opt-in** nightly (18:00 ET) midcap universe build + daily-bar archival — see §15.4 |
| `UNIVERSE_CAP_MIN` / `_MAX` | 1e9 / 5e9 | universe cap band (USD) |
| `UNIVERSE_MAX_REQUESTS` / `UNIVERSE_PACE_MS` | 1200 / 3000 | nightly IBKR request budget and pacing |
| `AUTO_EXECUTE_PAPER` | false | paper-only auto-exec of trigger proposals (§11) |
| `AUTO_EXECUTE_MAX_PER_DAY` | 5 | auto-exec daily cap |
| `DATA_ARCHIVE` | true | daily 16:20 ET bar archival (§15) |
| `DATA_ARCHIVE_SYMBOLS` | — | always-archived watchlist, e.g. `SPY,QQQ` |
| `DATA_ARCHIVE_MAX_SYMBOLS` | 30 | archival cap per day |
| `DEXTER_DATA_DIR` | `.dexter/data` | SQLite stores |
| `DATA_ARCHIVE_PATH` | `.dexter/data/market-archive.db` | bar archive |
| `DEXTER_LOG_DIR` / `_LEVEL` / `_KEEP` | `.dexter/logs` / info / 14 | logging |
| `FIRSTRATE_DATA_DIR` | `e:/Data/FirstRate/stock` (this machine) | FirstRate 1-min ZIPs for backtests |
| `GDELT_DATA_DIR` | `d:/Work/Trading/GDELT/gdelt_cleaned/parts_monthly` (this machine) | GDELT monthly parquet for sentiment backtests |

Risk rules are **not** env vars — edit `src/config/risk-rules.yaml`:

```yaml
max_position_pct: 5          # hard-enforced at acceptance
max_daily_loss_pct: 2        # kill-switch threshold
max_daily_trades: 20         # hard-enforced at acceptance
max_open_positions: 10       # hard-enforced at acceptance
min_risk_reward: 2.0         # hard-enforced at creation
min_price: 5.0               # hard-enforced at creation
# sector/overnight limits: advisory (risk_manager tool in prompts)
```

Restart the gateway after changing rules (they are cached).

## 6. Running the system

```bash
bun run gateway
```

One process starts: WhatsApp channel, cron runner (4 trading briefs are
seeded on first run and re-synced when prompts change in code), the
Opportunity Engine, event triggers, the outcome tracker (resuming any
executed proposals), outcome alerts, and the archive scheduler.

Useful alternatives:

```bash
bun run start                            # interactive TUI (research + tools)
bun run scripts/demo-opportunities.ts    # one engine cycle, printed, no LLM
bun run scripts/smoke-ibkr.ts NVDA       # IBKR wiring check
```

Run ad-hoc scripts with their own IBKR client ID while the gateway is up
(`IBKR_CLIENT_ID=2 bun run scripts/…`) — IBKR allows one connection per ID.

**Model selection** (`/model` in the TUI; the gateway reads the same
setting from `.dexter/settings.json`):
- **Anthropic** (API key) — recommended for briefs and trigger evaluations;
  tool-use reliability is what keeps multi-step workflows from stalling.
- **vLLM (local)** — served models are auto-discovered from
  `VLLM_BASE_URL`. Launch vLLM with tool parsing or every agent request
  fails: `--enable-auto-tool-choice --tool-call-parser <hermes|qwen3_xml>`
  (plus `--reasoning-parser qwen3` for Qwen3-family thinking models).
  Keep only ONE local serving stack resident — a loaded Ollama model plus
  vLLM overcommits the GPU and decode slows to a crawl via driver memory
  spillover. The model id in settings must match the served name exactly
  (suffix included) — re-run `/model` after changing the served model.

  Reference launch command (validated 2026-07, Qwen3.6-27B-FP8 on the
  RTX 6000 Pro, run from WSL2):
  ```bash
  python -m vllm.entrypoints.openai.api_server \
    --model Qwen/Qwen3.6-27B-FP8 --port 8000 --dtype auto \
    --trust-remote-code --attention-backend flashinfer \
    --kv-cache-dtype fp8 --mamba-ssm-cache-dtype float16 \
    --max-model-len 131072 --gpu-memory-utilization 0.92 \
    --enable-chunked-prefill --enable-prefix-caching \
    --enable-auto-tool-choice --tool-call-parser qwen3_xml \
    --reasoning-parser qwen3 --language-model-only \
    --speculative-config '{"method": "mtp", "num_speculative_tokens": 3}'
  ```
  At 0.92 GPU utilization the card must be exclusive: unload Ollama
  (`ollama stop <model>`) and quit LM Studio before launch, or decode
  silently degrades via sysmem spillover.
- **Ollama** — usable fallback; prefer tool-trained models (qwen3 family);
  older models (llama3, qwen2.5) mishandle tool results.

Stop with Ctrl-C. Safe at any time: the kill-switch state and all proposals
are on disk; the tracker replays today's fills on the next start.

## 7. A trading day, hour by hour

All times ET; weekends and NYSE holidays are skipped automatically.

| Time | What happens | What you see |
|---|---|---|
| 08:00 | **Pre-Market Brief** | WhatsApp: yesterday's performance recap, overnight moves, calendar, gaps |
| 08:00–09:30 | engine pre-open scans (5 min) | (logs only) |
| 09:30–10:30 | engine open-drive scans (2 min) | possible trigger alerts |
| 09:35 | **Market Open Scan** | ranked brief, ≤3 proposals (90 min expiry) — reply `accept P-XXXX` to act |
| 10:30–15:00 | engine midday scans (10 min) | occasional triggers |
| 12:00 | **Midday Check** | positions + mean-reversion look |
| 15:00–16:00 | engine pre-close scans (5 min) | |
| 15:30 | **Pre-Close Review** | hold/trim/close advice, ≤2 overnight proposals (45 min expiry) |
| any time | a candidate enters top-3 with rank ≥ 75 | trigger alert with a proposal, if the evaluation finds a catalyst |
| on fills | outcome tracker | 🎯/🛑 close alerts with realized P&L |
| 16:20 | archive scheduler | (logs only) day's bars archived |

Schedules are editable: the jobs live in the cron store and can be tuned
(time, active hours) without code changes; prompts are re-synced from code.

## 8. WhatsApp command reference

Deterministic commands, DMs only, handled **before** the agent (no LLM, no
tokens). Anything else goes to the agent as a normal question.

| Command | Aliases | Effect |
|---|---|---|
| `accept P-1A2B` | `ok P-1A2B`, `go P-1A2B` | Execute the proposal (all gates re-checked) |
| `reject P-1A2B` | `no P-1A2B` | Reject it |
| `proposals` | `proposal` | List open proposals |
| `positions` | `position` | Current holdings + daily P&L straight from IBKR |
| `performance` | `perf`, `performance 30` | Closed-trade summary (default 7 days) |
| `halt status` | | Kill-switch state + daily P&L headroom |

Examples of agent (non-command) usage: "what's in the latest scan?",
"why did you propose SOUN?", "show my positions".

## 9. Working with proposals

A proposal is a persisted, expiring trade recommendation:

```
P-3F2A LONG 50 NVDA @182.5 stop 178.2 target 191.0 (score 82) [open]
```

**Who creates them:** the 09:35 and 15:30 briefs, event triggers, or the
agent when you ask it to. Creation never trades.

**The risk gate at creation** silently protects you: any proposal with
R/R < `min_risk_reward`, entry < `min_price`, an incoherent stop/target, or
a fractional quantity is refused before it is stored. The agent sees the
violation list and must fix the numbers.

**Accepting:** reply `accept P-3F2A` (or approve the `accept_proposal`
tool in the TUI). The executor then re-checks everything — expiry, the
paper/live lock, the kill-switch, and the risk gate again with your live
account values (position size vs NetLiquidation, open-position count,
trades-today count). Only then is the bracket placed: entry + take-profit
+ stop, OCA-linked, transmitted atomically.

**After execution** the outcome tracker takes over — you will get a close
alert when the trade resolves:

```
🎯 Trade closed — target
P-3F2A LONG 50 NVDA @182.5 stop 178.2 target 191.0 [closed target +$412.37]
P&L +$412.37 gross, +$410.27 net of $2.10 commissions
```

Exit reasons: `target`, `stop`, `cancelled` (entry never filled),
`manual` (position closed outside the bracket — P&L unknown, check
`ibkr_account`), `unknown` (outcome unrecoverable).

**Expiry:** default 120 min (90 for intraday brief proposals, 45 for
overnight ones). Expired proposals cannot be accepted — ask for a fresh
evaluation instead of chasing a stale price.

## 10. The kill-switch

Once the account's daily P&L breaches −`max_daily_loss_pct` ×
NetLiquidation (default −2%), all new orders are refused for the rest of
the ET day. It **latches** (P&L recovering does not un-halt; restarts do
not clear it) and **fails safe** (if nothing can be verified, orders are
refused).

P&L verification has two sources: IBKR's `reqPnL` (preferred), falling
back to a **NetLiq proxy** — current NetLiquidation minus the session
baseline captured at gateway startup — because `reqPnL` is notoriously
flaky on paper accounts. A fail-safe refusal (both sources dead) does
NOT latch: the proposal stays open, and a retry after the Gateway
recovers succeeds.

- Inspect: `halt status` on WhatsApp.
- What still works while halted: rejecting proposals, closing positions
  manually in TWS, all research.
- Deliberate reset (think twice — the halt fired for a reason): from a
  REPL, `clearTradingHalt()` in `src/services/daily-loss-guard.ts`, or
  delete `.dexter/data/trading-halt.json` and restart.

## 11. Paper-only auto-execution

`AUTO_EXECUTE_PAPER=true` lets **trigger-created** proposals execute
without your reply — useful for accumulating labeled outcomes fast during
the paper-validation phase.

Guarantees, in code, not convention:

- refuses live ports/accounts **regardless of `IBKR_ALLOW_LIVE`** — no
  configuration can make auto-execution trade live;
- capped per day (`AUTO_EXECUTE_MAX_PER_DAY`, default 5);
- every standard gate still applies (kill-switch, risk gate, expiry);
- every auto-execution is announced on WhatsApp
  (`🤖 AUTO-EXECUTE (paper, n/cap)`);
- cron-brief proposals are **never** auto-executed — only trigger ones.

## 12. Performance tracking

Every closed trade is a labeled outcome; three ways to read them:

1. **WhatsApp:** `performance` (7 days) or `performance 30`:

   ```
   📊 Performance (last 7d): 12 closed, 7W/5L (58.3% win rate)
   Net P&L +$1,204.50 (gross +$1,230.10, commissions $25.60)
   Best: NVDA +$412.37 (P-3F2A)
   Worst: TSLA -$189.20 (P-9C1D)
   Exits: target 7, stop 5
   Still executing: 1
   ```

2. **Pre-Market Brief** opens with yesterday's recap automatically.
3. **Agent tool:** `trade_proposals` action `performance` (structured
   JSON) — usable in any conversation ("how did last week go?").

Interpreting exits: a high `manual` count means brackets keep expiring at
the close with positions open — revisit proposal expiries or the
Pre-Close Review; `cancelled` means entries don't fill — entry limits are
too far from the market.

## 13. Scorer calibration

The scorer's four factor weights (momentum / mean-reversion / volume /
trend, default 0.25 each) are calibratable by walk-forward grid search
over FirstRate data:

```bash
bun run scripts/calibrate-scorer.ts AAPL NVDA MSFT 2024-01-02 2024-12-30
bun run scripts/calibrate-scorer.ts AAPL --fine     # 0.10-step grid (long)
bun run scripts/calibrate-scorer.ts AAPL --apply    # persist the winner
```

Ranking is by average **out-of-sample** Sharpe (180-day train / 30-day
test folds), with penalties for configurations that barely trade.
`--apply` refuses to overwrite equal weights unless the winner beats them
by > 0.05 Sharpe, then writes `.dexter/data/scorer-weights.json` — picked
up by the live scorer and the engine (restart running processes).

## 14. Backtesting

```bash
bun run scripts/demo-backtest.ts AAPL          # replay with walk-forward folds
```

The engine (`src/backtest/`) replays 1-min FirstRate bars through the same
indicator + scorer pipeline as live, simulates fills with a slippage model
(half-spread + 1 tick for markets; distance-based fill probability for
limits) and IBKR-style commissions, and reports Sharpe, Sortino, max
drawdown, win rate, profit factor, Calmar per fold.

GDELT sentiment features can be joined via
`src/backtest/sentiment-loader.ts` (blocked on the entity→ticker mapper
for full coverage — see [DATA-SOURCES.md §6](DATA-SOURCES.md)).

Reading the metrics:
- **Sharpe/Sortino/CAGR are computed on daily-aggregated equity** (the
  bar-level curve is collapsed to one point per day); **max drawdown stays
  bar-level** (intraday excursions are real risk).
- Walk-forward fold curves are **chained multiplicatively** into the
  aggregate, so headline totals compound across folds.
- A mostly-in-cash strategy that bleeds costs steadily can show a very
  negative Sharpe with a small total loss — read profit factor and
  expectancy alongside it, and judge by the **average out-of-sample
  Sharpe** across folds.
- FirstRate ZIPs are streamed (single entry extracted, both `SYMBOL.txt`
  and `SYMBOL_full_1min_adjsplitdiv.txt` naming supported); walk-forward
  folds reuse a per-ticker extraction cache.

## 15. Data archival and historical data maintenance

### 15.1 Daily archival (automatic)

Every trading day at 16:20 ET the archive scheduler saves 1-min (1 day)
and 5-min (2 days) bars for **today's watched universe** — engine snapshot
symbols ∪ proposal symbols ∪ `DATA_ARCHIVE_SYMBOLS` — into
`market-archive.db`. The watchlist is never dropped by the cap; overflow
beyond `DATA_ARCHIVE_MAX_SYMBOLS` is logged.

Manual run (e.g. after a gateway outage):

```bash
bun -e 'import("./src/services/archive-scheduler.js").then(m => m.runArchiveOnce())'
```

Why it matters: when the ML phase needs "the features at signal time" for
any past trade, they are a local query — not an IBKR history request that
may no longer be available at 1-min granularity.

### 15.2 Backfilling history from IBKR

For historical ranges (e.g. the FirstRate gap, 2025-07-08 → present —
see [DATA-SOURCES.md §6](DATA-SOURCES.md#6-local-archive-audit-and-gap-filling-strategy)),
use the backfill script with IB Gateway running:

```bash
bun run scripts/backfill-bars.ts AAPL NVDA MSFT SPY QQQ --from 2025-07-08
```

- Chunked (7 calendar days/request by default) and **paced at 11 s/request**
  for IBKR's 60-requests-per-10-min limit — a symbol-year of 1-min bars
  takes ~10 minutes; run large universes overnight.
- **Resumable and idempotent**: interrupt any time; re-running continues
  after the last archived day (`--no-resume` to force a full re-fetch).
  Failed chunks are retried once after a 60 s back-off and reported in the
  summary — just re-run the same command to pick them up.
- Defaults match the FirstRate archives: extended hours (`--rth` to
  restrict), 1-min bars (`--bar-size "5 mins"` etc. to change).
- **Adjustment caveat**: ranged requests return as-traded (TRADES) prices —
  IBKR only serves split/dividend-adjusted history (`ADJUSTED_LAST`) for
  requests ending "now". The script therefore also stores a daily
  ADJUSTED_LAST series per symbol (bar_size `'1 day adj'`): the ratio of
  adjusted to as-traded daily closes gives the per-day factor to adjust
  intraday bars whenever a split or dividend falls inside your window.

### 15.3 Updating the GDELT archive

The GDELT pipeline lives in `d:\Work\Trading\GDELT` and needs **no API
key** (plain HTTP from `data.gdeltproject.org`). Run it with the
micromamba `normal` env (`d:/Local/Micromamba/envs/normal/python.exe`) —
it already has pandas, pyarrow, requests, beautifulsoup4 and tqdm.

To extend the cleaned monthly parquet (what dexter's sentiment loader
reads) from its last month to the present:

```bash
cd /d/Work/Trading/GDELT
python download-news.py --start 2025-10-01 --no-finalize
python download-news.py --reprocess          # second pass over failed URLs
```

- `--no-finalize` skips rebuilding the giant all-years parquet — the
  monthly parts under `gdelt_cleaned/parts_monthly` are what
  `GDELT_DATA_DIR` should point at.
- The slow step is headline scraping (top-100 events/day, threaded).
  Old article URLs rot: expect ~80% direct-fetch yield — **run this
  monthly** to keep rot low.
- **Wayback fallback runs only during `--reprocess`**, globally throttled
  (~1 request/1.5 s): archive.org's availability API rate-bans bursty
  clients (hammering it from the main pass's 100 threads gets the IP
  429-blocked for a while — the stats line now reports `rate-limited (429)`
  counts so this is visible). `--wayback` forces it on in the main pass,
  `--no-wayback` disables it entirely. A reprocess over thousands of failed
  URLs takes hours by design — run it overnight.
- The raw v2 mirror in `e:\Data\GDELT_raw` is a separate concern: the
  cleaned pipeline does not need it (it fetches GDELT v1 daily files
  directly). To keep the mirror current anyway: re-download
  `http://data.gdeltproject.org/gdeltv2/masterfilelist.txt`, take entries
  newer than the last local file, and wget them (~7 MB/day export-only,
  ~400 MB/day with mentions+GKG).
- To rebuild from the local mirror instead of the network:
  `python download-news.py --source local --local-dir e:/Data/GDELT_raw --gdelt-version v2 --start … --no-finalize`.

### 15.4 Midcap universe sweep (opt-in)

`UNIVERSE_SWEEP=true` enables a nightly job (18:00 ET, trading days) that
maintains a **US common-stock universe with market caps** — independent of
IBKR entitlements — and archives the daily-bar history that swing and
pattern scanners (cup-and-handle etc.) will consume:

1. listing directory from nasdaqtrader.com (~5,600 common stocks after
   filtering ETFs/warrants/units), refreshed weekly;
2. shares outstanding from SEC EDGAR (free, no key; set `UNIVERSE_SEC_UA`
   to a contact string per SEC fair-use policy);
3. market cap = shares × latest archived daily close; unknown names get a
   short daily-bar probe (budget-limited — the universe converges over a
   few nights);
4. names inside `UNIVERSE_CAP_MIN..MAX` (default $1–5B) get ~400 days of
   daily bars archived into `market-archive.db`, incrementally.

Manual run: `bun -e 'import("./src/services/universe-sweep.js").then(m => m.runUniverseSweepOnce())'`.
The universe lives at `.dexter/data/universe.json`.

Related: the Opportunity Engine can restrict its intraday scans to the same
band via `OPP_MARKET_CAP_MIN/MAX`, and the `ibkr_scanner` tool accepts
`maxMarketCap` — e.g. "scan midcap top gainers" in the TUI.

## 16. Monitoring and logs

Daily JSONL logs in `.dexter/logs/dexter-<date>.jsonl`
(`DEXTER_LOG_LEVEL=debug` for verbose). Grep-friendly service prefixes:

```
[opportunity-engine]  cycle summaries, triggers fired
[trigger-alerts]      evaluations, deliveries, suppressions
[proposal-executor]   accepts, gate refusals, failures
[risk-gate]           creation/acceptance refusals (inside error messages)
[outcome-tracker]     fills, closes, sweeps, re-attachments
[outcome-alerts]      close notifications
[archive-scheduler]   daily archival runs
[daily-loss-guard]    kill-switch trips and fail-safe refusals
[IBKR]                connection, reconnection, safety-lock warnings
```

Quick health checks: `halt status` and `proposals` on WhatsApp; the
`opportunities` tool in the TUI; `demo-opportunities.ts` for a full
engine cycle on demand.

## 17. Running the tests

```bash
bun test              # primary
npm run test:jest     # same files without bun (bun:test is bridged to jest)
npm run typecheck
```

Covered without any IBKR connection: the risk gate, bracket validation,
kill-switch latching/fail-safe, proposal lifecycle + performance math,
executor refusal gates (incl. the paper-only auto-exec lock), outcome
P&L math, market-hours. Live-socket behavior is exercised by
`scripts/smoke-ibkr.ts` against the paper Gateway.

## 18. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `Connection timeout (127.0.0.1:4002)` | IB Gateway not running / API not enabled / wrong port |
| Quotes are ~15 min old, `delayed: true` | expected with `IBKR_MARKET_DATA_TYPE=3` |
| Scanners return 0 rows during market hours | IBKR scanners need a **real-time** US equity subscription (Network A+B+C, ~$4.50/mo non-pro), shared with the paper account, **and a Gateway re-login** to load scanner entitlements |
| `Scanner type with code N is disabled` | was a dexter wire-format bug (string passed where the numeric ScanCode enum was expected) — fixed; if it recurs, check `@stoqey/ib` upgrade notes |
| `client id is already in use` | one client ID per concurrent process: the gateway owns `IBKR_CLIENT_ID=1`; run ad-hoc scripts with `IBKR_CLIENT_ID=2 bun run scripts/…` |
| Gateway alive but API silent / partial | check the Gateway log for `java.lang.OutOfMemoryError` — raise Memory Allocation to 2–4 GB (Configure → Settings, or `-Xmx` in `ibgateway.vmoptions`) and restart |
| Everything dead on a Monday morning; log shows climbing `[IBKR] Scheduling reconnect attempt N` | the weekly token invalidation (Sunday 01:00 ET) — the Gateway needs a manual 2FA login; see §3.1 |
| `SAFETY LOCK: refusing to place orders on live port` | you pointed at 4001/7496 — use the paper port (this is the lock working) |
| `KILL-SWITCH: new orders are blocked` | daily loss breached, or P&L unverifiable (IBKR down). `halt status` for details |
| `[risk-gate] REFUSED …` on create | the proposal's numbers violate risk-rules.yaml — fix R/R / price / quantity, don't loosen rules mid-day |
| `[risk-gate] REFUSED … exceeds N% of net liquidation` on accept | position too big for the account — recreate with fewer shares |
| No trigger or close alerts arriving | no WhatsApp session yet — message the bot once; check `[trigger-alerts]`/`[outcome-alerts]` logs for "no delivery target" |
| Trade closed as `manual`, P&L unknown | position was closed outside the bracket, or the DAY bracket expired at the close — reconcile in TWS/`ibkr_account` |
| Proposal `expired` before you replied | expiry is intentional staleness protection — ask for a fresh evaluation |
| Empty scanner results pre-market | normal before ~08:00 ET or on delayed feeds |
| Engine does nothing | market closed/holiday (engine idles), or `OPPORTUNITY_ENGINE=false` |
| jest: `better_sqlite3.node not found` | `cd node_modules/better-sqlite3 && npx prebuild-install` (bun installs skip node prebuilds) |

## 19. Going live — checklist

Do not rush this. The system is deliberately paper-locked in three
independent places.

1. **Evidence first:** ≥ 2–4 weeks of paper trading with real fills;
   `performance 30` shows a positive net P&L and an exit distribution you
   understand (few `manual`/`unknown`).
2. Review every `[risk-gate]` and `[daily-loss-guard]` refusal in the
   logs — each one is a story about behavior under stress.
3. Calibrate the scorer on recent data; re-run the backtests.
4. Decide sizing for live (`max_position_pct` deliberately small at first).
5. Switch IB Gateway to the live account, port 4001, and set
   `IBKR_PORT=4001`, `IBKR_ALLOW_LIVE=true` — manual acceptance only:
   **auto-execution cannot go live by construction.**
6. First live day: smallest sizes, every accept manual, `halt status`
   checked before each accept.
7. Keep the kill-switch threshold conservative; never clear a halt on the
   same day it fired.
