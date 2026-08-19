# Options — considered, not scheduled

Ideas the desk has examined and deliberately parked. Each entry records
why it is not being built now and what would change that. Move an entry
out of this file when it is either built (link the commit) or rejected
for good (say why).

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
