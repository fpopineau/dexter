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
- [ ] Step 4: Register tonight's proposals (overnight setups, earnings-bet window)
- [ ] Step 5: Identify swing setups for tomorrow
- [ ] Step 6: Output overnight action plan
```

## Step 1: Assess Current Positions & P&L

### 1.1 Position Inventory
Call `ibkr_account` (action positions) — the broker is the ONLY authority on
what is held. Then call `ibkr_orders` (action list) for live open orders:
a position's protection is judged from working exit orders at the broker,
NEVER from the proposals store or memory (auto-protect GTC exits are not
persisted in proposals; memory is historical context, not the book).

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
Call `event_risk` (action `macro`, withinDays 1) FIRST — the deterministic
calendar of dated macro binaries (CPI, FOMC, jobs, GDP) with the market's
implied top outcome and an uncertainty grade. A **high-uncertainty** print
resolving tomorrow is the #2 overnight risk factor after earnings: name it
in every keep/proposal rationale, and prefer flat on marginal setups.
Then call `web_search` only for what the calendar cannot know:
- **Query:** `"FOMC Fed speakers tomorrow"` — unscheduled policy-sensitive events.
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

Overnight caps are enforced DETERMINISTICALLY, not by you:
- Any GTC proposal you register is refused at acceptance if it exceeds
  `max_overnight_position_pct` per position or would push the surviving
  book past `max_overnight_exposure_pct` — do not pre-negotiate with the
  gate; propose honestly and read the refusal if one comes.
- The 15:52 EOD triage report states the overnight book's cap usage for
  positions that convert at the bell. If it flags an overshoot, recommend
  which positions to trim and why — that judgment is yours.
- `risk_manager` remains advisory context (per-position overnight check
  only); never report a cap as "validated" on its say-so.

## Step 4: Register Tonight's Proposals

The pre-close review PROPOSES — this skill's output is trade proposals
when candidates qualify, not only an action plan. Two lanes, both inside
the 15:00–16:00 window:

### 4.1 Overnight Setups (at most 2)
From the opportunities snapshot and the watchlist: candidates whose move
has a stated reason to survive the night (catalyst, pattern
continuation). Prefer lower-ATR names; check `earnings_calendar`
(withinDays 2) and `event_risk` (macro binaries) first. Register with
`trade_proposals`: `tif` "GTC" so the bracket survives the close,
quantity OMITTED, `expiresMinutes` 45. The acceptance gate enforces the
overnight caps — propose honest levels and let it answer.

### 4.2 The Earnings-Bet Window (at most 1)
15:00–15:55 is the ONLY entry window for an earnings bet. Where a
reporter passes the evidence bar (`earnings_bet_intel` reactions: ≥8
prints, ≥75% consistency, plus one external signal — `externalSignal`
counts), register ONE labeled proposal: `tradeClass` "earnings-bet",
`worstCaseGapPct` from the reactions record, quantity OMITTED,
`expiresMinutes` short enough to die by 15:55. "No reporter qualifies"
is the normal outcome most days — say it plainly.

## Step 5: Identify Swing Setups for Tomorrow

Look for potential setups to enter at tomorrow's open or on pullbacks.

### 5.1 Daily Chart Setups
Call `technical_analysis` with `barSize: "1 day"` on watchlist tickers:
- **Pullback-to-EMA:** Price pulling back to 21 EMA in an uptrend (50 EMA rising).
- **Breakout setup:** Price consolidating near resistance with increasing volume.
- **Oversold bounce:** RSI < 35 with hammer/doji candle on support.

### 5.2 After-Hours Movers
Call `web_search`:
- **Query:** `"after hours movers today [DATE]"` — identify earnings-driven gaps to trade at tomorrow's open.
- For any big gap, evaluate: gap-and-go vs gap-fill setup based on daily context.

### 5.3 Score Any New Candidates
Call `signal_scorer` for promising setups:
- Include the assessment of whether to wait for a pullback or enter at open.
- TOMORROW's candidates are prep-only in THIS step (tonight's proposals
  belong to Step 4). Any that graduate to a swing proposal in the
  pre-market flow must first pass the `company-snapshot` skill — its RED
  FLAGS line decides.

## Step 6: Output Overnight Action Plan

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
- Overnight gap risk is real, but the deterministic 15:52 EOD triage
  keeps winners and stabilizing losers BY DEFAULT (operator policy) — do
  not blanket-recommend flattening what the machine will keep 22 minutes
  later. Your judgment adds the exits the triage won't take: name the
  specific positions to close and why (thesis dead, macro binary night,
  cap overshoot), and let the rest ride protected.
- Never hold a position through an earnings print as part of an overnight keep. Holding through a print is a separate, explicitly-labeled earnings-bet decision with its own sizing rules — close the position or propose that bet explicitly. A keep must never quietly become an earnings bet.
