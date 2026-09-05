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

# Discovery: reaching an ONLINE system shortly — the 100-trade path is too slow

Started: 2026-09-05
**STATUS: CLARIFIED 2026-09-05 — 12 rounds, 48 questions. Next step: SPEC.md work-package
section (WP1 throughput → WP2 simulator → WP3 sequential/ladder/epoch → WP4 live plumbing).**

## Evidence base (measured this session, 2026-09-05, before any question)

**Where the validation stands**
- Freeze tag `validation-freeze-1` NOT placed. The official frozen sample is n = 0.
  Tag gate still open: manifest row 2 (bell-expiry of an unfilled DAY parent) is the last
  non-waivable observation; live yaml ratification + manifest identity rows pending.
- Epoch reset 2026-08-26 15:23Z at $12,336.17 (shadow-live, €10K scale, live profile).
- Since the epoch (8 trading days, 08-26..09-04): 38 proposals created, 11 executed,
  6 resolved under the protocol filter (5 intraday + 1 earnings bet): 3W/3L, net −$38.
  Daily cadence: 3–7 proposals/day, 0–2 executions/day, ~0.75 resolved trades/day.
- Naive projection: 100 trades ≈ 130 trading days ≈ 6+ months — AFTER the tag lands.
  The protocol also demands ≥2 regimes, ≥6 ISO weeks, per-class ≥30, cohort completeness.
- Runtime attestation shows the running gateway as profileEnv=live but accountType
  "unverified" (booted 10:20 today; account verification pending at read time).

**Where the trades die (the funnel)**
- Refusal ledger: 674 rows all-time, ~32/day since the epoch (278 rows, 82 symbols) vs
  6 trades. Gate split since epoch: judgment (LLM declined) 125, noise-stop 78,
  other/microstructure 28, entry-pricing 27, chase 7, risk-reward 6, extension 5.
- Counterfactual outcomes (MFE/MAE replay) of refusals since epoch:
  noise-stop 37 would-stop / 13 would-target / 19 unfilled / 9 open;
  entry-pricing 12 stop / 12 open / 3 unfilled; chase 4 stop / 3 unfilled;
  judgment 125 unknown (no levels). Reading: the deterministic gates that fire most are
  NOT refusing winners — relaxing them would raise n but likely sink expectancy.
- Trigger bar: compositeRank ≥ 75 (OPP_TRIGGER_SCORE unset → default 75), top-3 entry,
  max 10 triggers/day, 30-min cooldown. Four coverage addenda (08-27, 09-01, 09-03, 09-04)
  show the whole 4–18% single-name mover class scoring 55–66 — never evaluated at all;
  3x ETFs crowd out chipmakers. This class is the untested throughput lever.
- Benchmark ledger (21 nightly entries, top-15 movers/day): seen ~75%, triggered ~25%,
  proposed ~8%, executed ~4%.

**Data already logged and reusable**
- proposals.db: 210 rows all-time (129 closed) — but pre-epoch rows are pre-remediation,
  $249K scale, different rules: ledger says intraday agent-lane −$38K over 47 trades.
- refusals table with MFE/MAE counterfactuals (674 rows) — the richest "shadow" sample.
- benchmark-ledger.jsonl (21 days), equity-series.jsonl (2,584 samples, 5-min),
  opportunities.db (scan snapshots, 7-day retention), market-archive.db 200 MB +
  stream-bars.db 218 MB (intraday bars incl. extended hours since 08-25).
- Off-repo: FirstRate 1-min bars 2010–2025, GDELT 2015–2025; WP9 honest-replay backtest
  engine exists but is flagged UNTRUSTED until recalibrated.

**Structural constraints already decided**
- Live auto-execution is refused by construction (assertPaperOnly): live = manual accept.
- IBKR_ALLOW_LIVE=false until deliberate flip; live port 4001 vs paper 4002.
- Live tranche: 0.5%/trade (~$58), 1.5% daily halt (~$175), 15% × 4 slots, 6 trades/day.
- Operator lens (2026-08-23): "profit as surely as possible, even if missing larger gains".

**Candidate option families put to the questions**
A. Live-plumbing burn-in now (real account, minimum size, manual accept).
B. Throughput levers on paper (trigger bar / large-cap lane / significance ranking).
C. Shadow-execution sample (simulate fills+exits for every proposal against real bars).
D. Sequential pre-registered test replacing fixed n=100.
E. Deterministic-funnel backtest on FirstRate.
F. Two-tier live (one narrow lane live, the rest paper).

## Questions Asked

R1-Q1: What does "online" mean — which outcome counts as success?
R1-Q2: Time horizon for "shortly"?
R1-Q3: Which throughput levers are acceptable (behavior changes before the tag)?
R1-Q4: Is the pre-registered protocol negotiable before the tag?
R2-Q1: Live auto-execution posture (assertPaperOnly refuses live autoexec today)?
R2-Q2: What must be true before the first live trade?
R2-Q3: Refinement-loop model vs the freeze?
R2-Q4: Sizing for the first live tranche?
R3-Q1: Veto window length + unreachable-operator fallback?
R3-Q2: Where does the shadow (candidate) variant run?
R3-Q3: What does "proven on paper" mean for the throughput changes?
R3-Q4: Trigger bar target and daily trigger cap?
R4-Q1: What pre-registered evidence STOPS the live experiment?
R4-Q2: Size-ladder rungs?
R4-Q3: Daily statistics content?
R4-Q4: Shadow-variant promotion criterion?
R5-Q1: Slice-B first-cut scope (by ~Sep 10)?
R5-Q2: Which trade classes on live from end of September?
R5-Q3: Per-epoch identity rigor?
R5-Q4: Channels for the daily report and the veto/kill surface?
R6-Q1: If the paper proof fails by Sep 24, what happens to the live date?
R6-Q2: Broker ops at cutover (single IB Gateway paper -> live)?
R6-Q3: What stays a HUMAN action once live automation is on?
R6-Q4: LLM model + budget at 30 triggers/day?
R7-Q1: Reconcile promotions: human per case vs automated?
R7-Q2: Which paper evidence flips the live switch (replaces the 100-trade verdict)?
R7-Q3: Paper rehearsal numbers: bottom rung or today's 0.5%?
R7-Q4: What must be RUNNING on paper by Sep 30?
R8-Q1: Simulator fill model for shadow trades?
R8-Q2: Fate of the validation-freeze-1 machinery and its pending prerequisites?
R8-Q3: Cadence for sequential looks / ladder steps / epoch resets?
R8-Q4: Delivery style for the four work packages?
R9-Q1: Daily trade caps under the wider funnel?
R9-Q2: Which shadow variants run from day one?
R9-Q3: Representation of the live switch; ladder carry-over at cutover?
R9-Q4: Explicit out-of-scope list?
R10-Q1: Daily LLM spend cap?
R10-Q2: Paper behavior on a REJECT look or the -5% epoch stop?
R10-Q3: Ratification of risk-rules.live.yaml with the ladder driving per-trade risk?
R10-Q4: Anything else / enough?
R11-Q1: Alpha spending across the four looks?
R11-Q2: REJECT boundary definition?
R11-Q3: Metric unit and shadow-vs-live pairing?
R11-Q4: Scorer-weight calibration variant cadence?
R12-Q1: Fingerprint vs four WPs landing mid-epoch?
R12-Q2: Veto and kill semantics?
R12-Q3: When does the paper epoch with its looks start?
R12-Q4: Anything else / enough?

## Answers Received

R1-Q1: **Two tracks** — execution on REAL money, daily statistics on what happened,
and a loop that refines the live trading. Wants **as much automated trading as possible**
(note: today live auto-execution is refused by construction — assertPaperOnly).
R1-Q2: **By end of September 2026** (~3.5 weeks from 2026-09-05).
R1-Q3: **Lower the trigger bar** AND **widen the funnel's inputs** (large-cap lane,
ATR-normalised significance ranking, vehicle-vs-constituent dedupe). NOT relaxing the
deterministic gates (noise-stop / entry-pricing / spread).
R1-Q4: **Yes — re-register a faster test** (sequential / early-stopping design replaces
the fixed n = 100).

R2-Q1: **Veto window** — live proposals auto-execute unless vetoed within N minutes
(WhatsApp/dashboard). Automated by default; per-trade human stop remains possible.
R2-Q2: **Throughput changes proven on paper first** — lower bar + slice-B must run on
paper ~2 weeks without breaking anything and show the new class isn't toxic.
R2-Q3: **Shadow variant promotion** — live runs the frozen policy; a candidate variant
runs in parallel (paper / shadow simulation); promoted only on a pre-registered criterion.
R2-Q4: **Scale with evidence** — start 0.25%, step up on pre-registered live milestones.

R3-Q1: **Execute unconditionally, window = 0 min by default; duration CONFIGURABLE.**
(i.e. full automation on live from day one; the veto window is a knob, not a gate;
silence = consent at any duration.)
R3-Q2: **In-process simulation** — one gateway on the live account; candidate proposals
simulated against real bars (limit-touch fills, stop/target/EOD exits); no second broker
session.
R3-Q3: **Not toxic + no incidents** — the newly admitted class (rank 60-75) net >= 0 after
commissions over its first ~20 trades, zero unresolved broker anomalies, EOD flat daily.
R3-Q4: **Trigger bar 60, cap 30 triggers/day** (~3x LLM evaluations vs today).

R4-Q1: **Drawdown cap + bootstrap looks** — hard stop at -5% NetLiq from the live epoch
start; a look every 25 live trades: clearly negative 95% LCB of expectancy -> stop live,
back to paper.
R4-Q2: **0.25 -> 0.5 -> 0.75 -> 1.0% at 25 / 50 / 100 live trades**; each step needs
net > 0 and no open stop-rule breach; drop one rung on any -5% drawdown from the last
step-up.
R4-Q3: **All four**: live fills + slippage vs plan; funnel counts per lane with refusal
split; shadow-vs-live comparison with the promotion criterion's running status;
sequential-test status (n, net, LCB, drawdown from epoch start, next rung).
R4-Q4: **Claude recommends, operator decides per case** — no fixed promotion formula;
evidence presented at each epoch boundary, operator ratifies or refuses.

R5-Q1: **All four**: ATR-normalised significance ranking; large-cap scan lane
(marketCapAbove $10B, lower move threshold); vehicle-vs-constituent dedupe; pre-market
session-appropriate spread + reaction-mover extension exemption in hour one.
R5-Q2: **Intraday only on live**; swings and earnings bets accrue their record in the
in-process simulator and are promoted like any variant.
R5-Q3: **Fingerprint + epoch file + journal line** — an epoch = performance-epoch reset +
a journal entry naming the fingerprint; no tag/manifest/TOFU ceremony.
R5-Q4: **WhatsApp digest + dashboard page**; veto and kill commands on both.

R6-Q1: **Live waits until the proof passes** — the not-toxic bar is the gate, not the
calendar; Claude diagnoses and proposes the next candidate.
R6-Q2: **Keep paper on port 4002 as it is now. Run the CURRENT PROCESS (the whole
two-track loop) on the paper account first; switch to the real account once evidence
is accrued.** (Nuances the timeline: end-September = loop machinery running on paper;
the live switch is an evidence-gated event, not a date.)
R6-Q3: **Only flipping the live-automation switch on/off is human-only.** Everything
else (step-ups, epoch resets, halt/stop handling) is automated. Conflict with R4-Q4
resolved in R7-Q1.
R6-Q4: **Sonnet 5 everywhere, configurable daily USD spend cap** — cap stops
evaluations only, never exits.

R7-Q1: **Human per case, on paper AND live** — Claude presents the evidence; the operator
says 'promote'. Everything else stays automated. (R4-Q4 holds; R6-Q3 amended.)
R7-Q2: **First passing look: n >= 25, net > 0, 95% LCB > 0, PF >= 1.3** on the paper
epoch — the re-registered sequential test's first ACCEPT flips the live switch.
R7-Q3: **Full rehearsal** — paper starts at the bottom rung (0.25%), runs the ladder,
the -5% stop and epochs.
R7-Q4: **All four by Sep 30 on paper**: throughput changes (bar 60, cap 30, slice-B x4,
per-band tagging); in-process simulator + shadow variants; sequential test + size
ladder + epoch machinery; live-autoexec plumbing switched OFF (fake-broker tested).

R8-Q1: **Conservative on 5-second stream bars** — limit entries fill only on trade-
through; stops fill at the worse of stop price / next-bar open (gap-aware); targets need
trade-through; IBKR commissions charged; source = stream-bars.db.
R8-Q2: **Retire the tag ceremony; reuse the scorecard as the look evaluator** —
VALIDATION-PROTOCOL.md gets a superseding section; scorecard gains a --look mode;
manifest/TOFU/--final code stays in git, dormant.
R8-Q3: **Automatic at EOD when n crosses a look** — nightly job runs the look, applies
step-downs / the -5% stop immediately, queues step-ups and promotion recommendations in
the digest.
R8-Q4: **Throughput first, WP by WP, operator reviews each** — order: throughput ->
simulator -> sequential/ladder/epoch -> live plumbing; gateway restart after each WP.

R9-Q1: **Keep 6 trades/day, 4 slots**; the auto-exec daily cap aligns to 6 (was 5).
R9-Q2: **All four shadow variants**: the 75-bar funnel as shadow of the 60-bar incumbent;
gate-off counterfactuals (full P&L for every deterministic refusal); exit-policy variants
(ratchet vs target, x 1.5 vs 2.0 ATR, stop x/2 vs x/3); swing + earnings-bet classes.
R9-Q3: **WhatsApp 'live on/off' persisted to a state file** (two-step confirmed; no .env
edit, no restart, not a fingerprint surface); **ladder restarts at 0.25% at cutover**.
R9-Q4: **OUT**: backtest-engine recalibration; new data sources (Polymarket, FRED,
options flow, social); options module / fractional shares / second broker.
**NOT excluded** (may be pursued as a shadow variant): scorer-weight calibration /
regime routing.

R10-Q1: **$10/day** — evaluations stop when exceeded; exits and triage never do.
R10-Q2: **Pause new entries; Claude proposes; operator ratifies a new epoch** — same as
live, so the rehearsal is faithful; exits and triage continue; the digest carries the
diagnosis and the candidate variant.
R10-Q3: **Ratify the yaml as-is now**; max_risk_per_trade_pct = min(yaml ceiling,
current rung); one journal line records the ratification.
R10-Q4: **Not yet** — one more round on the statistics design, and add scorer-weight
calibration as a registered shadow variant.

R11-Q1: **O'Brien-Fleming-style** — one-sided confidence 99% at n=25, 97.5% at 50,
96% at 75, 95% at 100; familywise false-ACCEPT ~5%.
R11-Q2: **95% one-sided UPPER bound of expectancy < 0** — symmetric with ACCEPT.
R11-Q3: **R-multiples, paired by trading day** — per-trade net P&L / planned risk at
entry; entry-cohort (day) bootstrap; shadow-vs-live = bootstrap of the daily difference
in summed R.
R11-Q4: **Re-fit at each look; the variant re-ranks the same candidates** — calibrated
weights re-score every scanned candidate; the simulator trades the variant's trigger
set; Spearman monotonicity reported alongside.

R12-Q1: **Narrow the fingerprint to behavior paths** — identity = scanner / scorer /
gates / executor / exits / prompts / rules / env; simulator, digest, ladder, dashboard
and scorecard code are observability and may change mid-epoch. Behavior WPs still start
a new epoch.
R12-Q2: **veto = cancel the unfilled entry; kill = close at market** — 'veto P-XXXX'
inside the window cancels the resting entry (a filled entry stays, protected);
'kill SYMBOL' closes via the existing safe close path; 'live off' pauses intake.
R12-Q3: **At the throughput WP restart** — performance reset + journal line when bar 60 /
cap 30 / slice-B go live on paper (~Sep 10); today's 6 epoch trades become pre-epoch.
R12-Q4: **Enough — finalize.**

## Emerging Requirements — FINAL SYNTHESIS (2026-09-05, 12 rounds, 48 questions)

### The decision in one paragraph
The fixed n = 100 frozen-sample protocol is RETIRED as the go-live gate. It is replaced by
a two-track loop rehearsed on the paper account first: a widened funnel produces more
evaluated candidates; every proposal and every registered candidate variant is also
simulated conservatively against real bars; a pre-registered sequential test with
O'Brien-Fleming-style looks decides ACCEPT / REJECT / step-ups; a size ladder scales
risk with evidence; a nightly digest reports it all. The FIRST paper ACCEPT look (n >= 25)
is the evidence that lets the operator flip the live switch. Live trading is automated by
default (veto window 0 min, configurable); the operator's only per-trade power is veto/
kill, and the only human-only acts are the live switch and shadow-variant promotions.

### Timeline (target)
- Sep 5-10: WP1 throughput lands (bar 60, cap 30, slice-B x4, per-band tagging, yaml
  ratified as ceiling, bottom-rung 0.25%). Gateway restart = performance reset = paper
  epoch 1 starts (journal line with the fingerprint).
- Sep 10-24: not-toxic proof of the 60-75 class (net >= 0 after commissions over its
  first ~20, zero unresolved anomalies, flat by close daily). WP2 simulator, WP3
  sequential/ladder/epoch, WP4 live plumbing (OFF) land during this window — they are
  observability under the narrowed fingerprint and do not end the epoch.
- Sep 30: all four WPs RUNNING on paper. Live cutover = evidence-gated (first ACCEPT
  look), NOT a date. If the proof fails, live waits; Claude diagnoses and proposes.

### Requirements by work package
WP1 — Funnel throughput (behavior; starts epoch 1)
- OPP_TRIGGER_SCORE 75 -> 60; OPP_TRIGGER_MAX_PER_DAY 10 -> 30 (env, fingerprinted).
- Slice-B x4: ATR-normalised significance ranking (dayMove%/dailyATR%, dollar volume);
  large-cap scan lane (marketCapAbove $10B, lower move threshold); vehicle-vs-constituent
  dedupe (never trade a 3x ETF against its own constituents; surface the underlyings);
  session-appropriate spread for orders queued into the open + reaction-mover exemption
  from extension muting in hour one.
- Per-band tagging on proposals (trigger rank band at creation) so the 60-75 class is
  measurable apart; refusal ledger unchanged.
- Caps unchanged: 6 trades/day, 4 slots; AUTO_EXECUTE daily cap 5 -> 6.
- risk-rules.live.yaml ratified as the CEILING (journal line); effective per-trade
  risk = min(yaml, rung); paper starts at rung 0.25%.
- LLM_DAILY_SPEND_CAP_USD = 10 (evaluation lanes only).
WP2 — In-process simulator + shadow-variant registry (observability)
- Conservative fills on 5-second stream bars (trade-through entries/targets, gap-aware
  stops at worse of stop/next-open, IBKR commissions); bias labelled pessimistic.
- Every proposal simulated (live/paper trade AND its sim twin); registry v1: funnel-75,
  gate-off (per deterministic gate), exit-ratchet, exit-x2.0, stop-x/3, class-swing,
  class-earnings-bet, weights-calibrated (re-fit at each look, re-ranked trigger set).
- No extra LLM calls: variants are subsets / re-geometries of existing proposals.
WP3 — Sequential test + ladder + epoch machinery (observability + risk overlay)
- scorecard --look: unit = R per trade (net P&L / planned risk at entry); entry-day
  bootstrap 1000 reps seed 42; looks at n = 25/50/75/100 with one-sided LCB confidence
  99 / 97.5 / 96 / 95%; ACCEPT = LCB > 0 AND net > 0 AND PF >= 1.3; REJECT = 95%
  one-sided UCB < 0; hard stop = -5% NetLiq from epoch start (any time).
- Ladder 0.25 -> 0.5 -> 0.75 -> 1.0% at 25/50/100 with net > 0 and no breach;
  automatic step-down on -5% from the last step-up; step-ups queued for ratification.
- Stop/REJECT semantics (paper and live identical): intake paused, protection/triage/
  guardian continue, digest carries Claude's diagnosis + candidate; new epoch only on
  operator ratification (performance reset + journal line naming the fingerprint).
- Shadow-vs-live: bootstrap of the daily summed-R difference; promotion RECOMMENDATION
  needs >= 30 shadow trades and >= 10 days; promotion itself is human ('promote').
- Nightly job after EOD triage runs the look and the ladder logic automatically.
- Fingerprint narrowed to behavior paths (scanner/scorer/gates/executor/exits/prompts/
  rules/env); observability code excluded; scorecard's tag/manifest/TOFU/--final paths
  dormant; VALIDATION-PROTOCOL.md gets a superseding section; FREEZE-MANIFEST retired.
- Daily digest (WhatsApp + dashboard page): live fills + slippage vs plan; funnel counts
  per lane with refusal split by gate; shadow-vs-live; sequential-test status
  (n, net, LCB, drawdown from epoch, next rung); score-decile monotonicity.
WP4 — Live-automation plumbing, switched OFF (behavior surface, fake-broker tested)
- Replace assertPaperOnly with an explicit live switch: WhatsApp 'live on/off'
  (two-step confirmed), persisted to a state file, off by default, human-only to turn ON;
  the system may turn it OFF itself (-5% stop, unresolved anomaly).
- Veto window LIVE_VETO_WINDOW_MIN default 0 (execute unconditionally), configurable;
  silence = consent at any duration; entries only — exits/EOD/guardian stay automated.
- 'veto P-XXXX' cancels an unfilled entry; 'kill SYMBOL' closes via the safe close path.
- Live deployable scope = intraday only; swing/earnings-bet stay disabled on live and
  run only in the simulator. Cutover restarts the ladder at 0.25%.

### Human boundary (everything else is automated)
1. Turning the live switch ON (and any .env/port/2FA act at cutover).
2. 'promote' a shadow variant (paper and live) — starts a new epoch.
(Step-ups are ratified from the digest; step-downs, stops, halts, resets are automatic.)

### Scope fence (September)
OUT: backtest-engine recalibration on FirstRate; new data sources (Polymarket, FRED,
options flow, social); options / fractional shares / second broker; relaxing the
deterministic gates (their counterfactuals say no: noise-stop 37 would-stop vs 13
would-target since the epoch).
IN but later: scorer-weight calibration only as the weights-calibrated shadow variant.

### Delivery
Throughput first, WP by WP, one commit each, SPEC.md REQ-* traceability, bun + jest
green, operator review + gateway restart at each boundary; no push (Boundary).

### Gaps not covered (operator declined further rounds; settle in SPEC/PLAN)
- Dashboard page and digest line-by-line layout.
- Simulator edge cases: partial fills, halts, missing 5-second bars, extended-hours
  entries, symbols not streamed (fallback to 1-minute archive?).
- Cutover-day checklist: live IB Gateway login on 4001, account verification, first-day
  limits, rollback to paper.
- Ops still pending from before: CallMeBot watchdog activation; the runtime attestation
  read accountType 'unverified' at 10:20 today (verify it settles after boot).
