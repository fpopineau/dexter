import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { EventName, type Contract, type Order } from '@stoqey/ib';
import { placeBracketOrderCore, type BracketRequest } from './bracket.js';

// WP1 (REMEDIATION-2026-08-20): the bracket path is the only path that
// OPENS exposure, and it used to resolve on API handoff — no broker
// acknowledgement, no account binding, no idempotency key. This fake IBApi
// is the phase-1 harness: it drives placeBracketOrderCore through ack,
// reject, and timeout paths without a gateway.

class FakeIb extends EventEmitter {
    placed: Array<{ id: number; contract: Contract; order: Order }> = [];
    cancelled: number[] = [];
    nextId = 500;
    reqIds(): void {
        queueMicrotask(() => this.emit(EventName.nextValidId, this.nextId));
    }
    placeOrder(id: number, contract: Contract, order: Order): void {
        this.placed.push({ id, contract, order });
    }
    cancelOrder(id: number): void {
        this.cancelled.push(id);
    }
}

const ACCOUNT = 'DU1234567';

function req(overrides: Partial<BracketRequest> = {}): BracketRequest {
    return {
        symbol: 'NVDA',
        direction: 'long',
        quantity: 10,
        entryType: 'LMT',
        entryPrice: 100,
        stopPrice: 95,
        targetPrice: 110,
        refId: 'P-TEST',
        ...overrides,
    };
}

/** Place on the fake, then run `script` once the three legs are handed over. */
async function place(fake: FakeIb, script: (ids: number[]) => void, timeoutMs = 200) {
    const placement = placeBracketOrderCore(fake as never, ACCOUNT, req(), timeoutMs);
    // The core awaits nextValidId (microtask) then places synchronously —
    // one macrotask later the legs exist and the ack watch is armed.
    await new Promise((r) => setTimeout(r, 10));
    script(fake.placed.map((p) => p.id));
    return placement;
}

describe('placeBracketOrderCore — identity on every leg', () => {
    test('all three legs carry account, orderRef <refId>:<leg>, contiguous ids', async () => {
        const fake = new FakeIb();
        const result = await place(fake, (ids) => {
            for (const id of ids) fake.emit(EventName.orderStatus, id, 'PreSubmitted', 0, 10, 0, 40_000 + id);
        });
        expect(fake.placed.length).toBe(3);
        expect(fake.placed.map((p) => p.order.account)).toEqual([ACCOUNT, ACCOUNT, ACCOUNT]);
        expect(fake.placed.map((p) => p.order.orderRef)).toEqual(['P-TEST:entry', 'P-TEST:tp', 'P-TEST:stop']);
        expect(result.takeProfitOrderId).toBe(result.parentOrderId + 1);
        expect(result.stopOrderId).toBe(result.parentOrderId + 2);
    });

    // REQ-BRACKET-001 (review-17): the three TIFs are load-bearing — a DAY
    // parent dies at the bell unfilled, while the GTC exits protect a FILLED
    // position through a gateway-down close. Pin all three transmitted
    // values for both parent TIFs.
    test('intraday bracket: DAY parent, GTC exits — transmitted values pinned', async () => {
        const fake = new FakeIb();
        const placement = placeBracketOrderCore(fake as never, ACCOUNT, req({ tif: 'DAY' }), 200);
        await new Promise((r) => setTimeout(r, 10));
        for (const p of fake.placed) fake.emit(EventName.orderStatus, p.id, 'Submitted', 0, 10, 0, 1000 + p.id);
        await placement;
        expect(fake.placed.map((p) => p.order.tif)).toEqual(['DAY', 'GTC', 'GTC']);
    });

    test('swing bracket: GTC parent keeps GTC exits', async () => {
        const fake = new FakeIb();
        const placement = placeBracketOrderCore(fake as never, ACCOUNT, req({ tif: 'GTC' }), 200);
        await new Promise((r) => setTimeout(r, 10));
        for (const p of fake.placed) fake.emit(EventName.orderStatus, p.id, 'Submitted', 0, 10, 0, 1000 + p.id);
        await placement;
        expect(fake.placed.map((p) => p.order.tif)).toEqual(['GTC', 'GTC', 'GTC']);
    });
});

describe('placeBracketOrderCore — acknowledgement outcomes', () => {
    test('orderStatus on every leg → acknowledged, permIds captured in leg order', async () => {
        const fake = new FakeIb();
        const result = await place(fake, (ids) => {
            for (const id of ids) fake.emit(EventName.orderStatus, id, 'PreSubmitted', 0, 10, 0, 40_000 + id);
        });
        expect(result.ack.outcome).toBe('acknowledged');
        expect(result.ack.permIds).toEqual([
            40_000 + result.parentOrderId,
            40_000 + result.takeProfitOrderId,
            40_000 + result.stopOrderId,
        ]);
        expect(fake.cancelled).toEqual([]);
    });

    test('openOrder events also acknowledge (permId from the order object)', async () => {
        const fake = new FakeIb();
        const result = await place(fake, (ids) => {
            for (const id of ids) {
                fake.emit(EventName.openOrder, id, { symbol: 'NVDA' }, { orderId: id, permId: 77_000 + id }, {});
            }
        });
        expect(result.ack.outcome).toBe('acknowledged');
        expect(result.ack.permIds[0]).toBe(77_000 + result.parentOrderId);
    });

    test('broker error on the entry leg → rejected with the reason, all legs cancelled', async () => {
        const fake = new FakeIb();
        const result = await place(fake, (ids) => {
            fake.emit(EventName.error, new Error('order rejected - reason: exchange is closed'), 201, ids[0]);
        });
        expect(result.ack.outcome).toBe('rejected');
        expect(result.ack.rejection?.code).toBe(201);
        expect(result.ack.rejection?.reason).toContain('exchange is closed');
        // Best-effort unwind: a rejected parent must not leave live children.
        expect(fake.cancelled.sort()).toEqual([result.parentOrderId, result.takeProfitOrderId, result.stopOrderId]);
    });

    test('no events inside the window → unconfirmed, nothing cancelled', async () => {
        const fake = new FakeIb();
        const result = await place(fake, () => { /* silence */ }, 50);
        expect(result.ack.outcome).toBe('unconfirmed');
        expect(result.ack.permIds).toEqual([null, null, null]);
        expect(fake.cancelled).toEqual([]);
    });

    test('non-fatal warning codes do not reject (2109 outside-RTH attribute warning)', async () => {
        const fake = new FakeIb();
        const result = await place(fake, (ids) => {
            fake.emit(EventName.error, new Error('Order Event Warning: outside RTH attribute ignored'), 2109, ids[0]);
            for (const id of ids) fake.emit(EventName.orderStatus, id, 'Submitted', 0, 10, 0, 90_000 + id);
        });
        expect(result.ack.outcome).toBe('acknowledged');
    });

    test('rejection of one EXIT leg rejects the placement (no half-protected bracket)', async () => {
        const fake = new FakeIb();
        const result = await place(fake, (ids) => {
            fake.emit(EventName.orderStatus, ids[0], 'Submitted', 0, 10, 0, 1);
            fake.emit(EventName.error, new Error('invalid stop price'), 110, ids[2]);
        });
        expect(result.ack.outcome).toBe('rejected');
        expect(result.ack.rejection?.orderId).toBe(result.stopOrderId);
        expect(fake.cancelled.length).toBe(3);
    });
});

describe('ack-window terminal statuses (review 2026-08-21)', () => {
    test("an immediate 'Inactive' is a rejection, not an acknowledgement", async () => {
        const fake = new FakeIb();
        const result = await place(fake, (ids) => {
            fake.emit(EventName.orderStatus, ids[0], 'Inactive', 0, 10, 0, 0);
            fake.emit(EventName.orderStatus, ids[1], 'PreSubmitted', 0, 10, 0, 1);
            fake.emit(EventName.orderStatus, ids[2], 'PreSubmitted', 0, 10, 0, 2);
        });
        expect(result.ack.outcome).toBe('rejected');
        expect(result.ack.rejection?.reason).toContain('Inactive');
        expect(fake.cancelled.length).toBe(3); // legs swept
    });
});
