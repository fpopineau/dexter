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
4. **Failure is safe and now LOUD**: a dead Gateway cannot cause harm —
   the daily-loss guard fails closed ("P&L could not be verified"), so
   nothing trades. Detection is push, not pull: after 3 consecutive
   zero-symbol scan cycles during market hours (`OPP_HEALTH_EMPTY_CYCLES`)
   a ⚠️ scanner-health alert lands on WhatsApp, and a ✅ follows when
   scans recover. `halt status` and the JSONL log
   (`[IBKR] Scheduling reconnect attempt N`) remain for diagnosis.
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

### 3.2 Autostart at logon and the independent watchdog

Everything above assumes the stack was started; `scripts/ops/` makes that
automatic and adds an outside observer. One-time install (idempotent,
re-run after edits; remove with `uninstall-tasks.ps1`):

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/ops/install-tasks.ps1
```

Two scheduled tasks are registered for the interactive user:

- **`\Dexter\Stack`** — at logon (+30 s) runs `start-stack.ps1`: starts
  IB Gateway (newest install under `C:\Local\IBGateway`; its login window
  opens and **waits for password + 2FA** — autostart removes the
  forgot-to-launch failure, not the login) and the dexter gateway in a
  **visible console** (`run-gateway.cmd`, auto-restarts `bun run gateway`
  10 s after a crash; close the window to stop it deliberately). Safe to
  run by hand anytime — it skips whatever is already up.
- **`\Dexter\Watchdog`** — every 5 minutes, hidden, runs
  `scripts/ops/watchdog.ts`: a real API handshake against the Gateway
  (`reqCurrentTime` on its own client id — a listening port with a silent
  API, the post-failed-relogin zombie, counts as DOWN) plus a
  `bun run gateway` process check. Two consecutive failures → 🔴 WhatsApp
  alert; hourly re-alerts while down; 🟢 on recovery. State in
  `.dexter/watchdog/state.json`, log in `.dexter/watchdog/watchdog.log`,
  ad-hoc: `bun run scripts/ops/watchdog.ts --status`.

The watchdog deliberately does **not** deliver through the gateway's own
WhatsApp session — that session dies with the gateway, the exact outage
it must survive. It uses [CallMeBot](https://www.callmebot.com/blog/free-api-whatsapp-messages/)
(free, personal): add **+34 644 66 32 62** to contacts, WhatsApp it
"I allow callmebot to send me messages", put the returned key and your
phone in `.env` (`WATCHDOG_WHATSAPP_PHONE`, `WATCHDOG_CALLMEBOT_APIKEY`),
then verify: `bun run scripts/ops/watchdog.ts --test-alert`.

Known blind spot: tasks run only while logged on, so a box that reboots
to the login screen (Windows Update at 04:00) silences the watchdog
itself. Optional cover: create a [healthchecks.io](https://healthchecks.io)
check (period 10 min), set `WATCHDOG_HEALTHCHECK_URL` — the watchdog
pings it every round, pings stop when the box/watchdog dies, and
healthchecks alerts from outside (its webhook integration can call the
same CallMeBot URL to land that on WhatsApp too).

Expected weekend rhythm: after the Sunday-01:00-ET token invalidation,
the Gateway's next auto-restart leaves the API silent, so the watchdog's
🔴 on Sunday morning **is the reminder** to do the §3.1 login ritual.

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
| `OPP_TRIGGER_SCORE` | 60 | composite rank for event triggers (75 until 2026-09-05; proposals carry `trigger_band` '60-74' / '75+') |
| `OPP_TRIGGER_COOLDOWN_MIN` | 30 | per-symbol trigger debounce |
| `OPP_TRIGGER_MAX_PER_DAY` | 30 | trigger cap per ET day (10 until 2026-09-05) |
| `OPP_LARGECAP_LANE` / `_MIN_USD` / `_RESERVE` | true / 1e10 / 5 | large-cap scan lane + reserved candidate slots |
| `PREMARKET_SPREAD_HARD_MULT` | 3 | pre-open DAY accept spread deferral bound (09:31 ET re-check) |
| `LIVE_VETO_WINDOW_MIN` | 0 | veto window before an announced auto-execution places |
| `LLM_DAILY_SPEND_CAP_USD` | 10 | daily LLM spend cap for evaluation lanes (0 = off; needs `LLM_PRICE_IN_USD_PER_MTOK` + `LLM_PRICE_OUT_USD_PER_MTOK`) |
| `SIMULATOR` | true | nightly shadow-variant settle (17:10 ET) into `simulator.db`; `SIM_COMMISSION_PER_SHARE_USD` / `SIM_COMMISSION_MIN_USD` set the commission assumption |
| `CANDIDATE_ARCHIVE` | true | point-in-time capture of the overnight and cup-and-handle universes on every pre-close snapshot into `candidate-archive.db`; the 🌙 overnight benchmark block after the nightly settle replays yesterday's eligible candidates (mechanical twin: MKT at the next bar, take-x target, stop at the gate's minimum R:R, flat 10:00) and compares the universe, the top-5 by rank and the judgment's picks (gross R = the size-invariant label). Observability only; "eligible" is not "admissible". `bun run scripts/overnight-benchmark.ts --day YYYY-MM-DD` prints the table |
| `OPP_HEALTH_EMPTY_CYCLES` | 3 | zero-scan cycles before the scanner-health WhatsApp alert |
| `UNIVERSE_EXTRA_SYMBOLS` | — | mega-cap watchlist for the nightly archive + swing pattern scan |
| `OPP_MARKET_CAP_MIN` / `_MAX` | unset | restrict engine scans to a cap band (USD), e.g. 1e9–5e9 for midcaps; unset = unchanged behavior |
| `UNIVERSE_SWEEP` | false | **opt-in** nightly (18:00 ET) midcap universe build + daily-bar archival — see §15.4 |
| `UNIVERSE_CAP_MIN` / `_MAX` | 1e9 / 5e9 | universe cap band (USD) |
| `UNIVERSE_MAX_REQUESTS` / `UNIVERSE_PACE_MS` | 1200 / 3000 | nightly IBKR request budget and pacing |
| `AUTO_EXECUTE_PAPER` | false | paper-only auto-exec of proposals, all sources (§11) |
| `AUTO_EXECUTE_MAX_PER_DAY` | 6 | auto-exec daily cap (aligned with `max_daily_trades`) |
| `AUTO_EXECUTE_MIN_SCORE` | 0 | score floor — 0 since D6 (2026-08-21): the burn-in samples every band; raise only with a calibrated scorer |
| `PROFIT_TRAIL` | true | auto-close winners: arm at `profit_trail_arm_atr_mult`×ATR, close on `profit_trail_pullback_atr_mult`×ATR pullback from peak; absolute % fallback when ATR unknown; swing/earnings-bet exempt (§9) |
| `STALE_ENTRY_MAX_DAYS` | 3 | cancel executed-but-unfilled entries after N days (0 = off) |
| `AUTO_PROTECT` | true | re-attach GTC exits when DAY exits die on an open position (§9) |
| `EOD_TRIAGE` | true | 15:52 ET: close losing-and-fading DAY positions; keep the rest overnight |
| `DASHBOARD` / `_PORT` / `_HOST` | true / 8484 / 127.0.0.1 | local dashboard (§15bis) |
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
min_stop_atr_fraction: 0.4   # stop must be ≥ 0.4 × daily ATR from entry (noise filter)
max_extension_atr: 3         # refuse entries > 3 × ATR beyond the 10-day EMA (chasing)
max_target_atr: 1.5          # refuse intraday targets > 1.5 × ATR from entry (reachability cap)
max_risk_per_trade_pct: 0.25 # max loss-if-stopped per trade, % of NetLiq
min_price: 5.0               # hard-enforced at creation
# sector cap: hard-enforced at acceptance (skipped only when the sector
#   cannot be resolved); overnight caps: hard-enforced at acceptance for
#   deliberate GTC proposals AND at the pre-bell triage for DAY keeps
#   (WP5: market-value vetting, worst-first trims; a 15:40 preview lists
#   what will close — reply 'keep SYMBOL' to override anything except the
#   earnings guard)
# min_avg_volume: advisory only (risk_manager tool in prompts)
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
bun run start                            # interactive TUI (trade evaluation + tools)
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
| 08:00 | **Pre-Market Brief** | WhatsApp: performance recap, **today's & tomorrow's earnings reporters vs your book**, overnight moves, gaps, swing-pattern candidates (GTC STP_LMT proposals) |
| 08:00–09:30 | engine pre-open scans (5 min) | (logs only; ⚠️ scanner-health alert if scans return empty) |
| 09:30–10:30 | engine open-drive scans (2 min) | possible trigger alerts |
| 09:35 | **Market Open Scan** | ranked brief, ≤3 proposals (90 min expiry) — reply `accept P-XXXX` to act |
| 10:30–15:00 | engine midday scans (10 min) | occasional triggers |
| 12:00 | **Midday Check** | positions + mean-reversion look |
| 15:00–16:00 | engine pre-close scans (5 min) | |
| 15:30 | **Pre-Close Review** | hold/trim/close advice, **every position checked for earnings ≤2 days**, expiring DAY exits flagged, ≤2 overnight proposals (45 min expiry) |
| any time | a candidate enters top-3 with rank ≥ 75 | trigger alert with a proposal, if the evaluation finds a catalyst |
| RTH, every 60 s | **profit trail** watches each intraday position's peak (swing/earnings-bet exempt) | 📉➡️💰 auto-close alert when a winner ≥2.5×ATR pulls back 0.75×ATR from its peak |
| 15:52 | **EOD triage** of unresolved DAY positions | 🌇 report: losing-and-fading closed before the bell; the rest keep their overnight chance |
| every 10 min | **stale-entry sweeper** | 🚫 close alerts for expired intraday entries (past expiry +30 min grace) and for brackets whose entry never filled in 3 days (slots freed) |
| on fills | outcome tracker | 🎯/🛑 close alerts with realized P&L; 🛡️ auto-protect if DAY exits died on an open position |
| 16:20 | archive scheduler | (logs only) day's bars archived |
| 18:00 | universe sweep + swing-pattern scan | (logs only) watchlist + midcap history refreshed, pattern-scan.json rebuilt |
| all day | **dashboard** at `http://127.0.0.1:8585/` | live book, charts with entry/stop/target/peak lines, accept/reject/cancel/close/protect buttons |

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
| `orders` | `order` | Working (unfilled) orders — the state between an accepted proposal and a position |
| `protect SYM STOP [TGT]` | | Attach GTC protective exits to an open position (refuses if GTC exits already stand) |
| `close SYM [SYM…]` | | Market-close full position(s) and cancel their resting exits — risk-reducing, allowed even under the kill-switch |
| `cancel P-XXXX` or `cancel SYM` | | Cancel an executed-but-unfilled bracket — `orders` shows each bracket's P-id (refused once the entry has filled — use `close`) |
| `performance` | `perf`, `performance 30` | Closed-trade summary (default 7 days) |
| `halt status` | | Kill-switch state + daily P&L headroom |
| `halt clear` | | Operator override for a FALSE halt (deposit/resize read as a loss): clears the latch and re-anchors today's baseline at current equity. Real-loss halts should stand. |
| `veto P-XXXX` | | Live-loop (WP1): stop an announced/working auto-execution — open → rejected, executed-but-unfilled → bracket cancelled; refused once the entry has FILLED (use `kill`) |
| `kill SYM` | | Live-loop: close the position at market through the safe close path (same refusals as `close`) |
| `live status`, `ladder`, `epoch`, `digest` | | Live-loop state: the operator's live switch and the live-verdict conditions, the size-ladder rung (with any queued step-up), the current epoch (looks, ACCEPT, pending promotion), today's four-section digest |
| `live on` → `live on <token>` | | Live-loop (WP4): the first message shows the evidence (epoch, last look, ACCEPT state, rung, account kind, `IBKR_ALLOW_LIVE`, profile, veto window) and a 6-character token; typing it back within 2 minutes turns live auto-execution ON (journaled). Only this command ever writes ON. Then `epoch new` (no carry) opens the live epoch at 0.25 % |
| `live off` | | Immediate OFF (journaled). The system also turns the switch off by itself on any epoch stop (REJECT look, −5 % hard stop, unresolved broker anomaly) |
| `ladder up` → `ladder up confirm` | | Live-loop (WP3): apply a queued step-up (0.25 → 0.5 → 0.75 → 1.0 % at n ≥ 25/50/100 with net R > 0); shows the evidence first, confirm within 10 min. The automatic step-down (−5 % of marked NetLiq from the step-up mark) needs no command |
| `epoch new [carry]` | `epoch new confirm`, `epoch new carry confirm` | Live-loop (WP3): start the next epoch — the performance baseline resets with the USD NetLiq frozen (hard stop at −5 %), the record and journal line are written, the rung resets to 0.25 % unless `carry`. Two-step while an epoch is running; refused when IBKR cannot report NetLiq or the identity is unresolved |
| `promote <variant>` → `promote <variant> confirm` | | Live-loop (WP3): shows the variant's shadow evidence (n, days, ΔR LCB vs the incumbent, candidate flag) and the exact config change; confirm records the ratification (journal + epoch record). Then apply the change, restart, `epoch new` |

Examples of agent (non-command) usage: "what's in the latest scan?",
"why did you propose SOUN?", "show my positions".

## 9. Working with proposals

A proposal is a persisted, expiring trade recommendation:

```
P-3F2A LONG 50 NVDA @182.5 stop 178.2 target 191.0 (score 82) [open]
```

**Who creates them:** the 09:35 and 15:30 briefs, event triggers, or the
agent when you ask it to. Creation never trades.

**Trade classes (2026-08):** every proposal carries a `tradeClass` that
selects its risk budget and caps — shown as `{swing}` / `{earnings-bet}`
in proposal lines, and broken out per class in performance reports:

| Class | Horizon | Budget | Caps | Sizing basis |
|---|---|---|---|---|
| `intraday` (default) | hours–few nights | `max_risk_per_trade_pct` | — | stop distance |
| `swing` | up to ~2 weeks, GTC | `swing_risk_pct` | max `max_swing_positions` (3) | stop distance |
| `earnings-bet` | through one print, GTC | `earnings_bet_risk_pct` | max `max_earnings_bets` (1) | worst-case gap (`worstCaseGapPct`, floored at `earnings_bet_gap_floor_pct`) |

**Lanes (four-lane contract, 2026-09-05):** on top of the risk class, every
proposal names its `strategyId` — the strategy, separate from the risk
horizon. The lane fixes the class, the TIF, the holding horizon, the exit
policy and the exit deadline; a combination that dodges a gate is refused
at creation. Rows created before the contract show `legacy`.

| Lane | Risk class | TIF | Horizon | Exit policy | Deadline | Budget |
|---|---|---|---|---|---|---|
| `intraday` (default) | intraday | DAY | same session | take-at-x% (or ratchet) | none — the 15:52 triage closes it | min(rung, ceiling) |
| `overnight` | swing | GTC | next session | bracket + deadline | 10:00 ET next trading session | `overnight_risk_pct`, gap-stress capped |
| `swing` | swing | GTC | multi-session | structural + deadline | fill + `swing_max_hold_days` (10) at 15:50 ET | `swing_risk_pct`, gap-stress capped |
| `cup-and-handle` | swing | GTC | multi-session | structural + deadline | fill + `cup_max_hold_days` (15) at 15:50 ET | `swing_risk_pct`, gap-stress capped |
| `earnings-bet` | earnings-bet | GTC | through one print | bracket | none | worst-case gap |

Overnight setups are registered from 15:00 ET and their entry expiry is
clamped to the close: an unfilled overnight entry never arms the next
morning. Overnight, swing and cup-and-handle share the swing pool of 3
(overnight at most 2) and are disabled on a live account until each lane's
own record passes. The deadline sweeper closes a still-open position at its
deadline through the safe close path and stamps the row; a close that does
not confirm flat is an incident on WhatsApp. Sizing for these lanes is
composed at creation with the gap-stress budget: at live scale the WHOLE
overnight book is capped near 7.5% of NetLiq (1.5% daily loss / 20% stress),
so expect small sizes — that is the ratified risk, not a bug.

**Sizing composes the whole book (2026-09-05):** when a proposal omits its
quantity, the sizer takes the smallest of the risk budget, the position cap,
the room left on the same symbol, the remaining daily-loss headroom (the
open book's planned stop-outs plus today's realized losses), the overnight
caps and gap-stress room for swing-class lanes, the sector room and 1% of
the 20-day ADV — and names the constraint that bound. It then refuses a
trade whose estimated round-trip costs (two commissions at the IBKR fixed
tier, one spread crossing, slippage) exceed 20% of the gross gain at the
target; the ratio is stamped on the proposal. A sized proposal passes the
creation gate by construction; the acceptance gate re-checks with fresh
broker marks and refuses on drift. Nothing ever resizes a proposal after
acceptance.

**Lane rankings (2026-09-05):** a score compares only inside its lane. The
scanner's composite is the intraday ranking; the pre-close overnight
selection reads the `opportunities` tool with lane "overnight" (EOD
continuation: significance in ATR units, closing strength vs VWAP,
liquidity, RVOL, with exclusion reasons); the cup lane keeps its detector
score. Each proposal records its lane rank and the ranker version that
produced it, stamped by the server. The nightly digest's "Rank→R per lane"
line replaces the old pooled score deciles; `bun run
scripts/validate-lane-ranker.ts` is the chronological check (selection
days vs validation days) that any change to a ranker's weights must pass
first. Sizing confidence stays flat.

Swings and earnings bets require GTC brackets and a `company-snapshot`
card; earnings bets additionally require the `earnings_bet_intel`
evidence bar (≥8 prints, ≥75% consistency, ≥1 external signal) and are
**disabled outright in the live profile** (`earnings_bet_enabled: false`
in risk-rules.live.yaml) until the class earns ~10 proven paper bets —
see the per-class lines in `performance` reports for that ledger.

**The risk gate at creation** silently protects you: any proposal with
R/R < `min_risk_reward`, entry < `min_price`, an incoherent stop/target, a
stop closer than `min_stop_atr_fraction` × the daily ATR (noise-stop filter),
an intraday target further than `max_target_atr` × ATR from entry
(reachability cap — swing/earnings-bet classes and post-print repricing
days exempt), an intraday entry priced AT the market (buy-now filter —
a LMT must rest a pullback at least max(0.1%, 0.25× the stop distance)
away from the live price, a STP_LMT must trigger the same margin beyond
it), an entry more than `max_extension_atr` × ATR beyond the
10-day EMA (extension guard — no chasing), an entry within 2% of an
existing working bracket on the same symbol (duplicate-setup guard — the
daily brief re-proposing yesterday's trigger), or a fractional quantity is
refused before it is stored. The agent sees the violation list and must fix the numbers. The
ATR and EMA references are computed from **completed daily bars only** —
on a gap day the in-progress bar would inflate ATR and let the gap grant
itself permission to be chased.

**Accepting:** reply `accept P-3F2A` (or approve the `accept_proposal`
tool in the TUI). The executor first takes an **atomic claim** on the
proposal (`open → executing`) so two simultaneous accepts — a double-sent
message, or your accept racing auto-execution — can never place two
brackets: one wins, the other is told the proposal is already being
executed. It then re-checks everything — expiry, the paper/live lock
(including that the connection's account codes have actually been
received), the kill-switch, the risk gate again with your live account
values (position size vs NetLiquidation, risk budget, open-position
count, trades-today count), and the chase gate against a live quote.
Only then is the bracket placed: entry + take-profit + stop, OCA-linked,
transmitted atomically. A gate refusal returns the proposal to `open`
(retry allowed until expiry); a crash mid-placement leaves it
`executing` and it is swept to `failed` after 10 minutes with a note to
verify orders at IBKR manually.

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

**Auto-protect and the EOD-keep transition:** when a DAY bracket's exits
expire at the bell with the position still open (an EOD-triage keep, or
nobody acted), the tracker attaches a GTC stop/target OCA pair at the
proposal's levels and — instead of closing the proposal as `manual` —
**keeps the same proposal alive as a kept-overnight hold** (🌙 message):
it stays `executed`, still counts against `max_open_positions` and the
per-symbol caps, the next day's EOD triage re-triages its momentum like
any DAY position, `close SYMBOL` cancels the protect pair with it, and
the eventual GTC exit fill gives it a real labeled P&L. (Before
2026-08-11 the proposal was closed at the bell, which orphaned the hold:
invisible to triage and the caps, P&L forever unlabeled.)
For a `manual` close at any other time of day, plain auto-protect still
applies: the tracker re-attaches the GTC pair and tells you on WhatsApp
(`🛡️ AUTO-PROTECT`). If the position is genuinely flat it does nothing;
if protection cannot be attached you get a ⚠️ with the exact `protect`
command to send. Risk-reducing only; opt out with `AUTO_PROTECT=false`.

**Profit trail:** winners protect themselves. During regular hours every
intraday position (including 🌙 kept-overnight holds) is watched against
its peak price. Thresholds are **ATR-relative** (2026-08-11): the trail
arms once unrealized gain reaches `profit_trail_arm_atr_mult` × daily ATR
(default 2.5× ≈ 1.67R against the standard 1.5×ATR stop), and a pullback
of `profit_trail_pullback_atr_mult` × ATR (default 0.75×, floored at
0.35%) from the peak closes the position at market — cancelling its
bracket exits with it — and reports on WhatsApp (`📉➡️💰 PROFIT TRAIL`).
The geometry is uniform in R-space: worst exit after arming is
(2.5 − 0.75)×ATR ≈ 1.17R at any volatility, where the old absolute
5%/1.5% pair never armed on low-ATR mega-caps and flushed high-ATR
runners at ~0.5–0.8R inside single-bar noise. When ATR is unavailable
the absolute `profit_trail_arm_pct`/`profit_trail_pullback_pct` pair
(5%/1.5%) applies as fallback. **Swing and earnings-bet positions are
never trailed** — a swing lives on daily structure and an earnings bet
holds through the print by design; positions without a tracked proposal
keep the trail as a protective default. Peaks persist across restarts.
Direction-aware (shorts arm on drops, close on bounces). Thresholds live
in `risk-rules.yaml`; disable with `PROFIT_TRAIL=false`.

**Expiry:** default 120 min (90 for intraday brief proposals, 45 for
overnight ones). Expired proposals cannot be accepted — ask for a fresh
evaluation instead of chasing a stale price.

## 10. The kill-switch

Once the account's daily P&L breaches −`max_daily_loss_pct` × the
**session-baseline** equity (pre-trading NetLiq; default −2% paper, −3%
live), all new orders are refused for the rest of the ET day. It
**latches** (P&L recovering does not un-halt; restarts do not clear it)
and **fails safe** (if nothing can be verified, orders are refused).

**The halt is also a budget, not just a tripwire** (2026-08-11): at
acceptance time the risk gate refuses any proposal whose planned worst
case — this trade's stop-out cost (gap cost for earnings bets) plus the
open book's planned stop-outs plus today's realized losses — exceeds
the daily-loss limit. The book can never be built so that its own
intended stops latch the halt. Wins never expand this budget; realized
losses shrink it. When the class caps authorize a worse book than the
halt allows (they do, in both profiles), the gateway logs a
RISK-CONFIG warning at startup and the headroom gate binds before the
position caps.

P&L verification has two sources: IBKR's `reqPnL` (preferred), falling
back to a **NetLiq proxy** — current NetLiquidation minus the session
baseline captured at gateway startup — because `reqPnL` is notoriously
flaky on paper accounts. A fail-safe refusal (both sources dead) does
NOT latch: the proposal stays open, and a retry after the Gateway
recovers succeeds.

The switch covers **every risk-increasing order path**: proposal
acceptance, auto-execution, and direct `ibkr_orders place`. The
risk-reducing phone commands (`protect`, `close`, `cancel`) are
deliberately exempt. A `trading-halt.json` that exists but cannot be
parsed counts as **halted** (fail closed) — a corrupted latch must never
unlock trading on the day it fired.

- Inspect: `halt status` on WhatsApp.
- What still works while halted: rejecting proposals, `protect`/`close`/
  `cancel`, closing positions manually in TWS, all research.
- Deliberate reset (think twice — the halt fired for a reason): from a
  REPL, `clearTradingHalt()` in `src/services/daily-loss-guard.ts`, or
  delete `.dexter/data/trading-halt.json` and restart.

## 11. Paper-only auto-execution

`AUTO_EXECUTE_PAPER=true` lets proposals from **every source** (cron
briefs, scans, triggers) execute without your reply — the way to
accumulate labeled outcomes fast during the paper-validation phase.

Guarantees, in code, not convention:

- refuses live ports/accounts **regardless of `IBKR_ALLOW_LIVE`** — no
  configuration can make auto-execution trade live (live port refused
  statically, account identity fail-closed, non-paper accounts refused);
- **score floor** (`AUTO_EXECUTE_MIN_SCORE`): only proposals scoring
  ≥ the floor execute unattended; lower-scored ones stay open for a
  manual `accept`, and UNSCORED proposals never auto-execute at any
  floor. Default **0** since D6 (2026-08-21): the burn-in is an
  experiment ON the score — a floor conditions the sample on the
  variable under test. NOTE the sample is still shaped upstream
  (trigger rank threshold, skill score floors, the daily cap): floor 0
  removes the last stage of selection, it does not make sampling
  unbiased. Raise the floor only after the scorer passes its
  calibration gate. (Historical postures, no longer defaults: **80**
  selective, **1** early burn-in — both predate D6; the floor is 0
  everywhere now, and FLAT sizing, not the floor, is the risk control
  across bands);
- capped per day (`AUTO_EXECUTE_MAX_PER_DAY`, default 6 — aligned with
  `max_daily_trades` since 2026-09-05): when auto-exec hits its cap,
  manual accepts still work until the risk-rules cap;
- on a LIVE account (live-loop WP1/WP4) additionally gated by
  `IBKR_ALLOW_LIVE`, the operator's live switch (`live on` + token; `live
  off`; the system writes only OFF), verified identity, the live profile,
  a running epoch and no latched halt; swing and earnings-bet rows are
  never auto-executed on live (marked sim-only, settled in the simulator);
  `veto P-XXXX` and `kill SYMBOL` are the per-trade controls (`live
  status`, `ladder`, `epoch`, `digest` show the loop's state; `ladder up`,
  `epoch new`, `promote` are the operator's two-step acts — WP3);
- judged by the pre-registered sequential test (WP3): every evening the
  loop rebuilds the epoch sample, evaluates a look when n first reaches
  25/50/75/100 (ACCEPT = LCB > 0, net R > 0, PF ≥ 1.3; REJECT = UCB95 < 0
  → the epoch STOPS and new entries pause), watches the −5 % marked-NetLiq
  hard stop, and sends the four-section digest (fills, funnel, shadow vs
  incumbent, test status);
- every standard gate still applies (kill-switch, risk gate, chase gate,
  expiry);
- every auto-execution is announced on WhatsApp
  (`🤖 AUTO-EXECUTE (paper, score S, n/cap)`), and the gateway logs the
  effective floor and cap at boot.

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

**Swing pattern scan** (stages 3–5): after each sweep the pattern detectors
(pullback-in-uptrend, flat-base, cup-and-handle) run over every symbol with
enough daily history and persist the top 25 to
`.dexter/data/pattern-scan.json`. The agent exposes them as the
`swing_patterns` tool ("any swing setups?" in the TUI/WhatsApp), and the
08:00 Pre-Market Brief verifies news on the best few and registers GTC
STP_LMT swing proposals through the normal risk gates. Manual run + printed
table: `bun run scripts/pattern-scan.ts` (local archive only, no IBKR).

Related: the Opportunity Engine can restrict its intraday scans to the same
band via `OPP_MARKET_CAP_MIN/MAX`, and the `ibkr_scanner` tool accepts
`maxMarketCap` — e.g. "scan midcap top gainers" in the TUI.

## 15bis. The local dashboard

`http://127.0.0.1:8585/` (with the gateway running) — charts and the live
book, served by dexter itself from its own data. **This is the supported
way to watch the paper account visually**: any external viewer that logs
in with the paper credentials (TradingView's broker integration, a second
Gateway, IBKR Desktop) competes for the username's single brokerage
session and disconnects the Gateway mid-day. Client Portal web is the
only external exception.

What it shows: positions, working orders, open/executed proposals with
scores, profit-trail peaks (armed/watching), halt state and daily P&L,
and the latest swing-scan candidates. Click any symbol for its chart
(1-min live via the existing session, or daily from the archive) with
the entry / stop / target / trail-peak levels drawn on it. Auto-refreshes
every 30 s.

**Actions:** the sidebar carries the same deterministic commands as
WhatsApp — accept/reject open proposals, cancel working brackets,
close/protect positions — each behind a confirmation, each through the
full gate stack (paper lock, kill-switch, risk gates, chase gate).
Mutations are CSRF-protected by a per-startup token baked into the page;
after a gateway restart, reload the page if actions return 403.

Knobs: `DASHBOARD=false` to disable, `DASHBOARD_PORT` (code default
8484; this deployment pins 8585 — Windows' shifting Hyper-V excluded
port ranges swallowed 8484 after a reboot),
`DASHBOARD_HOST` (127.0.0.1 — it has no auth; do not bind it wider on an
untrusted network).

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
| Trade closed as `manual`, P&L unknown | position was closed outside the bracket — reconcile in TWS/`ibkr_account`. (A DAY bracket expiring at the bell no longer closes the proposal: it becomes a 🌙 kept-overnight hold, still tracked) |
| Proposal `expired` before you replied | expiry is intentional staleness protection — ask for a fresh evaluation |
| Empty scanner results pre-market | normal before ~08:00 ET or on delayed feeds |
| Engine does nothing | market closed/holiday (engine idles), or `OPPORTUNITY_ENGINE=false` |
| `is already being executed by another accept` | the double-accept protection: another accept (or auto-exec) claimed the proposal first — check `orders`, do not retry |
| `account codes not received yet — cannot verify` | fail-closed paper check right after a (re)connect — wait a few seconds and retry the accept |
| `nextValidId not received within 5s` | IBKR did not grant an order id — placement refused rather than guessed; retry, and check the Gateway if it persists |
| Proposal `failed` with "execution interrupted (crash/restart mid-placement)" | the process died between claim and confirmation — verify at IBKR (`orders` / TWS) whether the bracket exists before acting |
| URL refused: `only public http(s) destinations are allowed` | SSRF protection on web_fetch/browser — local/private addresses are never fetchable, by design |
| `[risk-gate] REFUSED … duplicate setup — P-XXXX already has a working bracket` | the same symbol already has a bracket within 2% of that entry — cancel it first or let it work |
| `📉➡️💰 PROFIT TRAIL` close you didn't ask for | the winner-protection rule (§9): peak ≥2.5×ATR then 0.75×ATR pullback → banked automatically (5%/1.5% absolute when ATR unknown) |
| Proposal closed `cancelled` by the stale-entry sweep | its entry never filled for `STALE_ENTRY_MAX_DAYS` — the zombie bracket was reclaimed |
| `Financial Datasets API unavailable (no credits…)` | expected: that provider is prepaid-only and unfunded; the circuit breaker silences it for 1h and the agent uses web_search/earnings_calendar |
| Dashboard action returns `forbidden — reload the dashboard page` | the CSRF token rotated with a gateway restart — reload the tab |
| jest: `better_sqlite3.node not found` | `cd node_modules/better-sqlite3 && npx prebuild-install` (bun installs skip node prebuilds) |

## 19. Going live — the protocol decides, not this page

**The acceptance contract for going live is
[VALIDATION-PROTOCOL.md](VALIDATION-PROTOCOL.md)** — a pre-registered,
frozen-sample evaluation (≥100 shadow-live trades, ≥6 weeks, ≥2 regimes,
positive net expectancy with a positive bootstrap lower bound, profit
factor ≥ 1.3, drawdown inside the live math, per-class discipline) whose
pinned evaluator is `scripts/validation-scorecard.ts`. No summary here is
authoritative; an earlier revision of this section said "2–4 positive
weeks may be enough" — it is superseded, and following it would be
exactly the peeking the protocol forbids.

What remains this page's business — the mechanics once the protocol
PASSES:

1. Re-read `risk-rules.live.yaml` line by line (risk-appetite decisions,
   REVIEW-marked).
2. Switch IB Gateway to the live account, port 4001, and set
   `IBKR_PORT=4001`, `IBKR_ALLOW_LIVE=true` — manual acceptance only:
   **auto-execution cannot go live by construction.**
3. First live day: smallest sizes, every accept manual, `halt status`
   checked before each accept.
4. Keep the kill-switch threshold conservative; never clear a halt on the
   same day it fired.
5. No scorer calibration, rule change, or backtest-driven adjustment
   between the protocol's PASS and the flip — a behavior change ends the
   validated sample (see the protocol's freeze section).
