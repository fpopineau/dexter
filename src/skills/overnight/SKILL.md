---
name: overnight-review
description: >
  End-of-day position review and overnight planning. Triggers when user asks
  to review positions before close, overnight risk assessment, "should I hold
  overnight", end-of-day review, swing hold evaluation, after-hours planning,
  or any request about managing positions through the overnight session.
---

# Overnight Position Review Skill

## Workflow Checklist

Copy and track progress:
```
Overnight Review Progress:
- [ ] Step 1: Assess current positions & P&L
- [ ] Step 2: Evaluate overnight catalysts & risk
- [ ] Step 3: Review each position hold/trim/close
- [ ] Step 4: Identify swing setups for tomorrow
- [ ] Step 5: Output overnight action plan
```

## Step 1: Assess Current Positions & P&L

### 1.1 Position Inventory
Call `memory_search`:
- **Query:** `"open positions"` or `"current trades"` — retrieve any tracked positions.
- If the user mentions specific positions, use those directly.

For each open position, call `ibkr_market_data`:
- Get current price, day's high/low, volume.
- Calculate unrealized P&L vs entry price.

### 1.2 Daily Performance Summary
Call `get_market_data`:
- **Query:** `"SPY QQQ IWM today performance"` — broad market context for the day.
- Note: Was today a trending or choppy day? Did the market close near highs or lows?

Summarize:
- Total unrealized P&L across all positions
- Number of winning vs losing positions
- Largest winner and largest loser

## Step 2: Evaluate Overnight Catalysts & Risk

### 2.1 After-Hours Earnings
Call `web_search`:
- **Query:** `"earnings reports after market close today [DATE]"` — any held positions reporting?
- **Critical:** If ANY open position has earnings tonight, flag prominently — this is the #1 overnight risk factor.

### 2.2 Macro Events
Call `web_search`:
- **Query:** `"economic calendar tomorrow [DATE]"` — Fed meeting, jobs report, CPI, etc.
- **Query:** `"FOMC Fed speakers tomorrow"` — any policy-sensitive events.
- Flag any high-impact event that could gap the market overnight.

### 2.3 Sector-Specific Risks
For each held sector, call `get_market_data`:
- **Query:** `"[sector] news after hours"` — any sector-moving developments.
- Check for: regulatory announcements, geopolitical developments, commodity moves.

### 2.4 Technical Overnight Risk
For each position, call `technical_analysis`:
- **Bar size:** `"1 day"` — daily chart context.
- Evaluate:
  - Is the stock extended from its 21 EMA? (mean-reversion risk overnight)
  - Is it sitting at a major resistance/support level?
  - Is RSI > 70 or < 30? (reversal risk)
  - Is it near a Bollinger Band extreme?

## Step 3: Review Each Position — Hold / Trim / Close

For each open position, make a recommendation:

### Hold Criteria (all should be true):
- No earnings tonight for this stock
- Trend intact (price above entry's reference EMA)
- No major macro catalyst that could gap against the position
- Position size within overnight exposure limit
- Unrealized profit has room to target, or loss is within acceptable range

### Trim Criteria (reduce but don't close):
- Extended move — lock in partial profits (sell 50% at 2:1 R/R achieved)
- Position oversized for overnight (exceeds max overnight exposure per position)
- Approaching a known resistance level (for longs) or support (for shorts)
- Elevated VIX suggesting increased overnight gap risk

### Close Criteria (any one is sufficient):
- Earnings tonight for this stock
- Stop loss hit or nearly hit
- Thesis invalidated (broke below key support for long, above key resistance for short)
- Daily loss limit approaching — reduce exposure defensively
- Major macro event overnight that could dominate price action

Call `risk_manager` to validate overnight exposure:
- Confirm total overnight exposure stays within `max_overnight_exposure_pct` limit.
- If exceeded, recommend which positions to trim to bring within limits.

## Step 4: Identify Swing Setups for Tomorrow

Look for potential setups to enter at tomorrow's open or on pullbacks.

### 4.1 Daily Chart Setups
Call `technical_analysis` with `barSize: "1 day"` on watchlist tickers:
- **Pullback-to-EMA:** Price pulling back to 21 EMA in an uptrend (50 EMA rising).
- **Breakout setup:** Price consolidating near resistance with increasing volume.
- **Oversold bounce:** RSI < 35 with hammer/doji candle on support.

### 4.2 After-Hours Movers
Call `web_search`:
- **Query:** `"after hours movers today [DATE]"` — identify earnings-driven gaps to trade at tomorrow's open.
- For any big gap, evaluate: gap-and-go vs gap-fill setup based on daily context.

### 4.3 Score Any New Candidates
Call `signal_scorer` for promising setups:
- Include the assessment of whether to wait for a pullback or enter at open.
- These are prep-only candidates: nothing is proposed here. Any that
  graduate to a swing proposal (pre-market flow) must first pass the
  `company-snapshot` skill — its RED FLAGS line decides.

## Step 5: Output Overnight Action Plan

```
# Overnight Review — [DATE] [TIME] ET

## Day Summary
**Market:** SPY [+/-X%] | QQQ [+/-X%] | VIX [level]
**Day type:** [Trending up / Trending down / Range-bound / Choppy]
**Account P&L today:** [+/- $X]

## Position Actions

### [TICKER] — [LONG/SHORT] @ $[entry]
**Current:** $[price] | **P&L:** [+/- $X] ([+/- Y%])
**Action:** HOLD / TRIM to [X shares] / CLOSE
**Reason:** [1-2 sentences]
**Tomorrow's stop:** $[adjusted stop if holding]
**Tomorrow's target:** $[next target level]

[Repeat for each position]

## Overnight Risk Factors
- [Earnings: TICKER1, TICKER2 reporting after close]
- [Macro: Event at TIME tomorrow]
- [Technical: SPY testing 200 EMA support]

## Tomorrow's Watchlist
| Ticker | Setup Type | Entry Zone | Stop | Target | Notes |
|--------|-----------|------------|------|--------|-------|
| [TICK] | [type]    | $[range]   | $[s] | $[t]   | [note]|

## Key Levels for Tomorrow
- **SPY:** Support $[X], Resistance $[Y]
- **QQQ:** Support $[X], Resistance $[Y]
```

**Important reminders:**
- This skill is most valuable 30–60 minutes before market close (15:00–15:30 ET).
- If running after hours, some data (TA on intraday bars) may reflect the regular session close, not after-hours moves.
- Overnight holding is inherently riskier due to gap risk — bias toward reducing exposure unless the setup is compelling.
- Never hold a position through an earnings print as part of an overnight keep. Holding through a print is a separate, explicitly-labeled earnings-bet decision with its own sizing rules — close the position or propose that bet explicitly. A keep must never quietly become an earnings bet.
