# WP6 PLAN — The sizer composes every budget at creation

EPHEMERAL (ADF PLAN gate). Absorbed into SPEC.md § "Sizer composition
(2026-09-05) — WP6" at landing; delete at the review. Contract:
REQ-SIZE-001..006 (AUD-06 completion, AUD-01 cost dimension). Delivery: one
commit, `bun test` + `tsc --noEmit` + Jest green, operator review. No push.
Lands before epoch 1 opens.

## Design in one paragraph

Today the sizer sees NetLiq (and, since WP5, the overnight book) while the
acceptance gate sees the whole book: planned stop-outs vs the daily-loss
headroom, the per-symbol aggregate, the overnight book cap and its
class-aware stress, the sector cap, the position slots, the daily trade cap,
and the spread/ADV microstructure. A proposal sized correctly for its own
budget is therefore refused later for a constraint that was known at
creation. WP6 builds the SAME book context at creation from the proposals
store (`book-context.ts`, pure, shared with the accept path for its four
pure sums), lets the sizer cap the quantity by every notional/risk
constraint and name the binding one, adds a net-viability refusal
(round-trip costs vs gross gain at target), and passes that context to the
creation-time gate so the creation gate and the sizer agree by
construction. Acceptance keeps its fresh broker-marked re-check: a moved
context refuses, never resizes.

## Task graph

| T | Scope (REQ) | Files | Tests (red first) |
|---|---|---|---|
| T1 | Book context builder | NEW `src/services/book-context.ts` — `buildBookContext(rows, {symbol, sector, sectorOf, valueOf, plannedRiskOverride, rules})` → open positions, per-class counts, per-symbol exposure, planned risk (with unpriceable rows listed, never zeroed), overnight notional + class-aware stressed loss, same-sector notional | NEW `book-context.test.ts` |
| T2 | Trade costs | NEW `src/services/trade-costs.ts` — commission per side (IBKR fixed model), round-trip estimate (commissions + spread crossing + slippage bps), cost-to-target %; rules keys `commission_per_share_usd`, `commission_min_usd`, `slippage_bps`, `max_cost_to_target_pct` | NEW `trade-costs.test.ts`; `risk-rules-validation` loads |
| T3 | Sizer composition | `position-sizer.ts` — `SizeInput.book` (headroom, symbol room, overnight book room + stress, sector room, ADV, spread) and `target`; caps compose, whole shares, `binding` named; viability refusal | `position-sizer.test.ts` — each cap binds and names itself; viability |
| T4 | Creation wiring + gate parity | `tools/proposals/index.ts` — assemble the context (store-side, live quote for spread when available, sector resolution live-only), size, then pass the same context into `createProposal`'s gate; stamp `cost_to_target_pct`; `trade-proposals.ts` column | NEW `sizer-gate-parity.test.ts` — a sized proposal passes `checkProposalRisk` with the same context |
| T5 | Accept path shares the builder | `proposal-executor.ts` — the four pure sums come from `buildBookContext` (union maxes and adopted verification unchanged) | existing executor tests; builder tests |
| T6 | Docs + SPEC | USER-MANUAL (sizing), AUTOMATION (creation gate), yamls, SPEC landing + traceability | — |

## Decisions taken in this plan (ratify at review)

1. Creation does not fetch the broker book (fresh, accept-time only): the
   creation context is the proposals store priced at the worst entry basis;
   acceptance re-checks with marks and the broker union. A drift between the
   two is an honest refusal, never a resize.
2. An unpriceable open row (no usable basis) does not refuse CREATION: the
   headroom cap is skipped with a note and the accept path keeps its strict
   refusal (creation is cheap; acceptance places orders).
3. Cost model: commissions per side = max(`commission_min_usd`, qty ×
   `commission_per_share_usd`) (IBKR fixed tier — the simulator's numbers),
   spread crossing = qty × entry × spread% (once, half at each side),
   slippage = 2 × qty × entry × `slippage_bps`/10,000. Missing spread →
   commissions + slippage only, noted. Refuse when costs exceed
   `max_cost_to_target_pct` (20 %) of qty × |target − entry|.
4. The sector cap at creation uses the same UNKNOWN bucket as the accept
   path when the sector resolves to nothing; in tests the sector is skipped.
5. `strategyVersion` is the strategy fingerprint (every lane rule is a
   fingerprint surface); no extra column.

## Verification

`bun test`, `tsc --noEmit`, Jest under real Node; the parity test is the
acceptance evidence for REQ-SIZE-004.
