# WP3 PLAN — Sequential test, size ladder, epochs, nightly digest (+ REQ-FP-003)

EPHEMERAL (ADF PLAN gate). Absorbed into SPEC.md § "Live-loop program" at
landing; delete at the WP3 review. Contract: REQ-SEQ-001..007,
REQ-LADDER-001..004, REQ-EPOCH-001..004, REQ-DIGEST-001..005, REQ-FP-003.
Delivery: one commit, `bun test` + `tsc --noEmit` + Jest green, operator
review. No push.

## Fingerprint discipline

Every WP3 module lives on an EXCLUDED path: `src/utils/sequential-test.ts`
(pre-registered exclusion) and a new `src/services/loop/` directory. The
ONE behavior-path edit is adding `src/services/loop` to `BEHAVIOR_EXCLUDE`
in `strategy-fingerprint.ts` — it must land before the first restart
(same argument as WP2; the restart has not happened). After that, WP4's
live-switch writer also lives under `src/services/loop/` and needs no
fingerprint edit. `gateway.ts` is NOT touched: the nightly looks + digest
run as the tail of the simulator's 17:10 ET job (REQ-SIM-006 order:
settle → looks → digest), and the equity guards hook into the excluded
`equity-series.ts` sampler.

## Task graph

| T | Scope (REQ) | Files | Types / data | Tests (red first) | Risk |
|---|---|---|---|---|---|
| T1 | Pre-registered math (SEQ-001..004, SEQ-006/007, LADDER-001/002 rules) | NEW `src/utils/sequential-test.ts` | `SEQ_CONSTANTS` (looks 25/50/75/100; one-sided LCB confidences 0.99/0.975/0.96/0.95; reject UCB 0.95; PF ≥ 1.3; hard stop 5%; bootstrap 1000/42/minDays 5; ladder rungs + milestones; promotion n ≥ 30 & ≥ 10 days; band '60-74' bar n ≥ 20), `constantsHash()`, `netRForRow`, `lookBoundaryReached`, `evaluateLook` (ACCEPT/REJECT/CONTINUE), `runningStats`, `dailyDifferenceBounds`, `ladderEligibility`, `stepDownDue`, `hardStopDue`, `bandLine`, `spearman` | NEW `sequential-test.test.ts` | LOW (excluded, pinned by hash) |
| T2 | Epoch control (EPOCH-001..004, SEQ-004, LADDER-003) | NEW `src/services/loop/epoch-control.ts`, `loop/journal.ts` | `LoopEpochRecord` (epoch-state.json superset: netLiq, constantsHash, looksDone, firstAcceptAt, stepUpEligible, promotionPending), `startEpoch` (performance reset + record + ladder reset + journal), `stopEpoch` (status, journal, live switch OFF, alert), `evaluateEquityGuards(netLiq)` | NEW `epoch-control.test.ts` — start writes record/ladder/journal, stop is idempotent and writes live-switch OFF, guards: hard stop, step-down re-anchors, never below 0.25 | LOW |
| T3 | Ladder control (LADDER-001..004) | NEW `loop/ladder-control.ts` | `ladderEligibilityNow`, `stepUp` (two-step confirm token), `stepDown`, `ladderStatusLine` | NEW `ladder-control.test.ts` | LOW |
| T4 | Sample + looks (SEQ-001..003, SEQ-005..007, EPOCH-002 anomalies) | NEW `loop/sample.ts`, `loop/looks.ts` | `EpochSample {trades: RTrade[], anomalies[]}`, `runNightlyLooks(deps)` → `LoopStatus` (look decision, running stats, band line, shadow diffs, ladder eligibility, integrity) | NEW `looks.test.ts` — boundary crossing evaluates once, ACCEPT recorded, REJECT stops the epoch, constants mismatch → NOT EVALUABLE, triage-failed → stop, band-negative blocks ACCEPT, step-up queued | LOW |
| T5 | Digest (DIGEST-001..005) | NEW `loop/digest.ts`, `loop/nightly.ts`; `simulator/index.ts` (pipeline tail), `outcome-alerts.ts` (delivery), `dashboard.ts` (`/api/loop`), `dashboard-page.ts` (Loop section), `loop-commands.ts` (`digest`) | `LoopDigest` JSON + WhatsApp text (≤ 12 lines/section) | NEW `digest.test.ts` — section builders on fixtures, truncation | LOW |
| T6 | Commands (LADDER-001, EPOCH-004) | `loop-commands.ts`, NEW `loop/promote.ts` | `ladder up` / `ladder up confirm`, `epoch new [carry]`, `promote <variant>` / `promote <variant> confirm` (records + prints the change), `digest` | `loop-commands.test.ts` (extended) | LOW |
| T7 | Scorecard `--look` (SEQ-005) + FP-003 | `scripts/validation-scorecard.ts` (early branch; legacy labelled), `runtime-attestation.ts` (liveSwitch, vetoWindowMin, rung, epochId), VALIDATION-PROTOCOL.md superseding section, FREEZE-MANIFEST.md banner, `strategy-fingerprint.ts` exclusion, docs, SPEC landing | — | attestation test extended | LOW (+ the one identity edit) |

## Decisions taken in this plan (to ratify at review)

1. `epoch new` is the epoch-creating command: it performs the performance
   reset itself (same `setPerformanceBaseline` + USD NetLiq) and writes the
   epoch record, ladder reset and journal line. The legacy `performance
   reset` keeps resetting only the baseline — touching its router would
   edit a behavior path. Precision on REQ-EPOCH-001.
2. Anomaly-driven epoch stops are detected at the nightly look from the
   EOD triage run stamp (`failed`) — the triage service is a behavior path
   and is not hooked. The UNRESOLVED OVERNIGHT EXCESS alarm stamps the same
   run `failed`, so it is covered by that read.
3. The −5% hard stop and the ladder step-down are evaluated by the equity
   sampler on every 5-minute mark (REQ-SEQ-004 letter) AND re-checked at the
   nightly look (belt and braces).
4. The UCB for the REJECT rule reuses the day-block bootstrap by negation
   (UCB(x) = −LCB(−x) at the same alpha) — no change to `day-bootstrap.ts`.
5. Shadow-vs-incumbent compares DAILY summed R over the incumbent's days
   (a variant day with no rows contributes 0 — variants are subsets or
   re-geometries of the same sources).
6. Promotion prints a per-variant config change (env/yaml key) and the
   restart + `epoch new` steps; gate-off variants print "requires a SPEC
   change" — they are evidence, not a switch.

## Verification

`bun test`, `npx tsc --noEmit`, Jest under real Node. Evidence: one
`--look` run against the paper ledger; one `digest` rendered from the
current ledgers.
