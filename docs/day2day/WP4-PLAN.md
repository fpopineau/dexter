# WP4 PLAN — Live-automation plumbing, switched OFF

EPHEMERAL (ADF PLAN gate). Absorbed into SPEC.md § "Live-loop program" at
landing; delete at the WP4 review. Contract: REQ-LIVE-004..009.
Delivery: one commit, `bun test` + `tsc --noEmit` + Jest green, operator
review. No push. Does NOT need the gateway running.

## Fingerprint discipline

The first gateway restart has not happened (the operator killed the
pre-WP1 gateway on 2026-09-05), so this WP lands BEFORE epoch 1 opens: the
restart carries WP1..WP4 together and the identity WP4 establishes is the
one epoch 1 records. Two behavior-path edits are therefore acceptable and
deliberate: `proposal-executor.ts` (REQ-LIVE-006 sim-only marking in the
live auto-exec branch; REQ-LIVE-009 header doctrine) — everything else
lives on excluded paths (`src/services/loop/`, `loop-control.ts`,
`loop-commands.ts`, `dashboard*.ts`, docs, tests).

## Task graph

| T | Scope (REQ) | Files | Types / data | Tests (red first) | Risk |
|---|---|---|---|---|---|
| T1 | Live switch writer (LIVE-004/005) | NEW `src/services/loop/live-switch-control.ts` | `createLiveSwitchControl(deps)` → `requestOn()` (6-char challenge, 2-min TTL, evidence block: epoch, last look, ACCEPT, rung, account kind, `IBKR_ALLOW_LIVE`, profile, veto window), `confirmOn(token)` (writes `enabled:true`, by operator, journal), `off()` (immediate, journal), `status()`; `liveLiveSwitchControl()` bound to the running process | NEW `live-switch-control.test.ts` — challenge/confirm/expiry/mismatch/off/no-pending; last look shown; system-side OFF after `live on` (epoch stop) | LOW |
| T2 | Grammar + operator (LIVE-004, LADDER-003 on live) | `loop-commands.ts`, `loop/operator.ts`, `loop-control.ts` | `LoopCommandCore.liveOn(token)`, `liveOff()`; `OperatorDeps.liveAccount` — `epoch new carry` refused on a live account; veto of a CLAIMED row → `refuse-claimed` naming `cancel`/`kill` (LIVE-007) | `loop-commands.test.ts`, `operator.test.ts`, `loop-control.test.ts` extended | LOW |
| T3 | Non-paper class doctrine (LIVE-006) | `proposal-executor.ts` (auto-exec live branch), `risk-rules-profile.test.ts` | live verdict + a class disabled in the raw live yaml → row `rejected` with a `sim-only:` note + refusal record; the simulator already replays every proposal (class variants) | `proposal-executor.test.ts` (live port + non-D account + switch on → swing row rejected sim-only; intraday unaffected); `risk-rules-profile.test.ts` pins that a LIVE account never gets the shadow forcing | LOW (pre-restart) |
| T4 | Veto lifecycle (LIVE-007/008) | tests only | — | `trade-proposals.test.ts` (`listDueAutoExecutions`: due listed in creation order, not-yet-due and expired excluded); `proposal-executor.test.ts` (a stamped row executed with `skipVetoWindow` is NOT re-deferred — reaches the gates); `veto-window.test.ts` (a refused/claimed row does not stop the sweep) | LOW |
| T5 | Dashboard parity (LIVE-004) | `dashboard.ts`, `dashboard-page.ts` | actions `live-on` (no token → challenge; token → confirm) / `live-off` through the same control; overview carries `live` (switch + line); header shows the switch with two buttons | smoke (build) | LOW |
| T6 | Docs + SPEC (LIVE-009) | TRADING-POLICY.md (step 4, "Going live at all"), USER-MANUAL.md (command table, live bullet), AUTOMATION.md (auto-exec bullet, command table), env.example, `proposal-executor.ts` header comment, SPEC landing notes + traceability | — | — | LOW |

## Decisions taken in this plan (to ratify at review)

1. `live on` never starts an epoch by itself: the switch and the account are
   different events (the live account arrives with a gateway restart on
   port 4001). The confirmation message instructs `epoch new` (no carry);
   `epoch new carry` is REFUSED on a live account (REQ-LADDER-003 letter).
2. A challenge mismatch refuses and KEEPS the pending challenge until its
   expiry (a typo should not force a new evidence read); expiry clears it.
3. `live status` prints the switch line plus the live-verdict conditions as
   the process sees them (account kind, `IBKR_ALLOW_LIVE`, profile, epoch,
   veto window) so the operator sees why live auto-execution would or
   would not fire.
4. Sim-only marking happens in the auto-exec live branch (status `rejected`,
   note `sim-only: …`, refusal ledger row). A hand `accept` of such a row on
   a live account is refused by the existing class gate (unchanged); the
   simulator settles the row either way (it replays every proposal).
5. No placement-path fake broker exists for the executor; "open → due →
   executed" is pinned as far as the gates: the due path must not
   re-defer and must reach the accept gates (a gate refusal without IBKR
   proves the path).

## Verification

`bun test`, `tsc --noEmit`, Jest under real Node. Evidence: `live status`
and the challenge rendered from the current data dir (no switch file →
OFF, no epoch → the message says so).
