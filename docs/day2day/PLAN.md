# Day2Day Trading Extension — Architecture & Plan

## Overview

Extend Dexter from a **research-only financial agent** into a **day/overnight trading recommendation system** while reusing its agent loop, tool framework, skill system, memory, and gateway infrastructure.

**Guiding principles:**
- Maximize reuse of existing Dexter code — add tools and skills, don't fork the core
- IBKR is the single source for real-time market data and order execution
- Local LLM (vLLM on RTX Blackwell 6000 Pro, 96 GB VRAM) for latency-sensitive tasks
- Claude API for deep reasoning when quality matters more than speed
- Advisory-first: generate recommendations with explicit entry/stop/target — execution is opt-in

---

## 1. What Dexter Already Provides (Reusable As-Is)

| Component                                                | Location                                              | Reuse                                                |
| -------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------- |
| Agent loop (iterative tool-calling with self-validation) | `src/agent/agent.ts`                                  | ✅ Core engine for recommendation synthesis           |
| Tool registry + concurrent executor                      | `src/tools/registry.ts`, `src/agent/tool-executor.ts` | ✅ Register new IBKR/TA tools alongside existing ones |
| Skill system (YAML frontmatter + markdown workflows)     | `src/skills/registry.ts`, `src/skills/loader.ts`      | ✅ Add `day-trade` and `overnight` skills             |
| Multi-provider LLM with prefix routing                   | `src/model/llm.ts`, `src/providers.ts`                | ✅ Route to local vLLM or Claude by model name        |
| Persistent memory (embeddings, temporal decay, MMR)      | `src/memory/`                                         | ✅ Track trade history, lessons, market regime        |
| Gateway + heartbeat cron                                 | `src/gateway/`, `src/cron/runner.ts`                  | ✅ Scheduled scans, automated signal loop             |
| Message queue (mid-run injection)                        | `src/agent/agent.ts` (queue drain)                    | ✅ Inject real-time alerts into running agent         |
| Context compaction (micro + full)                        | `src/agent/compact.ts`, `src/agent/microcompact.ts`   | ✅ Essential for high-frequency context cycling       |
| Finance tools (fundamentals, earnings, news, screening)  | `src/tools/finance/`                                  | ✅ Pre-market research, context enrichment            |
| Web search + browser automation                          | `src/tools/search/`, `src/tools/browser/`             | ✅ News catalyst verification                         |
| WhatsApp gateway                                         | `src/gateway/channels/whatsapp/`                      | ✅ Mobile trade alerts and recommendations            |

---

## 2. What's Missing — New Components Needed

### 2.1 Real-Time Market Data via IBKR

**Gap:** Current price tool (`src/tools/finance/stock-price.ts`) uses Financial Datasets API — snapshot only, no streaming, no intraday bars.

**Solution:** New IBKR integration layer.

| Component                       | Description                                                                               | Priority |
| ------------------------------- | ----------------------------------------------------------------------------------------- | -------- |
| `src/tools/ibkr/connection.ts`  | IB Gateway connection manager (connect/reconnect/heartbeat)                               | P0       |
| `src/tools/ibkr/market-data.ts` | Tool: request real-time quotes, intraday bars (1m/5m/15m), L2 book                        | P0       |
| `src/tools/ibkr/historical.ts`  | Tool: historical bar data for TA computation                                              | P0       |
| `src/tools/ibkr/orders.ts`      | Tool: place/modify/cancel orders (paper + live)                                           | P1       |
| `src/tools/ibkr/account.ts`     | Tool: positions, P&L, buying power, margin                                                | P1       |
| `src/tools/ibkr/scanner.ts`     | Tool: IBKR market scanner (top movers, gap-ups, volume leaders)                           | P1       |
| `src/services/ibkr-stream.ts`   | Background streaming sidecar: subscribes to ticks, writes to local buffer (SQLite/DuckDB) | P0       |

**Library choice:** [`@stoqey/ib`](https://github.com/stoqey/ib) (TypeScript native) or Python bridge via `ib_insync` shelling out to a sidecar process.

**Connection architecture:**
```
IB Gateway (headless, port 4001/4002)
    ↕ TCP
IBKR Streaming Sidecar (long-lived process)
    ↕ writes ticks + bars
Local Buffer (SQLite / DuckDB)
    ↕ queries
Dexter IBKR Tools (on-demand reads)
```

**Environment variables to add:**
```bash
IBKR_HOST=127.0.0.1
IBKR_PORT=4002          # 4001=live, 4002=paper
IBKR_CLIENT_ID=1
IBKR_ACCOUNT=           # optional, auto-detected
```

### 2.2 Technical Analysis Engine

**Gap:** Dexter has zero TA capability — no indicators, no pattern recognition.

**Solution:** New TA tool that computes indicators from IBKR bar data.

| Component                              | Description                                                                  | Priority |
| -------------------------------------- | ---------------------------------------------------------------------------- | -------- |
| `src/tools/ibkr/technical-analysis.ts` | Tool: compute indicators on requested ticker + timeframe                     | P0       |
| `src/tools/ibkr/ta-indicators.ts`      | Indicator library (RSI, MACD, VWAP, Bollinger, ATR, volume profile, EMA/SMA) | P0       |

**Indicator set (phase 1):**

| Indicator              | Use Case                           |
| ---------------------- | ---------------------------------- |
| RSI (14)               | Overbought/oversold                |
| MACD (12,26,9)         | Momentum direction + crossovers    |
| VWAP                   | Intraday fair value anchor         |
| Bollinger Bands (20,2) | Volatility + mean reversion        |
| ATR (14)               | Stop-loss sizing                   |
| EMA 9/21/50/200        | Trend structure                    |
| Volume Z-score         | Unusual activity detection         |
| Relative Volume (RVOL) | Participation strength vs. average |

**Implementation options:**
- Pure TypeScript (no dependency): implement core indicators directly — they're simple math on arrays
- Or use `technicalindicators` npm package
- Note: `ta-lib-python` exists in the workspace (`d:\Home\Trading\ta-lib-python`) — could be used via Python sidecar if preferred

### 2.3 Signal Generation & Scoring

**Gap:** No framework to combine TA + fundamentals + news into actionable signals.

**Solution:** A scoring module that feeds into the agent's reasoning.

| Component                         | Description                                                                                  | Priority |
| --------------------------------- | -------------------------------------------------------------------------------------------- | -------- |
| `src/tools/ibkr/signal-scorer.ts` | Tool: multi-factor signal score for a ticker (momentum, mean-reversion, breakout, sentiment) | P1       |
| `src/services/scanner-loop.ts`    | Background loop: pre-market scan → rank universe → cache top candidates                      | P1       |

**Signal factors:**
```
Score = w1·momentum + w2·mean_reversion + w3·volume_confirm + w4·sentiment + w5·fundamental_support

Where:
  momentum       = MACD histogram slope + RSI trend + price vs EMAs
  mean_reversion = distance from VWAP/Bollinger midline + RSI extremes
  volume_confirm = RVOL > 1.5 + volume trend alignment
  sentiment      = news sentiment (local LLM) + insider activity
  fundamental    = earnings surprise + analyst revision direction
```

### 2.4 Risk Management

**Gap:** No position sizing, no daily limits, no stop-loss framework.

| Component                        | Description                                                   | Priority |
| -------------------------------- | ------------------------------------------------------------- | -------- |
| `src/tools/ibkr/risk-manager.ts` | Tool: validate trade against risk rules before recommendation | P0       |
| `src/config/risk-rules.yaml`     | Configurable risk parameters                                  | P0       |

**Risk rules (configurable):**
```yaml
max_position_pct: 5          # Max 5% of account per position
max_daily_loss_pct: 2        # Stop trading after 2% daily drawdown
max_open_positions: 10       # Diversification limit
max_sector_exposure_pct: 20  # No more than 20% in one sector
min_risk_reward: 2.0         # Only take 2:1+ R/R trades
mandatory_stop_loss: true    # Every recommendation must have a stop
max_overnight_exposure_pct: 30  # Reduce exposure before close
```

### 2.5 Market Session Awareness

**Gap:** No concept of pre-market, regular hours, after-hours, overnight.

| Component                   | Description                                             | Priority |
| --------------------------- | ------------------------------------------------------- | -------- |
| `src/utils/market-hours.ts` | Market calendar: session detection, half-days, holidays | P1       |

**Sessions:**
```
Pre-market:    04:00–09:30 ET   → scan, plan, set alerts
Regular:       09:30–16:00 ET   → active trading window
After-hours:   16:00–20:00 ET   → earnings reactions, position adjustment
Overnight:     20:00–04:00 ET   → futures context, Asia/EU markets, macro
```

### 2.6 Local LLM Provider (vLLM)

**Gap:** Dexter supports Ollama for local models but not vLLM. For 96 GB VRAM with high-throughput serving, vLLM is superior.

**Solution:** Add vLLM as a new provider — it exposes an OpenAI-compatible API, so integration is minimal.

| Component                            | Description                                        | Priority |
| ------------------------------------ | -------------------------------------------------- | -------- |
| Provider entry in `src/providers.ts` | Add `vllm` provider with prefix `vllm:`            | P0       |
| Factory in `src/model/llm.ts`        | Reuse `ChatOpenAI` class pointing at vLLM base URL | P0       |

**Configuration:**
```bash
VLLM_BASE_URL=http://127.0.0.1:8000/v1    # vLLM OpenAI-compatible endpoint
VLLM_MODEL=meta-llama/Llama-3.3-70B-Instruct  # or Qwen3-72B
```

**Provider definition:**
```typescript
{ id: 'vllm', displayName: 'vLLM (local)', modelPrefix: 'vllm:',
  apiKeyEnvVar: undefined, fastModel: 'vllm:same', contextWindow: 131072 }
```

**Since vLLM serves an OpenAI-compatible API**, the factory just creates a `ChatOpenAI` instance with `baseURL` pointing to `VLLM_BASE_URL`. No new client code needed.

### 2.7 LLM Routing Strategy

**Model routing by task type:**

| Task                          | Model                        | Why                                     |
| ----------------------------- | ---------------------------- | --------------------------------------- |
| News sentiment classification | `vllm:llama-3.3-70b` (local) | Low latency, high throughput, zero cost |
| TA signal interpretation      | `vllm:llama-3.3-70b` (local) | Speed-critical, structured output       |
| Trade plan generation         | `vllm:llama-3.3-70b` (local) | Sub-second first token                  |
| Pre-market research brief     | `claude-sonnet-4` (API)      | Complex multi-source synthesis          |
| DCF / deep valuation          | `claude-sonnet-4` (API)      | Reasoning quality critical              |
| Unusual event interpretation  | `claude-sonnet-4` (API)      | Nuanced judgment                        |
| Backtesting analysis          | `vllm:llama-3.3-70b` (local) | Many iterations, cost-sensitive         |

**Implementation:** The skill definition or the cron job specifies which model to use via the `model` parameter in `AgentRunRequest`. No changes to the agent loop needed.

---

## 3. New Skills to Create

### 3.1 Day Trade Skill

**File:** `src/skills/day-trade/SKILL.md`

```
---
name: day-trade-scan
description: Invoked for intraday trading opportunities, day trade setups, scalp ideas, momentum plays
---
```

**Workflow steps:**
1. Check market session (pre-market/regular/after-hours)
2. Fetch IBKR scanner: top movers, unusual volume, gap-ups/downs
3. For each candidate:
   a. Compute TA indicators (RSI, MACD, VWAP, volume)
   b. Check recent news + sentiment (local LLM)
   c. Score signal (momentum / mean-reversion / breakout)
4. Risk-check top candidates (position size, daily P&L headroom)
5. Generate trade plans: ticker, direction, entry zone, stop, target, timeframe, confidence
6. Output ranked recommendations with rationale

### 3.2 Overnight Trade Skill

**File:** `src/skills/overnight/SKILL.md`

**Workflow steps:**
1. Review current positions and P&L
2. Check after-hours earnings calendar
3. Scan for overnight catalysts (macro events, Asia/EU market moves, futures)
4. Evaluate which positions to hold/trim/hedge overnight
5. Identify swing setups for next-day open
6. Output overnight action plan

### 3.3 Pre-Market Brief Skill

**File:** `src/skills/pre-market/SKILL.md`

**Workflow steps:**
1. Summarize overnight market moves (futures, Asia, Europe)
2. Today's earnings calendar + economic data releases
3. Pre-market movers and gap analysis
4. Review watchlist positions and key levels
5. Output structured morning brief with trade ideas

---

## 4. Automated Signal Loop (Cron-Based)

Reuse the existing **heartbeat cron** system in `src/gateway/config.ts`.

**Schedule:**
```yaml
cron:
  heartbeats:
    - name: pre-market-scan
      schedule: "0 8 * * 1-5"        # 8:00 AM ET, weekdays
      query: "Run pre-market brief"
      model: "claude-sonnet-4"        # Deep reasoning for morning prep
      isolated: true

    - name: market-open-scan
      schedule: "35 9 * * 1-5"        # 9:35 AM ET (5 min after open)
      query: "Scan for day trade setups"
      model: "vllm:llama-3.3-70b"    # Speed for active trading
      isolated: true

    - name: midday-check
      schedule: "0 12 * * 1-5"        # Noon ET
      query: "Review open positions and midday opportunities"
      model: "vllm:llama-3.3-70b"
      isolated: true

    - name: pre-close-review
      schedule: "30 15 * * 1-5"       # 3:30 PM ET (30 min before close)
      query: "Run overnight position review"
      model: "claude-sonnet-4"
      isolated: true
```

**Alert delivery:** Recommendations pushed via WhatsApp gateway (already built) for mobile notifications.

---

## 5. Proposed Directory Structure (New Files Only)

```
src/
├── tools/
│   └── ibkr/                          # NEW — all IBKR integration
│       ├── connection.ts              # IB Gateway connection manager
│       ├── market-data.ts             # Tool: real-time quotes + intraday bars
│       ├── historical.ts              # Tool: historical data for TA
│       ├── orders.ts                  # Tool: order placement (paper/live)
│       ├── account.ts                 # Tool: positions, P&L, buying power
│       ├── scanner.ts                 # Tool: IBKR market scanner
│       ├── technical-analysis.ts      # Tool: compute TA indicators
│       ├── ta-indicators.ts           # Pure indicator math library
│       ├── signal-scorer.ts           # Tool: multi-factor signal scoring
│       ├── risk-manager.ts            # Tool: trade validation vs risk rules
│       └── index.ts                   # Factory exports
├── services/
│   ├── ibkr-stream.ts                 # Background streaming sidecar
│   └── scanner-loop.ts               # Pre-market universe scanning
├── skills/
│   ├── day-trade/SKILL.md             # Day trading workflow
│   ├── overnight/SKILL.md             # Overnight position management
│   └── pre-market/SKILL.md            # Morning brief workflow
├── utils/
│   └── market-hours.ts                # Market session detection
└── config/
    └── risk-rules.yaml                # Risk management parameters

docs/day2day/
├── PLAN.md                            # This file
├── IBKR_SETUP.md                      # IB Gateway configuration guide
└── VLLM_SETUP.md                      # Local LLM serving setup
```

---

## 6. Implementation Phases

### Phase 0 — Infrastructure (Week 1)
- [ ] Add vLLM provider to `src/providers.ts` + `src/model/llm.ts`
- [ ] Set up IB Gateway (headless) on the machine
- [ ] Implement `src/tools/ibkr/connection.ts` — connect, reconnect, heartbeat
- [ ] Implement `src/tools/ibkr/market-data.ts` — real-time quotes + intraday bars
- [ ] Register IBKR tools in `src/tools/registry.ts`
- [ ] Verify end-to-end: ask Dexter "What is AAPL trading at?" → answered via IBKR

### Phase 1 — Technical Analysis (Week 2)
- [ ] Implement `src/tools/ibkr/ta-indicators.ts` — RSI, MACD, VWAP, BB, ATR, EMAs
- [ ] Implement `src/tools/ibkr/technical-analysis.ts` — tool wrapping indicators
- [ ] Implement `src/tools/ibkr/historical.ts` — fetch historical bars
- [ ] Implement `src/utils/market-hours.ts` — session awareness
- [ ] Verify: ask Dexter "Show me RSI and MACD for NVDA on 5-min bars"

### Phase 2 — Skills & Signals (Week 3)
- [ ] Write `src/skills/day-trade/SKILL.md`
- [ ] Write `src/skills/pre-market/SKILL.md`
- [ ] Write `src/skills/overnight/SKILL.md`
- [ ] Implement `src/tools/ibkr/signal-scorer.ts`
- [ ] Implement `src/config/risk-rules.yaml` + `src/tools/ibkr/risk-manager.ts`
- [ ] Verify: ask Dexter "Find me day trade setups" → full workflow executes

### Phase 3 — Automation & Alerts (Week 4)
- [ ] Configure heartbeat cron schedules for market sessions
- [ ] Implement `src/services/ibkr-stream.ts` — background tick/bar buffer
- [ ] Implement `src/services/scanner-loop.ts` — pre-market scanner
- [ ] Implement `src/tools/ibkr/scanner.ts` — IBKR market scanner tool
- [ ] Test full loop: cron triggers scan → agent runs → WhatsApp alert delivered

### Phase 4 — Execution (Week 5, optional)
- [ ] Implement `src/tools/ibkr/orders.ts` — paper trading first
- [ ] Implement `src/tools/ibkr/account.ts` — position tracking
- [ ] Add order confirmation flow (tool approval pattern, already in Dexter)
- [ ] Paper trade for 2+ weeks before considering live execution

---

## 7. Risk & Mitigations

| Risk                                                 | Mitigation                                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| IB Gateway disconnects during market hours           | Auto-reconnect in `connection.ts` with exponential backoff; health check via heartbeat      |
| LLM hallucinating trade signals                      | TA indicators are computed deterministically; LLM only interprets and synthesizes           |
| Latency spikes from Claude API during market hours   | Use local vLLM for all time-sensitive tasks; Claude only for scheduled research             |
| Overfitting signals to recent data                   | Require backtesting validation in Phase 4 before live trading                               |
| Fat-finger orders                                    | Mandatory tool approval for `orders.ts`; daily loss limit kill-switch in risk manager       |
| Local LLM quality insufficient for complex reasoning | Hybrid routing: local for speed tasks, Claude for depth — tested per-task before committing |
| IBKR rate limits (50 msg/sec)                        | Batch requests; streaming sidecar maintains subscriptions; tools query local buffer         |

---

## 8. Environment Variables Summary (New)

```bash
# IBKR Connection
IBKR_HOST=127.0.0.1
IBKR_PORT=4002                    # 4001=live, 4002=paper
IBKR_CLIENT_ID=1

# Local LLM (vLLM)
VLLM_BASE_URL=http://127.0.0.1:8000/v1
VLLM_MODEL=meta-llama/Llama-3.3-70B-Instruct

# Existing (already in Dexter)
ANTHROPIC_API_KEY=...             # Claude for deep reasoning
FINANCIAL_DATASETS_API_KEY=...    # Supplementary fundamental data
EXASEARCH_API_KEY=...             # News search
```

---

## 9. Available Historical Data Inventory

Data already on-disk, ready for backtesting and ML training.

### 9.1 GDELT — Global Event Sentiment (2015–2025)

**Location:** `d:\Home\Trading\GDELT\gdelt_cleaned\parts_monthly\`
**Format:** Parquet, 125 monthly files (`gdelt_headlines_2015-01.parquet` → `gdelt_headlines_2025-09.parquet`)

Three data layers per 15-minute interval:

| Layer                     | Key Fields                                                                                                                                                                                                                                     | Trading Value                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Events (Export)**       | CAMEO event codes, GoldsteinScale (-10 to +10), AvgTone, NumArticles, NumMentions, Actor names/countries                                                                                                                                       | Geopolitical risk scoring, conflict escalation signals                                   |
| **Mentions**              | Per-article tone (MentionDocTone), source name (Reuters, Bloomberg, WSJ...), confidence scores, 15-min timestamps                                                                                                                              | Source-weighted sentiment, news velocity tracking                                        |
| **GKG (Knowledge Graph)** | 6-dimensional sentiment (Tone, PositiveScore, NegativeScore, Polarity, ActivityDensity, SelfGroupRef), auto-extracted themes (ECON_STOCKMARKET, ECON_BANKRUPTCY, TAX_FNCACT_CENTRAL_BANK), named entities, monetary amounts, direct quotations | **Richest sentiment layer** — per-entity, per-theme, with controversy and energy metrics |

**Completion needed:** Sep 2025 → present (~7 months). Same download pipeline already exists (`download-news.py`).

### 9.2 FirstRate Data — Multi-Asset 1-Minute Bars (2010–2025)

**Location:** `d:\Home\Trading\ActivTradesFX\data\FirstRate\`
**Format:** CSV in ZIP archives, split-and-dividend adjusted

| Asset Class | Coverage                                | Notes                         |
| ----------- | --------------------------------------- | ----------------------------- |
| **Stocks**  | All US equities (A-Z archives)          | 1-min OHLCV, full history     |
| **ETFs**    | All US ETFs (A-Z archives)              | Same granularity              |
| **Futures** | Major contracts (ES, NQ, CL, GC, ZB...) | Full + complete dataset       |
| **Crypto**  | Major coins (BTC, ETH...)               | Full history                  |
| **Index**   | S&P 500, Nasdaq, Dow, Russell...        | Full history                  |
| **Options** | Quarterly (Q1 2010–Q3 2025)             | 15-year options chain history |

**Completion needed:** Q4 2025 → present. Same retrieval script (`retrieve-data.sh`) with updated API token.

### 9.3 FX Data — Multi-Source Coverage (2007–2026)

| Source             | Location                                   | Pairs                       | Timeframes               |
| ------------------ | ------------------------------------------ | --------------------------- | ------------------------ |
| **ActivTrades FX** | `ActivTradesFX/data/`                      | 34 pairs (majors + exotics) | Daily, 5-min             |
| **DukasCopy**      | `DukasCopy/`                               | 10+ pairs                   | Daily, 5-min             |
| **MT5 (DuckDB)**   | `ActivTradesFX/data/FX-MetaTrader5/`       | 35 pairs                    | 1m, 5m, 15m, 30m, 1h, 1d |
| **MT5 (CSV)**      | `ActivTradesFX/data/FX-MetaTrader5/pairs/` | 35 pairs                    | 1-min raw                |

**Total FX:** 35 currency pairs, 2007–2026, minute-level resolution. Multiple sources allow cross-validation.

---

## 10. Additional Data Sources (Non-Duplicating)

Sources that provide **orthogonal signals** not covered by GDELT, FirstRate, or IBKR.

### 10.1 Macro & Economic Calendar

| Source                   | Data                                                                 | Access             | Cost |
| ------------------------ | -------------------------------------------------------------------- | ------------------ | ---- |
| **FRED (St. Louis Fed)** | US interest rates, CPI, GDP, unemployment, yield curve, money supply | REST API, free key | Free |
| **ECB Data Portal**      | EUR rates, ESTR/EURIBOR, financial stress index, FX reference rates  | REST API           | Free |
| **Eurostat**             | Euro area CPI, GDP, unemployment                                     | REST API           | Free |
| **BIS Statistics**       | Central bank policy rates, REER, credit-to-GDP                       | REST API           | Free |
| **World Bank**           | Development indicators, economic metadata                            | REST API           | Free |

**Trading value:** Rate decisions, CPI surprises, and yield curve inversions are the strongest macro catalysts for day trading. FRED + ECB cover the majors. None of this is in GDELT or FirstRate.

**Integration:** New tool `src/tools/macro/economic-calendar.ts` — fetches upcoming releases + recent surprises, injects into pre-market brief.

### 10.2 Prediction Markets (Leading Indicators)

| Source         | Data                                                         | Access                     | Cost      |
| -------------- | ------------------------------------------------------------ | -------------------------- | --------- |
| **Polymarket** | Geopolitical event probabilities, election odds, policy bets | Public API (Gamma Markets) | Free      |
| **Kalshi**     | US regulatory event contracts (Fed rate, CPI, GDP)           | REST API                   | Free tier |

**Trading value:** Probability shifts in prediction markets often **lead** news by hours. A significant move in a Fed rate contract before the announcement is an early-warning signal. WorldMonitor uses Polymarket extensively for exactly this purpose.

**Integration:** New tool `src/tools/macro/prediction-markets.ts` — poll probability shifts, flag divergences.

### 10.3 Options Flow & Implied Volatility

| Source                | Data                                    | Access                                | Cost              |
| --------------------- | --------------------------------------- | ------------------------------------- | ----------------- |
| **IBKR API**          | Live options chains, Greeks, IV surface | Already connected                     | Free with account |
| **FirstRate Options** | Historical options data (2010–2025)     | Already on disk                       | Already owned     |
| **CBOE**              | VIX, VVIX, put/call ratio, skew index   | Delayed data free; real-time via IBKR | Free (delayed)    |

**Trading value:** Unusual options activity (large OTM call sweeps, put/call ratio extremes, IV rank) is among the strongest short-term predictive signals. The FirstRate options archive enables historical backtesting of options flow strategies.

**Integration:** New tool `src/tools/ibkr/options-flow.ts` — detect unusual activity, compute IV rank, put/call ratio.

### 10.4 Order Flow & Market Microstructure (from IBKR)

| Signal             | Source                   | Use                                               |
| ------------------ | ------------------------ | ------------------------------------------------- |
| **L2 Order Book**  | IBKR `reqMktDepth`       | Detect large resting orders, absorption, spoofing |
| **Time & Sales**   | IBKR `reqTickByTickData` | Track aggressive buying/selling, block trades     |
| **Short Interest** | IBKR short availability  | Squeeze candidates                                |

**Trading value:** Order flow confirms or contradicts TA signals. A breakout with aggressive buying on tape is higher conviction than a breakout into thin liquidity.

**Integration:** Extend `src/tools/ibkr/market-data.ts` with L2 + T&S feeds; add `src/tools/ibkr/order-flow.ts` for analysis.

### 10.5 Geopolitical & Supply Chain Intelligence (WorldMonitor-Inspired)

Borrowing ideas from WorldMonitor's 65+ data sources:

| Source               | Data                                                    | Trading Value                                         | Cost                           |
| -------------------- | ------------------------------------------------------- | ----------------------------------------------------- | ------------------------------ |
| **ACLED**            | Armed conflict events, protests, riots (30-day)         | Geopolitical risk for commodity/FX trades             | Free academic; paid commercial |
| **IMF PortWatch**    | Chokepoint transit intelligence (Suez, Panama, Malacca) | Oil/shipping disruption signals                       | Free                           |
| **NASA FIRMS**       | Near-real-time wildfire detection (VIIRS satellite)     | Commodity impact (agriculture, energy infrastructure) | Free                           |
| **Cloudflare Radar** | Internet outages by country                             | Emerging crisis detection (conflict, censorship)      | Free                           |
| **GIE AGSI+**        | EU natural gas storage levels                           | European energy price catalyst                        | Free                           |
| **U.S. EIA**         | Crude oil inventories, fuel prices                      | Weekly oil inventory surprise = instant price move    | Free                           |

**Integration:** New tool `src/tools/macro/geopolitical-signals.ts` — aggregate risk signals from multiple sources; feed into overnight skill for commodity/FX context.

### 10.6 Social Sentiment (Complementary to GDELT)

GDELT covers mainstream news. These cover crowd/retail sentiment:

| Source                                                 | Data                                   | Trading Value                      | Cost     |
| ------------------------------------------------------ | -------------------------------------- | ---------------------------------- | -------- |
| **Reddit API** (r/wallstreetbets, r/stocks)            | Retail sentiment, trending tickers     | Meme stock momentum, retail flow   | Free     |
| **X/Twitter** (via Dexter's existing `X_BEARER_TOKEN`) | Real-time market chatter               | Breaking news before wire services | Existing |
| **StockTwits**                                         | Per-ticker sentiment (bull/bear ratio) | Retail conviction indicator        | Free     |

**Integration:** Dexter already has X search (`X_BEARER_TOKEN` in env). Add a dedicated tool `src/tools/sentiment/social.ts` that aggregates Reddit + StockTwits + X for a composite retail sentiment score.

### 10.7 Data Source Overlap Matrix

Ensuring no duplication:

| Signal Type                 | GDELT             | FirstRate           | IBKR          | New Sources                                  |
| --------------------------- | ----------------- | ------------------- | ------------- | -------------------------------------------- |
| **Price OHLCV**             | ✗                 | ✅ historical        | ✅ live        | —                                            |
| **News text/headlines**     | ✅ (article-level) | ✗                   | ✅ (basic)     | —                                            |
| **News sentiment scores**   | ✅ (GKG 6-dim)     | ✗                   | ✗             | Social sentiment (Reddit/X/StockTwits)       |
| **Geopolitical events**     | ✅ (CAMEO codes)   | ✗                   | ✗             | ACLED (conflict), Polymarket (probabilities) |
| **Macro economic data**     | ✗                 | ✗                   | ✗             | FRED, ECB, EIA                               |
| **Options/volatility**      | ✗                 | ✅ historical chains | ✅ live chains | CBOE (VIX, skew)                             |
| **Order flow / L2**         | ✗                 | ✗                   | ✅ live        | —                                            |
| **Supply chain / shipping** | ✗                 | ✗                   | ✗             | IMF PortWatch, GIE AGSI+                     |
| **Natural disasters**       | ✅ (partial)       | ✗                   | ✗             | NASA FIRMS, USGS                             |
| **Prediction markets**      | ✗                 | ✗                   | ✗             | Polymarket, Kalshi                           |

---

## 11. Backtesting Architecture

### 11.1 Two-Tier Backtesting Strategy

| Tier              | What                                                          | Speed                      | Cost              |
| ----------------- | ------------------------------------------------------------- | -------------------------- | ----------------- |
| **Quantitative**  | TA indicators + signal scorer + risk rules on historical bars | Seconds over years of data | Zero              |
| **LLM-Augmented** | Replay top N signals through agent with historical context    | Minutes per signal         | Zero (local vLLM) |

### 11.2 Quantitative Backtest Engine

```
src/backtest/
├── engine.ts           # Bar-by-bar replay engine
├── data-loader.ts      # Load bars from FirstRate CSV/ZIP, IBKR, or DuckDB
├── simulator.ts        # Trade simulator (fills, slippage model, commissions)
├── metrics.ts          # Sharpe, Sortino, max drawdown, win rate, profit factor, Calmar
└── report.ts           # Generate performance report (markdown + JSON)
```

**Data flow:**
```
FirstRate ZIP archives → data-loader.ts (decompress + parse)
                              ↓
                    1-min OHLCV bar stream
                              ↓
                    ta-indicators.ts (compute RSI, MACD, VWAP, etc.)
                              ↓
                    signal-scorer.ts (generate buy/sell signals)
                              ↓
                    risk-manager.ts (validate position sizing, stops)
                              ↓
                    simulator.ts (simulate fills with slippage model)
                              ↓
                    metrics.ts (compute Sharpe, drawdown, etc.)
                              ↓
                    report.ts (output performance summary)
```

**Slippage model:**
- Market orders: half the bid-ask spread + 1 tick
- Limit orders: fill probability based on distance from mid
- Commission: IBKR tiered schedule (configurable)

**Walk-forward validation:**
- Train scoring weights on 6-month rolling window
- Test on next 1 month (out-of-sample)
- Step forward by 1 month, repeat
- Prevents overfitting to any specific market regime

### 11.3 LLM-Augmented Backtest

For validating whether the LLM synthesis improves or degrades raw signal quality:

1. Take the top 100 signals from quantitative backtest
2. For each signal, reconstruct the historical context:
   - TA indicators at that timestamp
   - GDELT news/sentiment within ±24h window
   - Recent fundamentals (earnings, analyst revisions)
3. Run through the agent with local vLLM (zero cost)
4. Compare LLM-filtered trades vs. all signals:
   - Did the LLM correctly filter out losing trades?
   - Did it reject winners?
   - Net Sharpe improvement?

**Caveat:** LLM backtesting is inherently non-deterministic. Run each signal 3× and use majority vote to reduce noise.

---

## 12. Machine Learning Pipeline

### 12.1 ML Architecture

```
                    ┌─────────────────────────────────────┐
                    │     vLLM (RTX 6000 Pro, 96GB)       │
                    │  ┌───────────────────────────────┐  │
                    │  │ Llama 3.3 70B (base model)    │  │
                    │  │  + LoRA: sentiment-ft          │  │  ← sentiment fine-tune
                    │  │  + LoRA: trade-classifier      │  │  ← signal quality classifier
                    │  └───────────────────────────────┘  │
                    │         ~75 GB VRAM                  │
                    └──────────────┬──────────────────────┘
                                   │ OpenAI-compat API
                    ┌──────────────┴──────────────────────┐
                    │        Dexter Agent Loop             │
                    │  predict tool → HTTP → vLLM          │
                    └──────────────┬──────────────────────┘
                                   │
        ┌──────────────────────────┼──────────────────────┐
        ▼                          ▼                       ▼
  Signal Weights             Regime Detector          Sentiment LoRA
  (XGBoost, CPU)           (HMM/GMM, CPU)         (vLLM multi-LoRA)
  ~0 GPU                   ~0 GPU                  shares base model
```

**VRAM budget:**

| Component                                   | VRAM         | Notes                           |
| ------------------------------------------- | ------------ | ------------------------------- |
| vLLM: Llama 3.3 70B (Q8)                    | ~75 GB       | Base model for all LLM tasks    |
| LoRA adapters (sentiment, trade classifier) | ~0.5 GB each | Hot-swapped per request by vLLM |
| XGBoost / HMM / GMM                         | 0 GPU        | CPU-only, tiny models           |
| KV cache headroom                           | ~20 GB       | For concurrent requests         |
| **Total**                                   | **~96 GB**   | Fits within budget              |

### 12.2 ML Models by Use Case

#### A. Signal Weight Optimization (XGBoost)

**Input features:**
- TA indicators at signal time (RSI, MACD histogram, VWAP distance, BB position, ATR, RVOL)
- Time-of-day, day-of-week
- VIX level, VIX change
- Sector relative strength
- Earnings proximity (days until next report)
- Recent GDELT sentiment score for the ticker's sector

**Target:** Next-N-bar return (classification: win/loss based on risk/reward target hit)

**Training data:** FirstRate 1-min bars + TA indicators → signal events → label by outcome. ~10 years of data, millions of signal instances.

**Model:** XGBoost classifier with walk-forward validation. Runs on CPU, instant inference.

#### B. Market Regime Detection (HMM / Gaussian Mixture)

**Input features:**
- 20-day realized volatility
- VIX level and term structure slope
- Market breadth (% stocks above 50-day MA)
- VWAP deviation distribution
- Average daily range / ATR ratio

**Regimes to detect:**
| Regime         | Characteristics                               | Trading Adjustment                    |
| -------------- | --------------------------------------------- | ------------------------------------- |
| Low-vol trend  | VIX < 15, narrow ranges, persistent direction | Trend-following, wider stops          |
| High-vol trend | VIX 15-25, wide ranges, directional           | Momentum, tighter stops, smaller size |
| Mean-reversion | VIX 20-30, range-bound, no follow-through     | Fade extremes, tight targets          |
| Crisis         | VIX > 30, gap risk, correlation spike         | Reduce size, hedge, or sit out        |

**Training data:** FirstRate index + VIX data (2010–2025). Unsupervised — no labels needed.

**Integration:** Regime feeds into the signal scorer as a context multiplier: momentum signals are upweighted in trend regimes, mean-reversion signals in range regimes.

#### C. Sentiment LoRA Fine-Tune

**Base model:** Llama 3.3 70B (already served by vLLM)

**Training approach:**
1. **Collect labeled data:**
   - GDELT GKG headlines (2015–2025) with 6-dimensional sentiment scores
   - Label: next-day price move of mentioned ticker/sector (from FirstRate bars)
   - Filter: only headlines with entity match to a traded ticker, confidence > 50
2. **Build training set:**
   - Input: headline text + entity + sector
   - Output: structured sentiment (bullish/bearish/neutral, confidence 0-100, time horizon)
3. **Fine-tune LoRA adapter** (~1-2 GB, trains in hours on RTX 6000 Pro)
4. **Serve via vLLM multi-LoRA** — switch adapter per request, no reloading

**Why LoRA instead of full fine-tune:**
- 70B full fine-tune needs >150 GB VRAM (impossible on 96 GB)
- LoRA trains only ~0.1% of parameters, fits in VRAM alongside inference
- vLLM supports multi-LoRA: same base model, multiple adapters, hot-swapped per request

#### D. Trade Quality Classifier (LoRA)

A second LoRA adapter trained to predict whether a proposed trade plan is likely to succeed:

**Input:** Full trade plan (ticker, direction, entry, stop, target, TA summary, sentiment, regime)
**Output:** Confidence score (0–100) + risk flags

**Training data:** Collected from live paper trading (Phase 4+). Needs ~500+ labeled trade outcomes.

### 12.3 Data Collection Pipeline (Start in Phase 0)

**Critical:** ML is useless without training data. Start archiving immediately.

```
src/services/data-archive.ts    # Continuous data archival service

Archives to DuckDB (local):
├── bars/          # All IBKR bar data (1m, 5m) for watched universe
├── ticks/         # Tick-by-tick for active trades
├── news/          # Every IBKR news headline + Exa/web search result
├── sentiment/     # LLM-generated sentiment scores (with timestamps)
├── signals/       # Every generated signal + outcome tracking
├── orders/        # All paper/live orders with fill details
└── gdelt/         # Continuous GDELT ingestion (extend existing pipeline)
```

**Storage estimate:**
- 1-min bars, 500 tickers, 1 year: ~15 GB
- News headlines, 1 year: ~2 GB
- GDELT monthly: ~1 GB/month
- Total: ~30 GB/year — trivial

### 12.4 GDELT Integration for Backtesting

The existing GDELT archive (2015–2025) enables **historical sentiment backtesting**:

```
src/backtest/sentiment-loader.ts

1. Load GDELT GKG parquet for target date range
2. Extract entities → match to ticker symbols (fuzzy match on company names)
3. Compute per-ticker sentiment features:
   - Rolling 24h average tone
   - Sentiment momentum (tone change rate)
   - News velocity (articles/hour)
   - Controversy score (polarity metric)
   - Source-tier-weighted sentiment
4. Align to bar timestamps (merge on 15-min boundaries)
5. Feed into signal scorer alongside TA indicators
```

**Entity matching challenge:** GDELT uses full company names ("NVIDIA Corporation") not tickers ("NVDA"). Build a mapping table from SEC EDGAR company-ticker database (free, 10K+ entries) + fuzzy matching.

---

## 13. Implementation Phases

### Phase 0 — Infrastructure (✅ code-complete)
- [x] Add vLLM provider to [`src/providers.ts`](../../src/providers.ts) + [`src/model/llm.ts`](../../src/model/llm.ts)
- [x] Implement [`src/tools/ibkr/connection.ts`](../../src/tools/ibkr/connection.ts) — singleton connection manager
- [x] Implement [`src/tools/ibkr/market-data.ts`](../../src/tools/ibkr/market-data.ts) — snapshot quotes
- [x] Register IBKR tools in [`src/tools/registry.ts`](../../src/tools/registry.ts) (gated on `IBKR_HOST`/`IBKR_PORT`)
- [x] Implement [`src/services/data-archive.ts`](../../src/services/data-archive.ts) — call-on-demand, persists to SQLite
- [ ] **Set up IB Gateway (paper, port 4002) and verify end-to-end** — *not yet validated against live connection*
- [ ] **Complete GDELT download (Sep 2025 → present)** — external pipeline, run `download-news.py`
- [ ] **Complete FirstRate data (Q4 2025 → present)** — external pipeline, run `retrieve-data.sh`

### Phase 1 — Technical Analysis (✅ code-complete)
- [x] [`src/tools/ibkr/ta-indicators.ts`](../../src/tools/ibkr/ta-indicators.ts) — RSI, MACD, VWAP, BB, ATR, EMAs (pure-TS)
- [x] [`src/tools/ibkr/technical-analysis.ts`](../../src/tools/ibkr/technical-analysis.ts) — agent-facing tool
- [x] [`src/tools/ibkr/historical.ts`](../../src/tools/ibkr/historical.ts) — historical bars
- [x] [`src/utils/market-hours.ts`](../../src/utils/market-hours.ts) — sessions + holidays + half-days through 2027
- [ ] Verify against live IBKR connection

### Phase 2 — Skills & Signals (✅ code-complete)
- [x] [`src/skills/day-trade/SKILL.md`](../../src/skills/day-trade/SKILL.md)
- [x] [`src/skills/pre-market/SKILL.md`](../../src/skills/pre-market/SKILL.md)
- [x] [`src/skills/overnight/SKILL.md`](../../src/skills/overnight/SKILL.md)
- [x] [`src/tools/ibkr/signal-scorer.ts`](../../src/tools/ibkr/signal-scorer.ts) — multi-factor 0–100 score
- [x] [`src/config/risk-rules.yaml`](../../src/config/risk-rules.yaml) + [`src/tools/ibkr/risk-manager.ts`](../../src/tools/ibkr/risk-manager.ts)
- [ ] Verify the day-trade skill end-to-end against live IBKR

### Phase 3 — Automation & Alerts (✅ code-complete)
- [x] Four trading cron jobs auto-seeded at gateway startup ([`src/cron/trading-schedules.ts`](../../src/cron/trading-schedules.ts))
- [x] [`src/services/ibkr-stream.ts`](../../src/services/ibkr-stream.ts) — realtime 5s bars, ring buffer + SQLite
- [x] [`src/services/scanner-loop.ts`](../../src/services/scanner-loop.ts) — wrapped by `ibkr_scanner` tool
- [x] [`src/tools/ibkr/scanner.ts`](../../src/tools/ibkr/scanner.ts) — agent-facing scanner
- [ ] **Wire `ibkr-stream` so symbols can be added/queried from the agent** — service exists but `addSymbol`/`getLatestBars` aren't exposed as tools yet
- [ ] **Wire `data-archive` invocation** — needs either a tool wrapper or a dedicated cron job that calls `archiveBars`
- [ ] End-to-end: cron triggers scan → agent runs skill → WhatsApp alert delivered

### Phase 4 — Execution + Paper Trading (✅ code-complete, awaiting validation)
- [x] [`src/tools/ibkr/orders.ts`](../../src/tools/ibkr/orders.ts) — MKT/LMT/STP/TRAIL/MOC/LOC/MIDPRICE
- [x] [`src/tools/ibkr/account.ts`](../../src/tools/ibkr/account.ts) — balances, margin, positions, P&L
- [x] `ibkr_orders` added to `TOOLS_REQUIRING_APPROVAL` ([`src/agent/tool-executor.ts`](../../src/agent/tool-executor.ts))
- [ ] Paper trade for 2+ weeks, collecting labeled trade outcomes

### Phase 5 — Backtesting (✅ code-complete)
- [x] [`src/backtest/engine.ts`](../../src/backtest/engine.ts) — bar-by-bar replay
- [x] [`src/backtest/data-loader.ts`](../../src/backtest/data-loader.ts) — FirstRate ZIP + SQLite archive
- [x] [`src/backtest/simulator.ts`](../../src/backtest/simulator.ts) — slippage + commissions
- [x] [`src/backtest/metrics.ts`](../../src/backtest/metrics.ts) — Sharpe, Sortino, drawdown, profit factor, Calmar
- [x] [`src/backtest/sentiment-loader.ts`](../../src/backtest/sentiment-loader.ts) — GDELT GKG parquet → daily per-ticker sentiment
- [ ] **Run walk-forward validation on 2015–2025 data** — needs a CLI/runner script
- [ ] LLM-augmented backtest on top 100 signals (local vLLM)
- [ ] SEC EDGAR entity → ticker mapping for sentiment-loader

### Phase 6 — ML Models (Next)
- [ ] Build entity→ticker mapping from SEC EDGAR (`src/ml/entity-mapper.ts`)
- [ ] XGBoost signal weight optimizer (CPU)
- [ ] HMM/GMM regime detector (CPU)
- [ ] Integrate regime detection into signal scorer
- [ ] **Evaluate RLM (Recursive Language Models) for long-context research
  workloads** — [alexzhang13/rlm](https://github.com/alexzhang13/rlm):
  root LM drives a REPL where the corpus is a variable, recursively
  calling sub-LMs over slices. Deliberately NOT for the intraday loop
  (small contexts, latency-critical, root-model reliability); target
  workloads where it fits:
  - GDELT corpus questions (tone history across ~50k headlines/monthly parquets)
  - the Phase-5 LLM-augmented backtest (hundreds of independent evaluations
    over reconstructed context windows)
  - filing (10-K) analysis and multi-week JSONL log forensics
  Recommended shape: Python sidecar (`pip install rlms`) exposed as a
  `deep_research` dexter tool; **hybrid routing — Anthropic as root
  (orchestration quality), local vLLM as the recursive worker fleet**
  (sub-calls free, parallel short-context batches are vLLM's sweet spot,
  fits `--max-model-len 32768` + prefix caching). First experiment: a
  GDELT tone-history question, fully offline, zero trading-system risk.

- [ ] **Evaluate an autoresearch-style overnight scorer-research loop** —
  [karpathy/autoresearch](https://github.com/karpathy/autoresearch): a
  coding agent autonomously hill-climbs code against a fast scalar
  metric (modify → run 5-min experiment → keep/discard → repeat, ~100
  experiments/night). The preconditions already exist here: the
  backtest is deterministic (~20 s/ticker-year), the metric is average
  out-of-sample Sharpe across walk-forward folds, and the calibration
  apply-guard (+0.05 Sharpe) is the keep/discard primitive. Target:
  let an agent iterate on signal-scorer factor code, exit geometry,
  composite-rank formula, and pattern-detector thresholds overnight
  (GPU idle window; compatible with the universe sweep).

  **MANDATORY anti-overfitting protocol** (backtest Sharpe does not
  generalize the way autoresearch's val_bpb does — an unsupervised
  hill-climber on it is an overfitting machine):
  1. **Locked holdout**: reserve tickers AND years the agent never
     sees; evaluated exactly once, by a human, after the run ends.
  2. **Multi-regime evaluation**: candidate changes must be scored
     across 2015–2025 FirstRate history (bull/bear/chop regimes),
     never a single year or a single mega-cap.
  3. **Walk-forward only**: the agent optimizes average OOS fold
     Sharpe; in-sample results are never the objective.
  4. **Complexity penalty**: prefer fewer parameters/branches; reject
     changes whose improvement vanishes when any one fold is dropped.
  5. **Human gate**: nothing the loop produces is applied to the live
     scorer without explicit review; the +0.05-Sharpe apply-guard stays
     as a floor, not a substitute for review.
  6. **Researcher agent = frontier model** (Claude), not the local
     model — autonomous code modification is where local-model
     brittleness costs the most; experiment cost is minutes, not tokens.

### Phase 7 — Sentiment Fine-Tuning (3+ months after Phase 0 verification)
- [ ] Build GDELT headline → ticker → outcome training set
- [ ] Train sentiment LoRA adapter on Llama 3.3 70B
- [ ] Deploy via vLLM multi-LoRA serving
- [ ] Train trade quality classifier LoRA (needs 500+ paper trade outcomes)
- [ ] (pairs with the RLM item above: RLM-style orchestration can also
  drive the training-set construction sweep over the GDELT archive)
- [ ] (pairs with the autoresearch item above: the same harness pattern —
  fixed time budget, scalar metric, keep/discard — applies to
  hill-climbing the LoRA training recipe on the RTX 6000 Pro)

### Phase 8 — Additional Data Sources (Ongoing)
- [ ] **`src/tools/macro/prediction-markets.ts` — Polymarket (PROMOTED: build
  first, ahead of the FRED calendar — it covers event timing AND adds
  crowd probabilities in one free feed).** APIs verified 2026-07: Gamma
  API (gamma-api.polymarket.com) is fully public, no key, plain REST;
  CLOB public endpoints for prices/history. Two integration modes:

  **Mode A — decision context (build first, ~half a day):**
  One tool, two actions: `events` (high-volume markets resolving soon,
  filtered by tags economics/fed/geopolitics: question, outcome odds,
  24h odds change, volume, resolution date) and `search` (by term).
  Pure parsers over Gamma JSON (fixture-tested), 5-min cache. Wire into
  prompts (auto re-synced): Pre-Market Brief quotes market-implied
  probabilities next to analyst forecasts and flags divergences;
  Pre-Close Review weighs tomorrow's event odds in overnight-hold
  decisions; trigger evaluations get relevant event odds as context.
  Later, once observed useful: a deterministic "event-risk dial"
  (high-volume markets resolving <24h with wide uncertainty → briefs
  instructed to size down). Purely additive to the judgment layer — no
  execution-path changes.

  **Mode B — proposal SOURCE (odds moves generate candidates):**
  A new trigger source parallel to the scanner engine, reusing the
  existing trigger→evaluation→proposal→risk-gate→human-accept pipeline:
  1. Deterministic detector polls high-volume markets and fires on
     significant odds moves (Δprobability over a window above a
     threshold, volume-qualified) — debounced per market, daily-capped,
     mirroring OPP_TRIGGER_* semantics.
  2. Event→instrument mapping resolves the tradable expression: a
     curated YAML table for the recurring cases (oil/OPEC/Hormuz →
     XLE/XOM/OXY; Fed-cut repricing → TLT/KRE; etc.), with the LLM
     evaluation refining/overriding per event.
  3. The standard trigger evaluation then verifies the move against
     news (the odds move is the catalyst candidate, not its proof),
     runs TA on the mapped tickers for entry/stop/target as usual, and
     registers proposals through the normal gates — human accept only.
  Mode B builds on Mode A's tool; nothing bypasses the safety model.
- [ ] `src/tools/macro/economic-calendar.ts` — FRED + ECB integration
- [ ] Kalshi (deferred — overlapping coverage, more setup than Polymarket)
- [ ] `src/tools/ibkr/options-flow.ts` — unusual activity, IV rank, put/call
- [ ] `src/tools/macro/geopolitical-signals.ts` — ACLED, IMF PortWatch, NASA FIRMS, EIA
- [ ] `src/tools/sentiment/social.ts` — Reddit + StockTwits + X aggregate

---

## 13bis. Sprint Plan (2026-05-17)

### Sprint A — Lock in what exists (✅ done)
- [x] Split day2day's uncommitted blob into six logical commits (vLLM / IBKR / market+risk+skills / cron / backtest / docs)
- [x] Mark Phase 0–5 ✅ in this document
- [x] Default `IBKR_PORT=4002` (paper Gateway) in `env.example`

### Sprint B — Prove it end-to-end against IB Gateway (in progress, 2026-05-18)
- [x] Bring up IB Gateway paper on port 4002
- [x] Verify `ibkr_market_data AAPL`, `ibkr_historical AAPL`, `technical_analysis AAPL 5 mins`
- [x] Verify full `signal_scorer` + `risk_manager` flow on AAPL
- [x] `ibkr_scanner` connects (returns empty pre-market, expected)
- [ ] Trigger the `day-trade-scan` skill end-to-end via the LLM; confirm output lands in WhatsApp
- [ ] Smoke-test backtest on one ticker against FirstRate archive
- [ ] Follow-up: fix DELAYED_VOLUME tick (code 74) unit scaling — current value is ~10⁴× too large

Sprint B uncovered three real bugs in the IBKR tools (all fixed in
[a7c2f24](https://github.com/fpopineau/dexter/commit/a7c2f24)):
- Informational IBKR codes were treated as fatal in every per-tool
  error handler — added `isNonFatalIbkrError` filter.
- No path to use delayed market data — added `IBKR_MARKET_DATA_TYPE`
  env var and `reqMarketDataType` call at connect.
- `market-data.ts` only mapped live tick codes; delayed feed (codes
  66–76) was silently dropped. Now mapped to the same labels with a
  `delayed: true` flag.

The single throwaway script that found these is
[scripts/smoke-ibkr.ts](../../scripts/smoke-ibkr.ts) — drives each
IBKR tool directly with the LLM bypassed.

### Sprint B+ — Close the obvious wiring gaps
- [ ] Expose `addSymbol` / `getLatestPrice` from `ibkr-stream` as agent tools (or as a watchlist hook)
- [ ] Add a `data-archive` cron job (or tool) so historical bars accumulate to SQLite for training
- [ ] Backtest CLI runner: `bun run src/backtest/cli.ts --ticker NVDA --from 2024-01 --to 2025-12`

### Sprint C — Macro & options data (Phase 8 starters)
- [ ] `src/tools/macro/economic-calendar.ts` (FRED + EIA) — biggest pre-market brief unlock
- [ ] `src/tools/ibkr/options-flow.ts` — IV rank, P/C ratio, unusual activity
- [ ] `src/tools/sentiment/social.ts` — Reddit + StockTwits + existing X bearer token aggregator

### Sprint D — ML pipeline (Phase 6)
- [ ] SEC EDGAR entity-mapper
- [ ] XGBoost weight optimizer trained on FirstRate + TA features
- [ ] HMM/GMM regime detector; plug regime into signal scorer as multiplier
- [ ] Defer LoRA fine-tunes until ≥500 labeled paper-trade outcomes from Sprint B's cron loop

---

## 14. Revised Directory Structure

```
src/
├── tools/
│   ├── ibkr/                          # IBKR integration
│   │   ├── connection.ts              # IB Gateway connection manager
│   │   ├── market-data.ts             # Tool: quotes + intraday bars + L2 + T&S
│   │   ├── historical.ts              # Tool: historical data for TA
│   │   ├── orders.ts                  # Tool: order placement (paper/live)
│   │   ├── account.ts                 # Tool: positions, P&L, buying power
│   │   ├── scanner.ts                 # Tool: IBKR market scanner
│   │   ├── technical-analysis.ts      # Tool: compute TA indicators
│   │   ├── ta-indicators.ts           # Pure indicator math library
│   │   ├── signal-scorer.ts           # Tool: multi-factor signal scoring
│   │   ├── risk-manager.ts            # Tool: trade validation vs risk rules
│   │   ├── options-flow.ts            # Tool: unusual options activity, IV rank
│   │   ├── order-flow.ts             # Tool: L2 + T&S analysis
│   │   └── index.ts                   # Factory exports
│   ├── macro/                         # Macro & geopolitical data
│   │   ├── economic-calendar.ts       # FRED + ECB + EIA integration
│   │   ├── prediction-markets.ts      # Polymarket + Kalshi
│   │   └── geopolitical-signals.ts    # ACLED, IMF PortWatch, NASA FIRMS
│   └── sentiment/                     # Social & news sentiment
│       └── social.ts                  # Reddit + StockTwits + X aggregate
├── services/
│   ├── ibkr-stream.ts                 # Background streaming sidecar
│   ├── scanner-loop.ts                # Pre-market universe scanning
│   └── data-archive.ts               # Continuous data archival to DuckDB
├── backtest/
│   ├── engine.ts                      # Bar-by-bar replay engine
│   ├── data-loader.ts                 # FirstRate ZIP + DuckDB loader
│   ├── sentiment-loader.ts            # GDELT parquet → per-ticker sentiment
│   ├── simulator.ts                   # Fills, slippage, commissions
│   ├── metrics.ts                     # Sharpe, Sortino, drawdown, profit factor
│   └── report.ts                      # Markdown + JSON performance report
├── ml/
│   ├── features.ts                    # Feature engineering from TA + macro + sentiment
│   ├── predict.ts                     # Tool: call ML models for predictions
│   └── entity-mapper.ts              # SEC EDGAR company → ticker mapping
├── skills/
│   ├── day-trade/SKILL.md             # Day trading workflow
│   ├── overnight/SKILL.md             # Overnight position management
│   └── pre-market/SKILL.md            # Morning brief workflow
├── utils/
│   └── market-hours.ts                # Market session detection
└── config/
    └── risk-rules.yaml                # Risk management parameters

docs/day2day/
├── PLAN.md                            # This file
├── IBKR_SETUP.md                      # IB Gateway configuration guide
└── VLLM_SETUP.md                      # Local LLM serving setup
```
