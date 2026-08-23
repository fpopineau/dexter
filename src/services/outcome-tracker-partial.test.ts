import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventName, type Contract, type Order } from '@stoqey/ib';

// Isolate the proposals DB BEFORE the store's first call (no-op when
// another suite already initialized the shared store — tests are
// delta-based with unique symbols, the established pattern).
const dir = mkdtempSync(join(tmpdir(), 'dexter-partial-'));
const prevDataDir = process.env.DEXTER_DATA_DIR;
// Plain assignment (REQ-TEST-001): `??=` kept the PRODUCTION path when .env
// supplied one — the preload isolates globally, this pins the suite's own dir.
process.env.DEXTER_DATA_DIR = dir;

import { createProposal, getProposal, setProposalStatus } from './trade-proposals.js';
import {
    __attachApiForTests,
    __handleOrderStatusForTests,
    __resetTrackerForTests,
    __setAckWindowForTests,
    __setFinalizeDelayForTests,
    trackExecutedProposal,
    trackManualExit,
} from './outcome-tracker.js';
import { __setManagedAccountsForTests } from '@/tools/ibkr/connection.js';

// WP2 (REMEDIATION-2026-08-20): the fill quantity used to arrive and be
// DISCARDED (`_filled`), so a partial fill + cancel closed as 'cancelled,
// P&L zero' while a real position sat in the account (HTH and BBT rows,
// 2026-08-14). These scenarios drive the tracker through partial-fill
// truth on a fake IBApi.

class FakeIb extends EventEmitter {
    placed: Array<{ id: number; contract: Contract; order: Order }> = [];
    cancelled: number[] = [];
    nextId = 9_000;
    /** Review 2026-08-21: a healthy broker ACKNOWLEDGES — the resize path
     *  requires both replacement legs acked before the old exits die, so
     *  the default fake acks every placement. autoAck=false models broker
     *  silence (the timeout test asserts the old exits SURVIVE it). */
    autoAck = true;
    reqIds(): void {
        queueMicrotask(() => this.emit(EventName.nextValidId, this.nextId));
    }
    placeOrder(id: number, contract: Contract, order: Order): void {
        this.placed.push({ id, contract, order });
        if (this.autoAck) {
            queueMicrotask(() => this.emit(EventName.orderStatus, id, 'PreSubmitted', 0, Number(order.totalQuantity ?? 0), 0, 60_000 + id));
        }
    }
    cancelOrder(id: number): void {
        this.cancelled.push(id);
        // Round-4 review: cancels are broker-CONFIRMED — a healthy fake
        // reports Cancelled, so the resize path's confirmation resolves on
        // the event, not the timeout. (Ids already forgotten by the tracker
        // make this a no-op status, same as production.)
        queueMicrotask(() => this.emit(EventName.orderStatus, id, 'Cancelled', 0, 0, 0));
    }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let seq = 700;
async function trackedProposal(symbol: string, quantity = 10, entry = 100) {
    // Same-symbol stacking must clear the duplicate-setup gate (>2% apart).
    const p = await createProposal({
        symbol,
        direction: 'long',
        entryType: 'LMT',
        entry,
        // Take-policy geometry (WP-EXIT): 4%-ATR fixture → x = 6%.
        stop: Math.round(entry * 0.975 * 100) / 100,
        target: Math.round(entry * 1.06 * 100) / 100,
        quantity,
        rationale: 'partial-fill scenario',
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
    __setAckWindowForTests(15);
    __setManagedAccountsForTests(['DU9999999']);
});

afterAll(() => {
    __resetTrackerForTests();
    __setFinalizeDelayForTests(null);
    __setAckWindowForTests(null);
    __setManagedAccountsForTests([]);
    __attachApiForTests(null);
    if (prevDataDir === undefined) delete process.env.DEXTER_DATA_DIR;
    else process.env.DEXTER_DATA_DIR = prevDataDir;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* held by sqlite */ }
});

describe('partial entry fills are recorded, not discarded', () => {
    test('first partial fill records the entry (row can never close as cancelled)', async () => {
        const t = await trackedProposal('WPA');
        __handleOrderStatusForTests(t.entryId, 'Submitted', 4, 6, 100.1);
        await sleep(20);
        const row = await getProposal(t.id);
        expect(row?.entryFillPrice).toBe(100.1);
        expect(row?.entryFilledAt).not.toBeNull();
    });

    test('zero-fill cancel still closes as cancelled with P&L 0', async () => {
        const t = await trackedProposal('WPB');
        __handleOrderStatusForTests(t.entryId, 'Cancelled', 0, 10, 0);
        await sleep(40);
        const row = await getProposal(t.id);
        expect(row?.status).toBe('closed');
        expect(row?.exitReason).toBe('cancelled');
        expect(row?.realizedPnl).toBe(0);
    });
});

describe('terminal partial entry → downgrade + exit resize', () => {
    test('quantity downgrades to the fill, planned preserved, exits replaced at the real size', async () => {
        const fake = new FakeIb();
        __attachApiForTests(fake as never);
        const t = await trackedProposal('WPC');

        __handleOrderStatusForTests(t.entryId, 'Submitted', 4, 6, 100.1);
        __handleOrderStatusForTests(t.entryId, 'Cancelled', 4, 6, 100.1);
        await sleep(60); // resize is async: nextValidId microtask + DB writes

        const row = await getProposal(t.id);
        expect(row?.status).toBe('executed'); // never 'cancelled' — the position is real
        expect(row?.quantity).toBe(4);
        expect(row?.plannedQuantity).toBe(10);
        expect(row?.note).toContain('4/10');

        // Replacement OCA pair at the REAL size, identity-bound (WP1 rules).
        expect(fake.placed.length).toBe(2);
        for (const p of fake.placed) {
            expect(p.order.totalQuantity).toBe(4);
            expect(p.order.account).toBe('DU9999999');
            expect(String(p.order.orderRef)).toContain(t.id);
        }
        // Old full-size exits cancelled.
        expect(fake.cancelled.sort()).toEqual([t.tpId, t.stopId].sort());
        // Tracking re-pointed: proposal order_ids reference the new pair.
        expect(row?.orderIds).toContain(fake.placed[0].id);
    });

    test('after resize: old exit terminals are ignored; new stop fill closes with P&L on the FILLED quantity', async () => {
        const fake = new FakeIb();
        __attachApiForTests(fake as never);
        const t = await trackedProposal('WPD');

        __handleOrderStatusForTests(t.entryId, 'Submitted', 4, 6, 100.0);
        __handleOrderStatusForTests(t.entryId, 'Cancelled', 4, 6, 100.0);
        await sleep(60);

        // The dead full-size exits report terminal — must NOT close the row.
        __handleOrderStatusForTests(t.tpId, 'Cancelled', 0, 10, 0);
        __handleOrderStatusForTests(t.stopId, 'Cancelled', 0, 10, 0);
        await sleep(40);
        expect((await getProposal(t.id))?.status).toBe('executed');

        // The resized stop fills: P&L on 4 shares, not the planned 10.
        const newStopId = fake.placed.find((p) => String(p.order.orderRef).endsWith(':stop2'))!.id;
        __handleOrderStatusForTests(newStopId, 'Filled', 4, 0, 95);
        await sleep(40);
        const row = await getProposal(t.id);
        expect(row?.status).toBe('closed');
        expect(row?.exitReason).toBe('stop');
        expect(row?.realizedPnl).toBeCloseTo((95 - 100) * 4, 2);
    });
});

describe('resize timeout fails CLOSED (review 2026-08-21 round 3)', () => {
    test('broker silence: new pair swept, OLD full-size exits survive', async () => {
        const fake = new FakeIb();
        fake.autoAck = false; // total broker silence
        __attachApiForTests(fake as never);
        const t = await trackedProposal('WPG');

        __handleOrderStatusForTests(t.entryId, 'Submitted', 4, 6, 100.0);
        __handleOrderStatusForTests(t.entryId, 'Cancelled', 4, 6, 100.0);
        await sleep(80);

        // The quantity downgrade is accounting truth and still lands…
        const row = await getProposal(t.id);
        expect(row?.quantity).toBe(4);
        // …but with no acknowledgement, the NEW pair is swept and the OLD
        // exits are NOT cancelled — an unknown replacement must never
        // replace known protection.
        const newIds = fake.placed.map((p) => p.id);
        expect(fake.cancelled.sort()).toEqual(newIds.sort());
        expect(fake.cancelled).not.toContain(t.tpId);
        expect(fake.cancelled).not.toContain(t.stopId);
        // Tracking still points at the ORIGINAL exits.
        expect(row?.orderIds).toContain(t.stopId);
    });
});

describe('manual-exit attribution allocates by quantity (WP2)', () => {
    test('a 10-share close cannot pay P&L on 15 shares of proposals', async () => {
        // One-thesis-per-symbol (2026-08-23) forbids CREATING a stack, but
        // stacked rows still exist in the wild (near-simultaneous accepts,
        // legacy data) — the tracker's allocation must stay honest on them.
        // Build the stack the only way production can: both rows created
        // while OPEN (the guard checks working rows), then both executed.
        const mk = async (qty: number, entry: number) => createProposal({
            symbol: 'WPE', direction: 'long', entryType: 'LMT', entry,
            stop: Math.round(entry * 0.975 * 100) / 100,
            target: Math.round(entry * 1.06 * 100) / 100,
            quantity: qty, rationale: 'partial-fill scenario', source: 'test',
        }, { dailyAtr: 0.04 * entry });
        const pa = await mk(10, 100);
        const pb = await mk(5, 104);
        const exec = async (p: { id: string }) => {
            const ids = [seq++, seq++, seq++];
            await setProposalStatus(p.id, 'executed', { orderIds: ids, executedAt: Date.now() });
            const row = await getProposal(p.id);
            trackExecutedProposal(row!);
            return { id: p.id, entryId: ids[0], tpId: ids[1], stopId: ids[2] };
        };
        const a = await exec(pa);
        const b = await exec(pb);
        __handleOrderStatusForTests(a.entryId, 'Filled', 10, 0, 100);
        __handleOrderStatusForTests(b.entryId, 'Filled', 5, 0, 104);
        await sleep(20);

        // Broker position is 10 (drift: b's fill never reached the broker
        // book, or a manual trim happened) — the close is 10 shares.
        trackManualExit('WPE', 8_888, 10, 'close command');
        __handleOrderStatusForTests(8_888, 'Filled', 10, 0, 106);
        await sleep(40);

        const rowA = await getProposal(a.id);
        const rowB = await getProposal(b.id);
        expect(rowA?.status).toBe('closed');
        expect(rowA?.realizedPnl).toBeCloseTo((106 - 100) * 10, 2);
        // b gets ZERO allocation: P&L unknown, never fabricated.
        expect(rowB?.status).toBe('closed');
        expect(rowB?.realizedPnl).toBeNull();
        expect(rowB?.note ?? '').toContain('allocation');
    });
});

describe('finalize event buffer (WP11 — no fills lost in the await window)', () => {
    test('events arriving while a trade is closed+buffering are not applied to the DB', async () => {
        const t = await trackedProposal('WPF');
        __handleOrderStatusForTests(t.entryId, 'Filled', 10, 0, 100);
        // Close via the stop: schedules finalize (10ms in tests).
        __handleOrderStatusForTests(t.stopId, 'Filled', 10, 0, 95);
        await sleep(40);
        const row = await getProposal(t.id);
        expect(row?.status).toBe('closed');
        // A very late event on the dead ids is ignored (not tracked).
        __handleOrderStatusForTests(t.tpId, 'Filled', 10, 0, 110);
        await sleep(20);
        expect((await getProposal(t.id))?.realizedPnl).toBeCloseTo((95 - 100) * 10, 2);
    });
});
