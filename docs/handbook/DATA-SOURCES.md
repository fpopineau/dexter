# Data Sources

Every data source the system uses, produces, or plans to use — what it
feeds, how to configure it, and what is still missing.

- [1. Live sources (wired)](#1-live-sources-wired)
- [2. Data the system produces](#2-data-the-system-produces)
- [3. Historical archives on disk (backtesting)](#3-historical-archives-on-disk-backtesting)
- [4. Planned sources (not yet integrated)](#4-planned-sources-not-yet-integrated)
- [5. Signal overlap matrix](#5-signal-overlap-matrix)
- [6. Local archive audit and gap-filling strategy](#6-local-archive-audit-and-gap-filling-strategy)

---

## Earnings calendar — Nasdaq public endpoint (FREE, wired)

Daily per-date fetch of US reporters (symbol, pre-market/after-hours
timing, consensus EPS), cached 6h in earnings-calendar.json with a 7-day
lookahead. Feeds the earnings_calendar tool, the Pre-Market Brief
(today/tomorrow reporters vs positions and watchlist) and the Pre-Close
Review overnight-risk check. Replaces the Financial Datasets news/earnings
dependency (that API is now prepaid-credits only; a circuit breaker
short-circuits its calls for 1h after a 401/402 so briefs never burn
iterations on a dead provider).

**Per-symbol Nasdaq endpoints (FREE, wired 2026-08-06):** the same host
serves keyless per-symbol JSON that the earnings-bet machinery and the
company-snapshot skill rely on (probed working):

| Endpoint | Used for |
|---|---|
| `/api/company/{sym}/earnings-surprise` | ~4 verified report dates + EPS surprise % — seeds the post-print reaction record (`earnings_bet_intel`), extended to 8+ prints by gap inference over IBKR daily bars |
| `/api/quote/{sym}/short-interest` | short interest + days-to-cover trend (snapshot card) |
| `/api/company/{sym}/insider-trades` | open-market insider buys vs sells, 3/12 months (snapshot card) |
| `/api/quote/{sym}/summary` | sector, industry, market cap, average volume (snapshot card) |

## Prediction markets — Polymarket Gamma API (FREE, wired 2026-08-11)

Keyless. Two surfaces in `src/services/event-risk.ts`, per the 2026-08-05
research memo's verdict (episodic context for the judgment layer, never a
scoring factor):

- **Dated macro binaries** (CPI, FOMC, jobs, GDP, central banks) with the
  market-implied top outcome and an uncertainty grade from bracket
  dispersion. Feeds the `event_risk` tool (macro action), the Pre-Market
  Brief and Pre-Close Review prompts, the overnight skill's gap-risk step,
  and an advisory macro-night warning in the EOD triage report
  (`EOD_MACRO_WARNING=false` disables). Cached 2h in event-risk.json.
- **Per-symbol "beat quarterly earnings?" markets** — the deterministic
  external signal for the earnings-bet evidence bar, returned as
  `externalSignal` by `earnings_bet_intel` (reactions) and by the
  `event_risk` tool (earnings_market action). Coverage skews to liquid,
  newsy names; null = signal absent, not negative.

Parsing traps (verified live): `outcomePrices` is a JSON-encoded string
array; `public-search` fuzzy-matches (q=STUB returns the Finnish election
via candidate "Stubb") so the matcher requires the exact `(TICKER)` in the
title; `endDate` midnight-UTC IS the UTC release day — converting to ET
would shift it a day early.

## News pulse — GDELT DOC 2.0 API (FREE, wired 2026-08-11)

Keyless. `src/services/news-pulse.ts` sweeps ONE batched OR-query every
~20 min (07:00–16:00 ET weekdays, gateway only) over the open book, the
earnings-reactor watchlist and the engine's current candidates. Per
symbol: unique headlines, distinct domains, top headlines, and a **hot**
flag (both floors met — the story is broad, not one syndicated wire).
Feeds the `news_pulse` tool, the Pre-Market Brief, and a read-only
annotation on the opportunities snapshot. Deliberately NOT a scoring
input (research memo: GDELT stock-level sentiment needs an in-house IC
pass first — the live-scoring lane stays closed).

Access is defensive by construction: the API allows 1 request / 5 s and
punishes violations with a multi-minute penalty; the throttle answer is
plain text over a ~11 s tarpit (axios, not fetch — undici's 10 s connect
cap turns every throttle into an opaque network error under tsx). A
degraded sweep keeps the previous snapshot and backs off
(`NEWS_PULSE_BACKOFF_MIN`, default 30 min); it is never reported as "no
news". Articles lag ~15–35 min; attribution is company-name-in-title
(precision over recall). Smoke: `scripts/smoke-external-signals.ts`.

## 1. Live sources (wired)

### 1.1 Interactive Brokers (IBKR) — the market backbone

The single source for real-time market data and order execution.
Connection via IB Gateway or TWS (`@stoqey/ib`, TCP).

| Feed | Consumed by | Notes |
|---|---|---|
| Market scanners (gap, %gain/%lose, volume, trade rate) | Opportunity Engine | ~25 rows/scan, per-code 5-min cache; **requires a real-time US equity subscription** (delayed feed has no scanner fallback) |
| Historical bars | signal scorer, TA tool, data archive | paced ~300–500 ms between requests |
| Realtime 5-s bars | `ibkr-stream` (top-N candidates) | ring buffer + SQLite |
| Snapshot quotes | `ibkr_market_data` tool | delayed feed supported (`IBKR_MARKET_DATA_TYPE=3`) |
| Account: NetLiquidation, daily P&L | daily-loss guard, risk gate | fail-safe: unverifiable → no orders |
| Positions, balances, margin | `ibkr_account` tool, briefs | |
| Orders + fills (`orderStatus`, `execDetails`, `commissionReport`) | orders tool, bracket, **outcome tracker** | current-day executions replayable |

```bash
IBKR_HOST=127.0.0.1
IBKR_PORT=4002            # 4002 IB Gateway paper / 4001 live / 7497 TWS paper / 7496 TWS live
IBKR_CLIENT_ID=0
IBKR_MARKET_DATA_TYPE=    # 3 = delayed (~15 min) for paper accounts without subscriptions
IBKR_ALLOW_LIVE=false     # safety lock — leave false
```

Cost: free with an account; real-time feeds need market-data
subscriptions (the delayed feed is enough for paper development).

### 1.2 LLM providers — the judgment layer

| Provider | Env | Used for |
|---|---|---|
| Anthropic / OpenAI / Google / xAI / OpenRouter / Moonshot / DeepSeek | `*_API_KEY` | briefs, trigger evaluations, research |
| vLLM (local, OpenAI-compatible) | `VLLM_BASE_URL` | latency/cost-sensitive tasks; model picked via `vllm/<name>` |
| Ollama (local) | `OLLAMA_BASE_URL` | alternative local runtime; also memory embeddings fallback |

At least one provider is required. Memory embeddings reuse OpenAI →
Gemini → Ollama, in that priority.

### 1.3 Web search — catalyst verification

The judgment layer treats "a move without a catalyst" as suspect; both the
briefs and every trigger evaluation call `web_search`.

| Provider | Env | Priority |
|---|---|---|
| Exa | `EXASEARCH_API_KEY` | 1st |
| Perplexity | `PERPLEXITY_API_KEY` | 2nd |
| Tavily | `TAVILY_API_KEY` | 3rd |
| LangSearch | `LANGSEARCH_API_KEY` | 4th |

**At least one key is effectively required** for the trading briefs and
triggers to work as designed.

### 1.4 Financial Datasets API — present-state fundamentals (plan-limited)

`FINANCIAL_DATASETS_API_KEY`. Upstream Dexter's finance tools
(fundamentals, screening); the company-snapshot skill uses them as a
best-effort financial-health check. Not in the execution path — and as of
2026-08-06 the current plan 403s the probed endpoints (`/earnings`,
`/prices`), so treat the whole surface as optional: the snapshot card
says "fundamental snapshot unavailable" and carries on with the Nasdaq
and IBKR sources above.

### 1.5 X / Twitter — optional sentiment

`X_BEARER_TOKEN` enables the `x_search` tool (public chatter, breaking
news). Optional; no scoring factor consumes it yet (see §4.4).

### 1.6 WhatsApp — the human channel

Not market data, but a required I/O source: proposals, alerts and the
deterministic command router ride on a Baileys (QR-paired) session.
`bun run gateway:login` to pair; access control in the gateway config.

## 2. Data the system produces

The feedback loop makes the system a data *producer*; these grow daily and
are the substrate for calibration and ML:

| Dataset | File | Produced by | Value |
|---|---|---|---|
| Ranked opportunity snapshots | `opportunities.db` | engine, every cycle | What the scanners saw, when; the day's watched universe |
| **Labeled trade outcomes** | `proposals.db` | outcome tracker | Entry/exit fills, exit reason, realized P&L per trade — the ML training labels |
| Intraday bar archive | `market-archive.db` | archive scheduler (16:20 ET daily) + `scripts/backfill-bars.ts` (historical ranges, incl. `'1 day adj'` adjustment series) | 1-min/5-min bars for the watched universe — the ML training features |
| Realtime bars | `stream-bars.db` | ibkr-stream | 5-s bars for top candidates |
| Midcap universe | `universe.json` | universe sweep (opt-in, nightly) | ~5,600 US common stocks with EDGAR-derived market caps — pattern-scanner substrate |
| JSONL logs | `.dexter/logs/` | all services | Auditable trace of every decision and gate refusal |

Archive scheduler configuration:

```bash
DATA_ARCHIVE=true                 # default on (with IBKR configured)
DATA_ARCHIVE_SYMBOLS=SPY,QQQ      # always-archived watchlist
DATA_ARCHIVE_MAX_SYMBOLS=30       # per-day cap (IBKR pacing)
DATA_ARCHIVE_PATH=.dexter/data/market-archive.db
```

## 3. Historical archives on disk (backtesting)

Proprietary/bulk datasets already owned, used by the backtest engine and
calibration — not required at runtime. The bulk data lives under
**`e:\Data`**; the GDELT processing pipeline and its cleaned output live
under **`d:\Work\Trading\GDELT`**. (See §6 for the audited coverage and
the gap-filling strategy.)

### 3.1 FirstRate Data — multi-asset 1-minute bars (2010 → 2025-07-07)

Location: `e:\Data\FirstRate\` (`stock/`, `etf/`, `futures/`, `crypto/`,
`index/`, `fx/`, `options/`) — set `FIRSTRATE_DATA_DIR=e:/Data/FirstRate/stock`.
CSV-in-ZIP per letter (`stock-A.zip` …), **split/dividend-adjusted**
(`adj_splitdiv`), extended hours, ~16,000 US stocks. Consumed by
`src/backtest/data-loader.ts` and `scripts/calibrate-scorer.ts`.

Audited state (2026-07-04): the "full" bundles were downloaded on
**2025-07-08** and their last bar is **2025-07-07** — a 12-month gap to
the present. The download token in `retrieve-data.sh` was tested and the
API answers **"no active subscription"**: refreshing FirstRate means
paying again (update subscription $79.95/mo, or a bundle re-purchase).
Decision: **do not renew** — see §6 for the cheaper substitutes.

### 3.2 GDELT — global news events & sentiment (2015 → 2025-09/10)

Two layers:
- **Raw v2 mirror** — `e:\Data\GDELT_raw`: 1.1M 15-min zips (export +
  mentions + GKG), complete 2015-02-18 → **2025-10-14 07:30 UTC**.
- **Cleaned monthly parquet** — `d:\Work\Trading\GDELT\gdelt_cleaned\parts_monthly`
  (set `GDELT_DATA_DIR` to this path): top-100 events/day with fetched
  headlines, through **2025-09**. This is what
  `src/backtest/sentiment-loader.ts` reads.

The update pipeline (`d:\Work\Trading\GDELT\download-news.py`) needs **no
API key** — GDELT is free over plain HTTP. Update procedure in the
[user manual §15.3](USER-MANUAL.md#153-updating-the-gdelt-archive).

**Blocker for full use in scoring:** entity→ticker mapping (GDELT names
companies, not tickers) — the planned SEC EDGAR mapper
(`src/ml/entity-mapper.ts`).

### 3.3 FX archives (2007–2026)

`e:\Data\ActiveTradeFX`, `e:\Data\DukasCopy`, `e:\Data\FX-MetaTrader5`,
`e:\Data\ForexAggregated`: 35 pairs, minute-level. On disk for future FX
strategies; nothing consumes them yet.

## 4. Planned sources (not yet integrated)

Ordered by expected signal-per-effort. None exist in code yet
(`src/tools/macro/`, `src/tools/sentiment/` are not created).

### 4.1 Economic calendar — FRED, ECB, EIA *(highest priority)*

Rate decisions, CPI prints, oil inventories: the strongest scheduled
catalysts for intraday trading. All free REST APIs. Target:
`src/tools/macro/economic-calendar.ts`, feeding the Pre-Market Brief with
today's releases and recent surprises.

### 4.2 Options flow & implied volatility — IBKR + CBOE

IV rank, put/call extremes, unusual OTM activity — among the strongest
short-horizon predictive signals; the IBKR connection already carries
options chains, and the FirstRate options archive enables backtesting.
Target: `src/tools/ibkr/options-flow.ts`.

### 4.3 Prediction markets — Polymarket, Kalshi

**Polymarket: DONE 2026-08-11** — landed as `src/services/event-risk.ts`
+ the `event_risk` tool (see the wired section above), not the originally
planned `src/tools/macro/prediction-markets.ts` path. Kalshi remains
unintegrated (Polymarket covers the macro calendar; add Kalshi only if a
needed market is missing).

### 4.4 Social sentiment — Reddit, StockTwits, X

Retail sentiment/momentum complementing GDELT's mainstream coverage. The
X bearer token already exists; Reddit and StockTwits are free. Target:
`src/tools/sentiment/social.ts` (composite retail score).

### 4.5 Geopolitical & supply chain — ACLED, IMF PortWatch, NASA FIRMS, GIE AGSI+

Commodity/FX context for the overnight skill. Free (ACLED: academic
tier). Target: `src/tools/macro/geopolitical-signals.ts`.

## 5. Signal overlap matrix

What covers what — the planned sources are orthogonal, not duplicative:

| Signal type | GDELT | FirstRate | IBKR | Produced in-house | Planned |
|---|---|---|---|---|---|
| Price OHLCV | — | ✅ historical | ✅ live | ✅ archive (daily) | — |
| News text / headlines | ✅ | — | ✅ basic | — | — |
| News sentiment scores | ✅ GKG 6-dim | — | — | — | social (Reddit/X/StockTwits) |
| Trade outcomes (labels) | — | — | ✅ fills | ✅ **outcome tracker** | — |
| Macro releases | — | — | — | — | FRED, ECB, EIA |
| Options / volatility | — | ✅ hist. chains | ✅ live chains | — | CBOE VIX/skew |
| Order flow / L2 | — | — | ✅ live | — | order-flow tool |
| Prediction markets | — | — | — | ✅ **event_risk** (Polymarket) | Kalshi |
| Geopolitical events | ✅ CAMEO | — | — | — | ACLED, PortWatch, FIRMS |

## 6. Local archive audit and gap-filling strategy

Audited 2026-07-04 (all coverage claims verified against the files on disk;
the FirstRate token tested against their API).

### 6.1 State of the archives

| Dataset | Location | Last data | Gap |
|---|---|---|---|
| FirstRate 1-min stocks/ETFs/… | `e:\Data\FirstRate` | **2025-07-07** | 12 months |
| GDELT raw v2 mirror | `e:\Data\GDELT_raw` | **2025-10-14** | ~9 months |
| GDELT cleaned parquet | `d:\Work\Trading\GDELT\gdelt_cleaned\parts_monthly` | **2025-09** | ~9 months |
| FX archives | `e:\Data\*` | 2026 | current enough, unused |

### 6.2 Stock bars — cheapest way to fill the gap

The need splits in two, and the cheapest answer differs:

| Option | Cost | Covers | Weakness |
|---|---|---|---|
| **IBKR API backfill** (`scripts/backfill-bars.ts`) | ~$0 | the traded/calibration universe, 1-min, years back | pacing-slow; no delisted names |
| Alpaca free tier | $0 | full market, 7+ yrs SIP minute bars (queries must end >15 min in the past) | rate limits, format conversion |
| Polygon.io ("Massive") Starter, 1 month | $29 | full market **incl. delisted**, ~5 yrs minute aggregates, unlimited REST | another vendor, one-time effort |
| FirstRate renewal | $79.95/mo or bundle re-buy | everything, same format | most expensive |

**Decision:**
- **Traded universe (calibration, backtests): IBKR backfill — free.**
  IBKR serves 1-min bars years back (the 6-month cap only applies to
  sub-30-second bars); pacing is ~60 historical requests/10 min, so a
  symbol-year of 1-min bars takes ~10 minutes. `scripts/backfill-bars.ts`
  writes straight into `market-archive.db` (chunked, paced, resumable) and
  the archive scheduler keeps it current daily from now on — the gap never
  regrows. Usage: [user manual §15.2](USER-MANUAL.md#152-backfilling-history-from-ibkr).
- **Adjustment caveat:** ranged IBKR requests serve as-traded TRADES prices
  (ADJUSTED_LAST is only available "ending now"), so the backfill also
  stores a daily ADJUSTED_LAST series per symbol (`'1 day adj'`) from which
  per-day split/dividend factors are derivable.
- **Full-market breadth (ML phase, survivorship-free):** buy **one month
  of Polygon Starter ($29)**, bulk-download the window, cancel. Alpaca's
  free tier is the $0 fallback. Defer until the ML phase actually starts.
- **FirstRate: do not renew.** The dead token means full re-purchase
  economics, and the two options above cover both needs for ≤$29.

### 6.3 GDELT — free, requires running the pipeline

No key, no cost — only compute, bandwidth and headline-rot. Missing
~9 months ≈ 1.9 GB (export-only; the cleaned pipeline does not need
mentions/GKG — mirroring those too is ~110 GB). Procedure and caveats:
[user manual §15.3](USER-MANUAL.md#153-updating-the-gdelt-archive).
Schedule it **monthly** — headlines are scraped from live article URLs,
and months-old links increasingly need the (slow, lossy) Wayback fallback.

### 6.4 Remaining obligations

| Item | State | Action |
|---|---|---|
| Stock 1-min gap (2025-07-08 →) | script ready | run `scripts/backfill-bars.ts` for the calibration universe (needs IB Gateway up) |
| GDELT gap (2025-10 →) | pipeline fixed & tested | run the §15.3 procedure; then monthly |
| SEC EDGAR entity→ticker mapper | not built | prerequisite for GDELT sentiment in scoring/backtests |
| Web-search key | required at runtime | set at least one of the four |
| Live scorer sentiment/fundamental factors | not in live path | scorer is 4-factor technical today; sentiment exists only in backtests |
| All §4 planned sources | not built | in priority order: calendar → options flow → prediction markets → social → geopolitical |

Pricing sources (checked 2026-07): [FirstRate bundles](https://firstratedata.com/bundle/all),
[Polygon pricing](https://polygon.io/pricing),
[Alpaca market-data FAQ](https://docs.alpaca.markets/us/docs/market-data-faq),
[IBKR historical-data limitations](https://interactivebrokers.github.io/tws-api/historical_limitations.html).
