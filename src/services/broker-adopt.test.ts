import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'dexter-adopt-'));
const prevDataDir = process.env.DEXTER_DATA_DIR;
// Plain assignment (REQ-TEST-001): `??=` kept the PRODUCTION path when .env
// supplied one — the preload isolates globally, this pins the suite's own dir.
process.env.DEXTER_DATA_DIR = dir;

import { decideAdoptions, selectManualExitRehydrations, type BrokerOrderSnap, type BrokerPositionSnap } from './broker-adopt.js';
import { countOpenExecuted, createAdoptedPosition, getProposal, resolveAdoptedFlat } from './trade-proposals.js';

// WP3 (REMEDIATION-2026-08-20): reconciliation used to run strictly DB →
// broker — unknown broker orders were discarded and unknown positions
// granted free cap headroom. The decision core is pure: fake snapshots in,
// an adoption plan out; the applier never places or cancels anything.

const ACCT = 'DU7777777';
const order = (o: Partial<BrokerOrderSnap>): BrokerOrderSnap =>
    ({ orderId: 1, symbol: 'NVDA', orderRef: null, account: ACCT, quantity: null, ...o });
const position = (p: Partial<BrokerPositionSnap>): BrokerPositionSnap =>
    ({ account: ACCT, symbol: 'NVDA', quantity: 10, avgCost: 100, ...p });

const TRACKED = [{ proposalId: 'P-AB12', symbol: 'NVDA', orderIds: [11, 12, 13] }];

function decide(orders: BrokerOrderSnap[], positions: BrokerPositionSnap[], tracked = TRACKED) {
    return decideAdoptions({ orders, positions, tracked, verifiedAccount: ACCT });
}

describe('decideAdoptions — orders', () => {
    test('an orderRef naming OUR proposal with an untracked id is adopted into its leg', () => {
        const plan = decide([order({ orderId: 99, orderRef: 'P-AB12:stop' })], []);
        expect(plan.orderAdoptions).toEqual([{ proposalId: 'P-AB12', leg: 'stop', orderId: 99 }]);
        expect(plan.orphanOrders).toEqual([]);
    });

    test('resized-leg refs (stop2/tp2) map to their base legs', () => {
        const plan = decide([order({ orderId: 98, orderRef: 'P-AB12:tp2' })], []);
        expect(plan.orderAdoptions).toEqual([{ proposalId: 'P-AB12', leg: 'tp', orderId: 98 }]);
    });

    test('already-tracked ids and recognized non-bracket refs are not orphans', () => {
        const plan = decide([
            order({ orderId: 12, orderRef: 'P-AB12:tp' }),          // already tracked
            order({ orderId: 40, orderRef: 'protect-NVDA:stop' }),  // position-actions order
            order({ orderId: 41, orderRef: 'close-NVDA' }),
        ], []);
        expect(plan.orderAdoptions).toEqual([]);
        expect(plan.orphanOrders).toEqual([]);
    });

    test('an unknown order with no recognizable ref is flagged, never touched', () => {
        const plan = decide([order({ orderId: 77, symbol: 'TSLA', orderRef: 'manual TWS entry' })], []);
        expect(plan.orphanOrders.map((o) => o.orderId)).toEqual([77]);
        expect(plan.orderAdoptions).toEqual([]);
    });

    test('a ref naming a proposal we are NOT tracking is an orphan (row already closed)', () => {
        const plan = decide([order({ orderId: 66, orderRef: 'P-DEAD:stop' })], []);
        expect(plan.orphanOrders.map((o) => o.orderId)).toEqual([66]);
    });
});

describe('decideAdoptions — positions', () => {
    test('a position with no executed row on the symbol is adopted (caps must see it)', () => {
        const plan = decide([], [position({ symbol: 'TSLA', quantity: -20, avgCost: 250 })]);
        expect(plan.positionAdoptions.length).toBe(1);
        expect(plan.positionAdoptions[0].symbol).toBe('TSLA');
    });

    test('a position matching a tracked symbol is already accounted — nothing to do', () => {
        const plan = decide([], [position({ symbol: 'NVDA' })]);
        expect(plan.positionAdoptions).toEqual([]);
        expect(plan.foreignPositions).toEqual([]);
    });

    test('a position in a FOREIGN account is flagged, never adopted into our book', () => {
        const plan = decide([], [position({ symbol: 'TSLA', account: 'U0000001' })]);
        expect(plan.positionAdoptions).toEqual([]);
        expect(plan.foreignPositions.map((p) => p.account)).toEqual(['U0000001']);
    });
});

describe('createAdoptedPosition (store)', () => {
    test('adopted row is executed, source=adopted, counted by the caps, levels labeled synthetic', async () => {
        const before = await countOpenExecuted();
        const row = await createAdoptedPosition({
            symbol: 'ADPT', direction: 'short', quantity: 20, avgCost: 250, account: ACCT,
        });
        expect(row.status).toBe('executed');
        expect(row.source).toBe('adopted');
        expect(row.entryFillPrice).toBe(250);
        expect(row.quantity).toBe(20);
        // Synthetic protection levels: coherent for the direction, labeled.
        expect(row.stop).toBeGreaterThan(250); // short: stop above basis
        expect(row.note ?? '').toContain('synthetic');
        expect(await countOpenExecuted()).toBe(before + 1);
        expect((await getProposal(row.id))?.tif).toBe('GTC');
    });
});

describe('adopted-row resolution lifecycle (round-7 review)', () => {
    test('an adopted row resolves when the broker no longer holds the symbol, and survives while it does', async () => {
        const row = await createAdoptedPosition({
            symbol: 'ADRS', direction: 'long', quantity: 5, avgCost: 80, account: ACCT,
        });
        // Broker still holds it → nothing resolves.
        const kept = await resolveAdoptedFlat(['ADRS', 'NVDA']);
        expect(kept).not.toContain(row.id);
        expect((await getProposal(row.id))?.status).toBe('executed');
        // Broker book no longer shows the symbol → the row closes honestly.
        const resolved = await resolveAdoptedFlat(['NVDA']);
        expect(resolved).toContain(row.id);
        const after = await getProposal(row.id);
        expect(after?.status).toBe('closed');
        expect(after?.exitReason).toBe('unknown');
        expect(after?.note ?? '').toContain('reconciliation sweep');
        // Idempotent: a second sweep finds nothing to resolve.
        expect(await resolveAdoptedFlat(['NVDA'])).not.toContain(row.id);
    });
});

afterAll(() => {
    if (prevDataDir === undefined) delete process.env.DEXTER_DATA_DIR;
    else process.env.DEXTER_DATA_DIR = prevDataDir;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* held by sqlite */ }
});

describe('manual-exit rehydration (round-6 review)', () => {
    const pos = (symbol: string, quantity: number): BrokerPositionSnap =>
        ({ account: ACCT, symbol, quantity, avgCost: 100 });

    test('working close-* orders on our account re-arm the guard', () => {
        const picked = selectManualExitRehydrations(
            [order({ orderId: 70, symbol: 'NVDA', orderRef: 'close-NVDA', quantity: 12 })],
            [pos('NVDA', 12)],
            ACCT,
        );
        expect(picked).toEqual([{ symbol: 'NVDA', orderId: 70, quantity: 12, flatSymbol: false }]);
    });

    test('a close on a FLAT symbol is flagged — it would OPEN a position, not close one', () => {
        const picked = selectManualExitRehydrations(
            [order({ orderId: 71, symbol: 'AMD', orderRef: 'close-AMD', quantity: 5 })],
            [], // flat book
            ACCT,
        );
        expect(picked[0]?.flatSymbol).toBe(true);
    });

    test('foreign-account and non-close refs are ignored', () => {
        const picked = selectManualExitRehydrations(
            [
                order({ orderId: 72, symbol: 'NVDA', orderRef: 'close-NVDA', account: 'DU0000001' }),
                order({ orderId: 73, symbol: 'NVDA', orderRef: 'protect-NVDA:stop' }),
            ],
            [pos('NVDA', 10)],
            ACCT,
        );
        expect(picked).toHaveLength(0);
    });
});
