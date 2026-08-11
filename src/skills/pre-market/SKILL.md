---
name: pre-market-brief
description: >
  Morning market briefing and trade preparation. Triggers when user asks for a
  pre-market brief, morning summary, "what happened overnight", market open
  preview, gap analysis, today's trading plan, or any request for morning
  market context before the US open.
---

# Pre-Market Brief Skill

## Workflow Checklist

Copy and track progress:
```
Pre-Market Brief Progress:
- [ ] Step 1: Overnight market recap
- [ ] Step 2: Today's calendar — earnings & economic data
- [ ] Step 3: Pre-market movers & gap analysis
- [ ] Step 4: Watchlist key levels
- [ ] Step 5: Compile morning brief
```

## Step 1: Overnight Market Recap

Gather context on what moved markets since the prior US close.

### 1.1 Broad Market Snapshot
Call `get_market_data`:
- **Query:** `"SPY QQQ IWM DIA current prices and percent change"` — US index futures / pre-market.

Call `ibkr_market_data` for futures context (if available):
- ES (S&P 500 futures), NQ (Nasdaq futures), YM (Dow futures), RTY (Russell 2000 futures)
- Note direction and magnitude — is the market gapping up or down?

### 1.2 Global Markets
Call `web_search` or `get_market_data`:
- **Query:** `"Asia Europe stock market performance today"` — Nikkei, Hang Seng, STOXX 600, DAX, FTSE.
- **Query:** `"US treasury yields today"` — 2Y and 10Y yields, yield curve direction.
- **Query:** `"crude oil gold dollar index today"` — commodity and currency context.

### 1.3 Overnight News
Call `event_risk` (action `macro`, withinDays 1): any CPI/FOMC/jobs binary
resolving today or tomorrow, with the market-implied consensus and its
uncertainty grade — a high-uncertainty print today reshapes the whole plan.
Call `news_pulse` (no args): which book/reactor/watchlist names carry a
broad news cycle right now (hot = many unique headlines across outlets).
Then call `get_market_data`:
- **Query:** `"market news today"` — top headlines, macro developments.
- Look for: Fed commentary, geopolitical events, sector-specific catalysts.

Summarize in 3–5 bullet points: what happened overnight, why it matters.

## Step 2: Today's Calendar — Earnings & Economic Data

### 2.1 Economic Calendar
Call `web_search`:
- **Query:** `"economic calendar today [DATE]"` — Fed speeches, jobs data, CPI, PMI, etc.
- Flag high-impact events (marked as "high" importance).
- Note exact release times — they create volatility windows.

### 2.2 Earnings Calendar
Call `web_search`:
- **Query:** `"earnings reports today [DATE] before market open"` — pre-market reporters.
- **Query:** `"earnings reports today [DATE] after market close"` — after-hours reporters.
- For any names on the user's watchlist reporting today, flag prominently.

## Step 3: Pre-Market Movers & Gap Analysis

### 3.1 Identify Big Movers
Call `web_search`:
- **Query:** `"pre-market movers today top gainers losers"` — stocks gapping significantly.
- Focus on gaps > 3% with volume confirmation.

### 3.2 Analyze Gaps
For the top 3–5 pre-market movers, call `technical_analysis`:
- **Bar size:** `"1 day"` — check daily chart context for support/resistance near gap levels.
- Determine: Is this a gap into resistance (fade candidate) or a breakaway gap (continuation)?
- Check if the gap fills a prior gap or breaks a key moving average.

### 3.3 Catalyst Identification
For each significant mover, call `get_market_data`:
- **Query:** `"[TICKER] news today"` — find the catalyst.
- Categorize: earnings, upgrade/downgrade, FDA approval, M&A, sector rotation, technical breakout.

## Step 4: Watchlist Key Levels

If the user has a watchlist in memory, call `memory_search`:
- **Query:** `"watchlist"` or `"tickers to watch"`

For each watchlist ticker, call `technical_analysis`:
- **Bar size:** `"1 day"` — identify daily support/resistance, trend direction.
- Note: key EMA levels (9, 21, 50, 200), recent Bollinger Band position, RSI zone.

For each ticker, identify:
- **Key support:** Nearest level where buyers may step in.
- **Key resistance:** Nearest level where sellers may appear.
- **Trend bias:** Above/below 21 EMA → short-term trend. Above/below 200 EMA → long-term trend.
- **Setup potential:** Is a breakout, pullback-to-support, or mean-reversion setup forming?

## Step 5: Compile Morning Brief

Output a structured brief in this format:

```
# Pre-Market Brief — [DATE]

## Overnight Recap
[3–5 bullet points: global markets, key overnight developments]

## Market Snapshot
| Index | Pre-Market | Change | Trend |
|-------|-----------|--------|-------|
| SPY   | $[price]  | [%]    | [↑/↓] |
| QQQ   | $[price]  | [%]    | [↑/↓] |
| IWM   | $[price]  | [%]    | [↑/↓] |

**VIX:** [level] | **10Y Yield:** [level] | **DXY:** [level]

## Today's Calendar
**Economic:** [events with times]
**Earnings (BMO):** [tickers]
**Earnings (AMC):** [tickers]

## Pre-Market Movers
| Ticker | Gap % | Catalyst | Daily Trend | Watch Level |
|--------|-------|----------|-------------|-------------|
| [TICK] | [%]   | [reason] | [trend]     | $[level]    |

## Watchlist Levels
| Ticker | Price  | Support | Resistance | RSI  | Trend  | Setup       |
|--------|--------|---------|------------|------|--------|-------------|
| [TICK] | $[px]  | $[s]    | $[r]       | [v]  | [dir]  | [type/none] |

## Today's Game Plan
[2–3 sentences: overall market bias, strategy focus (momentum/mean-reversion/range-bound), key levels to watch on SPY, sectors to focus on]

**Avoid:** [Any warnings — earnings risk, low liquidity names, choppy conditions]
```

**Important reminders:**
- This is a preparation skill — do NOT generate specific entry/stop/target trade plans. Use the `day-trade-scan` skill for that.
- If running before 4:00 AM ET, note that pre-market data is limited. Focus on overnight futures and global markets.
- Always note the time the brief was generated — pre-market data changes rapidly.
