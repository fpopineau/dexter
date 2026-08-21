/**
 * Proposal executor — the ONLY code path that turns an accepted proposal
 * into orders. Deterministic, no LLM involved.
 *
 * Gate order on accept:
 *   1. proposal exists, is open, not expired
 *   2. paper/live safety lock (assertOrderingAllowed)
 *   3. daily-loss kill-switch (assertDailyLossOk — fail-safe on uncertainty)
 *   4. risk gate with live account context (position size vs net
 *      liquidation, max open positions, max trades per day)
 *   5. bracket placement (entry + OCA stop/target)
 *
 * Callers: the WhatsApp command router (explicit human message) and the
 * approval-gated accept_proposal tool (interactive TUI confirmation).
 */

import { placeBracketOrder } from '@/tools/ibkr/bracket.js';
import { assertOrderingAllowed, getIBApi, getManagedAccounts, isLivePort } from '@/tools/ibkr/connection.js';
import { createIbkrMarketData } from '@/tools/ibkr/market-data.js';
import { logger } from '@/utils';
import { getMarketSession, isTradeableSession } from '@/utils/market-hours.js';
import { assertDailyLossOk } from './daily-loss-guard.js';
import { trackExecutedProposal } from './outcome-tracker.js';
import { getSectorInfo } from './sector-map.js';
import { assertAcceptContext, assertProposalRisk, checkMicrostructure, checkPriceRun, ENTRY_CONFIRM_FRACTION, plannedWorstLossUsd } from './proposal-risk-gate.js';
import { fetchDailyRiskContext } from '@/tools/ibkr/daily-atr.js';
import { fetchShortabilitySnapshot } from '@/tools/ibkr/microstructure.js';
import { fetchBrokerExposure, unionExposure } from './exposure-snapshot.js';
import {
    claimProposalForExecution,
    countExecutedSince,
    countOpenByClass,
    countOpenExecuted,
    etDayStartMs,
    expireStale,
    listExposure,
    formatProposalLine,
    getProposal,
    listTrackable,
    recordRefusal,
    releaseProposalClaim,
    setProposalStatus,
    sumRealizedPnlSince,
    type TradeProposal,
} from './trade-proposals.js';
import { getRiskRules } from '@/tools/ibkr/risk-rules.js';

export interface ExecutionOutcome {
    ok: boolean;
    message: string;
    /** Set when the refusal came from the chase gate: 'chasing' = the
     *  price ran past the entry (the setup may still be alive at fresh
     *  levels); 'invalidated' = it traded through the stop (dead). */
    chaseKind?: 'chasing' | 'invalidated';
}

/** Typed chase refusal so callers can distinguish "price ran" (worth a
 *  continuation at fresh levels) from "setup dead" (never re-enter). */
class ChaseRefusalError extends Error {
    constructor(message: string, public readonly kind: 'chasing' | 'invalidated') {
        super(message);
    }
}

export interface LiveQuote {
    last: number | null;
    bid: number | null;
    ask: number | null;
}

/** Best-effort live quote (nulls when unavailable). Live-only discipline
 *  everywhere: delayed quotes refused, never silently used. WP7 exposes
 *  bid/ask too — the microstructure gate prices the spread. */
export async function fetchLiveQuote(symbol: string): Promise<LiveQuote> {
    const none: LiveQuote = { last: null, bid: null, ask: null };
    try {
        const raw = await createIbkrMarketData().invoke({ ticker: symbol, exchange: 'SMART', currency: 'USD' });
        const data = (JSON.parse(String(raw)) as { data?: { last?: number; bid?: number; ask?: number; delayed?: boolean } }).data;
        // Never gate on a delayed quote: with IBKR_MARKET_DATA_TYPE=3 an
        // unentitled instrument degrades to ~15-min-delayed ticks, and for
        // the chase/invalidation check a stale price treated as live would
        // be exactly the failure the gate exists to catch.
        if (data?.delayed) {
            logger.warn(`[proposal-executor] ${symbol}: quote is DELAYED (entitlement regression?) — accept-time checks will refuse`);
            return none;
        }
        const bid = data?.bid && Number.isFinite(data.bid) && data.bid > 0 ? data.bid : null;
        const ask = data?.ask && Number.isFinite(data.ask) && data.ask > 0 ? data.ask : null;
        const last = data?.last && Number.isFinite(data.last) && data.last > 0
            ? data.last
            : bid !== null && ask !== null ? (bid + ask) / 2 : null;
        return { last, bid, ask };
    } catch {
        return none;
    }
}

/** Last price only (creation-time buy-now check, entry-context capture). */
export async function fetchLastPrice(symbol: string): Promise<number | null> {
    return (await fetchLiveQuote(symbol)).last;
}

export async function acceptProposal(id: string): Promise<ExecutionOutcome> {
    await expireStale();
    const p = await getProposal(id);
    if (!p) {
        return { ok: false, message: `Proposal ${id.toUpperCase()} not found.` };
    }
    if (p.status !== 'open') {
        return { ok: false, message: `Proposal ${p.id} is ${p.status}, not open. ${formatProposalLine(p)}` };
    }

    // Atomic claim (open → executing): exactly one concurrent accept wins.
    // Without this, two accepts racing through the async gates below could
    // both observe 'open' and place two brackets.
    if (!(await claimProposalForExecution(p.id))) {
        return { ok: false, message: `⛔ ${p.id} is already being executed by another accept — not placing a second bracket.` };
    }

    // Safety gates — order matters: cheap static lock first, then live P&L.
    // A gate REFUSAL leaves the proposal OPEN: gates re-run on every accept,
    // and transient conditions (P&L verification timeout, a halt cleared
    // later) must not permanently kill a valid proposal before its expiry.
    // The live quote is hoisted so the refusal ledger can record what the
    // chase gate actually saw (null when the refusal fired before the fetch).
    let liveLast: number | null = null;
    try {
        assertOrderingAllowed();
        // DAY brackets need a session to live in: placed post-close they are
        // guaranteed broker rejections (IBKR 201 "exchange is closed" —
        // observed live 2026-08-11, bell-race triggers). GTC brackets rest
        // legally at any hour; pre-market DAY orders rest until the open.
        // Gated off in tests (wall-clock dependent, same as the tracker's
        // DAY-expiry detection) — the scenario suites must not change
        // verdicts with the hour they run at.
        if (process.env.NODE_ENV !== 'test' && p.tif !== 'GTC' && !isTradeableSession(getMarketSession().session)) {
            throw new Error(
                '[session-gate] the session is over — a DAY bracket placed now is a guaranteed broker rejection. ' +
                'Re-propose as a GTC overnight setup if the thesis survives the night, or wait for the next session.',
            );
        }
        const lossStatus = await assertDailyLossOk();

        // WP6: refetch the market context — REQUIRED at accept, unlike
        // creation. A proposal created during a data outage used to reach
        // real orders with the noise-stop/target/extension/chase checks
        // silently skipped. Any missing piece refuses fail-closed (the
        // proposal stays open; retry when data is back).
        const riskCtx = await fetchDailyRiskContext(p.symbol);
        const quote = await fetchLiveQuote(p.symbol);
        const last = quote.last;
        liveLast = last;
        assertAcceptContext({ symbol: p.symbol, dailyAtr: riskCtx.dailyAtr, ema10: riskCtx.ema10, lastPrice: last });

        // WP7: microstructure — can the market absorb this order? Spread
        // and ADV are hard-required; borrow must be CONFIRMED for shorts;
        // a known halt refuses. All refusals transient (retry).
        const shortSnap = await fetchShortabilitySnapshot(p.symbol);
        const micro = checkMicrostructure(
            {
                symbol: p.symbol,
                direction: p.direction,
                quantity: p.quantity,
                bid: quote.bid,
                ask: quote.ask,
                avgDailyVolume20d: riskCtx.avgDailyVolume20d,
                shortable: shortSnap.shortable,
                halted: shortSnap.halted,
            },
            getRiskRules(),
        );
        for (const n of micro.notes) logger.info(`[proposal-executor] ${p.id}: ${n}`);
        if (micro.violations.length > 0) {
            throw new Error(`[microstructure-gate] ${micro.violations.join('; ')}`);
        }

        // Risk gate with live account context. Re-runs the static checks too:
        // rules may have been tightened since the proposal was created.
        const exposure = (await listExposure()).filter((t) => t.id !== p.id);
        const exposureValue = (t: { quantity: number; entryFillPrice: number | null; entry: number | null; entryLimit: number | null }) =>
            t.quantity * (t.entryFillPrice ?? t.entry ?? t.entryLimit ?? 0);

        // WP4: the broker book is canonical — the caps see the MAX of what
        // the DB believes and what the broker actually holds. FAIL CLOSED:
        // a fetch failure refuses the accept (proposal stays open, retry
        // when the snapshot is back) — unknown exposure never passes.
        // Planned-RISK headroom stays DB-side (a broker-only position has
        // no stop to price); WP3 adoption rows close that gap within a
        // sweep cycle, this union backstops the counts and notionals.
        const brokerBook = await fetchBrokerExposure();
        const union = unionExposure(
            exposure.map((t) => ({ symbol: t.symbol, quantity: t.quantity, valueUsd: exposureValue(t) })),
            brokerBook,
        );
        if (union.brokerOnlySymbols.length > 0) {
            logger.warn(`[proposal-executor] ${p.id}: broker holds cap-relevant positions with no DB row yet: ${union.brokerOnlySymbols.join(', ')} (adoption sweep pending)`);
        }

        // Sector concentration context — decision D3 (WP6): an
        // unresolvable sector no longer SKIPS the cap. Unknowns (ETFs,
        // metadata misses, resolution errors) count into a shared
        // 'UNKNOWN' bucket capped at the same percentage — a blind spot
        // can no longer accumulate unbounded concentration.
        const resolveSector = async (sym: string): Promise<string> => {
            try {
                return (await getSectorInfo(sym))?.sector ?? 'UNKNOWN';
            } catch {
                return 'UNKNOWN';
            }
        };
        const sector = await resolveSector(p.symbol);
        let sameSectorExposureUsd = 0;
        for (const t of exposure) {
            if ((await resolveSector(t.symbol)) === sector) sameSectorExposureUsd += exposureValue(t);
        }
        assertProposalRisk(
            {
                symbol: p.symbol,
                direction: p.direction,
                entryType: p.entryType,
                entry: p.entry,
                entryLimit: p.entryLimit,
                stop: p.stop,
                target: p.target,
                quantity: p.quantity,
                tradeClass: p.tradeClass,
                tif: p.tif,
            },
            {
                netLiquidation: lossStatus.netLiquidation,
                // Both counts exclude the row this accept just claimed to
                // 'executing' — otherwise the proposal consumes its own
                // position slot and daily-trade slot and the practical caps
                // sit one below the configured ones (audit 2026-08-20).
                // WP4: the DB count (per-proposal, sees stacking) and the
                // union count (per-symbol, sees broker-only positions)
                // guard different drifts — the larger one binds.
                openPositions: Math.max(await countOpenExecuted(p.id), union.distinctSymbols),
                executedToday: await countExecutedSince(etDayStartMs(), p.id),
                // Class caps re-checked with live counts (this proposal
                // excluded) — two accepts cannot both pass a full book.
                openSwingPositions: await countOpenByClass('swing', p.id),
                openEarningsBets: await countOpenByClass('earnings-bet', p.id),
                ...(p.worstCaseGapPct != null ? { worstCaseGapPct: p.worstCaseGapPct } : {}),
                // Committed notional on this symbol from OTHER working/filled
                // proposals — the aggregate cap stops same-name stacking.
                // WP4: MAX of the DB view and the broker's actual holding,
                // so a manual TWS position in the same name binds the cap.
                existingSymbolExposure: Math.max(
                    exposure
                        .filter((t) => t.symbol === p.symbol)
                        .reduce((sum, t) => sum + exposureValue(t), 0),
                    union.notionalBySymbol.get(p.symbol) ?? 0,
                ),
                // Daily-loss headroom: the open book's planned stop-outs
                // (gap cost for bets) plus today's realized losses — the
                // gate refuses a book that could stop out through the halt.
                // plannedWorstLossUsd's contract says null = NOT countable,
                // never zero risk — an unpriceable in-flight row therefore
                // refuses the accept instead of granting free headroom
                // (WP0.3; the refusal clears once the row prices or dies).
                openPlannedRiskUsd: exposure.reduce((sum, t) => {
                    const usd = plannedWorstLossUsd(t);
                    if (usd === null) {
                        throw new Error(
                            `[risk-gate] open proposal ${t.id} (${t.symbol}) has no usable price basis — ` +
                            `its worst-case risk is unknown, so the daily-loss headroom cannot be computed. ` +
                            `Retry when its entry fills or it is cleaned up.`,
                        );
                    }
                    return sum + usd;
                }, 0),
                realizedLossTodayUsd: Math.min(0, await sumRealizedPnlSince(etDayStartMs())),
                // Overnight book: GTC rows survive the close (incl. 🌙
                // kept-overnight holds — converted to GTC at the bell).
                overnightExposureUsd: exposure
                    .filter((t) => t.tif === 'GTC')
                    .reduce((sum, t) => sum + exposureValue(t), 0),
                sector,
                sameSectorExposureUsd,
                // WP6: the context the creation-time checks used, now
                // guaranteed present (assertAcceptContext above) — the
                // noise-stop, target-reachability and extension checks run
                // UNCONDITIONALLY at accept.
                dailyAtr: riskCtx.dailyAtr!,
                ema10: riskCtx.ema10!,
                lastPrice: last!,
                ...(riskCtx.recentEarnings === true ? { recentEarnings: true } : {}),
                // Earnings bets: re-verify the evidence at ACCEPTANCE — the
                // calendar or the record may have shifted since creation,
                // and this is the last gate before real orders. Fail-closed.
                ...(p.tradeClass === 'earnings-bet'
                    ? {
                        earningsBetEvidence: await (await import('./earnings-reactions.js'))
                            .fetchEarningsBetEvidence(p.symbol, p.direction),
                    }
                    : {}),
            },
        );

        // Chase/invalidation gate: proposal levels are anchored at creation
        // time; on a fast mover the edge may be gone by accept time. The
        // quote is guaranteed by the context gate above (WP6) — an
        // unavailable quote refused the accept before reaching here.
        if (last !== null) {
            const run = checkPriceRun(p, last);
            if (!run.ok) {
                // Steer the retry: a deep pullback limit under a runner
                // either never fills (SAP) or fills when momentum breaks
                // (AEHR) — the right re-proposal is a continuation trigger.
                // On invalidation (through the stop) the setup is dead:
                // never advise re-entering.
                const hint = run.kind === 'chasing' && p.entryType === 'LMT'
                    ? 'On a runner, a deep pullback limit either never fills or fills when momentum breaks — re-propose as STP_LMT continuation (trigger just above the market, fresh stop/target) or skip.'
                    : run.kind === 'chasing'
                        ? 'Ask for re-evaluated levels instead of accepting stale ones.'
                        : 'The setup is dead at these levels — do not re-enter; re-evaluate from scratch if the thesis still stands.';
                throw new ChaseRefusalError(`[chase-gate] ${run.reason}. ${hint}`, run.kind ?? 'chasing');
            }
        } else {
            logger.warn(`[proposal-executor] ${p.id}: live quote unavailable — chase check skipped`);
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`[proposal-executor] ${p.id} refused by gates (proposal stays open): ${msg}`);
        await releaseProposalClaim(p.id); // refusal → back to open, retryable
        // Ledger the ACCEPTANCE-time refusal — until 2026-08-13 only
        // creation-time refusals were recorded, so the chase gate (the SMCI
        // case itself) was invisible to the nightly counterfactual replay
        // and the gate scoreboard. proposalAgeSec quantifies how stale the
        // levels were when the gate fired; each retried accept records its
        // own event (distinct age/quote — not a duplicate).
        await recordRefusal({
            symbol: p.symbol, direction: p.direction, entryType: p.entryType,
            entry: p.entry, entryLimit: p.entryLimit, stop: p.stop, target: p.target,
            quantity: p.quantity, score: p.score, reason: msg,
            proposalAgeSec: Math.round((Date.now() - p.createdAt) / 1000),
            livePrice: liveLast,
        }).catch(() => { /* ledger is best-effort — never blocks the refusal path */ });
        return {
            ok: false,
            message:
                `⛔ ${p.id} NOT executed — ${msg}\n` +
                `The proposal remains OPEN (expires ${new Date(p.expiresAt).toISOString()}); ` +
                `resolve the issue and reply 'accept ${p.id}' to retry.`,
            ...(err instanceof ChaseRefusalError ? { chaseKind: err.kind } : {}),
        };
    }

    try {
        const result = await placeBracketOrder({
            symbol: p.symbol,
            direction: p.direction,
            quantity: p.quantity,
            entryType: p.entryType,
            entryPrice: p.entry ?? undefined,
            entryLimitPrice: p.entryLimit ?? undefined,
            stopPrice: p.stop,
            targetPrice: p.target,
            tif: p.tif, // GTC brackets survive the close (overnight/swing)
            refId: p.id, // orderRef "<id>:leg" — the broker-side correlation key
        });

        // Broker rejection inside the ack window (WP1): the legs were
        // cancel-swept in bracket.ts — the row is terminally 'failed' with
        // the broker's own reason, and no position slot stays consumed.
        // Before this, the row sat 'executed' until the tracker's async
        // self-heal caught up, and the operator was told it was WORKING.
        if (result.ack.outcome === 'rejected') {
            const r = result.ack.rejection!;
            const reason = `broker rejected order ${r.orderId} (code ${r.code ?? '?'}): ${r.reason}`;
            await setProposalStatus(p.id, 'failed', { note: reason });
            logger.error(`[proposal-executor] ${p.id} ${reason}`);
            return {
                ok: false,
                message: `❌ ${p.id} NOT executed — ${reason}. All bracket legs were cancelled; nothing is working.`,
            };
        }

        const orderIds = [result.parentOrderId, result.takeProfitOrderId, result.stopOrderId];
        // Deviation from the remediation plan's letter (recorded): an
        // UNCONFIRMED placement is marked 'executed' with a loud note
        // rather than left 'executing' — 'executing' rows are invisible to
        // the outcome tracker and releasable by the claim sweeper, and a
        // released claim on live orders invites a double placement. The
        // conservative direction is to track and consume the slot.
        const unconfirmed = result.ack.outcome === 'unconfirmed';
        await setProposalStatus(p.id, 'executed', {
            orderIds,
            orderPermIds: result.ack.permIds,
            executedAt: Date.now(),
            ...(unconfirmed ? { note: 'placement-unconfirmed: no broker ack within the window — verify with \'orders\'' } : {}),
        });
        logger.info(`[proposal-executor] ${p.id} executed (orders ${orderIds.join('/')}, ack ${result.ack.outcome})`);

        // Hand the bracket to the outcome tracker (fills, exit, realized P&L).
        const executed = await getProposal(p.id);
        if (executed) {
            try { trackExecutedProposal(executed); } catch (err) {
                logger.warn(`[proposal-executor] outcome tracking failed for ${p.id}: ${err}`);
            }
        }

        return {
            ok: true,
            message:
                `✅ ${p.id} bracket ${unconfirmed ? 'handed to broker' : 'ACKNOWLEDGED'}: ${p.direction.toUpperCase()} ${p.quantity} ${p.symbol} ` +
                `${p.entryType === 'MKT' ? 'at market' : `limit ${p.entry}`}, stop ${p.stop}, target ${p.target} ` +
                `(orders ${orderIds.join('/')}, OCA ${result.ocaGroup}` +
                `${result.ack.permIds[0] ? `, permId ${result.ack.permIds[0]}` : ''}).\n` +
                (unconfirmed
                    ? `⚠️ The broker has not acknowledged yet — verify with 'orders' before assuming the entry is working.`
                    : `The entry order is WORKING — you hold a position once it fills. ` +
                      `Track with 'orders' (resting orders) and 'positions' (fills).`),
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await setProposalStatus(p.id, 'failed', { note: msg });
        logger.error(`[proposal-executor] ${p.id} failed: ${msg}`);
        return { ok: false, message: `❌ ${p.id} NOT executed — ${msg}` };
    }
}

// ---------------------------------------------------------------------------
// Auto-execution (paper ONLY, behind AUTO_EXECUTE_PAPER)
//
// Stricter than manual acceptance: refuses live ports/accounts REGARDLESS of
// IBKR_ALLOW_LIVE, and enforces a daily cap (AUTO_EXECUTE_MAX_PER_DAY,
// default 5). Auto-execution is never available for live trading by design —
// going live always requires an explicit human acceptance per trade.
// ---------------------------------------------------------------------------

export function isAutoExecuteEnabled(): boolean {
    return (process.env.AUTO_EXECUTE_PAPER ?? '').trim().toLowerCase() === 'true';
}

function assertPaperOnly(): void {
    if (isLivePort()) {
        throw new Error('auto-execute is paper-only: refusing on a live port (4001/7496), regardless of IBKR_ALLOW_LIVE');
    }
    // An EMPTY account list is not proof of paper — it is proof of
    // nothing. Fail closed until IBKR says who we are (audit finding 4).
    const accounts = getManagedAccounts();
    if (accounts.length === 0) {
        throw new Error('auto-execute is paper-only: account identity not verified yet (no managed accounts received) — refusing');
    }
    const liveAccounts = accounts.filter((a) => !a.toUpperCase().startsWith('D'));
    if (liveAccounts.length > 0) {
        throw new Error('auto-execute is paper-only: connected account does not look like a paper account');
    }
}

function autoExecMaxPerDay(): number {
    const n = Number(process.env.AUTO_EXECUTE_MAX_PER_DAY);
    return Number.isFinite(n) && n > 0 ? n : 5;
}

export function autoExecMinScore(): number {
    const n = Number(process.env.AUTO_EXECUTE_MIN_SCORE);
    // D6 (resolved 2026-08-21): DEFAULT 0 for the paper burn-in. The old
    // 80 floor preferentially sampled one band — the ledger's worst
    // (0-for-5) — and starved the protocol's decile-monotonicity test of
    // cross-band data. The burn-in is an EXPERIMENT ON THE SCORE:
    // conditioning sampling on the score biases it. Every deterministic
    // gate still applies; AUTO_EXECUTE_MAX_PER_DAY bounds volume; sizing
    // is flat. The freeze pins whatever value is set here.
    return Number.isFinite(n) && n >= 0 ? n : 0;
}

function etDate(): string {
    const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`;
}

let autoExecDate = '';
let autoExecCount = 0;

/**
 * Auto-execute a proposal on PAPER. Returns a non-ok outcome (never throws)
 * when disabled, capped, non-paper, or when the underlying acceptance fails.
 */
export async function autoExecuteProposal(id: string): Promise<ExecutionOutcome> {
    if (!isAutoExecuteEnabled()) {
        return { ok: false, message: 'auto-execute is disabled (AUTO_EXECUTE_PAPER != true)' };
    }
    const today = etDate();
    if (today !== autoExecDate) {
        autoExecDate = today;
        autoExecCount = 0;
    }
    const max = autoExecMaxPerDay();
    if (autoExecCount >= max) {
        return { ok: false, message: `auto-execute daily cap reached (${max}/day)` };
    }

    // Static live-port refusal first — it must dominate every other message.
    if (isLivePort()) {
        return { ok: false, message: 'auto-execute refused — auto-execute is paper-only: refusing on a live port (4001/7496), regardless of IBKR_ALLOW_LIVE' };
    }

    // Confidence gate next: a pure filter that places nothing — refusals
    // here must not depend on connection state. The paper-identity assertion
    // runs just before anything could actually execute.
    const p = await getProposal(id);
    if (!p) {
        return { ok: false, message: `auto-execute: proposal ${id.toUpperCase()} not found` };
    }
    const minScore = autoExecMinScore();
    if (p.score == null || p.score < minScore) {
        return {
            ok: false,
            message: `auto-execute: ${p.id} score ${p.score ?? 'none'} is below the confidence threshold ` +
                `${minScore} (AUTO_EXECUTE_MIN_SCORE) — left open for manual 'accept ${p.id}'`,
        };
    }

    try {
        assertPaperOnly();
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[proposal-executor] auto-execute refused: ${msg}`);
        return { ok: false, message: `auto-execute refused — ${msg}` };
    }

    const outcome = await acceptProposal(id);
    if (outcome.ok) autoExecCount++;

    // The SMCI lesson: a 'chasing' refusal means the THESIS survived but
    // the price didn't wait — chase-gate correctness must not equal a
    // missed move. One deterministic STP_LMT continuation at fresh levels,
    // through every gate again. (proposeChaseContinuation recurses into
    // this function for the new proposal; the source guard ends the chain.)
    if (!outcome.ok && outcome.chaseKind === 'chasing') {
        const cont = await proposeChaseContinuation(p).catch((err) => {
            logger.warn(`[proposal-executor] chase continuation for ${p.id} failed: ${err}`);
            return null;
        });
        if (cont) {
            return {
                ok: outcome.ok,
                chaseKind: outcome.chaseKind,
                message: `🤖 AUTO-EXECUTE (paper, score ${p.score}, ${autoExecCount}/${max} today) — ${outcome.message}\n${cont.message}`,
            };
        }
    }
    return {
        ok: outcome.ok,
        ...(outcome.chaseKind ? { chaseKind: outcome.chaseKind } : {}),
        message: `🤖 AUTO-EXECUTE (paper, score ${p.score}, ${autoExecCount}/${max} today) — ${outcome.message}`,
    };
}

// ---------------------------------------------------------------------------
// Chase continuation — the SMCI lesson (2026-08-12)
//
// SMCI triggered at rank 83, was proposed at honest 2:1 geometry, and the
// chase gate refused acceptance 70 seconds later: the price had run +2.3%
// while the evaluation typed. The refusal message told the model the right
// re-proposal shape (STP_LMT continuation) — but the evaluation had
// already ended, nobody acted, and a +19% day went unmonetized. The gate
// was right to refuse the STALE price; the desk was wrong to stop there.
//
// On a 'chasing' auto-exec refusal, ONE continuation proposal is created
// deterministically: same thesis, STP_LMT trigger just above the market
// (it fills only if strength continues), the original's stop DISTANCE
// (the noise-stop calibration is unchanged minutes later), a fresh
// min_risk_reward target, tick-aligned, auto-sized, short expiry. Every
// gate re-runs on creation and acceptance. 'invalidated' refusals (traded
// through the stop) never continue — that setup is dead.
// ---------------------------------------------------------------------------

export function isChaseContinuationEnabled(): boolean {
    return (process.env.CHASE_CONTINUATION ?? 'true').trim().toLowerCase() !== 'false';
}

/** Confirmation quantum for the continuation trigger, as a fraction of the
 *  original stop distance. The chase gate defines "the price moved
 *  meaningfully" in units of the trade's own geometry (CHASE_FRACTION of
 *  the edge); a continuation must demand confirmation on the same scale —
 *  a 0.1%-above-last trigger is microstructure noise that converts
 *  "don't chase at X" into "chase at X + 4 cents" and pays a full 1R on
 *  every false breakout of a gap-fill day. The margin arithmetic lives in
 *  the risk gate (ENTRY_CONFIRM_FRACTION) since 2026-08-18 — the same
 *  "beyond noise" definition now also gates creation-time entry pricing,
 *  and the two must never drift apart. */

/** Pure: fresh continuation levels from the live price, preserving the
 *  original stop distance and re-deriving the target from the ROUNDED
 *  distance so the prescription passes its own gates. The trigger sits
 *  max(0.1%, ENTRY_CONFIRM_FRACTION × stop distance) beyond the
 *  live price — it fills only on continuation beyond noise, not on the
 *  first uptick. Null = degenerate. */
export function continuationLevels(
    p: { direction: 'long' | 'short'; entry: number | null; stop: number },
    last: number,
    minRiskReward: number,
): { entry: number; entryLimit: number; stop: number; target: number } | null {
    if (p.entry == null || !(p.entry > 0) || !(last > 0)) return null;
    const stopDist = Math.abs(p.entry - p.stop);
    if (!(stopDist > 0)) return null;
    const c2 = (x: number) => Math.ceil(x * 100) / 100;
    const f2 = (x: number) => Math.floor(x * 100) / 100;
    const confirm = Math.max(0.001 * last, ENTRY_CONFIRM_FRACTION * stopDist);
    // Review 2026-08-21 (round 3): the gate judges STP_LMT geometry at the
    // LIMIT CAP (the worst permitted fill) — so the continuation builds its
    // stop and target FROM the cap, or every continuation is refused by
    // the very gate it exists to satisfy (~1.56R at the cap when built
    // from the trigger).
    if (p.direction === 'long') {
        const trigger = c2(last + confirm);
        const cap = c2(trigger * 1.003);
        const stop = f2(cap - stopDist);
        const dist = Math.round((cap - stop) * 100) / 100;
        return { entry: trigger, entryLimit: cap, stop, target: c2(cap + minRiskReward * dist) };
    }
    const trigger = f2(last - confirm);
    if (!(trigger > 0)) return null;
    const cap = f2(trigger * 0.997);
    if (!(cap > 0)) return null;
    const stop = c2(cap + stopDist);
    const dist = Math.round((stop - cap) * 100) / 100;
    return { entry: trigger, entryLimit: cap, stop, target: f2(cap - minRiskReward * dist) };
}

/** One continuation per original proposal, process-lifetime. */
const continuedOriginals = new Map<string, string>();

async function proposeChaseContinuation(original: TradeProposal): Promise<ExecutionOutcome | null> {
    if (!isChaseContinuationEnabled()) return null;
    // Never chain: a continuation that gets chased again has had its two
    // honest shots — further pursuit is the chasing the gate exists to stop.
    if (original.source === 'chase-continuation') return null;
    if (original.tradeClass !== 'intraday') return null; // swings/bets re-plan, not re-price
    if (continuedOriginals.has(original.id)) return null;

    const last = await fetchLastPrice(original.symbol);
    if (last === null) return null;
    const rules = getRiskRules();
    const levels = continuationLevels(original, last, rules.min_risk_reward);
    if (!levels) return null;

    const { getDailyLossStatus } = await import('./daily-loss-guard.js');
    const { computeQuantity } = await import('./position-sizer.js');
    const netLiq = (await getDailyLossStatus().catch(() => null))?.netLiquidation;
    if (netLiq == null || !(netLiq > 0)) return null;
    const sized = computeQuantity({
        // Worst permitted fill (review 2026-08-21): STP_LMT sizes at the cap.
        entry: levels.entryLimit,
        stop: levels.stop,
        score: original.score,
        netLiquidation: netLiq,
        tradeClass: 'intraday',
    }, rules);
    if (sized.quantity === null) {
        return { ok: false, message: `🏃 chase continuation for ${original.id} not viable: ${sized.reason}` };
    }

    try {
        const { fetchDailyRiskContext } = await import('@/tools/ibkr/daily-atr.js');
        const { dailyAtr, ema10, recentEarnings } = await fetchDailyRiskContext(original.symbol);
        const { createProposal } = await import('./trade-proposals.js');
        const cont = await createProposal({
            symbol: original.symbol,
            direction: original.direction,
            // Judgment purity (review 2026-08-21): the continuation is the
            // ORIGINAL judgment re-priced — it inherits its model stamp.
            model: original.model ?? undefined,
            entryType: 'STP_LMT',
            entry: levels.entry,
            entryLimit: levels.entryLimit,
            stop: levels.stop,
            target: levels.target,
            quantity: sized.quantity,
            tif: 'DAY',
            tradeClass: 'intraday',
            score: original.score ?? undefined,
            rationale: `chase continuation of ${original.id} (price ran past ${original.entry} before acceptance): ` +
                `fills only on continued strength through ${levels.entry}`,
            source: 'chase-continuation',
            expiresMinutes: 30,
        }, {
            ...(dailyAtr != null ? { dailyAtr } : {}),
            ...(ema10 != null ? { ema10 } : {}),
            ...(recentEarnings === true ? { recentEarnings: true } : {}),
        });
        continuedOriginals.set(original.id, cont.id);
        logger.info(`[proposal-executor] chase continuation ${cont.id} for ${original.id}: ${original.direction} ${original.symbol} STP_LMT @${levels.entry}`);

        const exec = await autoExecuteProposal(cont.id);
        return {
            ok: exec.ok,
            message:
                `🏃 CHASE CONTINUATION ${cont.id} (replaces the stale ${original.id} levels): ${original.direction.toUpperCase()} ` +
                `${original.symbol} STP_LMT trigger ${levels.entry} (limit ${levels.entryLimit}), stop ${levels.stop}, ` +
                `target ${levels.target}, ${sized.quantity} shares — fills only if strength continues; expires in 30 min. ${exec.message}`,
        };
    } catch (err) {
        // A gate refusal here is a final, honest no — extension/headroom/
        // caps re-judged the fresh levels and said skip.
        return { ok: false, message: `🏃 chase continuation for ${original.id} refused: ${err instanceof Error ? err.message : err}` };
    }
}

/**
 * Cancel the bracket orders of an EXECUTED, still-unfilled proposal
 * (risk-reducing: it removes a pending entry). Refused once the entry has
 * filled — a position exists then; use protect/close instead. The outcome
 * tracker observes the cancellations and closes the proposal honestly.
 */
export async function cancelProposalBracket(id: string): Promise<ExecutionOutcome> {
    const p = await getProposal(id);
    if (!p) {
        return { ok: false, message: `Proposal ${id.toUpperCase()} not found.` };
    }
    if (p.status !== 'executed' || !p.orderIds?.length) {
        return { ok: false, message: `Proposal ${p.id} has no working bracket (status: ${p.status}). Use 'reject ${p.id}' for open proposals.` };
    }
    if (p.entryFillPrice != null) {
        return {
            ok: false,
            message: `⛔ ${p.id}: the entry has FILLED — cancelling the exits would leave the ${p.symbol} position unprotected. ` +
                `Use 'close ${p.symbol}' to exit, or leave the bracket working.`,
        };
    }
    try {
        const api = await getIBApi();
        for (const orderId of p.orderIds) {
            try { api.cancelOrder(orderId); } catch { /* already gone */ }
        }
        logger.info(`[proposal-executor] ${p.id}: cancel requested for orders ${p.orderIds.join('/')}`);
        return {
            ok: true,
            message: `🚫 ${p.id}: cancel requested for the ${p.symbol} bracket (orders ${p.orderIds.join('/')}). ` +
                `The close alert confirms once IBKR processes it.`,
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, message: `❌ Could not cancel ${p.id} — ${msg}` };
    }
}

/** Resolve 'cancel SYM' to the working bracket for that symbol. */
export async function cancelProposalForSymbol(symbol: string): Promise<ExecutionOutcome> {
    const sym = symbol.toUpperCase();
    const candidates = (await listTrackable()).filter((p) => p.symbol === sym);
    if (candidates.length === 0) {
        return {
            ok: false,
            message: `No working bracket for ${sym}. 'orders' shows what is live; an open proposal is removed with 'reject P-XXXX'.`,
        };
    }
    const unfilled = candidates.filter((p) => p.entryFillPrice == null);
    if (unfilled.length > 1) {
        return {
            ok: false,
            message: `${sym} has ${unfilled.length} working brackets (${unfilled.map((p) => p.id).join(', ')}) — cancel by id.`,
        };
    }
    // Zero unfilled → every bracket's entry has filled; delegate so the
    // standard "position would be unprotected" refusal explains it.
    return cancelProposalBracket((unfilled[0] ?? candidates[0]).id);
}

export async function rejectProposal(id: string): Promise<ExecutionOutcome> {
    const p = await getProposal(id);
    if (!p) {
        return { ok: false, message: `Proposal ${id.toUpperCase()} not found.` };
    }
    if (p.status !== 'open') {
        return { ok: false, message: `Proposal ${p.id} is already ${p.status}.` };
    }
    await setProposalStatus(p.id, 'rejected');
    return { ok: true, message: `🚫 ${p.id} rejected. ${formatProposalLine({ ...p, status: 'rejected' })}` };
}
