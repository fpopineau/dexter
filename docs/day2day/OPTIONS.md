# Options — considered, not scheduled

Ideas the desk has examined and deliberately parked. Each entry records
why it is not being built now and what would change that. Move an entry
out of this file when it is either built (link the commit) or rejected
for good (say why).

## Wider discovery mouth: 50-row scans + phase-aware scoring caps

**Idea** (funnel review, 2026-08-19): two knobs, one cheap and one
costed. (a) Scan windows `numberOfRows` 25 → 50 (IBKR's max) — same
subscription, near-zero cost; closes the residual blind spot of
non-watchlist names at ranks 26–50 on wild days (the sentinel already
covers watchlist names). (b) Scoring cap `OPP_MAX_CANDIDATES` 20 → 30,
**phase-aware only**: midday/pre-open have ~8 min of cycle slack;
open-drive is already saturated (~3.5-min cycles vs 2-min cadence) and
must STAY at 20 — a blanket raise would slow discovery at the open and
crowd IBKR historical pacing (which now also feeds the sentinel sweep,
regime proxies, and excursion capture).

**Why parked** (operator, 2026-08-19): wait for evidence. The nightly
capture report's funnel separates NEVER-SEEN (scan-window failure) from
seen-never-triggered (scoring/threshold failure) — a week of reports on
the current settings shows whether the mouth is actually clipping, and
by how much, before spending cycle time on it.

**Revisit when**: capture reports show recurring NEVER-SEEN movers that
50-row windows would have caught, or seen-but-cut names (union rank
21–40) that went on to be top movers. Both are direct queries against
the benchmark ledger.

## FDA / trial-readout calendar watchlist

**Idea** (MRNA post-mortem, 2026-08-19): the only news-watching approach
that structurally beats the tape is the *scheduled* kind — PDUFA dates,
advisory-committee meetings, and phase-readout windows are knowable in
advance, like the earnings calendar. A biotech calendar would put names
like MRNA on a watchlist *before* the wire hits: pre-positioned in the
scan universe, news-pulse query set, and evaluation context.

**Why parked** (operator, 2026-08-19): domain-oriented and narrow — it
covers a few dozen biotech names, and the logic generalizes badly: the
same argument spawns a DoD-contracts calendar, a court-docket calendar,
a regulatory-decision calendar… each with its own source, its own
parser, and its own maintenance tail. And even with the calendar, the
*result* still has to be read when it drops — the reading machinery
(tape-first detection → LLM reads the reason online) is the part that
generalizes, and it is already built (dawn watch + mover alerts +
trigger evaluation with web_search, 223913a).

**Revisit when**: (a) the mover-alert/evaluation path demonstrably
misses or lags catalyst days that a calendar would have pre-positioned
(the benchmark capture report is the evidence source — look for
NEVER-SEEN or late-seen names with scheduled biotech catalysts), or
(b) an off-the-shelf FDA-calendar feed (BiopharmaCatalyst-class) makes
the build a parser instead of a research project.

**Shape if built**: mirror earnings-calendar.ts (daily cache, date-keyed
lookups, `check` action against positions/watchlist), feed the reactor
mechanism the way fresh reporters feed it today.
