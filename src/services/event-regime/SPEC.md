# Event-regime yardstick — SPEC

Status: **specified, not implemented**. High-risk change to the risk
machinery — requires PLAN-gate approval before implementation. The
implementation is expected to live in this directory
(`src/services/event-regime/`), consumed by `../proposal-risk-gate.ts`,
`../profit-trail.ts`, and the creation-time context fetch in
`@/tools/ibkr/daily-atr.ts`.

## Problem

Every ATR-anchored gate uses the **daily ATR(14) computed from completed
daily bars** as its unit of price movement: the noise-stop floor
(`min_stop_atr_fraction` = 0.4×), the stop band implied by the target
cap (≤ 0.75×), the target-reachability cap (`max_target_atr` = 1.5×),
the extension guard (3× beyond EMA10), and the profit trail's arm/
pullback geometry (2.5× / 0.75×).

That yardstick is correct in the regime it was measured in — and
meaningless in an event regime. Two live exhibits:

- **MRNA 2026-08-19**: +110% pre-market by 07:50 ET (63 → 132.50) on a
  daily ATR of ~$2.8. The target cap (1.5× ATR = $4.20) and stop band
  ($1.12–$2.10) were absurd against a tape swinging $10 per 5-minute
  bar: every honest bracket geometry for the leg-2 continuation
  (trigger above the ~104 base at 07:35, real structure stop ~$14 away)
  is refused by gates calibrated to a $2.8 unit. The extension guard
  reads ~24× ATR beyond EMA10 — a hard refusal with no waiver, because
  MRNA was not an earnings reporter.
- **MEDP / MSFT Jul 30 (already patched piecemeal)**: the extension
  guard's `recentEarnings` waiver exists precisely because "a
  post-earnings re-rating is a new price regime, not a stretched move".
  That insight was applied only to earnings reporters and only to the
  extension check. Non-earnings events (FDA, M&A, legal) get no waiver,
  and the geometry gates (stop band, target cap) got no equivalent at
  all.

The house rule this generalizes: **new price regime, old yardstick —
the reference must come from the regime being traded, not the one that
ended when the news hit.**

## Solution

When a symbol is in an **event regime** — its move since the prior
completed close exceeds a multiple of its daily ATR — the ATR-anchored
checks measure against an **event ATR** derived from the intraday tape
actually being traded, instead of the stale daily ATR. Outside the
event regime, behavior is byte-identical to today.

## Domain model

```
EventContext {
    dailyAtr:  number | null   // ATR(14), completed daily bars (existing)
    prevClose: number | null   // prior completed close (existing)
    eventAtr:  number | null   // trailing realized range, see REQ-EVREG-002
    inEventRegime: boolean     // REQ-EVREG-001
    effectiveAtr: number | null // inEventRegime ? max(dailyAtr, eventAtr) : dailyAtr
}
```

Data flow: `fetchDailyRiskContext(symbol)` (creation-time, server-side,
cached, fail-open — the existing pathway that feeds `dailyAtr`/`ema10`/
`prevClose`/`recentEarnings` to the gate) is extended to also return
`eventAtr` when the day-move test warrants computing it. The gate
context (`RiskGateContext`) carries `eventAtr`; the gate derives
`effectiveAtr` and uses it wherever `ctx.dailyAtr` is used today. The
profit trail's `trailGeometry()` receives the same `effectiveAtr` for
positions whose entry was admitted under the event yardstick.

## Requirements

- **REQ-EVREG-001 — Regime detection.** A symbol is in the event regime
  when `|price − prevClose| ≥ K × dailyAtr`, with `K` configurable
  (`event_regime_atr_mult` in risk-rules.yaml, default **3**). Below K,
  nothing anywhere changes. Rationale for 3: MU 2026-08-18 peaked at
  ~2.2× and the normal yardstick produced correct geometry all day
  (verified in the post-mortem); MEDP's +17% measured 4.2×; MRNA ~21×.
- **REQ-EVREG-002 — Event ATR definition.** `eventAtr` = the high−low
  range of the trailing 60 minutes of extended-hours bars (5-minute
  bars, ≥ 6 usable bars required), computed server-side at proposal
  creation. Not model-supplied, ever.
- **REQ-EVREG-003 — Effective yardstick.** In the event regime,
  `effectiveAtr = max(dailyAtr, eventAtr)` replaces `dailyAtr` in: the
  noise-stop floor, the target-reachability cap, and the VIABLE
  GEOMETRY prescription bounds. `max()` guarantees the yardstick only
  ever widens — the stop floor never drops below today's.
- **REQ-EVREG-004 — Extension guard waiver.** In the event regime the
  extension guard is waived **with a visible gate note** (same
  mechanism as the `recentEarnings` waiver, which this generalizes).
  The buy-now entry-pricing filter, chase gate, and all non-ATR checks
  remain fully in force — confirmation/pullback entry discipline is the
  chasing protection in this regime, not the EMA distance.
- **REQ-EVREG-005 — Trail geometry.** Positions admitted under the
  event yardstick trail with `effectiveAtr` (arm 2.5×, pullback 0.75×
  of the SAME unit their stops were sized with). The trail must persist
  which unit a position was admitted under; re-deriving it later from a
  decayed intraday range would silently tighten the trail mid-hold.
- **REQ-EVREG-006 — Fail-safe degradation.** If `eventAtr` cannot be
  computed (bars unavailable, < 6 usable bars), the gate uses the daily
  yardstick unchanged — i.e., event-regime proposals are REFUSED as
  they are today. Degradation never loosens a check.
- **REQ-EVREG-007 — Ledger visibility.** Proposals admitted under the
  event yardstick record it: `entry_context`-style column
  (`event_atr REAL`, null = normal regime) so the nightly replay and
  future audits can score event-regime admissions as their own
  population. Refusals in the event regime carry the effective unit in
  the refusal text.
- **REQ-EVREG-008 — Config coherence.** The boot-time band-coherence
  warning (`min_stop_atr_fraction × min_risk_reward ≤ max_target_atr`)
  applies identically to the event yardstick by construction (same
  fractions, different unit) — no separate knobs for the fractions.

## Invariants

- Outside the event regime (day move < K × dailyAtr), gate and trail
  behavior is **byte-identical** to the pre-implementation baseline;
  the existing test suite must pass unmodified.
- `effectiveAtr ≥ dailyAtr` always — no check ever becomes stricter in
  dollar terms than today's daily-ATR version, and the stop FLOOR in
  dollars never shrinks.
- `eventAtr` is server-computed only; no model-supplied value reaches
  the gate.
- Missing data degrades toward refusal, never toward admission.

## Non-goals

- **Pre-market execution.** `outsideRth` stays false system-wide; this
  spec changes what geometry is *admissible*, not when orders fill.
  (Operator decision, tracked separately.)
- **Halt/LULD handling.** No modeling of trading halts; the buy-now
  filter's live-quote requirement is the only staleness protection.
- **Scorer recalibration.** The event-mover compositeRank boost
  (2026-08-19) is discovery-side and independent; weight recalibration
  remains deferred until the archive holds enough labeled days.
- **Earnings-bet class.** Gap-sized by its own machinery; untouched.
- **Options.** Deferred per the options-module gate.

## Acceptance criteria

- [ ] MRNA 2026-08-19 07:35 replay: long STP_LMT trigger ~105 (above
      the 98–104 base), stop ~91 (below the base, ≈ 0.5× the trailing
      hour range of ~$29), target 2:1 within 1.5× eventAtr — passes the
      gate that refuses it today on target-cap and extension grounds.
- [ ] MU 2026-08-18 09:53 replay: the confirmation short (trigger 954,
      stop 978.7, target 904.6) passes under BOTH yardsticks (day move
      1.6× ATR < K → event regime never activates).
- [ ] A normal-day proposal set (existing gate test fixtures) produces
      identical verdicts with the feature present.
- [ ] eventAtr unavailable in the event regime → refusal text names the
      daily-ATR unit (unchanged behavior), never a silently loosened cap.
- [ ] Admitted event-regime proposals carry `event_atr` on their row;
      the benchmark replay can partition outcomes by regime.
- [ ] Full suite green; no existing test modified to accommodate the
      feature (only added).

## Risk tags

- **HIGH — risk machinery**: loosens admission gates in a regime where
  moves are violent by definition. Mitigations: K-threshold isolation
  (REQ-EVREG-001), widen-only construction (REQ-EVREG-003), fail-safe
  degradation (REQ-EVREG-006), own ledger population for post-hoc
  scoring (REQ-EVREG-007). PLAN-gate approval required before
  implementation; recommend paper burn-in with the ledger column
  watched for ≥ 2 weeks before any live-profile activation.

## Open items

- K default (3) is set from three data points (MU 2.2× benign, MEDP
  4.2×, MRNA ~21×) — revisit once `event_atr`/excursion data
  accumulates.
- Whether the 60-minute trailing window should shrink pre-market when
  fewer bars exist (e.g. 06:50, 25 minutes into an event) or simply
  wait for 6 usable bars (current REQ-EVREG-002 choice: wait).
- Interaction with the profit trail's RTH-only limitation (trail peaks
  unseen pre-market) — accepted today, more consequential for
  event-regime positions entered near the open.
