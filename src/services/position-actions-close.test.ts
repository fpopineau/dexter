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
// Plain assignment (REQ-TEST-001): `??=` kept the PRODUCTION path when .env
// supplied one — the preload isolates globally, this pins the suite's own dir.
process.env.DEXTER_DATA_DIR = dir;

import { createProposal, getProposal, setProposalStatus } from './trade-proposals.js';
import {
    __attachApiForTests,
    __handleOrderStatusForTests,
    __resetTrackerForTests,
    __setFinalizeDelayForTests,
    __setReconciliationStateForTests,
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
        else {
            queueMicrotask(() => this.emit(EventName.orderStatus, id, 'Filled', Number(order.totalQuantity ?? 0), 0, this.fillPrice));
            // A filled full-size close leaves the account flat — round 11:
            // closePosition VERIFIES flatness with a fresh snapshot, so the
            // fake book must reflect the fill like the real one does.
            this.position = null;
        }
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
    /** Round 8: false models a broker that never sends openOrderEnd —
     *  the view is PARTIAL and must not be trusted as the whole book. */
    serveOrdersEnd = true;
    reqAllOpenOrders(): void {
        queueMicrotask(() => {
            for (const o of this.openOrders) this.emit(EventName.openOrder, o.id, o.contract, o.order);
            if (this.serveOrdersEnd) this.emit(EventName.openOrderEnd);
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
        // Take-policy geometry (WP-EXIT): 4%-ATR fixture → x = 6%.
        stop: Math.round(entry * 0.975 * 100) / 100,
        target: Math.round(entry * 1.06 * 100) / 100,
        quantity,
        rationale: 'close-lifecycle scenario',
        source: 'test',
    }, { dailyAtr: 0.04 * entry });
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
        reconcileWaitMs: 300,
        probeTimeoutMs: 250,
    });
    __setReconciliationStateForTests(null); // 'idle' — standalone semantics
});

afterAll(() => {
    __resetTrackerForTests();
    __setFinalizeDelayForTests(null);
    __setReconciliationStateForTests(null);
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
        // Round-10: FLAT is a distinct position claim — consumers gate on it.
        expect(out.flat).toBe(true);
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

    test('stacked pairs (two OCA groups): close REFUSES — no atomic exclusion, no order (round 9)', async () => {
        fake.position = { symbol: 'CLQG', qty: 10 };
        const exit = (id: number, oca: string) => ({
            id,
            contract: { symbol: 'CLQG' } as Contract,
            order: { action: 'SELL', orderType: 'STP', tif: 'GTC', orderRef: 'protect-CLQG', ocaGroup: oca } as unknown as Order,
        });
        fake.openOrders = [exit(9003, 'dexter-CLQG-1'), exit(9004, 'dexter-CLQG-2')];

        const out = await closePosition('CLQG', 'test-operator');
        expect(out.ok).toBe(false);
        expect(out.message).toContain('atomically');
        expect(fake.placed).toHaveLength(0); // the racy close never went out
    });

    test('boot gate (round 7): a close during pending reconciliation is refused, not guessed', async () => {
        fake.position = { symbol: 'CLQH', qty: 10 };
        __setReconciliationStateForTests('pending');
        const out = await closePosition('CLQH', 'test-operator');
        expect(out.ok).toBe(false);
        expect(out.message).toContain('reconciliation');
        expect(fake.placed).toHaveLength(0); // nothing reached the broker
        // Reconciliation completes → the same close proceeds normally.
        __setReconciliationStateForTests('done');
        const retry = await closePosition('CLQH', 'test-operator');
        expect(retry.state).toBe('filled');
    });

    test('mixed exit book (grouped + ungrouped): close REFUSES — partial coverage is no coverage (rounds 7+9)', async () => {
        fake.position = { symbol: 'CLQI', qty: 10 };
        fake.openOrders = [
            {
                id: 9005,
                contract: { symbol: 'CLQI' } as Contract,
                order: { action: 'SELL', orderType: 'STP', tif: 'GTC', orderRef: 'protect-CLQI:stop', ocaGroup: 'dexter-CLQI-1' } as unknown as Order,
            },
            {
                // Legacy stop-only protect order placed before groups existed.
                id: 9006,
                contract: { symbol: 'CLQI' } as Contract,
                order: { action: 'SELL', orderType: 'STP', tif: 'GTC', orderRef: 'protect-CLQI:stop' } as unknown as Order,
            },
        ];
        const out = await closePosition('CLQI', 'test-operator');
        expect(out.ok).toBe(false);
        expect(out.message).toContain('atomically');
        expect(fake.placed).toHaveLength(0);
    });

    test('incomplete book view (no openOrderEnd): close REFUSES — an unprovable book is unprovable (rounds 8+9)', async () => {
        fake.position = { symbol: 'CLQJ', qty: 10 };
        fake.serveOrdersEnd = false; // partial snapshot — an ungrouped exit could be hidden
        fake.openOrders = [{
            id: 9007,
            contract: { symbol: 'CLQJ' } as Contract,
            order: { action: 'SELL', orderType: 'STP', tif: 'GTC', orderRef: 'protect-CLQJ:stop', ocaGroup: 'dexter-CLQJ-1' } as unknown as Order,
        }];
        const out = await closePosition('CLQJ', 'test-operator');
        expect(out.ok).toBe(false);
        expect(out.message).toContain('snapshot');
        expect(fake.placed).toHaveLength(0);
        // The snapshot recovers → the same close proceeds, joined.
        fake.serveOrdersEnd = true;
        const retry = await closePosition('CLQJ', 'test-operator');
        expect(retry.state).toBe('filled');
        expect((fake.placed[0]!.order as unknown as { ocaGroup?: string }).ocaGroup).toBe('dexter-CLQJ-1');
    });

    test('a manual order appearing AFTER preflight surfaces in the result — flat but NOT clean (round 11)', async () => {
        fake.position = { symbol: 'CLQL', qty: 10 };
        fake.onPlace = (id, order) => {
            // Between preflight and cleanup, the operator parks a manual
            // stop in TWS. The close still fills and the account is flat —
            // but that resting order OPENS a position when it fills.
            fake.openOrders.push({
                id: 9009,
                contract: { symbol: 'CLQL' } as Contract,
                order: { action: 'SELL', orderType: 'STP', tif: 'GTC', orderRef: 'late manual stop' } as unknown as Order,
            });
            fake.position = null;
            queueMicrotask(() => fake.emit(EventName.orderStatus, id, 'Filled', Number(order.totalQuantity ?? 0), 0, fake.fillPrice));
        };
        const out = await closePosition('CLQL', 'test-operator');
        expect(out.state).toBe('filled');
        expect(out.flat).toBe(true);       // the account IS flat…
        expect(out.clean).toBe(false);     // …but the book is NOT settled
        expect(out.message).toContain('STILL WORKING');
    });

    test('a MANUAL (non-Dexter) exit refuses the close — it cannot be joined or cancelled from here (round 10)', async () => {
        fake.position = { symbol: 'CLQK', qty: 10 };
        fake.openOrders = [{
            id: 9008,
            contract: { symbol: 'CLQK' } as Contract,
            // Operator-placed TWS stop: no Dexter ref, no group we own.
            order: { action: 'SELL', orderType: 'STP', tif: 'GTC', orderRef: 'my manual stop' } as unknown as Order,
        }];
        const out = await closePosition('CLQK', 'test-operator');
        expect(out.ok).toBe(false);
        expect(out.message).toContain('not placed by');
        expect(fake.placed).toHaveLength(0);
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
        // attributes P&L and runs the exit cleanup itself. Round 12: the
        // fill leaves the account flat and settlement verifies it — a
        // clean delayed fill must NOT alarm the operator.
        const alerts: string[] = [];
        const { onAutoProtect } = await import('./outcome-tracker.js');
        const off = onAutoProtect((m) => { alerts.push(m); });
        fake.emit(EventName.orderStatus, closeOrderId, 'Filled', 4, 0, 195);
        fake.position = null; // the broker book reflects the fill
        await sleep(120);
        off();
        const row = await getProposal(t.id);
        expect(row?.exitReason).toBe('manual');
        expect(row?.realizedPnl).toBeCloseTo((195 - 200) * 4, 2);
        expect(hasWorkingManualExit('CLQE')).toBe(false);
        // Tracked bracket ids swept by the tracker's post-fill cleanup.
        expect(fake.cancelled.length).toBeGreaterThan(0);
        expect(alerts.filter((m) => m.includes('NOT FLAT'))).toHaveLength(0);
    });

    test('delayed fill with RESIDUAL position: the settlement check alarms even with clean cleanup (round 12)', async () => {
        const t = await trackedProposal('CLQM', 4, 200);
        __handleOrderStatusForTests(t.entryId, 'Filled', 4, 0, 200);
        fake.position = { symbol: 'CLQM', qty: 4 };
        let closeOrderId = 0;
        fake.onPlace = (id, order) => {
            closeOrderId = id;
            queueMicrotask(() => fake.emit(EventName.orderStatus, id, 'PreSubmitted', 0, Number(order.totalQuantity ?? 0), 0));
        };
        const out = await closePosition('CLQM', 'test-operator');
        expect(out.state).toBe('working');

        // The resting close fills an OUTDATED quantity — the broker book
        // still shows a residual position. Cleanup itself settles clean
        // (exits cancel-confirmed, book snapshot complete), which was
        // exactly the case the old incident-gated check missed.
        const alerts: string[] = [];
        const { onAutoProtect } = await import('./outcome-tracker.js');
        const off = onAutoProtect((m) => { alerts.push(m); });
        fake.emit(EventName.orderStatus, closeOrderId, 'Filled', 4, 0, 195);
        // fake.position stays { CLQM, 4 } — residue after the fill.
        await sleep(120);
        off();
        expect(alerts.some((m) => m.includes('CLQM') && m.includes('NOT FLAT'))).toBe(true);
    });
});

describe('boot-gate arming transitions (round-9 review)', () => {
    test('a failed/partial sweep never arms; a complete one does; done never regresses', async () => {
        const { __armAfterSweepForTests, reconciliationState, stopOutcomeTracker } = await import('./outcome-tracker.js');
        __setReconciliationStateForTests('pending');
        __armAfterSweepForTests(false); // skipped/partial sweep
        expect(reconciliationState()).toBe('pending'); // the regression under test: unconditional arming
        __armAfterSweepForTests(true); // a later COMPLETE sweep (retry or periodic)
        expect(reconciliationState()).toBe('done');
        __armAfterSweepForTests(false); // sticky: a later bad sweep must not close the gate mid-session
        expect(reconciliationState()).toBe('done');
        stopOutcomeTracker(); // clears the 60s arm-retry timer the false path scheduled
        expect(reconciliationState()).toBe('idle');
    });
});
