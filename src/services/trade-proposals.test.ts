import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point the proposals DB at a temp dir BEFORE the first store call.
const dir = mkdtempSync(join(tmpdir(), 'dexter-proposals-'));
const prevDataDir = process.env.DEXTER_DATA_DIR;
process.env.DEXTER_DATA_DIR = dir;

import {
    closeProposal,
    countExecutedSince,
    countOpenExecuted,
    createProposal,
    etDayStartMs,
    expireStale,
    formatPerformanceReport,
    formatProposalLine,
    getPerformanceSummary,
    getProposal,
    listProposals,
    listTrackable,
    markEntryFilled,
    setProposalStatus,
    type CreateProposalInput,
} from './trade-proposals.js';

afterAll(() => {
    if (prevDataDir === undefined) delete process.env.DEXTER_DATA_DIR;
    else process.env.DEXTER_DATA_DIR = prevDataDir;
    // The module keeps its SQLite handle open; on Windows the file can't be
    // deleted while held. Best-effort cleanup — a leftover temp dir is fine.
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* held by sqlite */ }
});

function validInput(overrides: Partial<CreateProposalInput> = {}): CreateProposalInput {
    return {
        symbol: 'nvda',
        direction: 'long',
        entryType: 'LMT',
        entry: 100,
        stop: 95,
        target: 110,
        quantity: 10,
        rationale: 'test proposal',
        source: 'test',
        ...overrides,
    };
}

describe('proposal store lifecycle', () => {
    test('create → get roundtrip, uppercased symbol, open status', async () => {
        const p = await createProposal(validInput());
        expect(p.id).toMatch(/^P-[0-9A-F]{4}$/);
        expect(p.status).toBe('open');
        expect(p.symbol).toBe('NVDA');
        const fetched = await getProposal(p.id.toLowerCase());
        expect(fetched?.id).toBe(p.id);
        expect(fetched?.executedAt).toBeNull();
        expect(fetched?.realizedPnl).toBeNull();
    });

    test('creation is refused by the risk gate on bad numbers', async () => {
        // R/R 0.8:1 < 2.0 minimum
        await expect(createProposal(validInput({ target: 104 }))).rejects.toThrow(/risk-gate/);
        // entry required even for MKT
        await expect(createProposal(validInput({ entryType: 'MKT', entry: undefined }))).rejects.toThrow(/risk-gate/);
    });

    test('stale open proposals expire', async () => {
        const p = await createProposal(validInput({ expiresMinutes: 0.001 as unknown as number }));
        await new Promise((r) => setTimeout(r, 100));
        const expired = await expireStale();
        expect(expired).toBeGreaterThanOrEqual(1);
        expect((await getProposal(p.id))?.status).toBe('expired');
    });

    test('executed → entry fill → closed with outcome', async () => {
        const p = await createProposal(validInput());
        await setProposalStatus(p.id, 'executed', { orderIds: [11, 12, 13], executedAt: Date.now() });

        expect(await countOpenExecuted()).toBe(1);
        expect(await countExecutedSince(etDayStartMs())).toBe(1);
        expect((await listTrackable()).map((t) => t.id)).toContain(p.id);

        await markEntryFilled(p.id, 100.05);
        await closeProposal(p.id, {
            exitReason: 'target',
            exitFillPrice: 110.1,
            realizedPnl: 100.5,
            commissions: 2.1,
        });

        const closed = await getProposal(p.id);
        expect(closed?.status).toBe('closed');
        expect(closed?.exitReason).toBe('target');
        expect(closed?.entryFillPrice).toBe(100.05);
        expect(closed?.exitFillPrice).toBe(110.1);
        expect(closed?.realizedPnl).toBe(100.5);
        expect(closed?.commissions).toBe(2.1);
        expect(await countOpenExecuted()).toBe(0);
        // executed-today counter still counts closed trades (max_daily_trades)
        expect(await countExecutedSince(etDayStartMs())).toBe(1);
        expect(formatProposalLine(closed!)).toContain('+$100.50');
    });

    test('closeProposal only transitions executed proposals', async () => {
        const p = await createProposal(validInput());
        await closeProposal(p.id, { exitReason: 'manual' });
        expect((await getProposal(p.id))?.status).toBe('open'); // untouched
    });
});

describe('performance summary', () => {
    test('aggregates wins, losses, win rate and net P&L', async () => {
        // Window must exclude trades closed by earlier tests in this file.
        await new Promise((r) => setTimeout(r, 5));
        const since = Date.now();

        const win = await createProposal(validInput({ symbol: 'WIN' }));
        await setProposalStatus(win.id, 'executed', { orderIds: [1, 2, 3], executedAt: Date.now() });
        await closeProposal(win.id, { exitReason: 'target', realizedPnl: 100, commissions: 1 });

        const loss = await createProposal(validInput({ symbol: 'LOSS' }));
        await setProposalStatus(loss.id, 'executed', { orderIds: [4, 5, 6], executedAt: Date.now() });
        await closeProposal(loss.id, { exitReason: 'stop', realizedPnl: -50, commissions: 1 });

        const unlabeled = await createProposal(validInput({ symbol: 'MANL' }));
        await setProposalStatus(unlabeled.id, 'executed', { orderIds: [7, 8, 9], executedAt: Date.now() });
        await closeProposal(unlabeled.id, { exitReason: 'manual' });

        const s = await getPerformanceSummary(since);
        expect(s.closed).toBe(3);
        expect(s.wins).toBe(1);
        expect(s.losses).toBe(1);
        expect(s.unlabeled).toBe(1);
        expect(s.winRatePct).toBe(50);
        expect(s.grossPnl).toBe(50);
        expect(s.commissions).toBe(2);
        expect(s.netPnl).toBe(48);
        expect(s.best?.symbol).toBe('WIN');
        expect(s.worst?.symbol).toBe('LOSS');
        expect(s.byExitReason).toMatchObject({ target: 1, stop: 1, manual: 1 });

        const report = formatPerformanceReport(s, 'test window');
        expect(report).toContain('1W/1L');
        expect(report).toContain('50% win rate');
        expect(report).toContain('+$48.00');
    });

    test('empty window reports cleanly', async () => {
        const s = await getPerformanceSummary(Date.now() + 60_000);
        expect(s.closed).toBe(0);
        expect(s.winRatePct).toBeNull();
    });
});

describe('listProposals', () => {
    test('filters by status', async () => {
        const open = await listProposals('open');
        for (const p of open) expect(p.status).toBe('open');
        const closed = await listProposals('closed');
        expect(closed.length).toBeGreaterThanOrEqual(3);
    });
});
