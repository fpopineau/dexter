# Discovery: Second-pass fixes to turn dexter into the day2day/overnight trading agent

Started: 2026-08-06
**STATUS: IMPLEMENTED — all 5 phases landed 2026-08-06 as commits
dfcac09 (scrub+deletions), 873d06e (trade classes), 3971e4e (earnings-bet
machinery), 87f5d2b (snapshot/workers/heartbeat), 487e645 (docs).**

Topic notes from the user (verbatim intent):
- Take advantage of opportunities quickly: roughly over a day / a night.
- Cup-and-handle detection can be considered, with positions a bit longer.
- Financial analysis still useful, but NOT for long-term investing — only for gathering information on the present.
- Earnings: external data and past behaviour with earnings should be considered to bet on stocks.

Context available from the first-pass scan (2026-08-06, this session):
- SOUL.md rewritten; loads correctly (no .dexter override). RULES.md aligned.
- Off-mission surfaces found: dcf + write-memo skills (injected every turn), 3 hardcoded
  "DCF valuation" exemplar strings, channels.ts research profiles, compact.ts research-session
  schema (drops stops/targets), subagent research-worker types (no trade tools), heartbeat
  default checklist (macro-only), screen-stocks/search tool descriptions, README/AGENTS.md,
  finance_agent.csv eval dataset, overnight/SKILL.md:159 earnings consent loophole,
  intro.ts tagline, /rules "research rules" strings.
- Cup-and-handle already implemented: pattern-detectors.ts (pullback-in-uptrend, flat-base,
  cup-and-handle), swing_patterns tool, pre-market cron registers GTC swing proposals.

## Questions Asked

R1-Q1: Earnings policy — what replaces "never through the print"?
R1-Q2: Max holding period for cup-and-handle/pattern swing trades?
R1-Q3: Fate of dcf-valuation + write-memo skills?
R1-Q4: Scope of the second pass (prompts/code/docs/evals)?

## Answers Received

R1-Q1: **Deliberate pre-print bets allowed** — a new, distinct strategy: dexter may
propose holding INTO a print when past post-earnings behaviour + external signals
support it; reduced size, explicitly labeled as an earnings bet, human-accepted.
R1-Q2: **Up to ~2 weeks** for pattern swings. SOUL horizon widens to
"hours to a couple of weeks for pattern swings".
R1-Q3: **Replace with a snapshot skill** — delete dcf/ and write-memo/, add a
lightweight "company snapshot" skill: present-state facts (financial health,
earnings history/surprises, short interest, float) that inform a trade; never a
fair-value estimate.
R1-Q4: **All four scopes**: prompts+skills, deeper code surfaces (compact.ts,
subagent types, heartbeat, microcompact), docs (README/AGENTS/PLAN residue), evals.

R2-Q1: Earnings-bet sizing model? → **Worst-case gap sizing**: assume gap to worst
historical post-print move (or floor like -20%); worst case must cost ≤ normal
per-trade risk budget.
R2-Q2: Earnings-bet signals? → **All four**: past post-print reactions (bars+calendar),
beat/miss + guidance history (Financial Datasets), implied vs historical move
(needs IBKR options data plumbing), news/X sentiment.
R2-Q3: Swing hold with print inside window? → **Exit before print by default**;
holding through requires a separate explicit earnings-bet decision at that time.
R2-Q4: Evals? → **Build a small trading eval IF it can run fast enough; otherwise
lean on the benchmark ledger.** (Speed threshold to clarify.)

R3-Q1: Earnings-bet home? → **New dedicated skill** (earnings-bet SKILL.md: discovery,
signal checklist, worst-case-gap sizing, labeled proposal). Triage/overnight route to it.
R3-Q2: Gate caps? → **One open earnings bet at a time** (training wheels; loosen later).
R3-Q3: Implied-move IBKR options data plumbing? → **Build in this pass**
(reqSecDefOptParams + ATM straddle quotes, read-only, no options trading).
R3-Q4: SOUL.md + RULES.md amendments? → **Claude drafts both**, keeping the user's
voice; user reviews the diff.

R4-Q1: Eval bar? → **Deterministic suite only** (jest scenario tests over gates/sizer/
detectors/gap math); judgment quality stays measured by the benchmark ledger.
R4-Q2: Heartbeat default checklist? → **All four**: positions vs stops, proposal
freshness, watchlist triggers, slimmed macro context line.
R4-Q3: Subagent roster? → **Two trade workers + general**: catalyst-check worker
(news/X/web + earnings calendar), setup-validation worker (TA, scorer, read-only
risk/market data), general worker stays; "financial analysis" worker retired.
R4-Q4: Live gating for earnings bets? → **Paper-only until proven** (own track record,
~10 bets acceptable outcomes) even after the rest goes live; enforced in
risk-rules.live.yaml.

R5-Q1: Bet direction? → **Both directions** (long and short earnings bets).
R5-Q2: Bet timing? → **Final hour before close** (AMC → that afternoon; BMO → prior
afternoon).
R5-Q3: Evidence bar? → **≥8 past prints, ≥75% direction consistency, plus at least
one supporting external signal.**
R5-Q4: Snapshot skill use? → **Required input for pattern-swing and earnings-bet
proposals; manual anytime; intraday momentum skips it.**

R6-Q1: Short mechanics? → **Detect and fall back**: real short when the account is
marginable, inverse/sector ETF otherwise, skip if no liquid vehicle.
R6-Q2: Daily bet trigger? → **Extend the existing Pre-Close Review cron** with the
earnings-bet step (calendar check → evidence screen → labeled proposals).
R6-Q3: Emoji? → **Strip everywhere**; plain headers in all skill outputs.
R6-Q4: README disclaimer? → **Honest personal-system framing** (proposes, human
accepts, gated live execution, not advice, own risk).

R7-Q1: Evals folder? → **Delete src/evals/ + finance_agent.csv** (git history preserves).
R7-Q2: Swing concurrency? → **Max 3 concurrent pattern swings.**
R7-Q3: Risk budgets? → **Differentiate all three classes**: intraday 0.25%, pattern
swings 0.5%, earnings bets 0.25% worst-case-gap — each tuned in risk-rules.yaml.
R7-Q4: 13F tools? → **Delete** institutional_holdings.ts + exports.

R8-Q1: Phasing? → **Phased commits on day2day**: (1) prompt/identity scrub + deletions,
(2) risk-rules classes + sizer/gate + tests, (3) earnings-bet skill + IV plumbing +
cron, (4) snapshot skill + subagent/heartbeat rework, (5) docs.
R8-Q2: Live profile? → **Mirror new class parameters into risk-rules.live.yaml now,
with earnings bets hard-disabled there** (paper-only-until-proven via config).
R8-Q3: Final check → **No further steering; finalize.** Implementation details
delegated: per-class ledger tagging, x-research retarget, "company-snapshot" name,
graceful degradation when options-data entitlement is missing.

## Emerging Requirements (FINAL SYNTHESIS)

### The mission, restated
Dexter is a day2day/overnight trading agent with THREE trade classes:
1. **Intraday/overnight momentum** — hours to a few nights (unchanged core).
2. **Pattern swings** — pullback-in-uptrend / flat-base / cup-and-handle, GTC
   stop-entries, held up to ~2 weeks, max 3 concurrent, 0.5% risk budget.
   Default: exit before any earnings print inside the window; holding through
   requires a separate explicit earnings-bet decision at that time.
3. **Earnings bets** — NEW class. Deliberate hold through a print, both directions
   (real short when account is marginable, inverse/sector ETF fallback, skip if no
   liquid vehicle). Entry in the final hour before close (AMC → same afternoon,
   BMO → prior afternoon). Max 1 open at a time. Sized by worst-case gap: assume
   gap to worst historical post-print move (floor ~-20%); worst case ≤ 0.25% NetLiq.
   Evidence bar: ≥8 past prints with computable reactions, ≥75% direction
   consistency, ≥1 supporting external signal. Signals: past post-print reactions
   (bars+calendar), beat/miss + guidance history (Financial Datasets), implied vs
   historical move (NEW IBKR options data plumbing: reqSecDefOptParams + ATM
   straddle quotes, read-only, degrade gracefully if entitlement missing),
   news/X sentiment. Paper-only until ~10 bets with acceptable outcomes, enforced
   by hard-disable in risk-rules.live.yaml. Trigger: Pre-Close Review cron gains
   the earnings-bet step. Workflow lives in a NEW dedicated earnings-bet skill.

Financial analysis is PRESENT-STATE ONLY: earnings history, financial health,
short interest, float, insider activity — context for a trade, never fair value.

### Deletions
- src/skills/dcf/ and src/skills/write-memo/ (entire directories).
- src/evals/ + finance_agent.csv.
- src/tools/finance/institutional_holdings.ts + exports.
- The three hardcoded "DCF valuation" exemplar strings (skill.ts:16, prompts.ts:84,
  registry.ts:308) — scrubbed in the same commit as the skill deletion.

### New builds
- **company-snapshot skill** — present-state card (financial health, earnings
  history/surprises, short interest, float, insider activity). Required input for
  pattern-swing and earnings-bet proposals; manual anytime; intraday skips it.
  Becomes the canonical skill example in prompt strings.
- **earnings-bet skill** — discovery (calendar × evidence screen), signal checklist,
  worst-case-gap sizing, labeled proposal.
- **IBKR options data plumbing** — ATM straddle quote fetch for implied move.
- **Deterministic eval suite** — jest scenario tests over gates/sizer/detectors/
  worst-case-gap math (no LLM in the loop). Judgment quality measured by the
  nightly benchmark ledger; per-class outcome tagging so "10 proven bets" is
  measurable.
- **Risk-rules classes** — per-class budgets (0.25/0.5/0.25 worst-case), swing cap 3,
  earnings-bet cap 1; mirrored into risk-rules.live.yaml with earnings bets disabled.

### Rewrites (from first-pass scan, all confirmed in scope)
- SOUL.md: horizon widens ("hours to a couple of weeks for pattern swings"),
  earnings stance amended (deliberate labeled bets replace the absolute ban) —
  Claude drafts, user reviews diff. Same for .dexter/RULES.md rules 4 & 7.
- prompts.ts: "research tools" framing, tool-usage policy, "Research Rules" heading
  → "Trading Rules".
- channels.ts: profiles + table exemplars → trade-shaped (entry/stop/target/R, size,
  ATR, RVOL); WhatsApp = terse alert register.
- compact.ts: "research session" → trading session; must-keep schema gains open-trade
  state (proposals, entry/stop/target, size, gate verdicts, time-in-trade).
- Subagent roster: catalyst-check worker (news/X/web + earnings calendar) +
  setup-validation worker (TA, scorer, read-only risk/market data) + general;
  "financial analysis" worker retired; "NVDA moat" example scrubbed.
- heartbeat/prompt.ts default checklist: positions vs stops, proposal freshness,
  watchlist triggers, slimmed macro context line.
- Tool descriptions: screen-stocks (present-state filters, not the trade funnel),
  search/index.ts (catalyst-first + fix the misfiled "when NOT to use" bullet),
  get-financials router, fetch/prompt.ts wording.
- overnight/SKILL.md:159 consent loophole → routes to the earnings-bet skill instead.
- x-research skill: retargeted to positioning/catalyst intel ending in trade-relevant
  assessment.
- Emoji stripped from all skill output templates.
- microcompact COMPACTABLE_TOOLS: reviewed so trade-critical results stay protected.
- Docs: README (honest personal-system disclaimer, trading identity, day2day is the
  product), AGENTS.md (trading architecture, SOUL/risk-rules/proposal lifecycle),
  PLAN.md residue (DCF routing row, w5·fundamental_support), handbook nits,
  intro.ts tagline, /rules strings → "trading rules".

### Phasing (day2day branch, focused commits)
1. Prompt/identity scrub + deletions (skills, evals, 13F, exemplar strings).
2. Risk-rules trade classes + sizer/gate changes + deterministic eval suite.
3. Earnings-bet skill + IV plumbing + Pre-Close Review cron extension.
4. company-snapshot skill + subagent roster + heartbeat rework.
5. Docs (README, AGENTS.md, PLAN residue, handbook nits).

### Sequencing note (phase 1 decision, 2026-08-06)
The SOUL.md/RULES.md earnings-stance flip (allowing labeled bets) is DEFERRED to
phase 3 — declaring the policy in live prompt content before the worst-case-gap
sizer and gate caps exist would let the agent propose "earnings bets" sized by the
stop-based sizer. Phase 1 shipped: horizon widening + present-state financial
framing in SOUL.md, swing discipline (2 weeks / max 3 / exit-before-print) in
RULES.md rule 7. Rule 4 (never through the print) stays absolute until phase 3.

### Known gaps / notes
- Options-data entitlement on the paper account is unverified (echo of the news API
  gap recorded in smoke-live.ts) — probe before relying on the implied-move signal;
  the skill must degrade gracefully to the three cheap signals.
- Worst-case-gap floor set at -20% pending real data; revisit after first bets.
- Swing budget 0.5% on a €3.7K account still produces small positions; acceptable
  during burn-in, revisit at live switch.

---

# Discovery: profit-taking policy ("better now than later") + €10K live account

Started: 2026-08-22

Context: reassessment of the 2026-08-21 review-challenge action list under two
new operator requirements: (1) the profit trail / early profit-taking prevails
over target-holding — anything up ~4-5% intraday is taken immediately, with the
threshold scaled to the instrument's potential (3-10%) and the benefit tracked;
(2) the live account will be €10,000 (not €3.7K as previously planned, not the
$250K paper scale); operator can reset the paper account equity if useful.

## Questions Asked

## Answers Received

## Emerging Requirements

### Round 1 (2026-08-22)

Q1 Take semantics at +x%: **target sits at x%** — the bracket's LMT leg is
placed at x% from entry at creation (broker-side). Ratchet-stop+trail mode
(lock x−1%, trail the rest) kept as a CONFIGURABLE alternative.
Q2 x% source: **ATR default + LLM override** — deterministic default
clamp(k×dailyATR%, 3%, 10%); judgment may override within the band; gate
clamps/refuses outside it.
Q3 R:R gate: **stops must tighten** — keep 2:1 but judge it against the take
level: x% ≥ 2× stop distance is the geometry bar. Wide-stop chases refused.
Q4 €10K shadow-live: **reset paper NetLiq to ≈€10K AND run live rules on
paper** (profile override). Scorecard ×4 scaling dropped; new stats epoch.

### Round 2 (2026-08-22)

Q5 Ratchet toggle: **global config, default target@x%** (exit_style: target |
ratchet, whole intraday class; flipping is a freeze-relevant behavior change).
Q6 Scope: **intraday + its overnight conversions** keep the x% target; swings
keep structural targets; earnings bets keep gap exits.
Q7 Earnings bets under shadow-live: **enabled as the one documented deviation**
from live.yaml (sized by live 1% gap budget); recorded in the protocol.
Q8 €10K rules: **Claude drafts a revised risk-rules.live.yaml for review**
(slots/trades/caps re-derived for €10K), operator ratifies before the reset.

### Round 3 (2026-08-22)

Q9 Tracking: **both counterfactuals + scorecard lane** — same-day MFE/MAE
after the take (excursion machinery) AND a bounded replay of whether the old
structural 2:1 target would have hit before the stop; scorecard gains a
take-vs-target comparison line.
Q10 k default: **k = 1.5** — x = clamp(1.5 × dailyATR%, 3%, 10%).
Q11 Reset: **$11,700 (≈€10K) AFTER the code lands** — exit-policy WP + shadow
profile + before-tag fixes → operator resets paper account → 'performance
reset' → one clean epoch at the right scale.
Q12 Adopted rows: **exempt** — take policy governs only Dexter-underwritten
positions; adopted rows keep auto-protect + operator ownership.

### Round 4 (2026-08-22)

Q13 Floor-vs-cap conflict: **cap wins** — max_target_atr 1.5 retained; when
the 3% floor pushes x past 1.5×ATR the proposal is refused. Implicit intraday
eligibility: dailyATR% ≥ ~2. Low-vol names out of the intraday class.
Q14 Prior before-tag fix list: **all stand**, sequenced with the two new WPs.

## Emerging Requirements (final synthesis)

**WP-EXIT — take-at-x% exit policy (intraday class + its conversions)**
- Target IS the take level: bracket LMT at x% from entry, broker-side.
- x = clamp(1.5 × dailyATR%, 3%, 10%); LLM may override within [3,10]
  citing instrument potential; gate clamps/refuses outside; take_pct +
  take_pct_source recorded on the proposal.
- Reachability cap max_target_atr 1.5 retained and WINS over the 3% floor
  (refusal, not waiver) → intraday requires dailyATR% ≥ ~2 in practice.
- Geometry bar: 2:1 judged against the take level at worst fill ⇒
  stopDist ≤ x/2 (≈ ≤0.75×ATR unclamped — matches the entry-audit stops).
- exit_style: target (default) | ratchet — global config, whole class;
  ratchet = at +x% tighten stop to lock ≈x−1%, trail the rest (runner
  machinery). Flipping exit_style is freeze-relevant (new sample).
- EOD conversions keep the x% target overnight (protect pair re-placed at
  x-target + stop). Swings, earnings bets, adopted rows exempt.
- dailyATR unavailable at creation → fail-closed refusal (intraday).
- Tracking: per closed take — same-day post-exit MFE/MAE (excursion
  machinery) + bounded replay "would the structural 2:1 target have hit
  before the stop"; scorecard gains a take-vs-target comparison line.

**WP-SHADOW — €10K shadow-live**
- Live target account: €10,000 (supersedes €3.7K plan).
- Profile override so PAPER runs risk-rules.live.yaml; ONE documented
  deviation: earnings_bet_enabled: true (class keeps building its record
  at live-scale 1% gap sizing); deviation recorded in the protocol.
- Claude drafts a €10K revision of risk-rules.live.yaml (slots, daily
  trades, caps, whole-share affordability re-derived) → operator ratifies.
- Scorecard: ×4 drawdown scaling REMOVED; drawdown judged at live scale
  against the new epoch's frozen NetLiq.
- Sequence: all code lands → operator resets paper NetLiq to $11,700
  (≈€10K) in IBKR Account Management → 'performance reset' → clean boot →
  remaining freeze prereqs → tag validation-freeze-1.

**Prior before-tag fix list: all stand** (profit-trail ownership now more
important — ratchet mode leans on that service).
