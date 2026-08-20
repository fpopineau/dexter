/**
 * Reverse reconciliation — broker → DB (WP3, REMEDIATION-2026-08-20).
 *
 * The existing reconciliation runs strictly DB → broker: it asks whether
 * OUR order ids still exist and discards everything else. This module adds
 * the other direction: broker orders carrying our orderRef re-attach to
 * their proposals, unknown orders are flagged, and unknown POSITIONS are
 * adopted into capped rows — before this, a manual TWS position granted
 * free headroom under every exposure cap.
 *
 * Deliberately conservative: adoption NEVER places or cancels an order.
 * It writes rows, re-points tracking, and tells the operator.
 */

import { EventName, type IBApi, type Order } from '@stoqey/ib';
import { logger } from '@/utils';
import { createAdoptedPosition, listExposure } from './trade-proposals.js';
import { fetchPositions } from './position-actions.js';

export interface BrokerOrderSnap {
    orderId: number;
    symbol: string;
    orderRef: string | null;
    account: string | null;
}

export interface BrokerPositionSnap {
    account: string;
    symbol: string;
    /** Signed: positive = long, negative = short. */
    quantity: number;
    avgCost: number;
}

export interface TrackedView {
    proposalId: string;
    symbol: string;
    orderIds: number[];
}

export type AdoptLeg = 'entry' | 'tp' | 'stop';

export interface AdoptionPlan {
    /** orderRef names one of OUR live proposals but the id is untracked —
     *  re-attach it to the leg (post-reconnect / missed-resize cases). */
    orderAdoptions: Array<{ proposalId: string; leg: AdoptLeg; orderId: number }>;
    /** Broker orders that are neither tracked nor attributable to us. */
    orphanOrders: BrokerOrderSnap[];
    /** Verified-account positions with no executed row on the symbol. */
    positionAdoptions: BrokerPositionSnap[];
    /** Positions in OTHER accounts — flagged, never adopted (D5). */
    foreignPositions: BrokerPositionSnap[];
}

/** Bracket-leg refs: "<proposalId>:<leg>", incl. the WP2 resize legs. */
const LEG_REF = /^(P-[0-9A-F]{4}):(entry|tp|stop|tp2|stop2)$/;
/** Refs of ours that are deliberately NOT proposal-tracked (position
 *  actions, reduce-only tool, synthetic bracket ids). */
const RECOGNIZED_NON_BRACKET = /^(protect-|close-|reduce-|BRKT-)/;

/** Pure: what the broker book implies about the DB. */
export function decideAdoptions(input: {
    orders: BrokerOrderSnap[];
    positions: BrokerPositionSnap[];
    tracked: TrackedView[];
    verifiedAccount: string;
}): AdoptionPlan {
    const trackedIds = new Set(input.tracked.flatMap((t) => t.orderIds));
    const trackedByProposal = new Map(input.tracked.map((t) => [t.proposalId, t]));
    const trackedSymbols = new Set(input.tracked.map((t) => t.symbol.toUpperCase()));

    const orderAdoptions: AdoptionPlan['orderAdoptions'] = [];
    const orphanOrders: BrokerOrderSnap[] = [];
    for (const o of input.orders) {
        if (trackedIds.has(o.orderId)) continue;
        const ref = (o.orderRef ?? '').trim();
        const m = LEG_REF.exec(ref);
        if (m && trackedByProposal.has(m[1])) {
            const leg = (m[2] === 'tp2' ? 'tp' : m[2] === 'stop2' ? 'stop' : m[2]) as AdoptLeg;
            orderAdoptions.push({ proposalId: m[1], leg, orderId: o.orderId });
            continue;
        }
        if (RECOGNIZED_NON_BRACKET.test(ref)) continue; // ours, managed elsewhere
        orphanOrders.push(o);
    }

    const positionAdoptions: BrokerPositionSnap[] = [];
    const foreignPositions: BrokerPositionSnap[] = [];
    for (const p of input.positions) {
        if (p.quantity === 0) continue;
        if (p.account !== input.verifiedAccount) {
            foreignPositions.push(p);
            continue;
        }
        if (trackedSymbols.has(p.symbol.toUpperCase())) continue;
        positionAdoptions.push(p);
    }

    return { orderAdoptions, orphanOrders, positionAdoptions, foreignPositions };
}

/** Open-order snapshot with the fields adoption matches on. */
export function fetchOpenOrderSnaps(api: IBApi): Promise<BrokerOrderSnap[]> {
    const found: BrokerOrderSnap[] = [];
    return new Promise<BrokerOrderSnap[]>((resolve) => {
        const timer = setTimeout(() => { cleanup(); resolve(found); }, 10_000);
        const onOpen = (id: number, contract: { symbol?: string }, order: Order) => {
            found.push({
                orderId: id,
                symbol: (contract.symbol ?? '').toUpperCase(),
                orderRef: typeof order.orderRef === 'string' ? order.orderRef : null,
                account: typeof order.account === 'string' ? order.account : null,
            });
        };
        const onEnd = () => { clearTimeout(timer); cleanup(); resolve(found); };
        function cleanup() {
            api.off(EventName.openOrder, onOpen);
            api.off(EventName.openOrderEnd, onEnd);
        }
        api.on(EventName.openOrder, onOpen);
        api.on(EventName.openOrderEnd, onEnd);
        api.reqAllOpenOrders();
    });
}

/** Orphans already reported this process — the sweep repeats every N
 *  minutes and must not repeat the alarm for the same standing order. */
const notifiedOrphans = new Set<number>();
const notifiedForeign = new Set<string>();

export interface AdoptionHooks {
    /** Re-point a tracked trade's leg at a broker order id (tracker map +
     *  proposal order_ids). */
    repointOrder(proposalId: string, leg: AdoptLeg, orderId: number): Promise<void>;
    notify(message: string): Promise<void>;
    verifiedAccount(): string;
}

/** One reverse-reconciliation sweep. Best-effort by contract: any failure
 *  logs and returns — the sweep reruns on its interval. */
export async function runBrokerAdoption(api: IBApi, hooks: AdoptionHooks): Promise<void> {
    let account: string;
    try {
        account = hooks.verifiedAccount();
    } catch (err) {
        logger.warn(`[broker-adopt] sweep skipped — account identity unavailable: ${err}`);
        return;
    }
    const [orders, positions, exposure] = await Promise.all([
        fetchOpenOrderSnaps(api),
        fetchPositions(api),
        listExposure(),
    ]);
    const plan = decideAdoptions({
        orders,
        positions,
        tracked: exposure.map((t) => ({ proposalId: t.id, symbol: t.symbol, orderIds: t.orderIds ?? [] })),
        verifiedAccount: account,
    });

    for (const a of plan.orderAdoptions) {
        try {
            await hooks.repointOrder(a.proposalId, a.leg, a.orderId);
            logger.info(`[broker-adopt] ${a.proposalId}: adopted broker order ${a.orderId} as ${a.leg} (matched by orderRef)`);
        } catch (err) {
            logger.error(`[broker-adopt] ${a.proposalId}: order adoption failed: ${err}`);
        }
    }

    for (const p of plan.positionAdoptions) {
        try {
            const row = await createAdoptedPosition({
                symbol: p.symbol,
                direction: p.quantity > 0 ? 'long' : 'short',
                quantity: Math.abs(p.quantity),
                avgCost: p.avgCost,
                account: p.account,
            });
            await hooks.notify(
                `📥 ADOPTED: broker position ${p.quantity > 0 ? 'LONG' : 'SHORT'} ${Math.abs(p.quantity)} ${p.symbol} ` +
                `@ ${p.avgCost.toFixed(2)} had no proposal row — recorded as ${row.id} (source 'adopted') so every ` +
                `exposure cap sees it. It carries SYNTHETIC stop/target labels only — Dexter will not manage it: ` +
                `protect or close it yourself ('protect ${p.symbol} …' / 'close ${p.symbol}').`,
            );
        } catch (err) {
            logger.error(`[broker-adopt] position adoption ${p.symbol} failed: ${err}`);
        }
    }

    const newOrphans = plan.orphanOrders.filter((o) => !notifiedOrphans.has(o.orderId));
    if (newOrphans.length > 0) {
        for (const o of newOrphans) notifiedOrphans.add(o.orderId);
        await hooks.notify(
            `⚠️ UNKNOWN broker order(s) working: ` +
            newOrphans.map((o) => `#${o.orderId} ${o.symbol}${o.orderRef ? ` (ref '${o.orderRef}')` : ''}`).join(', ') +
            `. Not Dexter's — left untouched. Review in TWS; a resting exit on a flat symbol is a position waiting to happen.`,
        );
    }

    const newForeign = plan.foreignPositions.filter((p) => !notifiedForeign.has(`${p.account}:${p.symbol}`));
    if (newForeign.length > 0) {
        for (const p of newForeign) notifiedForeign.add(`${p.account}:${p.symbol}`);
        await hooks.notify(
            `⚠️ Position(s) in a FOREIGN account on this connection: ` +
            newForeign.map((p) => `${p.symbol} x${p.quantity} (${p.account})`).join(', ') +
            `. Single-account rule (D5): not adopted, not counted — use a single-account login.`,
        );
    }
}
