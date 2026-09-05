# WP1 PLAN — Funnel throughput + behavior seams (live-loop program)

EPHEMERAL (ADF PLAN gate). Absorbed into SPEC.md § "Live-loop program
(2026-09-05)" once landed; delete at the WP1 review. Contract: SPEC.md
REQ-TRIG-001..004, REQ-SCAN-004..008, REQ-RISK-008..011, REQ-LLM-001..002,
REQ-LIVE-001..003 (seams). Delivery: one commit, `bun test` + `tsc --noEmit`
+ Jest green, operator review, gateway restart, `performance reset` = paper
epoch 1.

## Goal and the one rule

Widen the funnel so the 60–74 rank class reaches evaluation, and land every
behavior-path hook WP2–WP4 will need as an INERT seam (state file absent =
today's behavior). After this restart the fingerprint must not move again
in September.

## Task graph (T = task; → = depends on)

| T | Scope (REQ) | Files | Types / data | Tests (red first) | Risk |
|---|---|---|---|---|---|
| T1 | Trigger + auto-exec defaults (TRIG-001, TRIG-004) | `opportunity-engine.ts` (export `triggerScore`, `triggerMaxPerDay`), `proposal-executor.ts` (export `autoExecMaxPerDay`), `gateway.ts` boot line | — | `opportunity-engine.test.ts` defaults 60/30 + env override + garbage; `proposal-executor.test.ts` cap default 6 | MED |
| T2 | Trigger rank in lane context + stamps (TRIG-002/003) | `lane-context.ts`, `agent-runner.ts`, `trigger-alerts.ts`, `trade-proposals.ts`, `tools/proposals/index.ts` | `AgentLaneContext.triggerRank?`; columns `trigger_rank REAL`, `trigger_band TEXT` (proposals), `trigger_rank REAL` (refusals); `TradeProposal.triggerRank/triggerBand`; pure `triggerBand(rank)` | `lane-context.test.ts` (rank visible inside the run, null outside); `trade-proposals.test.ts` (band mapping, columns round-trip); `tools/proposals/index.test.ts` (stamp from context, NULL off-lane) | MED (schema, additive) |
| T3 | Significance ranking (SCAN-004/005) → T2 | `event-mover.ts` (delete `eventMoverBoost`, add `significanceTerm`, `significanceSuppressed`), `opportunity-engine.ts` composite | `SIGNIFICANCE` constants block {minAtr 1.0, pointsPerAtr 8, cap 25}; `Opportunity.dollarVolume: number \| null` | `event-mover.test.ts` (term monotone/capped/aligned-only; suppression matrix incl. reactor hour-one exemption) | MED |
| T4 | Large-cap lane (SCAN-006) | `opportunity-engine.ts` | env `OPP_LARGECAP_LANE` (true), `OPP_LARGECAP_MIN_USD` (10e9), `OPP_LARGECAP_RESERVE` (5); source tag `LARGECAP:<code>`; pure `largeCapScansFor(plan)`, `scanFamilyOf(source)`, `selectReservedAdmissions` | `opportunity-engine.test.ts` | MED |
| T5 | Vehicle complexes (SCAN-007/008) | NEW `src/config/vehicle-complexes.yaml`, NEW `src/services/vehicle-complexes.ts`; `opportunity-engine.ts` (constituent admission); `trade-proposals.ts` createProposal + `proposal-executor.ts` accept (opposite-direction refusal); `classifyRefusalGate` gains 'complex' | `VehicleComplex {name, vehicles[], constituents[]}`; pure `parseVehicleComplexes`, `complexesOf`, `isVehicle`, `complexAdmission(rawMove%, atr%)`, `oppositeDirectionConflict(sym, dir, working[])` | NEW `vehicle-complexes.test.ts`; `trade-proposals.test.ts` + `proposal-executor.test.ts` refusal at create/accept | HIGH (gate) |
| T6 | Pre-market spread two-tier (RISK-008) | `proposal-risk-gate.ts` `checkMicrostructure`, `proposal-executor.ts` accept, `trade-proposals.ts` (`spread_deferred INTEGER`, `markSpreadDeferred`, `listSpreadDeferredUnfilled`), NEW `src/services/spread-recheck.ts` (Cron `31 9 * * 1-5` ET + on-demand), `gateway.ts` start/stop | env `PREMARKET_SPREAD_HARD_MULT` (3); pure `spreadRecheckDecision` | `proposal-risk-gate.test.ts` two-tier; NEW `spread-recheck.test.ts` decision + DB selection | HIGH (order placement) |
| T7 | Sizer rung overlay (RISK-009) | NEW `src/services/ladder-state.ts`; `position-sizer.ts` `classRiskPct(class, rules, rungPct?)`, `computeQuantity(input, rules, rungPct?)` | `LADDER_RUNGS`, `LadderState`, pure `parseLadderState`, `rungFromState` | NEW `ladder-state.test.ts`; `position-sizer.test.ts` overlay = min(yaml, rung), default 0.25 w/o file; existing sizer/class tests pass an explicit rung where they pin budgets | HIGH (sizing) |
| T8 | Epoch-stop latch (RISK-010) | NEW `src/services/epoch-state.ts`; `proposal-executor.ts` accept path | `EpochState`, pure `parseEpochState`, `epochGateVerdict` (absent = running; corrupt = stopped, fail-closed) | NEW `epoch-state.test.ts`; `proposal-executor.test.ts` stopped file refuses entry, row stays open; `position-actions-close` untouched (no edit) | HIGH (accept path) |
| T9 | LLM spend meter + cap (LLM-001/002) | NEW `src/services/llm-spend.ts`; `agent-runner.ts` (refuse evaluation lanes at cap; record `DoneEvent.tokenUsage`), `trigger-alerts.ts` (catch → refusal row), `gateway.ts` boot validation; `classifyRefusalGate` gains 'spend-cap' | env `LLM_DAILY_SPEND_CAP_USD` (10), `LLM_PRICE_IN_USD_PER_MTOK`, `LLM_PRICE_OUT_USD_PER_MTOK`; file `llm-spend.json`; pure `priceUsd`, `isEvaluationLane`, `spendVerdict`, `assertSpendConfig` | NEW `llm-spend.test.ts` | MED |
| T10 | Live/veto seams (LIVE-001/002/003) | NEW `src/services/live-switch.ts` (reader only), NEW `src/services/loop-control.ts` (veto/kill core + read-only status), NEW `src/gateway/loop-commands.ts` (grammar), `proposal-executor.ts` (`assertAutoExecAllowed` replaces `assertPaperOnly`; veto window stamp; `autoExecuteProposal(id, {skipVetoWindow})`), NEW `src/services/veto-window.ts` (due-sweep, 30 s), `trade-proposals.ts` (`auto_execute_at INTEGER`, `setAutoExecuteAt`, `listDueAutoExecutions`), `proposal-commands.ts` delegation, `dashboard.ts` runAction veto/kill, `gateway.ts` start/stop | env `LIVE_VETO_WINDOW_MIN` (0); pure `autoExecVerdict(state)`; `ExecutionOutcome.deferred?` | `proposal-executor.test.ts` (verdict matrix; window 0 immediate; window > 0 due-stamped, row open); NEW `loop-commands.test.ts` (veto: open→rejected, executed-unfilled→cancel path, filled→kill hint; kill routes; others "not available"); NEW `veto-window.test.ts` (due selection) | HIGH (safety boundary) |
| T11 | Yaml ratification + journal (RISK-011) | `src/config/risk-rules.live.yaml`, `docs/day2day/VALIDATION-JOURNAL.md` | — | none (doc/config) | LOW |
| T12 | Fingerprint env list + docs | `strategy-fingerprint.ts` BEHAVIOR_ENV (+ new knobs), `env.example`, `docs/day2day/AUTOMATION.md`, `docs/handbook/USER-MANUAL.md` | — | `strategy-fingerprint.test.ts` (new keys present in the digest) | LOW |

Independent: T1, T2, T4, T7, T8, T9, T11. Dependent: T3 → T2 (reactor set,
minutes-since-open already available); T5 → T3 (admission uses the ATR
term); T6 → none but shares `trade-proposals.ts` columns with T2/T10;
T10 → T8 (verdict reads the epoch latch) and T7 (nothing) ; T12 last.

## Decisions taken in this plan (small deviations from SPEC wording, to ratify at review)

1. Large-cap reserved slots are bounded by a knob `OPP_LARGECAP_RESERVE`
   (default 5, best scan ranks first) rather than "the lane's own row
   count" — 100 extra sequential scorings per cycle would starve the
   cadence. Recorded as a REQ-SCAN-006 precision.
2. Complex constituent admission (REQ-SCAN-007) uses the ATR-normalised
   bar `|move| ≥ 1.0 × dailyATR%` with a 1% floor, not the sentinel's 5%
   raw bar — a +4% chipmaker on a +4% sector day is exactly the case.
3. `loop-commands` answers read-only `live status` / `ladder` / `epoch`
   from the state files (cheap, observability); `live on|off`, `ladder up`,
   `epoch new`, `promote` answer "not available until WP3/WP4".
4. The spend meter hooks the agent runner's `DoneEvent.tokenUsage` (already
   accumulated per run) instead of the per-iteration counter — one write
   per run, no edit inside `src/agent`.
5. `AUTO_EXECUTE_PAPER=true` stays the master auto-exec switch on every
   account type (renaming the env is a WP4 concern); the live branch adds
   its conditions on top.

## Verification (the harness)

- `bun test` (primary; preload isolates DEXTER_DATA_DIR), `npx tsc --noEmit`,
  `npm run test:jest` (4 workers). All green before the commit.
- Behavior evidence at review: boot log shows bar 60 / cap 30 / auto-exec 6;
  scorecard prints the new fingerprint; first `opportunities` snapshot
  shows `LARGECAP:`/`COMPLEX:` sources; a refusal row carries `trigger_rank`.

## Operator actions after the commit

1. Review the WP1 diff at the boundary.
2. Restart the gateway → send `performance reset` → journal line
   "epoch 1 START <iso> fp <12hex> netliq $<n> rung 0.25".
3. Set `LLM_PRICE_IN_USD_PER_MTOK` / `LLM_PRICE_OUT_USD_PER_MTOK` in `.env`
   BEFORE the restart (the cap defaults to $10 and refuses to boot without
   prices) — or set `LLM_DAILY_SPEND_CAP_USD=0` to disable the cap.
