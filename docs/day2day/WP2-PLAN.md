# WP2 PLAN — In-process simulator + shadow-variant registry (+ fingerprint narrowing)

EPHEMERAL (ADF PLAN gate). Absorbed into SPEC.md § "Live-loop program" at
landing; delete at the WP2 review. Contract: REQ-SIM-001..007, and
REQ-FP-001/002 pulled forward from WP3 (see "Sequencing" — without them
this landing would move the epoch-1 fingerprint). Delivery: one commit,
`bun test` + `tsc --noEmit` + Jest green, operator review. No gateway
behavior changes; no push.

## Sequencing — why the fingerprint narrowing lands here

The fingerprint hashes the whole `src` tree today (`RUNTIME_PATHS`). The
WP1 restart has not happened yet (the operator must set the LLM price
knobs first), so the first restart can carry WP1 + WP2 + the narrowed
identity in one go: epoch 1 then starts on an identity that WP3/WP4
(observability + control plane) cannot move. If WP2 landed WITHOUT the
narrowing, every later observability commit would end the epoch.

## Task graph

| T | Scope (REQ) | Files | Types / data | Tests (red first) | Risk |
|---|---|---|---|---|---|
| T1 | Fill model (SIM-002) | NEW `src/services/simulator/fill-model.ts` | `SimBar`, `SimSpec` (entry/exit levels, entry deadline, flat-at, optional ratchet), `SimResult`, `simulateBracket(bars, spec)`, `commissionsFor(qty, sides, cfg)`, `netR(...)` | NEW `fill-model.test.ts` — strict trade-through LMT, STP_LMT band, MKT next-open, gap-aware stop, target strict, tie → stop, eod-flat at the triage bar, GTC carry (`open`), unfilled past the deadline, ratchet arm/lock/trail, MFE/MAE, commissions | LOW |
| T2 | Variant registry (SIM-004/005) | NEW `simulator/variants.ts` | `SimSource` (normalised proposal/refusal), `VariantDef {name, applies, spec, status}`, `VARIANTS_V1`, `sizeAtRung(entry, stop, rungPct, netLiq)` | NEW `variants.test.ts` — applies/geometry per variant: incumbent, funnel-75, gate-off:<gate>, exit-ratchet, exit-x2.0, stop-x/3, class-swing, class-earnings-bet, weights-calibrated inactive | LOW |
| T3 | Bar sources (SIM-003) | NEW `simulator/bars.ts` | pure `coverageOk`, `sessionFilter`, `frameToEpochMs`; loaders stream-5s (read-only `stream-bars.db`) → archive 1-min → IBKR 1-min; `loadSimBars` returns `{bars, source}` or null | NEW `bars.test.ts` — coverage/gap math, session filter (half-day aware), frame conversion round-trip, loader order with fakes | LOW |
| T4 | Store (SIM-001/007) | NEW `simulator/store.ts` | `simulator.db` (own file, REQ-TEST-001 guard), table `sim_trades` (no order-id columns), `upsertSimTrade`, `listSimTrades`, `findSimTrade` | NEW `store.test.ts` — round trip in a temp dir, unique (variant, kind, id) | LOW |
| T5 | Settle (SIM-001/005/006) | NEW `simulator/settle.ts` | `runSettleOnce(deps)`: single-flight, run stamp `sim-settle-run.json` running→completed\|failed, sources = proposals in lookback + refusals with levels + open GTC rows; per variant: bars → simulate → size at rung → row | NEW `settle.test.ts` — with fakes: rows written per variant, open GTC re-settled, unknown on missing bars, stamp lifecycle, failure isolated | LOW |
| T6 | Report (SIM-001 twin line; WP3 digest input) | NEW `simulator/report.ts` | pure `summarizeVariants(rows)`, `twinCalibration(rows, proposals)` | NEW `report.test.ts` | LOW |
| T7 | Service + wiring (SIM-006) | NEW `simulator/index.ts` (Cron 17:10 ET + boot catch-up, `onSimulatorReport`), `gateway.ts` start/stop, `outcome-alerts.ts` report delivery | — | wiring glue (honest ledger) | LOW |
| T8 | Fingerprint narrowing (FP-001/002) | `strategy-fingerprint.ts` | `BEHAVIOR_INCLUDE`, `BEHAVIOR_EXCLUDE`, pure `isBehaviorPath`, `codeIdentity` over `git ls-tree -r` filtered + scoped status/diff | `strategy-fingerprint.test.ts` — classification pin (every excluded entry exists; observability modules excluded; behavior modules included), real temp-repo: excluded edit leaves identity, behavior edit moves it | HIGH (validation integrity) |
| T9 | Docs + SPEC landing notes | `env.example` (SIM_* knobs), `AUTOMATION.md`, `USER-MANUAL.md`, SPEC "WP2 landed" | — | — | LOW |

## Decisions taken in this plan (to ratify at review)

1. `sim_trades` lives in its own `simulator.db` (same data dir), not in
   `proposals.db`: the behavior store's schema stays untouched, two
   writers never contend on one file, and REQ-SIM-007 becomes structural
   (a different database, no order-id columns).
2. All simulator times use the codebase's ET-frame convention
   (`barTimeFrameMs` / `etFrameMs`): archive bar strings, stream unix
   seconds and proposal epoch stamps all compare in one frame.
3. Sizing base for `sizeAtRung` is the epoch NetLiq
   (`performance-epoch.json`, fallback $11,700); R is rung-invariant so
   this only scales the informational USD column.
4. Ratchet exits are classified `target` when the exit is above the fill
   (win) and `stop` otherwise, with a note — the SPEC's outcome set has no
   separate ratchet label.
5. Settle runs at 17:10 ET (benchmark starts 16:45 with IBKR pacing) plus a
   boot catch-up when today's stamp is missing after 17:10 on a trading
   day; open GTC rows re-settle nightly for up to 20 trading days, then
   `unknown` ("horizon expired").
6. Fingerprint policy: `src` (+ root runtime configs, SOUL.md) is INCLUDED
   by default; an explicit EXCLUDE list names observability/control-plane/
   evaluator/TUI paths and every `*.test.ts`. A new file is behavior
   unless excluded — a forgotten exclusion ends an epoch loudly rather
   than letting a behavior file escape silently. `scripts/` leaves the
   identity (scorecard/ops tooling is not runtime behavior).

## Verification

`bun test`, `npx tsc --noEmit`, Jest under the real Node binary. Evidence at
review: `simulator.db` rows per variant after one settle against the
current paper ledger; the fingerprint pin test lists the exclusions.
