# WP5 PLAN — Four-lane contract (strategy identity ≠ risk horizon)

EPHEMERAL (ADF PLAN gate). Absorbed into SPEC.md § "Four-lane contract
(2026-09-05) — WP5" at landing; delete at the review. Contract:
REQ-LANE-001..009. Delivery: one commit, `bun test` + `tsc --noEmit` + Jest
green, operator review. No push. Lands BEFORE epoch 1 opens (the restart
carries it).

## Design in one paragraph

Lanes ride the EXISTING risk classes: intraday stays intraday; overnight,
swing and cup-and-handle ride the swing class (GTC exits, gap-stress vet,
`swing_enabled` gate — disabled on live until earned, forced on paper). A
`StrategyContract` (strategyId, setupId, holdingHorizon, exitPolicyId,
exitDeadline, detectorVersion) is stamped on every proposal by a
deterministic table; the deadline is set at entry fill from the market
calendar and enforced by a 60-second sweeper through the safe close path.
The sizer composes the gap-stress budget for the swing class. Cohorts split
by strategy in the sample, digest and simulator. No triage edit is needed:
an overnight-lane position is a GTC swing-class position at 15:52 (earnings
guard + whole-book vet apply; it is not closed by the flat-by-close rule),
and its unfilled entry dies with its expiry (clamped to the close).

## Task graph

| T | Scope (REQ) | Files | Tests (red first) |
|---|---|---|---|
| T1 | Contract table + calendar math | NEW `src/services/lane-contract.ts`; `risk-rules.ts` + both yamls (6 keys) | NEW `lane-contract.test.ts`: table, derivations, refusals, window, deadlines (weekend, holiday, half-day, N trading days), stress cap math |
| T2 | Persistence | `trade-proposals.ts`: 7 columns, type/Row/fromRow, `CreateProposalInput.strategyId/setupId/detectorVersion`, contract resolution + `[lane-contract]` refusals + overnight lane cap in `createProposal`, `markEntryFilled` stamps `exit_deadline`, `listDeadlineDue`, `markDeadlineClosed`, `countOpenByStrategy` | `trade-proposals.test.ts`: lane fields persisted, derived defaults, deadline stamped at fill, due listing, lane cap, legacy null |
| T3 | Sizer | `position-sizer.ts`: `strategyId`, `overnightBookNotionalUsd`; swing-class notional capped by overnight position cap and stress budget minus existing book; overnight budget key | `position-sizer.test.ts`: caps bind, reasons, intraday unchanged |
| T4 | Deadline sweeper | NEW `src/services/lane-deadline-sweeper.ts` (pure `selectDueDeadlines`, `sweepDeadlinesOnce(deps)`, start/stop); `gateway.ts` start/stop | NEW `lane-deadline-sweeper.test.ts` with fake deps: due → closed + stamped; flat already → stamped no order; not due → untouched; close not confirmed → incident line |
| T5 | Cup lane + scan archive | `pattern-detectors.ts` (`detectorVersion`, `state`), `pattern-scanner.ts` (`matches[]`, `detectorVersion`), `tools/patterns/index.ts` description | `pattern-detectors.test.ts` (state/version), `pattern-scanner` snapshot shape |
| T6 | Tool + crons + skills | `tools/proposals/index.ts` (`strategyId`, `setupId`, class derivation, coherence); `trading-schedules.ts` (Pre-Close overnight lane; Pre-Market cup lane); RULES.md rule 7; overnight SKILL contract paragraph | tool coherence unit (pure `coherent`/derivation exported) |
| T7 | Cohorts + simulator | `sequential-test.ts` `RTrade.strategyId`; `loop/sample.ts` (strategyId, legacy apart); `loop/looks.ts` `lanes`; `loop/digest.ts` lane lines; `simulator/settle.ts` + `variants.ts` (`strategyId` on `SimSource`, overnight entry deadline = expiry, `lane-overnight`, `lane-cup-and-handle`, `exit-fixed-3`) | `sample.test.ts`, `looks.test.ts`, `digest.test.ts`, `variants.test.ts` |
| T8 | Research + docs + SPEC | NEW `scripts/remaining-excursion.ts`; USER-MANUAL lane table; AUTOMATION (sweeper, lanes, keys); SPEC landing notes + traceability | script smoke-run read-only |

## Decisions taken in this plan (research parameters, ratify at review)

1. Overnight lane: entries from 15:00 ET, expiry clamped to the close,
   exit at 10:00 ET next session (`overnight_exit_minutes_et: 600`), budget
   `overnight_risk_pct` = the swing budget of each profile (0.5 base / 0.75
   live), at most 2 concurrent (`max_overnight_lane_positions: 2`) inside
   the swing pool of 3.
2. Hold limits: swing 10 trading days, cup-and-handle 15 trading days, both
   closing at 15:50 ET (before the 15:52 triage) on the last day.
3. The swing risk class is the overnight-capable class; no new `TradeClass`.
4. Exit attribution of a deadline close stays `manual` at the tracker (the
   MKT close is tracked like every deliberate close) with `deadline_closed_at`
   as the distinguishing stamp — no new `ExitReason` value.
5. Cup states: `pivot-ready` / `breakout-confirmed` only; `retest` needs
   breakout history the archive does not keep yet.
6. `exit-fixed-3` is the AUD-01 comparison variant; the intraday take policy
   itself does not change here.

## Verification

`bun test`, `tsc --noEmit`, Jest under real Node; `scripts/remaining-excursion.ts`
against the ledger (read-only); the yamls validate at load (rules
validation test).
