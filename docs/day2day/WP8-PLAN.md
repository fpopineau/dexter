# WP8 PLAN — Lane-conditional discovery and scoring

EPHEMERAL (ADF PLAN gate). Absorbed into SPEC.md § "Lane-conditional
discovery and scoring (2026-09-05) — WP8" at landing; delete at the review.
Contract: REQ-DISC-001..006 (AUD-08; the discovery half of AUD-07 that WP5
left open). Delivery: one commit, `bun test` + `tsc --noEmit` + Jest green,
operator review. No push. Lands before epoch 1 opens. The intraday ranking
and the trigger bar are NOT changed (the ratified funnel stays; changing
them mid-programme would re-open the operator's decision).

## Design in one paragraph

One generic composite (four flat-weighted factors + an RVOL bonus + a
family bonus) ranks every candidate for every consumer: the Pre-Close
Review picks overnight holds off a list built for intraday momentum, the
digest's "score deciles" pools the model's confidence scores across lanes
whose scores mean different things, and no harness validates a lane's
ranking against outcomes chronologically and independently of any weight
choice. WP8 (1) adds versioned, pure, per-lane RANKERS whose factors and
weights are visible in code — the overnight lane gets an EOD-continuation
ranker (significance in ATR units, closing strength vs VWAP, liquidity,
RVOL; deterministic exclusions with reasons), the intraday lane keeps the
composite under the name `composite-v1`, the cup lane keeps the detector
score under `detector-v1`; (2) publishes the overnight ranking inside every
opportunity snapshot and through the `opportunities` tool (`lane:
"overnight"`), which the Pre-Close Review now reads; (3) stamps the lane
rank and the ranker version on every proposal SERVER-SIDE (never from the
model) and carries them into the epoch sample; (4) replaces the pooled
"score deciles" with per-lane rank→R lines (never pooled across lanes),
provenance shown; (5) ships a chronological validation harness that reads
the ledger and the WP7 candidate archive per lane, splits by day
(selection / validation), and reports rank→R and top-tercile lift on each
half — the pre-registered pass any reweighting must clear. Sizing
confidence stays flat (it already is on the live profile).

## Task graph

| T | Scope (REQ) | Files | Tests (red first) |
|---|---|---|---|
| T1 | Lane rankers | NEW `src/services/lane-rankers.ts` — `RANKER_VERSIONS`, `rankOvernight(opps)` (score 0–100 with factor breakdown + exclusions), `laneRankFor(strategyId, symbol, sources)` (server-side provenance resolution), `buildSnapshotLanes(opps)` | NEW `lane-rankers.test.ts` — factor pins, exclusions, ordering, provenance per lane |
| T2 | Snapshot + tool | `opportunity-engine.ts` — `OpportunitySnapshot.lanes` (additive, persisted); `tools/opportunities/index.ts` — `lane` param returns the lane ranking with reasons | engine test untouched (additive); tool shape by type |
| T3 | Provenance on proposals | `trade-proposals.ts` — columns `lane_rank REAL`, `ranker_version TEXT` (+ type, row, insert); `tools/proposals/index.ts` — resolves both server-side (trigger rank / snapshot lane score / pattern score); `loop/sample.ts` + `RTrade` carry them | `trade-proposals.test.ts` (persisted), fixture updates |
| T4 | Cohort-only comparability | `loop/looks.ts` — `rankByLane` (per lane: rankerVersion, Spearman rank→R, n) replaces `decile`; `digest.ts`, `validation-scorecard.ts`, fixtures | `looks.test.ts` (per-lane, never pooled), `digest.test.ts` |
| T5 | Candidate archive provenance | `candidate-archive.ts` — overnight rows take the lane score and `ranker_version` (column) when the snapshot carries lanes; else the composite with `composite-v1` | `candidate-archive.test.ts` |
| T6 | Consumers | `trading-schedules.ts` Pre-Close message, `src/skills/overnight/SKILL.md` 4.1 read `opportunities` lane "overnight" | — |
| T7 | Chronological harness | NEW `scripts/validate-lane-ranker.ts` — per lane: ledger rows with `lane_rank` and the overnight candidate twins; chronological split by day (first 60 % / last 40 %); Spearman rank→R and top-tercile mean R vs rest on each half; provenance line (ranker versions, scorer weights source); "insufficient" under n < 20 per half; never writes | — (read-only; smoke-run) |
| T8 | Docs + SPEC | AUTOMATION (engine lanes, tool), USER-MANUAL (digest line, tool), SPEC landing + traceability | — |

## Decisions taken in this plan (ratify at review)

1. Overnight ranker v1 (`eod-continuation-v1`): score = significance
   (0–40: |day move| / daily ATR %, linear to 3× ATR) + closing strength
   (0–20: price vs VWAP toward the direction, linear to +2 %) + liquidity
   (0–20: log10 dollar volume from $1M to $100M) + RVOL (0–20: linear to
   3×). Exclusions (score null, reason listed): stale data, price missing,
   ATR missing, day move unknown, counter-move. These are the WP7
   eligibility rules re-used as ranking inputs; earnings are NOT a ranking
   factor (the archive and the review exclude them separately).
2. The intraday composite is unchanged and named `composite-v1`; its weight
   provenance is the scorer's `weightsSource`. The trigger rank is the
   intraday lane rank. Cup-and-handle uses the detector score
   (`detector-v1`). Swing and earnings-bet carry no lane rank (null).
3. Lane rank and ranker version are stamped server-side at creation from
   the latest snapshot / pattern scan / trigger context; the model cannot
   pass them. A symbol absent from the snapshot gets null (recorded).
4. The pooled "Score deciles" line is retired: rank→R is reported per lane
   from the lane rank, the legacy lane from the model's score (its only
   rank), and never pooled. Fewer than 5 rows → "n/a".
5. Sizing confidence stays flat (live profile already 1.0/1.0); the T7
   harness is the pre-registered pass any change must clear.
6. No new discovery scans in WP8 (an intraday pullback lane needs its own
   scan family — recorded as a non-goal, with the WP7 archive as the place
   to measure it first).

## Verification

`bun test`, `tsc --noEmit`, Jest under real Node; the T1 factor pins and
the T4 per-lane test are the acceptance evidence; the T7 script smoke-runs
against the live data directory read-only.
