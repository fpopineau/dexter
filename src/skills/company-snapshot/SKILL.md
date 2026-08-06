---
name: company-snapshot
description: >
  Present-state company card for a trade candidate: what the business is,
  how healthy it is right now, its earnings record, short interest, insider
  activity, and red flags. REQUIRED before any pattern-swing or earnings-bet
  proposal (positions held days need to know what they're holding); useful
  anytime the user asks "what is X / snapshot of X / what am I holding".
  Never a valuation — no fair value, no price targets, no long-term thesis.
---

# Company Snapshot Skill

A position held for days needs present-state facts: is the business
solvent and boring, or is there a landmine (offering, print, crowded
short) inside the holding window? That is all this card answers. It is
NOT a valuation — if the output starts arguing the stock is "cheap",
delete that line.

Intraday momentum trades skip this skill — at trigger time the tape and
the catalyst decide, not the company.

## Workflow Checklist

```
Snapshot Progress:
- [ ] Step 1: Identity & tape
- [ ] Step 2: Next print & earnings record
- [ ] Step 3: Short interest & insider activity
- [ ] Step 4: Financial health (best effort)
- [ ] Step 5: News tone
- [ ] Step 6: The card
```

## Step 1: Identity & Tape

Call `web_fetch` on
`https://api.nasdaq.com/api/quote/[SYMBOL]/summary?assetclass=stocks`
(prompt: "extract sector, industry, market cap, average volume, previous
close, 52-week range") — this is a JSON API, extract the fields.
Then `ibkr_market_data` (or `get_market_data` without IBKR) for the live
price and today's move. Note average daily volume — it bounds what the
account can trade cleanly.

## Step 2: Next Print & Earnings Record

- `earnings_calendar` (action `check`, withinDays 14): the NEXT report
  date. A print inside a swing's holding window is the headline red flag —
  the swing must plan its exit before that date, or the candidate dies.
- `earnings_bet_intel` (action `reactions`): the post-print record —
  consistency, average move, worst adverse move, surprise streak from the
  verified prints. This doubles as print-risk context for swings.

## Step 3: Short Interest & Insider Activity

- `web_fetch` on
  `https://api.nasdaq.com/api/quote/[SYMBOL]/short-interest?assetClass=stocks`
  (prompt: "latest short interest, average daily volume, days to cover,
  and the trend over the last few settlement dates").
  Days-to-cover ≥ ~5 = crowded short — squeeze fuel on good news, but
  also company-in-trouble signal; note which story fits.
- `web_fetch` on
  `https://api.nasdaq.com/api/company/[SYMBOL]/insider-trades`
  (prompt: "number of open-market buys vs sells over 3 and 12 months").
  Insiders buying in the open market is rare and meaningful; routine
  sell programs are noise — count only open-market activity.

## Step 4: Financial Health (Best Effort)

Call `get_financials` for a current snapshot: cash vs debt, margins,
revenue trajectory, share count trend (dilution!). If the data plan
refuses (circuit breaker will say so), state "fundamental snapshot
unavailable" and move on — the card survives without it; the tape,
print record, and filings tone carry the decision.

What matters at this horizon:
- **Cash runway / dilution risk**: a cash-burner near empty sells shares
  into strength — the classic swing-killer offering.
- **Share count trend**: rising = serial diluter.
- Everything else (margins, growth) is one line of color, not a thesis.

## Step 5: News Tone

`web_search` the last ~2 weeks: offerings/shelf filings, guidance
changes, analyst actions, litigation/regulatory events. One query,
specific: "[SYMBOL] offering OR guidance OR downgrade OR FDA news".

## Step 6: The Card

Under 15 lines, plain headers, no emoji:

```
SNAPSHOT [SYMBOL] — [date]
Business: [sector/industry, market cap, one-phrase what-they-do]
Tape: $[price] ([+/-]% today), avg vol [X]M, 52w [low–high]
Next print: [date, AMC/BMO | "none inside 14d"]
Earnings record: [n] prints, [x] up / [y] down, avg |move| [z]%, worst adverse [w]%
Short interest: [x]% float-ish, [d] days to cover, [rising/falling]
Insiders (3mo): [buys] open-market buys / [sells] sells
Health: [cash vs debt one-liner | "fundamental snapshot unavailable"]
News: [one line of tone]
RED FLAGS: [print inside window / offering risk / dilution / crowded short / none]
```

The RED FLAGS line is the point of the card. For a swing or earnings-bet
proposal, carry it into the rationale; a red flag you cannot neutralize
("exit before the print", "size for the squeeze") kills the candidate.
