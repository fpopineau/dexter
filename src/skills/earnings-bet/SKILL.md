---
name: earnings-bet
description: >
  Deliberate hold THROUGH an earnings print — the only sanctioned way to
  carry a position into a report. Triggers when: the pre-close review finds
  tonight's/tomorrow-morning's reporters worth evaluating, the user asks to
  "bet on X's earnings", "hold through the print", "earnings play", or an
  open position's exit-before-print decision is being reconsidered. Both
  directions (long and short). One open bet at a time; sized to the worst
  historical gap, never the stop.
---

# Earnings Bet Skill

A stop cannot protect a position through a print — the price gaps. This
class therefore has its own rules, enforced by the gate and the sizer:
worst-case-gap sizing, one bet at a time, and (until the class earns its
live record) paper-only. Your job here is the evidence, the direction,
and an honest proposal. The machines do the sizing.

## Workflow Checklist

```
Earnings Bet Progress:
- [ ] Step 1: Confirm the print (date + timing)
- [ ] Step 2: Entry window check
- [ ] Step 3: Reaction record — evidence bar
- [ ] Step 4: External signals (need at least one)
- [ ] Step 5: Snapshot, direction, and vehicle
- [ ] Step 6: Propose (labeled, auto-sized)
```

## Step 1: Confirm the Print

Call `earnings_calendar` (action `day` for today AND tomorrow, or `check`
on the candidate):
- Confirm the symbol actually reports, and whether it is AMC (after close)
  or BMO (before open). An unconfirmed date kills the bet — never guess.
- If the calendar could not be fetched, that is "could not verify", not
  "no earnings". Stop.

## Step 2: Entry Window Check

Entry happens in the FINAL HOUR before the close that precedes the print:
- AMC print → enter between 15:00–15:55 ET that same day.
- BMO print → enter between 15:00–15:55 ET the PRIOR session.

Outside the window: prepare the evaluation, state when the entry window
opens, and do NOT propose yet — a proposal created hours early carries
stale levels into the most information-dense hours of the day.

## Step 3: Reaction Record — Evidence Bar

Call `earnings_bet_intel` (action `reactions`):
- The verdict is deterministic: `meetsBarLong` / `meetsBarShort` require
  ≥8 computable prints with ≥75% direction consistency. If the side you
  want fails the bar, there is no bet — do not argue with the record.
- Note `nVerified` vs `n`: inferred prints (gap-snapped, not published
  dates) are acceptable evidence, but say so in the rationale.
- Record `worstAdverseForLongPct` (long) or `worstAdverseForShortPct`
  (short) — this is the `worstCaseGapPct` the proposal must carry — and
  `avgAbsMovePct`, the historical move size.

## Step 4: External Signals — Need At Least One

The record says how the stock tends to react; at least one CURRENT signal
must say this print isn't the exception:

1. **Surprise/guidance streak**: the reactions output includes per-print
   `epsSurprisePct` for verified prints — a beat streak supports a long
   thesis, a miss/cut streak supports a short.
2. **Implied vs historical move**: `earnings_bet_intel` (action
   `implied_move`, pass the reaction date). Implied well ABOVE
   `avgAbsMovePct` = the market already expects fireworks (edge shrinks);
   implied at/below the average with a consistent record = the setup this
   class exists for. A null implied move (missing options entitlement) is
   a known blind spot — say "implied move unavailable" and weigh the rest.
3. **News/catalyst tone**: `web_search` the specific pre-print story
   (guidance chatter, channel checks, peer results this week).
4. **Positioning**: `x_search` / the x-research skill — who is crowded on
   which side, who is trapped if the print surprises.

Zero supporting signals = no bet, even with a perfect record.

## Step 5: Snapshot, Direction, and Vehicle

Run the `company-snapshot` skill on the candidate — REQUIRED for this
class. Its RED FLAGS line can kill a bet the record supports: an
offering-prone cash burner, or dilution into strength, turns a "7 of 8
up" record into a trap. Carry the card's red-flags line into the
proposal rationale.

- **Long**: straight equity buy.
- **Short**: try the real short first. If the account cannot short (cash
  account, hard-to-borrow refusal at order time), express the thesis via
  a LIQUID inverse or sector vehicle if one honestly tracks the name —
  otherwise SKIP. Never force a bearish bet through an illiquid proxy.
- Check `memory_search` for standing instructions and current exposure to
  the name or its sector before proposing.

## Step 6: Propose — Labeled, Auto-Sized

Create via `trade_proposals` (action `create`):
- `tradeClass: "earnings-bet"` — never disguise the class; the gate sizes
  bets against the gap precisely because the stop will not hold.
- `tif: "GTC"`, `entryType` MKT (indicative entry = current price) or LMT
  at the market — this entry is about time, not level.
- **OMIT quantity** — the sizer applies the worst-case-gap budget.
- `worstCaseGapPct`: the worst adverse value from Step 3, verbatim.
- `stop`: real structure for the POST-print session (it manages the
  reaction, not the gap); `target`: an honest objective ≥2× the stop
  distance, informed by `avgAbsMovePct`.
- `expiresMinutes`: 60 — an unaccepted bet must not survive into the print.
- `rationale`: one line of record ("7 of 8 up, worst gap −12%, 3 inferred"),
  one line of signal ("beat streak 4Q + implied 6% vs 9% avg").

Alert format (WhatsApp): first line starts with `EARNINGS BET`, then
setup/record, entry/stop/target with size, the ask. Under 10 lines.

## Hard Rules

- The evidence bar is not negotiable: no ≥8-print record with ≥75%
  consistency on your side + ≥1 external signal → no bet.
- One open earnings bet at a time — the gate refuses the second; do not
  queue another "for after".
- If the gate or sizer refuses, the refusal stands: fix honestly or skip.
  Never resubmit the same trade as 'intraday'/'swing' to dodge the class
  rules — that converts a sized bet into an unsized one.
- After the print, the bet becomes an ordinary position: manage the
  reaction (trim/close/trail) in the next session's review; never "let it
  ride" into a second print.
- The morning after, report the outcome exactly as it landed — gap, exit,
  P&L — win or lose.
