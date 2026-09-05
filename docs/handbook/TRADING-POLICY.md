# Trading Policy — in plain terms

What the system does with money, and why, without the code. The numbers
below are the **first-tranche live settings** (target account €10,000 ≈
$11,700); the ones marked *pending ratification* live in
`src/config/risk-rules.live.yaml` and must be reviewed by the operator
before the validation reset and again before real money.

The one rule behind everything: **profit as surely as possible, even if
that means missing larger gains.** Every choice below — small risk
budgets, early profit-taking, flat by close, refusing doubt — follows
from it.

## What it trades

US stocks only, whole shares only (IBKR blocks fractional orders via the
API). Long or short. The core class is the **intraday bracket**: enter
during the session, exit the same day. Two more classes exist — multi-day
**swings** and deliberate **earnings bets** — but both are switched off
for live trading until each earns its own track record (see "Disabled
until proven").

## How a trade starts

1. A deterministic scanner (no AI, no cost) continuously ranks the
   market and surfaces candidates.
2. An AI judgment layer, on schedules and events, checks candidates for
   a real catalyst and registers a **trade proposal**: symbol,
   direction, entry, stop, target, size, and the reasoning.
3. Every proposal then passes independent safety gates: risk budget,
   position caps, daily limits, duplicate checks, market hours, and a
   late-day cutoff (no new intraday entries in the last minutes before
   close).
4. **A human holds the switch and the veto.** On the paper account an
   auto-execute mode exists. On a real account auto-execution fires only
   while the operator's **live switch** is on — a state file written
   solely by the operator's challenge-confirmed `live on` (a 6-character
   token, 2-minute window; `live off` is immediate; the system itself can
   only ever turn it *off*, which it does on any epoch stop). Even then,
   every other condition must hold: `IBKR_ALLOW_LIVE`, a verified live
   account, the live rule profile, a running epoch, no daily halt. The
   per-trade controls are the **veto window** (an announced execution
   waits `LIVE_VETO_WINDOW_MIN` minutes for `veto P-XXXX`; a row the
   executor has already claimed cannot be vetoed — `cancel` / `kill`
   apply after placement) and `kill SYMBOL`. A hand `accept` remains
   available at all times.
5. Acceptance places a **bracket**: the entry order plus its stop-loss
   and take-profit, linked so that one exit filling cancels the other.
   A position is never in the market without its protection.

Only one active idea per symbol at a time — the database itself enforces
it, not just the code.

## How big a trade can be

| Limit | Value | In dollars (on $11.7K) |
|---|---|---|
| Risk per trade (max loss if the stop fires) | 0.5% *(pending ratification)* | ≈ $58 |
| Position size cap | 15% of account | ≈ $1,755 |
| Open positions | 4 at most | ≈ 60% deployed max |
| New trades per day | 6 | — |
| Daily loss stop | 1.5% *(pending ratification)* | ≈ $175 |

The stop distance and the size are linked: the share count is chosen so
that hitting the stop loses at most the per-trade risk budget. Roughly
three losing trades in a day reach the daily stop.

## How trades end ("better now than later")

Targets proved hard to predict, so the policy takes profits early rather
than waiting for the ideal exit:

- The take-profit is set at **x% above the entry**, where x is about
  1.5× the stock's typical daily move, bounded between 3% and 10%.
  Stocks that barely move are refused — there is nothing to take.
- The stop is at most **half of x**, so a winner pays at least twice
  what a loser costs.
- The exits are placed as good-till-cancelled orders: they survive a
  gateway restart or crash. A position is never left unprotected.
- An optional "ratchet" mode locks in gains on a pullback from the peak
  instead of using a fixed take level; the default is the fixed take.

## End of the day

Intraday means intraday — the policy is **flat by close**:

- At 15:52 ET the end-of-day triage looks at every intraday position.
  Losers that are still fading are closed before the bell. Everything it
  does is verified against the broker afterwards; anything unresolved
  raises an alarm instead of being silently assumed done.
- Resting entry orders that never filled are cancelled.
- A position may be deliberately kept overnight only by passing a
  separate vetting, including a gap stress test: assume a 20% overnight
  gap against the book — the surviving overnight exposure must fit
  inside one daily-loss budget. Kept positions get overnight-safe
  protection.

## Earnings

Never hold a position through an earnings report by accident. The
earnings guard flattens any position whose company reports within the
guard window. Holding through a print is only allowed as a deliberate,
size-limited earnings bet — a class that is disabled on live.

## When trading stops

A kill-switch guardian watches the daily loss. When the day's loss
reaches the limit it **latches**: no new entries for the rest of the
day, and unfilled entry orders are cancelled until the book is clean.
The latch is based on observed account values, and it stays down —
recovering during the day does not un-latch it.

## Disabled until proven

Every trade class beyond intraday ships **off** for live trading. A
class is enabled only after its own record on paper passes a
pre-registered bar: at least 30 trades, net positive, profit factor
≥ 1.3, and a statistically positive cohort. A good-looking report is not
an authorization — the switch is flipped by hand and recorded in the
validation journal.

## Going live at all

The system rehearses on the paper account under the exact live rules and
live account scale, and is judged by a **pre-registered sequential test**
(SPEC.md § "Live-loop program"): the paper epoch is evaluated when its
closed-trade count first reaches 25, 50, 75 and 100, with confidences
chosen in advance (99 / 97.5 / 96 / 95 %). A look ACCEPTS when the
lower bound of expectancy in R is positive, net R is positive and the
profit factor is ≥ 1.3; it REJECTS when the upper bound is negative
(the epoch stops, new entries pause); a −5 % drawdown of marked equity
stops the epoch at any time. The first paper ACCEPT is the cutover
evidence. The evidence is displayed in the `live on` challenge; the
decision is the operator's, and the code neither flips the switch nor
withholds it.

Going live is then a deliberate, layered act: `IBKR_ALLOW_LIVE` (an env
flag, restart required), the live switch (`live on` + token), a fresh
epoch on the live account at the bottom size rung (0.25 % risk per
trade; the ladder steps up only on the operator's confirmation at 25 /
50 / 100 trades with a positive record, and steps down automatically on
a −5 % drawdown). Classes not enabled in the live rules (swing,
earnings-bet) never trade on the live account — their rows are marked
sim-only and settle in the simulator. `live off`, `veto`, `kill` and a
stopped epoch each end automated entries at once; protective exits are
never gated.
