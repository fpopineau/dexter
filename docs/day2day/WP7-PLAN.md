# WP7 PLAN — Overnight benchmark + eligible-candidate archive

EPHEMERAL (ADF PLAN gate). Absorbed into SPEC.md § "Overnight benchmark and
candidate archive (2026-09-05) — WP7" at landing; delete at the review.
Contract: REQ-BENCH-001..007 + REQ-SIM-003 amendment (AUD-13). Delivery: one
commit, `bun test` + `tsc --noEmit` + Jest green, operator review. No push.
Lands before epoch 1 opens. Observability only — nothing here can place,
modify or cancel an order, and nothing here feeds a look.

## Design in one paragraph

The intraday benchmark judges the day's top movers against the funnel and
treats the opening gap as uncapturable; the simulator replays proposals and
refusals only. An overnight selection made at 15:30 is precisely a bet on
the gap and the next morning, and the candidates the scanner surfaced but
the judgment never admitted leave no trace — so "did the overnight lane
pick well among what it could see?" has no data. WP7 (1) captures the
observable universe once a day, point-in-time, BEFORE the close (the latest
pre-close opportunity snapshot for the overnight lane; the nightly pattern
scan for the cup-and-handle lane), with deterministic eligibility reasons
and versioned mechanical levels; (2) gives each eligible overnight
candidate a mechanical twin under the lane's contract (MKT at the next bar,
stop at `stop_atr_multiplier` × daily ATR, target at take-x, flat at the
10:00 ET deadline) replayed nightly with the simulator's pessimistic fill
model against next-session bars; (3) joins each candidate to what the
system did with it (proposed / refused by gate / not admitted); (4) reports
the common perimeter every night: universe vs top-k by rank vs the
judgment's picks, with the gap dimension. A prerequisite defect is fixed
first: the bar loader's coverage check reads the overnight gap as a hole,
so EVERY GTC twin settled so far is 'unknown' (simulator.db, 2026-09-05).
Coverage becomes session-aware, and GTC rows replay on regular-session bars
because `outsideRth` is false system-wide.

## Task graph

| T | Scope (REQ) | Files | Tests (red first) |
|---|---|---|---|
| T0 | Session-aware coverage; GTC rows on RTH bars | `simulator/bars.ts` — `sessionSegments(fromT, toT, isHalfDay, isHoliday)`, `coverageOkAcross`; `loadSimBars` judges each regular-session segment intersecting the window; `settle.ts` passes `rth: true` for every row; `variants.ts` unchanged | `bars.test.ts` — two-session window covered by two blocks, a hole inside one session fails, weekend/holiday skipped, half-day segment |
| T1 | Candidate archive store + pure eligibility/levels | NEW `src/services/candidate-archive.ts` — `candidate-archive.db` (`candidates`, UNIQUE(day, lane, symbol), first capture stands); `overnightEligibility`, `overnightLevels` (v1), `cupEligibility`, `cupLevels` (v1), `candidatesFromSnapshot`, `candidatesFromPatternScan`, `disposeCandidates` | NEW `candidate-archive.test.ts` |
| T2 | Capture wiring | `candidate-archive.ts` — `captureCandidatesOnce(deps)`, cron 15:35 ET weekdays (holiday skip), `startCandidateArchive/stop`, env `CANDIDATE_ARCHIVE`; `gateway.ts` starts it | capture with fake snapshot/scan/earnings; second capture same day ignored |
| T3 | Overnight benchmark replay + report | NEW `src/services/overnight-benchmark.ts` — `runOvernightBenchmarkOnce(deps)`: pending eligible overnight rows whose deadline passed → mechanical twin via `simulateBracket`, gap % at the next session's first bar, rung sizing, commissions, netR; disposition join; `formatOvernightReport` (universe / top-5 / judgment / not-admitted / unknown, gap stats) | NEW `overnight-benchmark.test.ts` |
| T4 | Nightly pipeline slot | `simulator/index.ts` — after the settle, before the looks: run the overnight benchmark and report through the simulator callbacks (failure reported, never blocks the looks) | existing simulator tests; DI'ed run |
| T5 | Archive universe widened | `archive-scheduler.ts` — universe adds symbols with OPEN GTC rows (multi-session twins need every session) and the prior day's eligible candidates (their next-session bars) — pure `orderArchiveUniverse` | NEW `archive-scheduler.test.ts` (pure ordering + cap) |
| T6 | Operator script | NEW `scripts/overnight-benchmark.ts --day YYYY-MM-DD` — read-only table of a day's universe with dispositions and outcomes | — |
| T7 | Docs + SPEC | AUTOMATION (candidate archive, overnight benchmark, pipeline order), USER-MANUAL (the 🌙 report line), env.example, SPEC landing + traceability | — |

## Decisions taken in this plan (ratify at review)

1. Coverage is judged per regular-session segment; GTC twins replay on
   regular-session bars only, because Dexter's brackets never set
   `outsideRth` — a stop cannot fill after hours, and the gap-aware fill
   model already prices an open through the stop at the open. REQ-SIM-003's
   "GTC rows may fill in extended hours" assumption is withdrawn.
2. One capture per lane per day at 15:35 ET from the latest pre-close
   snapshot (the Pre-Close Review reads the same snapshot at 15:30); the
   first capture of a day stands (point-in-time integrity). A missed capture
   (gateway down across 15:35) leaves the day without a universe and the
   report says so; no backfill from later snapshots.
3. Eligibility is the deterministic subset of the overnight lane's rules:
   not stale, price ≥ `min_price`, ATR known, day move known and WITH the
   direction (continuation), no earnings within 2 days (calendar; unknown →
   eligible with a note). LLM reasons are never reconstructed; the
   disposition join (proposed / refused:<gate> / not-admitted) records what
   happened.
4. Mechanical levels v1 (`CANDIDATE_LEVELS_VERSION`): MKT entry at the next
   bar after capture ("buy before the close"), stop = price ∓
   `stop_atr_multiplier` × daily ATR, target = price ± take-x % (ATR
   formula within the take band), exit at the lane deadline (10:00 ET next
   session, half-day aware). Rows keep the version they were captured with.
5. Cup-and-handle candidates are archived (pivot, suggested entry/stop,
   state, detector version) but NOT replayed in WP7: a 15-session horizon
   belongs with the swing benchmark (later WP).
6. R is rung-invariant; USD at the current rung against the epoch NetLiq
   (simulator convention). The report is a WhatsApp line through the
   simulator callbacks; the benchmark never writes `sim_trades` and no look
   reads `candidates` (REQ-SIM-007 analogue).

## Verification

`bun test`, `tsc --noEmit`, Jest under real Node. The T0 tests are the
acceptance evidence that GTC twins stop being 'unknown' by construction;
the T3 tests are the acceptance evidence for REQ-BENCH-004/005.
