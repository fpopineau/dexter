import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventName, OrderType, type Contract, type Order } from '@stoqey/ib';

// Isolate the proposals DB BEFORE the store's first call (no-op when
// another suite already initialized the shared store — tests are
// delta-based with unique symbols, the established pattern).
const dir = mkdtempSync(join(tmpdir(), 'dexter-close-'));
process.env.DEXTER_DATA_DIR ??= dir;

import { createProposal, getProposal, setProposalStatus } from './trade-proposals.js';
import {
    __attachApiForTests,
    __handleOrderStatusForTests,
    __resetTrackerForTests,
    __setFinalizeDelayForTests,
    hasWorkingManualExit,
    trackExecutedProposal,
} from './outcome-tracker.js';
import { __setCloseDepsForTests, closePosition } from './position-actions.js';

// Round-4 review (2026-08-21): the close lifecycle had zero direct
// coverage, and two real defects hid in it — the filled branch returned
// no state (EOD triage counts closed ONLY on state==='filled'), and
// trackManualExit registered AFTER the fill wait, so the tracker's
// permanent listener discarded the fill of an order it did not know:
// P&L lost, entry stuck "working" forever, every later close refused.

/** Fake broker with production-shaped event wiring: watchOrderAcks
 *  subscribes for real, and the tracker's status handler is attached to
 *  the same stream exactly as attachOutcomeTracker does in production. */
class FakeIb extends EventEmitter {
    placed: Array<{ id: number; order: Order }> = [];
    cancelled: number[] = [];
    /** Broker reaction per placement; default fills at `fillPrice`. */
    onPlace: ((id: number, order: Order) => void) | null = null;
    fillPrice = 110;
    position: { symbol: string; qty: number } | null = null;

    placeOrder(id: number, _contract: Contract, order: Order): void {
        this.placed.push({ id, order });
        if (this.onPlace) this.onPlace(id, order);
        else queueMicrotask(() => this.emit(EventName.orderStatus, id, 'Filled', Number(order.totalQuantity ?? 0), 0, this.fillPrice));
    }
    cancelOrder(id: number): void {
        this.cancelled.push(id);
        // Healthy broker confirms the cancel (round 4: cleanup counts
        // confirmed cancels, not requests).
        queueMicrotask(() => this.emit(EventName.orderStatus, id, 'Cancelled', 0, 0, 0));
    }
    reqPositions(): void {
        queueMicrotask(() => {
            if (this.position) {
                this.emit(EventName.position, 'DU9999999', { symbol: this.position.symbol, secType: 'STK' }, this.position.qty, 100);
            }
            this.emit(EventName.positionEnd);
        });
    }
    cancelPositions(): void { /* one-shot fetch cleanup */ }
    /** Open-order book served to the OCA probe and the orphan sweep. */
    openOrders: Array<{ id: number; contract: Contract; order: Order }> = [];
    reqAllOpenOrders(): void {
        queueMicrotask(() => {
            for (const o of this.openOrders) this.emit(EventName.openOrder, o.id, o.contract, o.order);
            this.emit(EventName.openOrderEnd);
        });
    }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let fake: FakeIb;
let nextId = 5_000;

let seq = 7_700;
async function trackedProposal(symbol: string, quantity = 10, entry = 100) {
    const p = await createProposal({
        symbol,
        direction: 'long',
        entryType: 'LMT',
        entry,
        stop: entry - 5,
        target: entry + 10,
        quantity,
        rationale: 'close-lifecycle scenario',
        source: 'test',
    });
    const ids = [seq++, seq++, seq++];
    await setProposalStatus(p.id, 'executed', { orderIds: ids, executedAt: Date.now() });
    const row = await getProposal(p.id);
    trackExecutedProposal(row!);
    return { id: p.id, entryId: ids[0], tpId: ids[1], stopId: ids[2] };
}

beforeEach(() => {
    __resetTrackerForTests();
    __setFinalizeDelayForTests(10);
    fake = new FakeIb();
    // Production wiring: the tracker's permanent status listener rides the
    // same event stream watchOrderAcks does (outcome-tracker attach).
    fake.on(EventName.orderStatus, (id: number, status: string, filled: number, remaining: number, avg: number) =>
        __handleOrderStatusForTests(id, status, filled, remaining, avg));
    __attachApiForTests(fake as never);
    __setCloseDepsForTests({
        getApi: async () => fake as never,
        verifyAccounts: async () => { /* verified in-fake */ },
        verifiedAccount: () => 'DU9999999',
        nextOrderId: async () => nextId++,
        fillWaitMs: 200,
        cancelConfirmMs: 150,
    });
});

afterAll(() => {
    __resetTrackerForTests();
    __setFinalizeDelayForTests(null);
    __attachApiForTests(null);
    __setCloseDepsForTests(null);
});

describe('closePosition lifecycle (round-4 review)', () => {
    test("immediate fill returns state 'filled' and releases the duplicate-close guard", async () => {
        fake.position = { symbol: 'CLQA', qty: 10 };
        const out = await closePosition('CLQA', 'test-operator');
        expect(out.ok).toBe(true);
        // The regression: this was undefined, so EOD triage never counted
        // a successful close as closed.
        expect(out.state).toBe('filled');
        expect(fake.placed).toHaveLength(1);
        expect(fake.placed[0]!.order.orderType).toBe(OrderType.MKT);
        // The fill was consumed by the tracker (registration preceded
        // placement) — the guard must NOT stay latched.
        expect(hasWorkingManualExit('CLQA')).toBe(false);
    });

    test('a fast fill is attributed: tracked proposal gets manual exit P&L, not a lost fill', async () => {
        const t = await trackedProposal('CLQB', 10, 100);
        // Entry filled → there is a position the close can attribute to.
        __handleOrderStatusForTests(t.entryId, 'Filled', 10, 0, 100);
        fake.position = { symbol: 'CLQB', qty: 10 };
        fake.fillPrice = 110;

        const out = await closePosition('CLQB', 'test-operator');
        expect(out.state).toBe('filled');
        await sleep(80); // finalize delay (10ms) + async DB write

        const row = await getProposal(t.id);
        expect(row?.exitReason).toBe('manual');
        expect(row?.realizedPnl).toBeCloseTo((110 - 100) * 10, 2);
        expect(hasWorkingManualExit('CLQB')).toBe(false);
    });

    test('broker rejection: state rejected, guard released, exits untouched', async () => {
        const t = await trackedProposal('CLQC', 5, 50);
        __handleOrderStatusForTests(t.entryId, 'Filled', 5, 0, 50);
        fake.position = { symbol: 'CLQC', qty: 5 };
        fake.onPlace = (id) => {
            queueMicrotask(() => fake.emit(EventName.error, new Error('order rejected - reason: outside RTH'), 201, id));
        };

        const out = await closePosition('CLQC', 'test-operator');
        expect(out.ok).toBe(false);
        expect(out.state).toBe('rejected');
        // Nothing reached the broker: protection untouched, guard released
        // (a latched guard would refuse the retry the message asks for).
        expect(fake.cancelled).toHaveLength(0);
        expect(hasWorkingManualExit('CLQC')).toBe(false);
        // Retry after resolving is allowed immediately.
        fake.onPlace = null;
        fake.fillPrice = 51;
        const retry = await closePosition('CLQC', 'test-operator');
        expect(retry.state).toBe('filled');
    });

    test('broker silence: state unconfirmed, ok, exits standing, guard HOLDS against a second close', async () => {
        fake.position = { symbol: 'CLQD', qty: 8 };
        fake.onPlace = () => { /* no broker reaction at all */ };

        const out = await closePosition('CLQD', 'test-operator');
        expect(out.ok).toBe(true);
        expect(out.state).toBe('unconfirmed');
        // Exits must survive an unconfirmed close (flatness unproven).
        expect(fake.cancelled).toHaveLength(0);
        // The order may still be alive at the broker — a second full-size
        // close would reverse the position when both fill.
        expect(hasWorkingManualExit('CLQD')).toBe(true);
        const second = await closePosition('CLQD', 'test-operator');
        expect(second.ok).toBe(false);
        expect(second.message).toContain('WORKING');
    });

    test('close JOINS a single exit OCA group — broker-side mutual exclusion (round 5)', async () => {
        fake.position = { symbol: 'CLQF', qty: 10 };
        const exit = (id: number, orderType: string, oca: string) => ({
            id,
            contract: { symbol: 'CLQF' } as Contract,
            order: { action: 'SELL', orderType, tif: 'GTC', orderRef: 'protect-CLQF', ocaGroup: oca } as unknown as Order,
        });
        fake.openOrders = [exit(9001, 'STP', 'dexter-CLQF-1'), exit(9002, 'LMT', 'dexter-CLQF-1')];

        const out = await closePosition('CLQF', 'test-operator');
        expect(out.state).toBe('filled');
        const placed = fake.placed[0]!.order as unknown as { ocaGroup?: string; ocaType?: number };
        expect(placed.ocaGroup).toBe('dexter-CLQF-1');
        expect(placed.ocaType).toBe(1);
    });

    test('stacked pairs (two OCA groups): close does NOT join — ambiguity falls back to cleanup', async () => {
        fake.position = { symbol: 'CLQG', qty: 10 };
        const exit = (id: number, oca: string) => ({
            id,
            contract: { symbol: 'CLQG' } as Contract,
            order: { action: 'SELL', orderType: 'STP', tif: 'GTC', orderRef: 'protect-CLQG', ocaGroup: oca } as unknown as Order,
        });
        fake.openOrders = [exit(9003, 'dexter-CLQG-1'), exit(9004, 'dexter-CLQG-2')];

        const out = await closePosition('CLQG', 'test-operator');
        expect(out.state).toBe('filled');
        const placed = fake.placed[0]!.order as unknown as { ocaGroup?: string };
        expect(placed.ocaGroup).toBeUndefined();
    });

    test('working close (acked, unfilled): cleanup happens when the fill lands later', async () => {
        const t = await trackedProposal('CLQE', 4, 200);
        __handleOrderStatusForTests(t.entryId, 'Filled', 4, 0, 200);
        fake.position = { symbol: 'CLQE', qty: 4 };
        let closeOrderId = 0;
        fake.onPlace = (id, order) => {
            closeOrderId = id;
            queueMicrotask(() => fake.emit(EventName.orderStatus, id, 'PreSubmitted', 0, Number(order.totalQuantity ?? 0), 0));
        };

        const out = await closePosition('CLQE', 'test-operator');
        expect(out.state).toBe('working');
        expect(hasWorkingManualExit('CLQE')).toBe(true);
        expect(fake.cancelled).toHaveLength(0);

        // The resting close fills later (e.g. at the open) — the tracker
        // attributes P&L and runs the exit cleanup itself.
        fake.emit(EventName.orderStatus, closeOrderId, 'Filled', 4, 0, 195);
        await sleep(80);
        const row = await getProposal(t.id);
        expect(row?.exitReason).toBe('manual');
        expect(row?.realizedPnl).toBeCloseTo((195 - 200) * 4, 2);
        expect(hasWorkingManualExit('CLQE')).toBe(false);
        // Tracked bracket ids swept by the tracker's post-fill cleanup.
        expect(fake.cancelled.length).toBeGreaterThan(0);
    });
});
