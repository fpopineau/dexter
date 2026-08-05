# Research memo — "Signal or Noise in Multi-Agent LLM-based Stock Recommendations?" (arXiv:2604.17327)

**Status:** analysis recorded 2026-08-05 · no protocol commitment yet · companion note (French) in the Obsidian vault: `00-Inbox/2026-08-05 Signal or Noise in Multi-Agent LLM-based Stock Recommendations — analyse et pertinence dexter.md`

Fatouros & Metaxas (Alpha Tensor Technologies), submitted 2026-04-19. 22 pp.
Paper: <https://arxiv.org/abs/2604.17327>

---

## 1. What the paper shows

First portfolio-level validation of **MarketSenseAI**, a deployed multi-agent
LLM equity system: four specialist agents (News, Fundamentals, Dynamics,
Macro) → synthesis agent → monthly five-point ordinal recommendation per
stock. All signals generated **live** at each observation date (no
retro-generation), which is the paper's central anti-look-ahead safeguard.

Headline numbers:

| | S&P 500 cohort | S&P 100 cohort |
|---|---|---|
| Window | 19 mo (Sep 2024–Mar 2026) | 35 mo (May 2023–Mar 2026) |
| Strong-buy EW portfolio | +2.18 %/mo | +2.02 %/mo |
| Passive EW benchmark | +1.15 % (≈RSP) | +1.47 % (EQWL) |
| Compound excess | +25.2 pp | +30.5 pp |
| MC null (10k same-size random portfolios) | 99.7th pct, p=0.003 | p=0.17 (n.s.) |
| Picks/month | ~35 | ~10 |
| Ordinal-score ICIR | +0.489 (p=0.024) | — |

Attribution via **NNLS projection of thesis embeddings onto agent
embeddings** (text-embedding-3-small, reconstruction cos 0.944): adaptive
integration, agent weights rotate with regime (Fundamentals leads S&P 500,
Macro S&P 100, Dynamics episodic momentum), rotation co-moves with sector
composition and macro calendar. Striking: the **News agent has the highest
thesis cosine (0.903) but ~zero pooled IC (+0.004)** — it supplies
narrative, not signal; Fundamentals and Macro carry the IC.

## 2. Critique (what to trust, what not)

Strengths: live generation (gold standard), honest reporting (S&P 100
non-significance, "pooled IC directional only"), same-size MC null, fixed
cohort.

Weaknesses:

1. 19 months, one broadly bullish regime; ICIR barely clears the T=19
   significance threshold (0.489 vs 0.47).
2. **No factor regression.** Picks are tilted Financials (+6.7 pp) then IT;
   the MC null preserves size but not sector tilts, so part of the excess
   may be replicable sector timing. "Alpha beyond classical factors" is
   asserted, not established.
3. No transaction costs / turnover / capacity (minor at monthly cadence on
   S&P names, but unquantified).
4. "Continuously present" cohort = mild survivorship.
5. NNLS attribution is semantic, not causal (agent-agent cosines 0.46–0.79;
   no ablation-by-resynthesis).
6. S&P 100 window predates LLM training cutoffs → partial contamination
   risk, acknowledged.

## 3. Fit with day2day: the mismatch that matters

MarketSenseAI is a **monthly, fundamentals/macro, buy-and-hold stock
picker**. day2day is **intraday/overnight**, with a deterministic
opportunity engine (4-factor scorer) doing the heavy lifting and the LLM
confined to scheduled/triggered judgment, human-gated bracket execution,
and a labeled-outcome tracker.

Consequently **do not import the content-level conclusions**. "News ≈
noise, Fundamentals/Macro = signal" is a 1-month-horizon result; at
day2day horizons the ordering plausibly inverts (news catalysts and
momentum dominate; fundamentals are ~constant within a day). Horizon-
dependent facts must be measured in-house, not transferred.

What transfers is the **methodology**: the paper's title question, asked
precisely of our stack, becomes — *does the LLM judgment layer add value
over the deterministic scanner alone?*

## 4. Reuse options

### R1 — Counterfactual null for proposals (highest value, small change)

Adapt the paper's same-size MC null: at each proposal, compare against
random same-size draws from the opportunity engine's candidate pool at the
same timestamp. If LLM proposals don't beat this null net of commissions,
the judgment layer is expensive narration.

- Missing link: proposals don't currently pin the engine snapshot they were
  drawn from. Add a `snapshotId` (or timestamp key into `opportunities.db`)
  to `src/services/trade-proposals.ts` rows at creation, and extend
  snapshot retention beyond 7 days (archive alongside `market-archive.db`).
- Analysis is then an offline script replaying candidate pools through
  `market-archive.db` bars (and later the real-fill ledger), no IBKR calls.
- Effort: small schema change + one analysis script. Do the schema change
  **now** so data accrues; the test itself waits for sample size (see R4).

### R2 — Component-level IC at native horizons

The paper's per-agent IC analysis, mapped to our signal sources: each
scorer factor (momentum / mean-reversion / volume / trend), RVOL, GDELT
sentiment, catalyst-news flags — IC vs forward returns at 30 min / EOD /
overnight, from `opportunities.db` snapshots × `market-archive.db` bars.

- Extends `scripts/calibrate-scorer.ts` (which already grid-searches
  weights on OOS Sharpe) with an IC/ICIR report per component per session
  phase (open-drive vs midday vs pre-close).
- Directly tests whether the News/GDELT layer carries intraday signal —
  the in-house answer to the paper's News-is-noise finding.

### R3 — NNLS embedding attribution for briefs (observability)

Embed the tool outputs consumed by a brief (scanner summary, TA, risk,
news) and the brief's final recommendation text; NNLS-project the latter
onto the former. Cheap monitor of "which input drives the judgment" and
how that rotates across session phases / regimes.

- Inputs already exist in the scratchpad JSONL (`.dexter/scratchpad/`,
  `llmSummary` fields). Needs an embedding pass + small script.
- Caveat from the critique: semantic attribution, not causal. If a
  decision hinges on it, confirm with ablation (re-run brief minus one
  input) — which our isolated agent runs make easy, unlike the paper.

### R4 — Pre-registered evaluation protocol (power discipline)

The S&P 100 lesson (~10 obs/month ⇒ p=0.17 despite +30 pp) translates
here as: no verdict before enough labeled outcomes. The PLAN.md ML
roadmap's ≥500-outcome threshold (phases 6–7) is the right order of
magnitude.

- Before the data exists, freeze a short protocol doc (this directory):
  primary metric (net P&L of proposals vs R1 null distribution; win rate
  secondary), blocked bootstrap over trading days, α, kill/stop rules.
  Same discipline as the ActivTradesFX predictor-study protocol.
- The paper also validates our live-first stance: signals generated live
  and archived beat any retro-generated backtest for credibility.

### R5 — Optional: monthly conviction filter upstream of `overnight`

A MarketSenseAI-style monthly fundamental/macro conviction score could
bias the `overnight` skill's universe (long-bias only in top-conviction
names). Different product, different horizon — park it as a candidate
experiment, not a validation of day2day.

### R6 — Explicit non-transfers

- Do **not** downweight news/GDELT on the paper's authority (horizon
  mismatch — measure via R2).
- Do **not** cite the paper's p=0.003 as evidence that LLM judgment works
  intraday; it is evidence for monthly fundamental synthesis in one
  regime, without factor controls or costs.

## 5. Suggested order

1. R1 schema change (start accruing counterfactual data immediately).
2. R2 IC report as a calibrate-scorer extension.
3. R4 protocol doc frozen before outcome count approaches the threshold.
4. R3 when observability becomes a question; R5 backlog.
