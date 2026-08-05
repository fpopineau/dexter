# Research memo — Stock screening for day2day/overnight: can we beat the IBKR scanner?

**Status:** research recorded 2026-08-05. Deep-research harness completed the
search + claim-extraction phases; the adversarial verification phase failed on
an org resource limit, so claims are tagged: **[K]** = consistent with
well-established literature/documentation independently known, **[U]** =
extracted from the cited source but not re-verified. Companion vault note (FR):
`00-Inbox/2026-08-05 Screening day2day — recherche.md`.

**Verdict up front:** yes — a home-built screener that dominates the IBKR
scanner is feasible at retail budget. The IBKR scanner's hard caps (breadth,
no attached market data, fixed scan codes) are documented limits, and
full-market snapshot data is purchasable for $29–$99/mo. The edge of a DIY
screener is not latency; it is **breadth (5,600+ vs ≤50 rows), composability
(arbitrary criteria incl. archive-derived baselines), and historizability
(backtestable scans)** — exactly the three things scan codes cannot give us.

---

## 1. What the IBKR scanner actually caps

- [K] TWS API scanner: **max 50 rows per scan code**, max 10 concurrent
  scanner subscriptions → ~500 rows total across all scans; our engine
  effectively works with ~25/scan. ([TWS docs](https://interactivebrokers.github.io/tws-api/market_scanners.html))
- [K] Scanner rows carry **no market data** (no bid/ask/last/volume) — every
  quote requires separate `reqMktData` calls under pacing/market-data-line
  limits. The engine sees the scanners' view of the tape, not the tape.
- [U] Web API pacing (if we ever migrate): 50 req/s global,
  `/iserver/scanner/run` 1 req/s, snapshots 10 req/s, history 5 concurrent.
  ([IBKR Web API pacing](https://www.interactivebrokers.com/docs/web-api/trading/usage-and-availability/pacing-limitations))

Conclusion: IBKR is fine as the **execution + top-N streaming** backbone; it
is structurally incapable of full-market composable scanning.

## 2. Screening criteria with empirical support at our horizons

Ranked by strength of evidence and fit to day/overnight:

1. **Overnight/intraday return decomposition** — [K] Lou, Polk & Skouras
   (JFE 2019, ["Tug of War"](https://personal.lse.ac.uk/polk/research/TugOfWar.pdf)):
   momentum profits accrue almost entirely **overnight** (overnight CAPM alpha
   ~0.98 %/mo, t=3.84; intraday ≈ 0); stocks sorted on past overnight returns
   show hugely persistent overnight alpha (+3.47 %/mo, t=16.8) offset
   intraday; the smoothed overnight-minus-intraday spread itself predicts
   strategy returns. → a per-symbol overnight/intraday decomposition computed
   from our own 1-min archive is a *cheap, evidence-backed feature* the IBKR
   scanner cannot express. Directly relevant to the `overnight` skill's
   long/short bias.
2. **Open inflation / morning reversal in attention stocks** — [K] Berkman,
   Koch, Tuttle & Zhang ([SSRN 1625495](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1625495)):
   systematically positive overnight returns then intraday reversal,
   concentrated in **high retail-attention** names with heavy at-open retail
   buying. → warning label for overnight longs in the very names our gap/RVOL
   scans surface; suggests a fade-the-open screen variant.
3. **Intraday momentum (index level)** — [K] Gao, Han, Li & Zhou (JFE 2018):
   first half-hour return predicts last half-hour (SPY, 1993–2013),
   statistically and economically significant. → session-context feature
   (regime flag for the day-trade skill), not a stock ranker.
4. **Daily short-sale flow** — [K] Diether, Lee & Werner-line result
   ([paper](https://www.cis.upenn.edu/~mkearns/finread/short_sellers_predict_returns.pdf)):
   1σ increase in relative short volume ⇒ ~2.9 bp lower next-day abnormal
   return; decays within ~a week; **gross-only** (execution costs ~6.2 %/mo
   kill the naive long-short). FINRA daily short-volume files are free. →
   viable *ranking feature* (not standalone strategy) at exactly our horizon.
5. **PEAD / earnings drift** — [K] survey evidence ([Fink 2020](https://static.uni-graz.at/fileadmin/sowi/Working_Paper/2020-04_Fink.pdf)):
   drift horizon is weeks-to-quarters (mismatched to ours), magnitude
   declining over time, exploitability post-costs disputed. → keep earnings
   as **event context** (we already have the Nasdaq calendar wired), not as a
   drift-capture screen.
6. Practitioner staples already in the engine (gap %, RVOL, trade-rate) are
   consistent with 1–2 above; the upgrades the literature suggests are
   *per-minute-of-day RVOL baselines* (vs naive daily ratios) and *float
   rotation*, both computable from our archive + universe.json market caps.

## 3. Data sources for full-market scanning (retail budget)

| Source | Cost | Full-market? | Latency | Notes |
|---|---|---|---|---|
| IBKR scanner | $0 (sub) | ✗ (≤50/scan) | RT | current engine; keep for execution/stream |
| **Alpaca Algo Trader Plus** | **$99/mo** | ✓ (SIP, unlimited ws symbols, 10k req/min) | RT | [U] the budget-compatible real-time option ([docs](https://docs.alpaca.markets/us/docs/about-market-data-api)); free tier is IEX-only (~small % of volume → RVOL/gap distortion) + 30 ws symbols + 15-min history embargo |
| **Polygon/Massive snapshot** | $29/mo (Starter) | ✓ (~10k tickers, **one REST call**, per-ticker OHLCV + minute bar + prev day + change fields) | **15-min delayed** on Starter/Developer; RT needs Advanced $199 | [U] ideal for pre-market/EOD/overnight scans where 15 min doesn't hurt ([docs](https://polygon.io/docs/stocks/get_v2_snapshot_locale_us_markets_stocks_tickers)) |
| Finviz Elite / Trade-Ideas / TradingView | $40–$120+/mo | UI products | RT-ish | no proper APIs / expensive; not automation-grade — [K] general knowledge, not re-verified |
| EODHD / FMP | $20–$60/mo | ✓ EOD | EOD | fine for nightly universe stats, not live scanning |

Decision shape: **latency-tiered hybrid.**
- Open-drive (09:30–10:30) is the only phase where real-time breadth matters →
  either accept IBKR's narrow-but-RT view there, or pay Alpaca $99.
- Pre-open, midday, pre-close, overnight → Polygon Starter's $29 delayed
  full-market snapshot is strictly better than 10 scan codes.
- Cross-check note: DATA-SOURCES §6.2 already picked Polygon Starter as the
  one-month bulk-history buy; the same subscription covers snapshot scanning.

## 4. Proposed architecture (screener v2)

1. **Universe:** `universe.json` (~5,600 names, EDGAR caps) — already built.
2. **Ingest:** one snapshot poll per engine phase cadence (Polygon: 1 call;
   Alpaca: paginated REST or ws) → full-market frame in memory.
3. **Features:** composable criteria computed in TS against the frame +
   SQLite baselines: gap %, RVOL vs same-minute 20-day baseline, VWAP
   deviation, ATR-normalized range, overnight/intraday decomposition (rolling,
   from archive), short-flow percentile (FINRA daily file), float rotation,
   earnings-window flag. The existing 4-factor scorer becomes one feature
   among several.
4. **Rank + snapshot:** same `opportunities.db` pattern (extended schema),
   which makes the screener **historized and backtestable by construction** —
   the property the counterfactual-null memo (RESEARCH-signal-or-noise R1)
   needs anyway.
5. **Shadow evaluation before switch:** run screener v2 next to the IBKR
   scanner for N weeks; compare candidate sets (overlap, uniques) and forward
   returns of top-N via the existing outcome/backtest machinery. Replace only
   on measured superiority — same discipline as everything else.

## 5. Open items

- Re-verify [U] pricing/caps before purchase (vendor pages change).
- Decide the open-drive latency question ($99 Alpaca vs IBKR-narrow) after
  the shadow run quantifies what breadth is worth in that phase.
- FINRA short-volume ingestion script (free, daily, trivial).
