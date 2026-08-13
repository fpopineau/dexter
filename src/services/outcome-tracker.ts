/**
 * Outcome tracker — closes the feedback loop on executed proposals.
 *
 * After the executor places a bracket, this service watches the three
 * orders (entry / take-profit / stop) through IBKR's orderStatus,
 * execDetails and commissionReport events and writes the outcome back
 * onto the proposal row:
 *
 *   entry fill price/time → exit fill price → exit reason
 *   (target | stop | cancelled | manual | unknown) → gross realized P&L
 *   and commissions → status 'closed'.
 *
 * These labeled outcomes are what performance reporting, scorer
 * calibration against real fills, and the future ML pipeline consume.
 *
 * Resilience:
 *   - listeners re-attach after automatic IBKR reconnects (onReconnect);
 *   - at attach time, reqExecutions replays today's executions so fills
 *     that happened while the gateway was down are recovered (IBKR only
 *     serves current-day executions — older misses are swept as 'unknown');
 *   - tracked state is rebuilt from the proposals DB at startup
 *     (status = 'executed'), so restarts lose nothing.
 *
 * Exit classification:
 *   - take-profit order fills   → 'target'
 *   - stop order fills          → 'stop'
 *   - entry cancelled unfilled  → 'cancelled' (P&L 0 by construction)
 *   - both exits terminal with the entry filled and no exit fill
 *     → 'manual'. Deliberate closes (closePosition — the phone command,
 *       profit-trail, EOD triage) register their MKT order via
 *       trackManualExit, and its fill supplies the exit price and a real
 *       realized P&L; only truly untracked exits stay 'P&L unknown'
 *       (recorded as null, never guessed).
 */

import { allocReqId, getIBApi, isNonFatalIbkrError, onReconnect } from '@/tools/ibkr/connection.js';
import { logger } from '@/utils';
import type { CommissionReport, Contract, Execution, IBApi } from '@stoqey/ib';
import { EventName } from '@stoqey/ib';
import {
    closeProposal,
    convertToOvernightHold,
    getProposal,
    listTrackable,
    markEntryFilled,
    recordLateExitFill,
    type ExitReason,
    type TradeProposal,
} from './trade-proposals.js';
import type { PositionActionOutcome } from './position-actions.js';

// ---------------------------------------------------------------------------
// Pure outcome math (unit-tested)
// ---------------------------------------------------------------------------

/**
 * Gross realized P&L of a round trip: (exit − entry) × qty, sign-adjusted
 * for shorts. Commissions are tracked separately.
 */
export function computeRealizedPnl(
    direction: 'long' | 'short',
    quantity: number,
    entryAvgPrice: number,
    exitAvgPrice: number,
): number {
    const perShare = direction === 'long'
        ? exitAvgPrice - entryAvgPrice
        : entryAvgPrice - exitAvgPrice;
    return Math.round(perShare * quantity * 100) / 100;
}

/** Flag a stop exit whose fill landed more than this many stop-distances
 *  BEYOND the stop level itself. Honest gap-throughs exist (an overnight
 *  earnings gap can blow 2-3R past a stop), so those get flagged for
 *  review too — that is intended, not a false positive. */
export const SUSPECT_FILL_STOP_MULT = 3;

/**
 * Sanity-check a stop-exit fill against the trade's own geometry — the
 * SECZ lesson (2026-08-13): IBKR's paper simulator filled a 6.43 buy-stop
 * at 11.92, outside RTH, against a real tape trading 5.78 — a −16.7R
 * phantom loss booked as a routine 'stop'. A fill this far through its own
 * level is, on paper, almost certainly a simulator artifact (stops match
 * stray quotes at full size, no depth); live, it is a catastrophic fill
 * that deserves eyeballs either way. FLAG-ONLY: attribution and P&L are
 * recorded unchanged — the operator decides what the number means.
 */
export function assessStopExitFill(
    direction: 'long' | 'short',
    entryFill: number,
    stop: number,
    exitFill: number,
): { suspect: boolean; beyondStopR: number } {
    const stopDist = Math.abs(entryFill - stop);
    if (!(stopDist > 0) || !(exitFill > 0)) return { suspect: false, beyondStopR: 0 };
    // Adverse distance PAST the stop: a long stops out below its stop, a
    // short above. Ordinary slippage is a small positive fraction; negative
    // means the fill was better than the level (price-improved).
    const beyond = direction === 'long' ? stop - exitFill : exitFill - stop;
    const beyondStopR = Math.round((beyond / stopDist) * 10) / 10;
    return { suspect: beyondStopR > SUSPECT_FILL_STOP_MULT, beyondStopR };
}

/** IBKR sends this sentinel for "no value" numeric fields. */
const IB_UNSET = 1.7e308;

export function isIbNumber(n: number | undefined | null): n is number {
    return typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < IB_UNSET;
}

/**
 * Pure: is this finalize the DAY-bracket-expired-at-the-bell case — entry
 * filled, no exit fill (expiry never fills anything), tif DAY, at/after the
 * close? That case is a TRANSITION (keep the proposal alive under the
 * protect pair), never a terminal close: closing it is what orphaned kept
 * positions outside the caps, the triage and the ledger.
 */
export function decideDayExpiryHold(input: {
    reason: ExitReason;
    entryFilled: boolean;
    exitFillKnown: boolean;
    tif: 'DAY' | 'GTC' | null;
    afterBell: boolean;
}): boolean {
    return input.reason === 'manual' && input.entryFilled && !input.exitFillKnown
        && input.tif === 'DAY' && input.afterBell;
}

// ---------------------------------------------------------------------------
// Tracked state
// ---------------------------------------------------------------------------

type OrderRole = 'entry' | 'takeProfit' | 'stop';

interface TrackedTrade {
    proposalId: string;
    symbol: string;
    direction: 'long' | 'short';
    quantity: number;
    entryOrderId: number;
    takeProfitOrderId: number;
    stopOrderId: number;
    entryAvgPrice: number | null;
    entryRecorded: boolean;
    exitAvgPrice: number | null;
    exitReason: ExitReason | null;
    /** execIds seen for this trade — attributes commissionReports. */
    execIds: Set<string>;
    /** Last IBKR error for any of this trade's orders (rejection reason). */
    lastOrderError?: string;
    commissions: number;
    /** Terminal (cancelled/inactive) state per exit order id. */
    terminalExits: Set<number>;
    /** Order id of a deliberate market-close working for this symbol
     *  (closePosition / profit-trail / EOD triage) — finalize waits for
     *  its fill so the close gets a real P&L instead of 'unknown'. */
    pendingManualExit?: number;
    finalizeTimer: ReturnType<typeof setTimeout> | null;
    closed: boolean;
}

const byOrderId = new Map<number, { trade: TrackedTrade; role: OrderRole }>();
const byProposalId = new Map<string, TrackedTrade>();
const byExecId = new Map<string, TrackedTrade>();

type TradeClosedCallback = (proposal: TradeProposal) => void | Promise<void>;
const closedCallbacks = new Set<TradeClosedCallback>();

/** Register a callback fired after a tracked trade is closed. */
export function onTradeClosed(cb: TradeClosedCallback): () => void {
    closedCallbacks.add(cb);
    return () => closedCallbacks.delete(cb);
}

/** Let commission reports trail the final fill before computing net P&L. */
const FINALIZE_DELAY_MS = 2_500;
/** Executed proposals older than this are swept as 'unknown' at startup. */
const STALE_TRACKING_MS = 5 * 24 * 3600_000;

// ---------------------------------------------------------------------------
// Event handling
// ---------------------------------------------------------------------------

function registerOrders(trade: TrackedTrade): void {
    byProposalId.set(trade.proposalId, trade);
    byOrderId.set(trade.entryOrderId, { trade, role: 'entry' });
    byOrderId.set(trade.takeProfitOrderId, { trade, role: 'takeProfit' });
    byOrderId.set(trade.stopOrderId, { trade, role: 'stop' });
}

function unregister(trade: TrackedTrade): void {
    byProposalId.delete(trade.proposalId);
    byOrderId.delete(trade.entryOrderId);
    byOrderId.delete(trade.takeProfitOrderId);
    byOrderId.delete(trade.stopOrderId);
    for (const execId of trade.execIds) byExecId.delete(execId);
    if (trade.finalizeTimer) clearTimeout(trade.finalizeTimer);
}

async function finalize(trade: TrackedTrade, reason: ExitReason, note?: string): Promise<void> {
    if (trade.closed) return;
    trade.closed = true;

    // Surface the broker's rejection reason — 'cancelled' without a why
    // forces log archaeology (e.g. IBKR 201 permission rejections). But an
    // EMPTY reason ("Ordre annulé - Raison :" with nothing after) is IBKR's
    // routine end-of-day expiry cancel — appending it only confuses.
    if (trade.lastOrderError && !/Raison\s*:?\s*$/i.test(trade.lastOrderError)) {
        note = note ? `${note} — ${trade.lastOrderError}` : trade.lastOrderError;
    }

    // DAY-bracket expiry at the bell: entry filled, tif DAY, and we are at/
    // after the close — the exits died of old age, nobody acted. Gated off
    // in tests (wall-clock dependent).
    const proposalEarly = await getProposal(trade.proposalId).catch(() => null);
    const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const afterBell = etNow.getHours() > 15 || (etNow.getHours() === 15 && etNow.getMinutes() >= 55);
    const dayExpiry =
        process.env.NODE_ENV !== 'test' &&
        decideDayExpiryHold({
            reason,
            entryFilled: trade.entryAvgPrice != null,
            // A known exit fill means a DELIBERATE close (profit-trail / EOD
            // triage / operator) that happened to land near the bell — expiry
            // never fills anything.
            exitFillKnown: trade.exitAvgPrice != null,
            tif: proposalEarly?.tif ?? null,
            afterBell,
        });

    // EOD-KEEP TRANSITION (closes the orphaned-keep hole): protect FIRST,
    // and when the GTC pair lands, the proposal is NOT closed — it flips to
    // a kept-overnight hold on the same row and tracking re-points at the
    // new exits. It stays inside the caps, tomorrow's triage re-checks it,
    // and the eventual GTC exit fill gives it a real P&L. Only when
    // protection cannot attach does the old close-as-manual path run.
    let protectAttempt: PositionActionOutcome | null = null;
    if (
        dayExpiry && proposalEarly &&
        (process.env.AUTO_PROTECT ?? '').trim().toLowerCase() !== 'false'
    ) {
        try {
            const { protectPosition, wasRecentlyClosed } = await import('./position-actions.js');
            if (wasRecentlyClosed(proposalEarly.symbol)) {
                logger.info(`[outcome-tracker] ${trade.proposalId} EOD-keep transition skipped — ${proposalEarly.symbol} was deliberately closed just now`);
            } else {
                protectAttempt = await protectPosition(proposalEarly.symbol, proposalEarly.stop, proposalEarly.target);
                const ids = protectAttempt.protectOrderIds;
                if (protectAttempt.ok && ids) {
                    const newTargetId = ids.targetOrderId ?? ids.stopOrderId;
                    const converted = await convertToOvernightHold(trade.proposalId, {
                        orderIds: [trade.entryOrderId, newTargetId, ids.stopOrderId],
                        note: 'DAY exits expired at the bell — kept overnight under GTC protection (EOD keep)',
                    });
                    if (converted) {
                        // Re-point tracking at the protect pair; the trade lives on.
                        byOrderId.delete(trade.takeProfitOrderId);
                        byOrderId.delete(trade.stopOrderId);
                        trade.takeProfitOrderId = newTargetId;
                        trade.stopOrderId = ids.stopOrderId;
                        byOrderId.set(newTargetId, { trade, role: 'takeProfit' });
                        byOrderId.set(ids.stopOrderId, { trade, role: 'stop' });
                        trade.terminalExits.clear();
                        trade.exitReason = null;
                        trade.closed = false;
                        logger.info(`[outcome-tracker] ${trade.proposalId} kept overnight — tracking continues on protect orders ${newTargetId}/${ids.stopOrderId}`);
                        await notifyAutoProtect(
                            `🌙 ${trade.proposalId} ${proposalEarly.symbol}: the DAY bracket expired at the close with the position ` +
                            `still open (${proposalEarly.direction.toUpperCase()} ${proposalEarly.quantity} @ ${trade.entryAvgPrice}) — nothing was closed. ` +
                            `${protectAttempt.message} ` +
                            `The proposal STAYS TRACKED as a kept-overnight hold: it still counts against the position caps, ` +
                            `tomorrow's EOD triage re-checks it, and P&L attributes to ${trade.proposalId} when a GTC exit fills. ` +
                            `NOTE: it was sized by INTRADAY rules and never passed the overnight vetting (tighter caps, earnings check). ` +
                            `Reply 'close ${proposalEarly.symbol}' if you'd rather not hold it.`,
                        );
                        return;
                    }
                    // Conversion refused (raced a concurrent close) — fall
                    // through to the normal close; protection stands.
                }
            }
        } catch (err) {
            logger.error(`[outcome-tracker] EOD-keep transition ${trade.proposalId} failed: ${err}`);
        }
    }
    if (dayExpiry) {
        note = 'DAY bracket exits expired at the session close with the position still open — GTC re-protection attempted (see auto-protect)';
    }

    // Fill sanity on stop exits — the stop LEVEL lives on the proposal row
    // (the trade object only tracks order ids), so fetch it pre-close; the
    // post-close fetch below re-reads the row with its outcome fields.
    if (reason === 'stop' && trade.entryAvgPrice != null && trade.exitAvgPrice != null) {
        const levels = await getProposal(trade.proposalId).catch(() => null);
        if (levels?.stop != null) {
            const fill = assessStopExitFill(trade.direction, trade.entryAvgPrice, levels.stop, trade.exitAvgPrice);
            if (fill.suspect) {
                const warnText =
                    `⚠ SUSPECT FILL: stop ${levels.stop} filled at ${trade.exitAvgPrice} — ` +
                    `${fill.beyondStopR}× the stop distance through the level. Verify against the tape ` +
                    `before trusting this P&L: paper-sim artifacts fill at phantom prices (SECZ 2026-08-13), ` +
                    `and a real fill this bad deserves review either way.`;
                note = note ? `${note} ${warnText}` : warnText;
                logger.warn(`[outcome-tracker] ${trade.proposalId} ${trade.symbol}: ${warnText}`);
            }
        }
    }

    const realizedPnl =
        reason === 'cancelled'
            ? 0
            : trade.entryAvgPrice != null && trade.exitAvgPrice != null
                ? computeRealizedPnl(trade.direction, trade.quantity, trade.entryAvgPrice, trade.exitAvgPrice)
                : undefined;

    try {
        await closeProposal(trade.proposalId, {
            exitReason: reason,
            exitFillPrice: trade.exitAvgPrice ?? undefined,
            realizedPnl,
            commissions: trade.commissions > 0 ? Math.round(trade.commissions * 100) / 100 : undefined,
            note,
        });
    } catch (err) {
        logger.error(`[outcome-tracker] failed to close ${trade.proposalId}: ${err}`);
    }
    unregister(trade);
    logger.info(
        `[outcome-tracker] ${trade.proposalId} ${trade.symbol} closed: ${reason}` +
        (realizedPnl !== undefined ? ` pnl ${realizedPnl}` : '') +
        (trade.commissions ? ` (commissions ${trade.commissions.toFixed(2)})` : ''),
    );

    const proposal = await getProposal(trade.proposalId).catch(() => null);

    // AUTO-PROTECT: a 'manual' close with a filled entry means the exits
    // died while the position may still be open (the DAY-bracket trap —
    // it left TWO positions naked overnight on 2026-07-22). Re-attach GTC
    // protection at the proposal's levels. Risk-REDUCING by construction:
    // protectPosition itself no-ops when the position is flat and refuses
    // when GTC exits already exist. Opt out with AUTO_PROTECT=false.
    //
    // The DAY-expiry-at-the-bell case normally never reaches here (the
    // EOD-keep transition above protects AND keeps the proposal alive);
    // when it does, the transition already tried protection — never place
    // a second pair, just surface what happened.
    if (
        reason === 'manual' && trade.entryAvgPrice != null && proposal &&
        process.env.NODE_ENV !== 'test' &&
        (process.env.AUTO_PROTECT ?? '').trim().toLowerCase() !== 'false'
    ) {
        try {
            if (protectAttempt) {
                if (protectAttempt.ok) {
                    await notifyAutoProtect(
                        `🛡️ ${proposal.symbol}: GTC exits re-armed (${protectAttempt.message}) but the ${trade.proposalId} ` +
                        `row could not be kept alive (a concurrent close won) — it is closed as manual; reconcile with 'positions'.`,
                    );
                } else if (!protectAttempt.message.includes('No open position')) {
                    await notifyAutoProtect(`⚠️ ${proposal.symbol} may be UNPROTECTED (${trade.proposalId} exits died) and auto-protect could not attach exits: ${protectAttempt.message}`);
                }
            } else {
                const { protectPosition, wasRecentlyClosed } = await import('./position-actions.js');
                if (wasRecentlyClosed(proposal.symbol)) {
                    logger.info(`[outcome-tracker] auto-protect ${proposal.symbol} skipped — position was deliberately closed just now`);
                } else {
                    const outcome = await protectPosition(proposal.symbol, proposal.stop, proposal.target);
                    if (outcome.ok) {
                        logger.info(`[outcome-tracker] auto-protected ${proposal.symbol} after dead exits: ${outcome.message}`);
                        await notifyAutoProtect(`🛡️ AUTO-PROTECT ${proposal.symbol}: the ${trade.proposalId} bracket exits died with the entry filled. ${outcome.message}`);
                    } else {
                        logger.info(`[outcome-tracker] auto-protect ${proposal.symbol} not applied: ${outcome.message}`);
                        // "No open position" is the normal case (position really was
                        // closed outside the bracket) — only surface actionable refusals.
                        if (!outcome.message.includes('No open position')) {
                            await notifyAutoProtect(`⚠️ ${proposal.symbol} may be UNPROTECTED (${trade.proposalId} exits died) and auto-protect could not attach exits: ${outcome.message}`);
                        }
                    }
                }
            }
        } catch (err) {
            logger.error(`[outcome-tracker] auto-protect ${proposal.symbol} failed: ${err}`);
            await notifyAutoProtect(`⚠️ ${proposal.symbol} may be UNPROTECTED (${trade.proposalId} exits died) — auto-protect errored: ${err instanceof Error ? err.message : err}. Use 'protect ${proposal.symbol} ${proposal.stop} ${proposal.target}'.`);
        }
    }

    if (proposal) {
        for (const cb of [...closedCallbacks]) {
            try {
                await cb(proposal);
            } catch (err) {
                logger.error(`[outcome-tracker] onTradeClosed callback failed: ${err}`);
            }
        }
    }
}

// --- Auto-protect notifications (bridged to WhatsApp by the gateway) ---
type AutoProtectCallback = (message: string) => void | Promise<void>;
const autoProtectCallbacks = new Set<AutoProtectCallback>();

/** Register a callback for auto-protect outcomes (idempotent per cb). */
export function onAutoProtect(cb: AutoProtectCallback): () => void {
    autoProtectCallbacks.add(cb);
    return () => autoProtectCallbacks.delete(cb);
}

async function notifyAutoProtect(message: string): Promise<void> {
    for (const cb of [...autoProtectCallbacks]) {
        try { await cb(message); } catch (err) {
            logger.error(`[outcome-tracker] auto-protect callback failed: ${err}`);
        }
    }
}

function scheduleFinalize(trade: TrackedTrade, reason: ExitReason, note?: string, delayMs = FINALIZE_DELAY_MS): void {
    if (trade.closed || trade.finalizeTimer) return;
    trade.finalizeTimer = setTimeout(() => {
        trade.finalizeTimer = null;
        void finalize(trade, reason, note);
    }, delayMs);
}

// ---------------------------------------------------------------------------
// Manual-exit attribution
// ---------------------------------------------------------------------------
// Guardian exits (profit-trail, EOD triage, the phone 'close' command) close
// positions with their own MKT order, outside the tracked bracket — which is
// why 15 of the first 49 closed proposals said 'P&L unknown'. The closer
// registers its order here; its fill becomes the exit price for every
// affected proposal, and the finalize pass waits for it.

interface ManualExit {
    symbol: string;
    quantity: number;
    source: string;
    trades: TrackedTrade[];
}

const manualExitOrders = new Map<number, ManualExit>();

/** Pure: the tracked trades a manual close of `symbol` attributes to —
 *  entry filled (there is a position to close) and not yet finalized. */
export function selectManualExitTargets<T extends { symbol: string; closed: boolean; entryRecorded: boolean }>(
    trades: T[],
    symbol: string,
): T[] {
    const sym = symbol.trim().toUpperCase();
    return trades.filter((t) => t.symbol === sym && !t.closed && t.entryRecorded);
}

/**
 * Register a deliberate market-close order (called by closePosition right
 * after placement, BEFORE it cancels the bracket exits). All entry-filled
 * tracked trades on the symbol share the close's fill price — economically
 * exact even when two proposals stacked the position.
 */
export function trackManualExit(symbol: string, orderId: number, quantity: number, source: string): void {
    const trades = selectManualExitTargets([...byProposalId.values()], symbol);
    if (trades.length === 0) {
        logger.info(`[outcome-tracker] manual exit ${symbol} order ${orderId} (${source}): no tracked trades to attribute`);
        return;
    }
    manualExitOrders.set(orderId, { symbol: symbol.trim().toUpperCase(), quantity, source, trades });
    for (const t of trades) t.pendingManualExit = orderId;
    logger.info(
        `[outcome-tracker] manual exit ${symbol} order ${orderId} (${source}) → will attribute P&L to ${trades.map((t) => t.proposalId).join(', ')}`,
    );
}

/** A registered manual-exit order filled at `avgFillPrice`. */
function handleManualExitFill(orderId: number, avgFillPrice: number): void {
    const manual = manualExitOrders.get(orderId);
    if (!manual) return;
    manualExitOrders.delete(orderId);

    for (const trade of manual.trades) {
        const note = `position closed at market by ${manual.source} @ ${avgFillPrice}`;
        if (trade.closed) {
            // Finalized before the fill arrived (close placed outside RTH,
            // filled at the next open) — patch the blanks retroactively.
            if (trade.entryAvgPrice != null) {
                const pnl = computeRealizedPnl(trade.direction, trade.quantity, trade.entryAvgPrice, avgFillPrice);
                void recordLateExitFill(trade.proposalId, { exitFillPrice: avgFillPrice, realizedPnl: pnl, note }).catch(
                    (err) => logger.error(`[outcome-tracker] late exit fill ${trade.proposalId}: ${err}`),
                );
            }
            continue;
        }
        trade.exitAvgPrice = avgFillPrice;
        trade.exitReason = 'manual';
        trade.pendingManualExit = undefined;
        // Replace a generic exits-died finalize already pending: the fill
        // carries the informative note and the P&L.
        if (trade.finalizeTimer) {
            clearTimeout(trade.finalizeTimer);
            trade.finalizeTimer = null;
        }
        scheduleFinalize(trade, 'manual', note);
    }
}

/** How long finalize waits for a registered close order's fill before
 *  giving up (a MKT close placed outside RTH waits for the open — the
 *  late-fill patch covers that case). */
const MANUAL_EXIT_GRACE_MS = 30_000;

const TERMINAL_STATUSES = new Set(['Cancelled', 'ApiCancelled', 'Inactive']);

function handleOrderStatus(
    orderId: number,
    status: string,
    _filled: number,
    remaining: number,
    avgFillPrice: number,
): void {
    // Deliberate market-closes are tracked separately from brackets.
    if (manualExitOrders.has(orderId)) {
        if (status === 'Filled' && remaining === 0 && isIbNumber(avgFillPrice)) {
            handleManualExitFill(orderId, avgFillPrice);
        } else if (TERMINAL_STATUSES.has(status)) {
            const manual = manualExitOrders.get(orderId);
            manualExitOrders.delete(orderId);
            for (const t of manual?.trades ?? []) t.pendingManualExit = undefined;
        }
        return;
    }

    const entry = byOrderId.get(orderId);
    if (!entry || entry.trade.closed) return;
    const { trade, role } = entry;

    if (status === 'Filled' && remaining === 0) {
        if (role === 'entry') {
            if (!trade.entryRecorded && isIbNumber(avgFillPrice)) {
                trade.entryRecorded = true;
                trade.entryAvgPrice = avgFillPrice;
                void markEntryFilled(trade.proposalId, avgFillPrice).catch((err) =>
                    logger.error(`[outcome-tracker] markEntryFilled ${trade.proposalId}: ${err}`),
                );
                logger.info(`[outcome-tracker] ${trade.proposalId} entry filled @ ${avgFillPrice}`);
            }
        } else {
            if (isIbNumber(avgFillPrice)) trade.exitAvgPrice = avgFillPrice;
            trade.exitReason = role === 'takeProfit' ? 'target' : 'stop';
            scheduleFinalize(trade, trade.exitReason);
        }
        return;
    }

    if (TERMINAL_STATUSES.has(status)) {
        if (role === 'entry' && !trade.entryRecorded) {
            // Entry never filled and is gone — bracket is dead, nothing traded.
            scheduleFinalize(trade, 'cancelled', 'entry order cancelled before filling');
            return;
        }
        if (role !== 'entry') {
            trade.terminalExits.add(orderId);
            const bothExitsDead =
                trade.terminalExits.has(trade.takeProfitOrderId) &&
                trade.terminalExits.has(trade.stopOrderId);
            if (bothExitsDead && trade.exitReason === null && trade.entryRecorded) {
                // Entry filled, both exits gone without filling: closed manually
                // or the DAY bracket expired. P&L is unknown — never guessed.
                // When a registered close order is working, give its fill time
                // to arrive first: it carries the real exit price.
                scheduleFinalize(
                    trade,
                    'manual',
                    'both bracket exits terminated without filling — position closed or left unprotected outside the bracket',
                    trade.pendingManualExit !== undefined ? MANUAL_EXIT_GRACE_MS : FINALIZE_DELAY_MS,
                );
            }
        }
    }
}

function handleExecDetails(_reqId: number, _contract: Contract, execution: Execution): void {
    const orderId = execution.orderId;
    if (orderId === undefined) return;

    // Manual-exit fallback (covers a missed orderStatus event): the close
    // order's own quantity decides completeness, not any one trade's.
    const manual = manualExitOrders.get(orderId);
    if (manual) {
        const avg = isIbNumber(execution.avgPrice) ? execution.avgPrice : undefined;
        const cum = isIbNumber(execution.cumQty) ? execution.cumQty : undefined;
        if (avg !== undefined && cum !== undefined && cum >= manual.quantity) {
            handleManualExitFill(orderId, avg);
        }
        return;
    }

    const entry = byOrderId.get(orderId);
    if (!entry || entry.trade.closed) return;
    const { trade, role } = entry;

    if (execution.execId) {
        trade.execIds.add(execution.execId);
        byExecId.set(execution.execId, trade);
    }

    // Fallback fill source (covers fills replayed by reqExecutions after a
    // gateway restart, where the orderStatus event was missed).
    const avg = isIbNumber(execution.avgPrice) ? execution.avgPrice : undefined;
    const cum = isIbNumber(execution.cumQty) ? execution.cumQty : undefined;
    if (avg !== undefined && cum !== undefined && cum >= trade.quantity) {
        if (role === 'entry' && !trade.entryRecorded) {
            trade.entryRecorded = true;
            trade.entryAvgPrice = avg;
            void markEntryFilled(trade.proposalId, avg).catch((err) =>
                logger.error(`[outcome-tracker] markEntryFilled ${trade.proposalId}: ${err}`),
            );
            logger.info(`[outcome-tracker] ${trade.proposalId} entry filled @ ${avg} (execDetails)`);
        } else if (role !== 'entry' && trade.exitReason === null) {
            trade.exitAvgPrice = avg;
            trade.exitReason = role === 'takeProfit' ? 'target' : 'stop';
            scheduleFinalize(trade, trade.exitReason);
        }
    }
}

function handleOrderError(err: Error, code: number, id: number): void {
    const entry = byOrderId.get(id);
    if (!entry || entry.trade.closed) return;
    if (isNonFatalIbkrError(code)) return;
    entry.trade.lastOrderError = `IBKR ${code}: ${err.message}`;
}

function handleCommissionReport(report: CommissionReport): void {
    const execId = report.execId;
    if (!execId) return;
    const trade = byExecId.get(execId);
    if (!trade || trade.closed) return;
    if (isIbNumber(report.commission)) {
        trade.commissions += report.commission;
    }
}

// ---------------------------------------------------------------------------
// Attachment lifecycle
// ---------------------------------------------------------------------------

let attachedApi: IBApi | null = null;
let started = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

/** Replay today's executions and wait for the end marker (or timeout). */
function replayExecutions(api: IBApi): Promise<void> {
    return new Promise<void>((resolve) => {
        const reqId = allocReqId();
        const timer = setTimeout(() => {
            cleanup();
            resolve();
        }, 10_000);
        const onEnd = (id: number) => {
            if (id !== reqId) return;
            clearTimeout(timer);
            cleanup();
            resolve();
        };
        function cleanup() {
            api.off(EventName.execDetailsEnd, onEnd);
        }
        api.on(EventName.execDetailsEnd, onEnd);
        try {
            api.reqExecutions(reqId, {});
        } catch (err) {
            logger.warn(`[outcome-tracker] reqExecutions failed: ${err}`);
            clearTimeout(timer);
            cleanup();
            resolve();
        }
    });
}

/**
 * Reconcile tracked trades against the orders that actually exist.
 *
 * An IB Gateway restart (or the day rollover) can destroy an unfilled
 * bracket: the tracked order ids then reference nothing, no orderStatus
 * event will ever arrive, and the proposal would linger as 'executed'
 * for days — silently consuming max_open_positions headroom. After the
 * executions replay (so fills are already accounted for), any tracked
 * trade with NO live order and NO recorded fill is closed honestly.
 */
async function reconcileAgainstOpenOrders(api: IBApi): Promise<void> {
    if (byProposalId.size === 0) return;

    const openIds = new Set<number>();
    let endSeen = false;
    await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
            cleanup();
            resolve();
        }, 10_000);
        const onOpen = (id: number) => {
            openIds.add(id);
        };
        const onEnd = () => {
            endSeen = true;
            clearTimeout(timer);
            cleanup();
            resolve();
        };
        function cleanup() {
            api.off(EventName.openOrder, onOpen);
            api.off(EventName.openOrderEnd, onEnd);
        }
        api.on(EventName.openOrder, onOpen);
        api.on(EventName.openOrderEnd, onEnd);
        try {
            api.reqAllOpenOrders();
        } catch (err) {
            logger.warn(`[outcome-tracker] reqAllOpenOrders failed: ${err}`);
            clearTimeout(timer);
            cleanup();
            resolve();
        }
    });

    if (!endSeen) {
        // Snapshot may be incomplete — never close trades on partial data.
        logger.warn('[outcome-tracker] open-orders snapshot incomplete, skipping reconciliation');
        return;
    }

    for (const trade of [...byProposalId.values()]) {
        if (trade.closed || trade.finalizeTimer) continue;
        const anyAlive =
            openIds.has(trade.entryOrderId) ||
            openIds.has(trade.takeProfitOrderId) ||
            openIds.has(trade.stopOrderId);
        if (anyAlive) continue;

        if (!trade.entryRecorded) {
            logger.warn(`[outcome-tracker] ${trade.proposalId}: bracket orders no longer exist and entry never filled — closing as cancelled`);
            void finalize(trade, 'cancelled', 'bracket orders no longer exist (Gateway restart or day expiry); entry never filled');
        } else if (trade.exitReason === null) {
            logger.warn(`[outcome-tracker] ${trade.proposalId}: exits no longer exist with entry filled — closing as manual`);
            void finalize(trade, 'manual', 'bracket exits no longer exist — reconcile the position manually (ibkr_account)');
        }
    }
}

async function attach(): Promise<void> {
    const api = await getIBApi();
    if (api === attachedApi) return;
    attachedApi = api;

    api.on(EventName.orderStatus, handleOrderStatus);
    api.on(EventName.execDetails, handleExecDetails);
    api.on(EventName.commissionReport, handleCommissionReport);
    api.on(EventName.error, handleOrderError);

    // Replay today's executions (recovers fills missed while down), THEN
    // reconcile tracked trades against the orders that still exist.
    if (byOrderId.size > 0) {
        await replayExecutions(api);
        await reconcileAgainstOpenOrders(api);
    }
    logger.info(`[outcome-tracker] attached (${byProposalId.size} trade(s) tracked)`);
}

function attachWithRetry(): void {
    void attach().catch((err) => {
        logger.warn(`[outcome-tracker] attach failed, retrying in 60s: ${err}`);
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
            retryTimer = null;
            if (started) attachWithRetry();
        }, 60_000);
    });
}

/**
 * Track a just-executed proposal (called by the executor right after the
 * bracket is placed). Safe to call before startOutcomeTracker.
 */
export function trackExecutedProposal(p: TradeProposal): void {
    if (!p.orderIds || p.orderIds.length < 3) {
        logger.warn(`[outcome-tracker] ${p.id} has no bracket order ids — cannot track`);
        return;
    }
    if (byProposalId.has(p.id)) return;
    const [entryOrderId, takeProfitOrderId, stopOrderId] = p.orderIds;
    registerOrders({
        proposalId: p.id,
        symbol: p.symbol,
        direction: p.direction,
        quantity: p.quantity,
        entryOrderId,
        takeProfitOrderId,
        stopOrderId,
        entryAvgPrice: p.entryFillPrice,
        entryRecorded: p.entryFillPrice != null,
        exitAvgPrice: null,
        exitReason: null,
        execIds: new Set(),
        commissions: 0,
        terminalExits: new Set(),
        finalizeTimer: null,
        closed: false,
    });
    logger.info(`[outcome-tracker] tracking ${p.id} (orders ${p.orderIds.join('/')})`);
    if (started) attachWithRetry();
}

let unregisterReconnect: (() => void) | null = null;

/**
 * Start the tracker: rebuild state from the proposals DB, sweep stale
 * entries, attach IBKR listeners (re-attaching after reconnects).
 * Idempotent; called at gateway startup when IBKR is configured.
 */
export async function startOutcomeTracker(): Promise<void> {
    if (started) return;
    started = true;

    const trackable = await listTrackable().catch((err) => {
        logger.error(`[outcome-tracker] could not load executed proposals: ${err}`);
        return [] as TradeProposal[];
    });

    const now = Date.now();
    for (const p of trackable) {
        const age = now - (p.executedAt ?? p.updatedAt);
        // GTC brackets legitimately live for weeks (swing trades) — they are
        // reconciled against live orders on attach instead of age-swept.
        if (age > STALE_TRACKING_MS && p.tif !== 'GTC') {
            // IBKR can only replay the current day's executions — the outcome
            // of this trade is unrecoverable. Label honestly and move on.
            await closeProposal(p.id, {
                exitReason: 'unknown',
                note: 'stale: executed while tracking was unavailable; outcome not recoverable',
            }).catch(() => { /* best-effort */ });
            logger.warn(`[outcome-tracker] swept stale executed proposal ${p.id} as 'unknown'`);
            continue;
        }
        trackExecutedProposal(p);
    }

    unregisterReconnect = onReconnect(() => attachWithRetry());
    attachWithRetry();
}

/** Stop tracking (gateway shutdown). Tracked state stays in the DB. */
export function stopOutcomeTracker(): void {
    started = false;
    if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
    }
    if (unregisterReconnect) {
        unregisterReconnect();
        unregisterReconnect = null;
    }
    if (attachedApi) {
        attachedApi.off(EventName.orderStatus, handleOrderStatus);
        attachedApi.off(EventName.execDetails, handleExecDetails);
        attachedApi.off(EventName.commissionReport, handleCommissionReport);
        attachedApi.off(EventName.error, handleOrderError);
        attachedApi = null;
    }
    for (const trade of [...byProposalId.values()]) {
        if (trade.finalizeTimer) {
            clearTimeout(trade.finalizeTimer);
            trade.finalizeTimer = null;
        }
    }
    logger.info('[outcome-tracker] stopped');
}

/** Diagnostics: proposals currently being watched. */
export function trackedProposalIds(): string[] {
    return [...byProposalId.keys()];
}
