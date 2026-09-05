import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'dexter-simstore-'));
const prev = process.env.DEXTER_DATA_DIR;
process.env.DEXTER_DATA_DIR = dir;

import { findSimTrade, listOpenSimTrades, listSimTrades, upsertSimTrade, type SimTrade } from './store.js';

afterAll(() => {
    if (prev === undefined) delete process.env.DEXTER_DATA_DIR; else process.env.DEXTER_DATA_DIR = prev;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* held by sqlite */ }
});

function row(overrides: Partial<SimTrade> = {}): SimTrade {
    return {
        variant: 'incumbent', sourceKind: 'proposal', sourceId: 'P-0001', symbol: 'MU', direction: 'long', tradeClass: 'intraday',
        entryType: 'LMT', entry: 100, entryLimit: null, stop: 97, target: 106, quantity: 10, tif: 'DAY', createdAt: 1_000,
        barSource: 'archive-1m', fillAt: 1_060, fillPrice: 100, exitAt: 5_000, exitPrice: 106, outcome: 'target',
        commissions: 2, netUsd: 58, netR: 58 / 30, status: 'settled', biasNote: 'pessimistic', settledAt: 9_000, horizonDays: 1, note: null,
        ...overrides,
    };
}

describe('simulator store (REQ-SIM-001/007 — its own database, no order-id columns)', () => {
    test('upsert is keyed on (variant, source kind, source id): a re-settle replaces, never duplicates', async () => {
        await upsertSimTrade(row());
        await upsertSimTrade(row({ outcome: 'stop', exitPrice: 97, netUsd: -32, netR: -32 / 30 }));
        const all = await listSimTrades({});
        expect(all).toHaveLength(1);
        expect(all[0].outcome).toBe('stop');
        const found = await findSimTrade('incumbent', 'proposal', 'P-0001');
        expect(found?.netUsd).toBe(-32);
        expect(await findSimTrade('exit-x2.0', 'proposal', 'P-0001')).toBeNull();
    });

    test('list filters by variant, status and creation time; open rows are listed for re-settlement', async () => {
        await upsertSimTrade(row({ variant: 'class-swing', sourceId: 'P-0002', tif: 'GTC', status: 'open', outcome: 'open', exitAt: null, exitPrice: null, netUsd: null, netR: null, createdAt: 2_000 }));
        await upsertSimTrade(row({ variant: 'gate-off:noise-stop', sourceKind: 'refusal', sourceId: 'R-77', createdAt: 3_000 }));
        expect((await listSimTrades({ variant: 'incumbent' })).map((r) => r.sourceId)).toEqual(['P-0001']);
        expect((await listSimTrades({ status: 'open' })).map((r) => r.sourceId)).toEqual(['P-0002']);
        expect((await listSimTrades({ sinceMs: 2_500 })).map((r) => r.sourceId)).toEqual(['R-77']);
        expect((await listOpenSimTrades()).map((r) => r.variant)).toEqual(['class-swing']);
    });
});
