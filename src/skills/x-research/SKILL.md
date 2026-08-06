---
name: x-research
description: >
  X/Twitter real-time positioning and catalyst intel. Searches X for breaking
  news, crowd positioning, sentiment shifts, and catalyst chatter on a ticker,
  sector, or market event. Use when: user asks "what are people saying about",
  "X/Twitter sentiment", "check X for", "what's CT saying about", or when a
  trade evaluation needs to know who is on which side of a name and why.
---

# X Research Skill

Agentic intel-gathering over X/Twitter using the `x_search` tool. Decompose
the question into targeted searches, iterate to refine signal, and synthesize
into a positioning read that feeds a trade decision.

## Research Loop

### 1. Decompose into Queries

Turn the research question into 3–5 targeted queries using X operators:

- **Core query**: Direct keywords or `$TICKER` cashtag
- **Expert voices**: `from:username` for known analysts or accounts
- **Bearish signal**: keywords like `(bearish OR short OR fade OR dilution OR offering OR miss)`
- **Bullish signal**: keywords like `(bullish OR breakout OR squeeze OR catalyst OR beat)`
- **News/links**: add `has:links` to surface tweets with sources
- **Noise reduction**: `-is:reply` to focus on original posts; `-airdrop -giveaway` for crypto topics

### 2. Execute Searches

Use the `x_search` tool with `command: "search"`. For each query:

- Start with `sort: "likes"` and `limit: 15` to surface highest-signal tweets
- Add `min_likes: 5` or higher to filter noise for broad topics
- Use `since: "1d"` or `"7d"` depending on how time-sensitive the topic is
- If a query returns too much noise, narrow with more operators or raise `min_likes`
- If too few results, broaden with `OR` terms or remove restrictive operators

### 3. Check Key Accounts (Optional)

For well-known analysts, fund managers, or company executives, use
`command: "profile"` to see their recent posts directly.

### 4. Follow Threads (Optional)

When a high-engagement tweet appears to be a thread starter, use
`command: "thread"` with the tweet ID to get full context.

### 5. Synthesize

Group findings by theme (bullish, bearish, neutral, news/catalysts):

```
### [Theme]

[1–2 sentence summary of the theme]

- @username: "[key quote]" — [likes]♥ [Tweet](url)
- @username2: "[another perspective]" — [likes]♥ [Tweet](url)
```

End with a **Positioning Read** paragraph: predominant tone (bullish/bearish/
mixed/neutral), how crowded each side looks, who is trapped if the move
reverses, and any notable divergence between retail and institutional voices.

## Refinement Heuristics

| Problem | Fix |
|---|---|
| Too much noise | Raise `min_likes`, add `-is:reply`, narrow keywords |
| Too few results | Broaden with `OR`, remove restrictive operators |
| Crypto spam | Add `-airdrop -giveaway -whitelist` |
| Want expert takes only | Use `from:` or `min_likes: 50` |
| Want substance over hot takes | Add `has:links` |

## Output Format

Present a structured read:

1. **Query Summary**: what was searched and time window
2. **Sentiment Themes**: grouped findings with sourced quotes and tweet links
3. **Positioning Read**: tone, crowding, who's trapped on a reversal, key voices
4. **Trade Relevance**: one paragraph — does this confirm or deny the catalyst, and does crowding change the risk? X is noisy and not predictive on its own; state what it adds to the decision, not a verdict.
