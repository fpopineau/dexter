# Research memo — External news as signal: GDELT and prediction markets (Polymarket/Kalshi)

**Status:** research recorded 2026-08-05. Deep-research harness completed
search + claim extraction; the adversarial verification phase failed on an org
resource limit. Tags: **[K]** = consistent with independently known
literature/documentation, **[U]** = extracted from the cited source, not
re-verified. Companion vault note (FR):
`00-Inbox/2026-08-05 News externes GDELT-Polymarket — recherche.md`.

**Operational question:** does a GDELT / prediction-market layer deserve a
slot in the live scorer (today 4 technical factors), or should it stay in
backtest/brief-context?

**Verdict up front:** two different products, two different answers.
- **GDELT stock-level sentiment → not live yet.** Published evidence is at
  daily/monthly horizons and mostly index-level; stock-level intraday
  evidence for GDELT specifically is thin, and our entity→ticker mapper
  doesn't exist yet. Keep it in the backtest lane; gate any live entry on
  measured in-house IC (protocol below).
- **Polymarket/Kalshi macro probabilities → yes, but as episodic context,
  not a scoring factor.** The credible evidence is about *event windows*
  (FOMC, CPI, elections, weekend gaps) where prediction markets demonstrably
  lead; between events, liquidity is too thin for a continuous factor. This
  fits the Pre-Market Brief and the `overnight` skill's gap-risk assessment —
  i.e., the planned §4.3 `prediction-markets` tool, consumed by the judgment
  layer, not by the scorer.

---

## 1. GDELT: what the evidence supports

- [U] An arXiv preprint ([2505.16136](https://arxiv.org/html/2505.16136v1))
  runs a pipeline **nearly identical to ours** (GDELT v2 2015→2025, CAMEO
  economic/policy codes, top-100 events/day by num_articles, headline-only
  sentiment via FinBERT) and reports next-day FX/rates Sharpe of 4.6–5.9
  cost-adjusted. Two readings: (a) our parquet design is a recognized
  research shape; (b) Sharpe >5 on a daily macro signal is a **red flag** —
  treat as likely look-ahead/overfitting until reproduced, never as a prior.
- [U] BBVA Research ([paper](https://www.bbvaresearch.com/wp-content/uploads/2022/07/News-Media-Sentiments-from-Big-Data-with-author-info.pdf)):
  GDELT GKG daily tone/attention measures predict next-day **aggregate**
  Chinese index returns (in-sample 1 %-level significance; OOS improvement
  over EGARCH baseline). Index-level, daily — encouraging, not stock-level.
- [U] RavenPack-based factor study (~5,350 global stocks, 2000–2017):
  long-short news-sentiment quintiles earn ~3.8–4.3 %/yr (t>4) at **monthly**
  rebalance. Shows news sentiment carries stock-level information, but the
  documented horizon is monthly — no direct intraday/overnight evidence.
- [K] Known GDELT-specific frictions (all already flagged in our docs):
  15-min publication latency + additional gap between event time and GDELT
  timestamp; **entity→ticker mapping** unsolved (our planned EDGAR mapper is
  the prerequisite); headline re-scraping is a **look-ahead + survivorship
  hazard** (dead URLs, edited headlines, Wayback fallback lossy) — our parquet
  headlines were fetched months after the events for old data.
- Net: GDELT's comparative advantage for us is *macro/geopolitical event
  density and its 2015→ backtest depth*, not ticker-level intraday sentiment.
  Benzinga-sourced feeds are the cheaper path to ticker-level news (see §3).

## 2. Prediction markets: what the evidence supports

- [U] Kalshi Fed-funds contracts ([SWW 2025](https://yanbinwu.com/research/SWW_FedContract2025.pdf)):
  prices incorporate FOMC/macro news within minutes and track CME fed funds
  futures; **liquidity concentrates at-the-money** (≈1¢ spreads ATM, wide at
  tails); typical activity ~6 trades/day, ~$1.2k/day per contract → stale
  minute-level prices outside announcement windows.
- [U] A Fed staff paper (Diercks, Katz & Wright, "Kalshi and the Rise of
  Macro Markets", via [Forbes](https://www.forbes.com/sites/jasonbrett/2026/02/23/kalshi-polymarket-offer-evolution-of-predictions-for-fed-wall-street/)):
  Kalshi matched/outperformed Bloomberg & Blue Chip surveys and fed funds
  futures; identified the modal Fed outcome ahead of every FOMC since 2022.
- [U] 2024-election microstructure ([price-discovery study](https://www.researchgate.net/publication/408443600_Price_Discovery_across_Political_Prediction_Markets_Evidence_from_the_2024_US_Presidential_Election)):
  Polymarket dominated political price discovery (with Betfair/Kalshi ~85 %
  of information shares); on election night Polymarket reached 50 % of its
  move **25 min before ES futures** (>3 h at completion); weekend information
  accumulating on Polymarket predicted overnight equity gaps (DJT overnight
  regression β=0.36, R²=0.22; assassination-attempt weekend: +11.5 pp while
  CME closed).
- [U] Caveats: naive Polymarket volume figures overstate activity ~2.5×
  (mint/burn vs real turnover, [arXiv 2603.03136](https://arxiv.org/abs/2603.03136));
  election-night lead is a headline anecdote from the deepest market ever run
  — do not generalize to thin markets. [U] A Dec 2025 paper finds Polymarket
  earnings markets less biased than analyst consensus — interesting for
  earnings-window context on covered names.
- Net: prediction markets are credible **event-window macro probability
  sensors** (free APIs, both venues), with documented depth limits between
  events. That is exactly the shape of a brief-context tool, not a
  continuous per-stock factor.

## 3. Cheaper ticker-level news alternatives (context)

- [K] **Alpaca News API = Benzinga content**, free with an Alpaca account:
  real-time WebSocket + historical REST — the obvious first ticker-level news
  feed for both live briefs and backtests.
- [U] Benzinga direct: ~600–900 headlines/day real-time, TCP/REST/RSS
  (enterprise pricing). [U] sec-api.io: real-time EDGAR 8-K/Form-4 WebSocket,
  ~$49–55/mo. Both are upgrades to consider only after the free Benzinga-via-
  Alpaca layer proves IC.

## 4. Methodological pitfalls checklist (for any test we run)

1. Headline re-scraping look-ahead (current headline ≠ headline at event
   time); URL survivorship (dead links bias toward big outlets/stories).
2. GDELT timestamp ≠ publication time ≠ event time; align conservatively
   (trade only after `gdelt_ts + one full 15-min cycle`).
3. Entity→ticker mapping errors create false signal concentration in
   mega-caps (name-collision bias).
4. Polymarket/Kalshi: use book depth, not volume; beware of markets created
   *after* the event became likely (listing bias); fees/spread on thin books.
5. Single-event anecdotes (election night) are existence proofs, not
   expected edge.

## 5. Test protocol (pre-registrable, uses only what we own)

- **P1 — GDELT macro event-study (no ticker mapping needed).** From the
  cleaned parquet (2015→2025-09): event-day tone/attention aggregates →
  forward returns of SPY/sector ETFs at 30 min / EOD / overnight, from the
  1-min archive (backfill SPY/sector ETFs via `scripts/backfill-bars.ts`).
  Blocked bootstrap CIs; report IC by horizon and by CAMEO class. Cost: ~0.
- **P2 — GDELT stock-level (blocked on EDGAR mapper).** Once
  `src/ml/entity-mapper.ts` exists: per-ticker daily tone → IC vs
  overnight/next-day returns, purged CV, vs the RavenPack monthly benchmark
  as sanity floor. Only a pre-registered IC pass admits it to live scoring —
  same gate as every other factor (cf. RESEARCH-signal-or-noise R2/R4).
- **P3 — Prediction-market accrual (start now, judge later).** Build the
  planned `prediction-markets` tool read-only: poll Polymarket/Kalshi free
  APIs on a fixed macro-event watchlist (FOMC, CPI, NFP, elections,
  geopolitics), log probabilities + book depth to SQLite daily. After ≥6
  months: overnight-gap regressions (index/sector) on close-to-open
  probability changes. Meanwhile the live feed can already serve the
  Pre-Market Brief and `overnight` skill as *advisory context* — no scoring
  weight, so no statistical gate needed.
- **P4 — Benzinga-via-Alpaca ticker news.** Free: log the stream for the
  watched universe; measure catalyst-flag IC on scanner candidates (does
  "has fresh news" improve top-N forward returns?). This is the cheapest
  path to a live news factor and doubles as the trigger-evaluation catalyst
  source.

## 6. Bottom line

Keep the scorer technical for now. Start the two zero-cost accruals (P3
probability logging, P4 news-stream logging) immediately — they only produce
value with elapsed time. Run P1 on the archive this month. Everything enters
live scoring through the same pre-registered IC gate; until then GDELT stays
a backtest asset and prediction markets stay brief-context.
