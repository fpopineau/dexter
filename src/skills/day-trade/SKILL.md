---
name: day-trade-scan
description: >
  Intraday trading opportunity scanner. Triggers when user asks for day trade
  setups, scalp ideas, momentum plays, intraday opportunities, "what should I
  trade today", breakout candidates, mean-reversion setups, or any real-time
  short-term trade recommendation during market hours.
---

# Day Trade Scan Skill

## Workflow Checklist

Copy and track progress:
```
Day Trade Scan Progress:
- [ ] Step 1: Check market session & conditions
- [ ] Step 2: Identify candidate universe
- [ ] Step 3: Run technical analysis on candidates
- [ ] Step 4: Score signals
- [ ] Step 5: Validate against risk rules
- [ ] Step 6: Generate trade plans
- [ ] Step 7: Register actionable setups as proposals
```

## Step 1: Check Market Session & Conditions

Determine the current session and adapt strategy:

- **Pre-market (04:00–09:30 ET):** Focus on gap analysis, pre-market movers, and planning. Do NOT recommend entries until open unless explicitly asked for pre-market trades.
- **Regular hours (09:30–16:00 ET):** Full scanning mode. Prioritize momentum in the first 30 min, mean-reversion mid-day, and trend trades in the afternoon.
- **After-hours (16:00–20:00 ET):** Earnings reactions only. Flag but do not recommend new entries unless the user specifically asks.
- **Closed / Holiday:** Report that the market is closed. Offer to prepare a watchlist for the next session instead.

Check broad market context with `get_market_data`:
- **Query:** `"SPY QQQ IWM current prices"` — assess market direction and breadth.
- If SPY is down > 1%, shift bias toward short setups or defensive names.
- If VIX is elevated (> 25), widen stops and reduce position sizes in recommendations.

## Step 2: Identify Candidate Universe

Build a candidate list from multiple sources (use tools in parallel where possible):

### 2.1 Opportunity Engine (preferred)
Call `opportunities` (action `latest`; if missing or older than 10 minutes,
action `refresh`) — this is the ranked, pre-scored scanner universe. When it
returns candidates, use its top entries as the primary candidate list and
skip 2.2.

### 2.2 Scanners & Screening (fallback)
- Call `ibkr_scanner` (e.g. `TOP_PERC_GAIN`, `MOST_ACTIVE`, `HOT_BY_VOLUME`).
  Note: IBKR scanners return empty without a real-time market-data
  subscription — if empty, fall back to direct TA on liquid large caps
  (SPY/QQQ leaders, recent movers from context).
- Call `stock_screener` if available (requires FINANCIAL_DATASETS_API_KEY):
  `"stocks with market cap above 1 billion, volume above 2 million, and price above 10"`.
- Prefer liquid names (avg volume > 1M) with tight spreads.

### 2.3 News & Catalyst Scan
Call `web_search` (or `get_market_data` if available) for market news and
sector themes; verify any candidate's move has a catalyst.

### 2.4 Watchlist
If the user has a watchlist in memory, call `memory_search`:
- **Query:** `"watchlist"` or `"tickers to watch"`
- Include any tickers the user mentioned in the conversation.

Combine all sources into a candidate list of 5–10 tickers.

## Step 3: Run Technical Analysis on Candidates

For each candidate ticker, call `technical_analysis`:
- **Ticker:** The candidate symbol
- **Bar size:** `"5 mins"` for intraday setups (use `"15 mins"` if user prefers swing-style day trades)
- **Use RTH:** `true` (regular trading hours only for cleaner signals)

**Key indicators to evaluate:**
| Indicator | Bullish Signal | Bearish Signal |
|-----------|---------------|----------------|
| RSI (14) | 30–50 rising (oversold bounce) | 70+ declining (overbought fade) |
| MACD | Histogram turning positive, signal cross up | Histogram turning negative, signal cross down |
| VWAP | Price reclaiming VWAP from below | Price rejecting VWAP from above |
| Bollinger %B | < 0.2 with reversal candle | > 0.8 with rejection candle |
| EMA 9/21 | 9 EMA crossing above 21 EMA | 9 EMA crossing below 21 EMA |
| Volume | RVOL > 1.5 confirming direction | Low volume divergence from price |

## Step 4: Score Signals

Call `signal_scorer` for each candidate that shows promising technicals:
- **Ticker:** The candidate
- **Direction:** `"long"` or `"short"` based on Step 3 assessment

The signal scorer combines:
- **Momentum** — MACD slope, RSI trend, price vs EMAs
- **Mean reversion** — distance from VWAP/Bollinger midline, RSI extremes
- **Volume confirmation** — RVOL, volume trend alignment
- **Sentiment** — recent news tone

**Threshold:** Only proceed with candidates scoring **≥ 60/100**.

## Step 5: Validate Against Risk Rules

**Entry discipline — the two patterns that produced every early live loss:**

- **Don't chase extension.** If price is already far above its 10-day EMA
  (the gate refuses beyond 3× daily ATR), the move is statistically due to
  mean-revert — scanners surface these names precisely BECAUSE they are
  extended. Longs on extended movers need a pullback/consolidation entry,
  not a top-tick fill. A big-% gainer late in its run is a candidate for
  no-trade (or a short setup), not a momentum long.
- **Respect the opening range.** Entries in the first ~15 minutes
  (09:30–09:45 ET) buy directly into the gap-fade zone — 4 of the first 7
  live losses filled there and reversed immediately. Prefer waiting for
  the opening range to form and entering on its break or on the first
  pullback that holds.

**Set the levels from structure, in this order — never backwards from the
R/R requirement:**

1. **Stop first, at real structure**: the low of day, the pullback low, the
   breakout base, or VWAP — the price where the setup is objectively wrong.
   It must be at least **0.4× the daily ATR** away from entry (the proposal
   gate enforces this): a tighter stop sits inside ordinary intraday noise
   and fills on randomness even when the idea is right. Sanity band:
   0.4–1.5× daily ATR.
2. **Target at a real objective**: prior high/low, measured move, gap fill.
   If the honest objective is closer than 2× the stop distance, there is no
   trade — do NOT stretch the target or tighten the stop to manufacture 2:1.
3. **Size from the risk budget**: `shares = floor(0.25% of NetLiq / (entry − stop))`.
   Every trade then loses the same amount when wrong. Never size up to the
   5% position-value cap on a tight stop — that cap is a ceiling, not a
   sizing method.

Call `risk_manager` for each trade candidate:
- **Ticker:** The candidate
- **Direction:** long/short
- **Entry price:** Current price from TA data
- **Stop price:** From structure as above (typically entry ± 1–1.5× ATR)
- **Target price:** The real objective (must give ≥ 2:1 vs the stop)

The risk manager validates:
- Position size doesn't exceed max allocation
- Daily loss limit not breached
- Sector exposure within limits
- Risk/reward ratio meets minimum threshold
- Stop loss is present and reasonable

**If risk check fails:** Report the specific violation and suggest adjustments (smaller size, wider stop, etc.).

## Step 6: Generate Trade Plans

For each validated setup, output a structured trade plan:

```
## [TICKER] — [LONG/SHORT] Setup

**Signal Score:** [X/100] | **Strategy:** [Momentum/Mean-Reversion/Breakout]
**Confidence:** [High/Medium/Low]

**Entry:** $[price] (limit order at [level])
**Stop Loss:** $[price] ([X]% risk, [Y]× ATR below/above entry)
**Target 1:** $[price] (1:1 R/R)
**Target 2:** $[price] (2:1 R/R)
**Position Size:** [X] shares (~$[Y], [Z]% of account)
**Timeframe:** [Minutes/Hours]

**Technical Setup:**
- RSI: [value] — [interpretation]
- MACD: [histogram value] — [interpretation]
- VWAP: [relation to price] — [interpretation]
- Volume: [RVOL] — [interpretation]

**Catalyst:** [News/technical trigger]

**Risk Notes:** [Any caveats — earnings nearby, low float, wide spread, etc.]
```

**Rank** all recommendations by signal score, highest first.

## Step 7: Register Proposals

For each **actionable** setup (score ≥ 60 AND risk-validated), register it
with `trade_proposals` (action `create`, at most 3 per scan):
- **Pick the entry type by strategy**: momentum continuation on a fast
  mover → `STP_LMT` (entry = trigger slightly ABOVE current price,
  entryLimit = trigger +0.3–0.6% — enters WITH strength; a below-market
  limit on a runner never fills). Mean-reversion / pullback-to-support →
  `LMT` at the support level. `MKT` only when immediacy beats price.
- `entry` is REQUIRED even for MKT proposals (pass the current price — it
  anchors the deterministic risk validation).
- OMIT `quantity` — the deterministic position sizer computes it from the account, the score, and the stop distance (risk_manager's suggestion uses a placeholder account value and must never size a real proposal), `expiresMinutes` 90,
  `rationale` one line (setup + catalyst + risk note), include the signal
  `score`.
- Creation NEVER trades. Include each returned proposal ID in your answer
  with: "Reply 'accept <ID>' to execute (paper), or 'reject <ID>'."
- If the create is refused with `[risk-gate] REFUSED …`, the numbers violate
  the risk rules — fix the entry/stop/target/size and retry once; never
  loosen the rules to force a trade.
- During pre-market, register proposals only if the user explicitly wants
  pre-market entries; otherwise present the plans and offer to register at
  the open.

**Important reminders:**
- Never recommend more trades than the risk rules allow simultaneously.
- Always include a stop loss — no exceptions.
- Flag if a stock has earnings within 2 days (overnight risk).
- If no setups meet the quality threshold, say so explicitly — no trade is better than a forced trade.
