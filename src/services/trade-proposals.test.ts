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
    convertToOvernightHold,
    countExecutedSince,
    countOpenByClass,
    countOpenExecuted,
    createProposal,
    etDayStartMs,
    expireStale,
    formatPerformanceReport,
    formatProposalLine,
    getPerformanceBaseline,
    getPerformanceSummary,
    getProposal,
    setPerformanceBaseline,
    listProposals,
    listTrackable,
    markEntryFilled,
    recordLateExitFill,
    setProposalStatus,
    sumRealizedPnlSince,
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
        expect(p.tif).toBe('DAY'); // default: intraday bracket
        const fetched = await getProposal(p.id.toLowerCase());
        expect(fetched?.id).toBe(p.id);
        expect(fetched?.executedAt).toBeNull();
        expect(fetched?.realizedPnl).toBeNull();
    });

    test('GTC tif persists (overnight/swing brackets)', async () => {
        const p = await createProposal(validInput({ tif: 'GTC' }));
        expect((await getProposal(p.id))?.tif).toBe('GTC');
    });

    test('STP_LMT with entryLimit passes the gate end-to-end (regression)', async () => {
        // Regression: createProposal did not forward entryLimit to the risk
        // gate, so EVERY momentum STP_LMT create was refused with
        // "requires entryLimit" even when the caller supplied it.
        const p = await createProposal(validInput({
            symbol: 'QCRH', entryType: 'STP_LMT',
            entry: 100.35, entryLimit: 100.65, stop: 93.18, target: 116,
            quantity: 26, tif: 'GTC',
        }));
        const stored = await getProposal(p.id);
        expect(stored?.entryType).toBe('STP_LMT');
        expect(stored?.entryLimit).toBe(100.65);
        // …and it is still refused when the cap is genuinely missing.
        await expect(createProposal(validInput({
            symbol: 'QCRH', entryType: 'STP_LMT',
            entry: 100.35, stop: 93.18, target: 116, quantity: 26,
        }))).rejects.toThrow(/entryLimit/);
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
        // Delta-based: the store module caches its DB across test files in a
        // single-process run, so absolute counts are not isolation-safe.
        const baseOpen = await countOpenExecuted();
        const baseExecuted = await countExecutedSince(etDayStartMs());

        const p = await createProposal(validInput());
        await setProposalStatus(p.id, 'executed', { orderIds: [11, 12, 13], executedAt: Date.now() });

        expect(await countOpenExecuted()).toBe(baseOpen + 1);
        expect(await countExecutedSince(etDayStartMs())).toBe(baseExecuted + 1);
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
        expect(await countOpenExecuted()).toBe(baseOpen);
        // executed-today counter still counts closed trades (max_daily_trades)
        expect(await countExecutedSince(etDayStartMs())).toBe(baseExecuted + 1);
        expect(formatProposalLine(closed!)).toContain('+$100.50');
    });

    test('EOD-keep transition: a filled DAY position converts instead of closing (orphaned-keep hole)', async () => {
        const baseOpen = await countOpenExecuted();
        const p = await createProposal(validInput({ symbol: 'KEEP' }));
        await setProposalStatus(p.id, 'executed', { orderIds: [301, 302, 303], executedAt: Date.now() });
        await markEntryFilled(p.id, 100.05);

        expect(await convertToOvernightHold(p.id, { orderIds: [301, 402, 401], note: 'kept overnight (test)' })).toBe(true);

        const kept = await getProposal(p.id);
        expect(kept?.status).toBe('executed'); // NOT closed — the hold stays a tracked trade
        expect(kept?.tif).toBe('GTC'); // exits survive the close now
        expect(kept?.orderIds).toEqual([301, 402, 401]); // protect pair adopted (entry id kept)
        expect(kept?.keptOvernightAt).not.toBeNull();
        expect(kept?.note).toContain('kept overnight (test)');
        expect((await listTrackable()).map((t) => t.id)).toContain(p.id); // next-day triage sees it
        expect(await countOpenExecuted()).toBe(baseOpen + 1); // caps still count it

        // The eventual GTC exit fill closes it with a REAL labeled outcome.
        await closeProposal(p.id, { exitReason: 'stop', exitFillPrice: 95, realizedPnl: -50.5 });
        const closed = await getProposal(p.id);
        expect(closed?.status).toBe('closed');
        expect(closed?.realizedPnl).toBe(-50.5);
        expect(await countOpenExecuted()).toBe(baseOpen);
    });

    test('sumRealizedPnlSince nets closed outcomes and ignores unknown P&L', async () => {
        const before = await sumRealizedPnlSince(0);

        const win = await createProposal(validInput({ symbol: 'PNLW' }));
        await setProposalStatus(win.id, 'executed', { orderIds: [501, 502, 503], executedAt: Date.now() });
        await closeProposal(win.id, { exitReason: 'target', realizedPnl: 120.25 });

        const loss = await createProposal(validInput({ symbol: 'PNLL' }));
        await setProposalStatus(loss.id, 'executed', { orderIds: [511, 512, 513], executedAt: Date.now() });
        await closeProposal(loss.id, { exitReason: 'stop', realizedPnl: -45.75 });

        const unknown = await createProposal(validInput({ symbol: 'PNLU' }));
        await setProposalStatus(unknown.id, 'executed', { orderIds: [521, 522, 523], executedAt: Date.now() });
        await closeProposal(unknown.id, { exitReason: 'manual' }); // realizedPnl null — contributes nothing

        expect(await sumRealizedPnlSince(0)).toBeCloseTo(before + 74.5, 2);
        // A cutoff after these closes sees none of them.
        expect(await sumRealizedPnlSince(Date.now() + 60_000)).toBe(0);
    });

    test('EOD-keep transition refuses unfilled entries and rows a concurrent close already won', async () => {
        // Unfilled entry: there is no position to keep — nothing converts.
        const unfilled = await createProposal(validInput({ symbol: 'KEEPX' }));
        await setProposalStatus(unfilled.id, 'executed', { orderIds: [311, 312, 313], executedAt: Date.now() });
        expect(await convertToOvernightHold(unfilled.id, { orderIds: [311, 412, 411] })).toBe(false);
        expect((await getProposal(unfilled.id))?.tif).toBe('DAY'); // untouched

        // Already closed: the close wins; the convert must not resurrect it.
        const gone = await createProposal(validInput({ symbol: 'KEEPY' }));
        await setProposalStatus(gone.id, 'executed', { orderIds: [321, 322, 323], executedAt: Date.now() });
        await markEntryFilled(gone.id, 100);
        await closeProposal(gone.id, { exitReason: 'manual' });
        expect(await convertToOvernightHold(gone.id, { orderIds: [321, 422, 421] })).toBe(false);
        const after = await getProposal(gone.id);
        expect(after?.status).toBe('closed');
        expect(after?.keptOvernightAt).toBeNull();

        await closeProposal(unfilled.id, { exitReason: 'cancelled' }); // cross-file count hygiene
    });

    test('execution claim is atomic: one winner, release restores open', async () => {
        const { claimProposalForExecution, releaseProposalClaim } = await import('./trade-proposals.js');
        const p = await createProposal(validInput({ symbol: 'RACE' }));

        // Fire concurrent claims — exactly one may win.
        const results = await Promise.all(
            Array.from({ length: 5 }, () => claimProposalForExecution(p.id)),
        );
        expect(results.filter(Boolean).length).toBe(1);
        expect((await getProposal(p.id))?.status).toBe('executing');

        // A claimed proposal cannot be claimed again…
        expect(await claimProposalForExecution(p.id)).toBe(false);
        // …until released (gate refusal path), after which it is retryable.
        await releaseProposalClaim(p.id);
        expect((await getProposal(p.id))?.status).toBe('open');
        expect(await claimProposalForExecution(p.id)).toBe(true);
        await releaseProposalClaim(p.id); // cleanup for cross-file counts
    });

    test('duplicate-setup guard: refuses a near-identical entry against a working bracket', async () => {
        const a = await createProposal(validInput({ symbol: 'DUPE', entry: 100, stop: 95, target: 110 }));
        await setProposalStatus(a.id, 'executed', { orderIds: [71, 72, 73], executedAt: Date.now() });

        // Same symbol, entry within 2% → refused (the daily re-propose pattern).
        await expect(createProposal(validInput({ symbol: 'DUPE', entry: 101, stop: 96, target: 111 })))
            .rejects.toThrow(/duplicate setup/);
        // A genuinely different level (>2%) is a new trade.
        const fresh = await createProposal(validInput({ symbol: 'DUPE', entry: 106, stop: 100.7, target: 116.7 }));
        expect(fresh.status).toBe('open');

        await closeProposal(a.id, { exitReason: 'cancelled' }); // free the slot for other tests
    });

    test('listStaleUnfilled finds old unfilled entries, not filled or fresh ones', async () => {
        const { listStaleUnfilled } = await import('./trade-proposals.js');
        const old = await createProposal(validInput({ symbol: 'STAL' }));
        await setProposalStatus(old.id, 'executed', { orderIds: [81, 82, 83], executedAt: Date.now() - 4 * 24 * 3600_000 });
        const fresh = await createProposal(validInput({ symbol: 'STAF' }));
        await setProposalStatus(fresh.id, 'executed', { orderIds: [84, 85, 86], executedAt: Date.now() });
        const filled = await createProposal(validInput({ symbol: 'STAG' }));
        await setProposalStatus(filled.id, 'executed', { orderIds: [87, 88, 89], executedAt: Date.now() - 4 * 24 * 3600_000 });
        await markEntryFilled(filled.id, 100.01);

        const stale = (await listStaleUnfilled(3 * 24 * 3600_000)).map((p) => p.id);
        expect(stale).toContain(old.id);
        expect(stale).not.toContain(fresh.id);
        expect(stale).not.toContain(filled.id);

        for (const id of [old.id, fresh.id, filled.id]) await closeProposal(id, { exitReason: 'cancelled' });
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

describe('performance baseline (non-destructive reset)', () => {
    test('a reset hides earlier closes from default reports but keeps them in the DB', async () => {
        const since = Date.now() - 60_000; // covers everything this file closed

        const before = await createProposal(validInput({ symbol: 'OLDL' }));
        await setProposalStatus(before.id, 'executed', { orderIds: [21, 22, 23], executedAt: Date.now() });
        await closeProposal(before.id, { exitReason: 'stop', realizedPnl: -500, commissions: 1 });

        await new Promise((r) => setTimeout(r, 5));
        const baseline = setPerformanceBaseline('gate-stack overhaul');
        expect(getPerformanceBaseline()?.epochMs).toBe(baseline.epochMs);
        await new Promise((r) => setTimeout(r, 5));

        const after = await createProposal(validInput({ symbol: 'NEWW' }));
        await setProposalStatus(after.id, 'executed', { orderIds: [24, 25, 26], executedAt: Date.now() });
        await closeProposal(after.id, { exitReason: 'target', realizedPnl: 200, commissions: 1 });

        // Default: floored to the baseline — only the new trade counts.
        const fresh = await getPerformanceSummary(since);
        expect(fresh.baseline?.epochMs).toBe(baseline.epochMs);
        expect(fresh.closed).toBe(1);
        expect(fresh.netPnl).toBe(199);
        expect(formatPerformanceReport(fresh, '7d')).toContain('Baseline');

        // Full history on demand: the old loss is still there, undeleted.
        const all = await getPerformanceSummary(since, { includeAllHistory: true });
        expect(all.baseline).toBeNull();
        expect(all.closed).toBeGreaterThanOrEqual(2);
        const closed = await listProposals('closed');
        expect(closed.some((p) => p.symbol === 'OLDL')).toBe(true);
    });

    test('a window starting after the baseline is not widened by it', async () => {
        const s = await getPerformanceSummary(Date.now() + 60_000);
        expect(s.baseline).toBeNull(); // baseline is a floor, not a ceiling
        expect(s.closed).toBe(0);
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

describe('recordLateExitFill (P&L attribution after the fact)', () => {
    test('patches a closed manual row, and only that', async () => {
        // The 'close outside RTH' shape: proposal finalized as manual/unknown,
        // the MKT close fills at the next open.
        const p = await createProposal(validInput({ symbol: 'LATE' }));
        await setProposalStatus(p.id, 'executed', { orderIds: [31, 32, 33], executedAt: Date.now() });
        await markEntryFilled(p.id, 100);
        await closeProposal(p.id, { exitReason: 'manual', note: 'both bracket exits terminated without filling' });
        expect((await getProposal(p.id))?.realizedPnl).toBeNull();

        await recordLateExitFill(p.id, { exitFillPrice: 104, realizedPnl: 40, note: 'position closed at market by EOD triage @ 104' });
        const patched = await getProposal(p.id);
        expect(patched?.realizedPnl).toBe(40);
        expect(patched?.exitFillPrice).toBe(104);
        expect(patched?.note).toContain('both bracket exits terminated');
        expect(patched?.note).toContain('EOD triage @ 104');

        // A second late fill must NOT overwrite the recorded P&L.
        await recordLateExitFill(p.id, { exitFillPrice: 90, realizedPnl: -100, note: 'bogus duplicate' });
        expect((await getProposal(p.id))?.realizedPnl).toBe(40);
    });

    test('rows with a real P&L (e.g. stop exits) are never touched', async () => {
        const s = await createProposal(validInput({ symbol: 'STOPD' }));
        await setProposalStatus(s.id, 'executed', { orderIds: [34, 35, 36], executedAt: Date.now() });
        await closeProposal(s.id, { exitReason: 'stop', realizedPnl: -50 });
        await recordLateExitFill(s.id, { exitFillPrice: 1, realizedPnl: 999 });
        expect((await getProposal(s.id))?.realizedPnl).toBe(-50);
    });
});

// ---------------------------------------------------------------------------
// Trade classes — persistence, counting, and the server-side swing cap
// ---------------------------------------------------------------------------

describe('trade classes', () => {
    test('tradeClass persists and defaults to intraday', async () => {
        const plain = await createProposal(validInput({ symbol: 'CLSA' }));
        expect(plain.tradeClass).toBe('intraday');
        const swing = await createProposal(validInput({
            symbol: 'CLSB', tradeClass: 'swing', tif: 'GTC',
        }));
        expect(swing.tradeClass).toBe('swing');
        expect((await getProposal(swing.id))?.tradeClass).toBe('swing');
        expect(formatProposalLine(swing)).toContain('{swing}');
        expect(formatProposalLine(plain)).not.toContain('{intraday}');
    });

    test('countOpenByClass counts executing/executed only, and can exclude one id', async () => {
        const a = await createProposal(validInput({ symbol: 'CLSC', tradeClass: 'swing', tif: 'GTC' }));
        const b = await createProposal(validInput({ symbol: 'CLSD', tradeClass: 'swing', tif: 'GTC' }));
        const before = await countOpenByClass('swing');
        await setProposalStatus(a.id, 'executed', { executedAt: Date.now() });
        await setProposalStatus(b.id, 'executed', { executedAt: Date.now() });
        expect(await countOpenByClass('swing')).toBe(before + 2);
        expect(await countOpenByClass('swing', a.id)).toBe(before + 1);
        // Closing frees the slot.
        await closeProposal(a.id, { exitReason: 'target', realizedPnl: 10 });
        expect(await countOpenByClass('swing')).toBe(before + 1);
        // cleanup for the cap test below
        await closeProposal(b.id, { exitReason: 'target', realizedPnl: 10 });
    });

    test('the swing cap is enforced server-side at creation', async () => {
        const syms = ['CLSE', 'CLSF', 'CLSG'];
        const ids: string[] = [];
        for (const sym of syms) {
            const p = await createProposal(validInput({ symbol: sym, tradeClass: 'swing', tif: 'GTC' }));
            await setProposalStatus(p.id, 'executed', { executedAt: Date.now() });
            ids.push(p.id);
        }
        // Fourth swing: the store counts 3 executing/executed swings itself —
        // no caller-supplied context can understate the book.
        await expect(
            createProposal(validInput({ symbol: 'CLSH', tradeClass: 'swing', tif: 'GTC' })),
        ).rejects.toThrow(/max 3/);
        // An intraday proposal is unaffected by the full swing book.
        const ok = await createProposal(validInput({ symbol: 'CLSI' }));
        expect(ok.tradeClass).toBe('intraday');
        for (const id of ids) await closeProposal(id, { exitReason: 'manual', realizedPnl: 0 });
    });

    test('per-class ledger appears in the performance summary', async () => {
        const p = await createProposal(validInput({ symbol: 'CLSJ', tradeClass: 'swing', tif: 'GTC' }));
        await setProposalStatus(p.id, 'executed', { executedAt: Date.now() });
        await closeProposal(p.id, { exitReason: 'target', realizedPnl: 25 });
        const s = await getPerformanceSummary(Date.now() - 60_000, { includeAllHistory: true });
        expect(s.byClass.swing).toBeDefined();
        expect(s.byClass.swing.wins).toBeGreaterThanOrEqual(1);
        const report = formatPerformanceReport(s, 'test');
        expect(report).toContain('swing:');
    });
});
