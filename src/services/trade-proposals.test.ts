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
        // Take-policy fixture (WP-EXIT): a 4%-ATR name has x = 6% → the
        // target sits AT 106 and the 2:1 gate wants the stop within 3.
        stop: 97.5,
        target: 106,
        quantity: 10,
        rationale: 'test proposal',
        source: 'test',
        ...overrides,
    };
}

/** Gate context for the take policy: ATR pinned at 4% of the worst-fill
 *  basis so x = clamp(1.5×4, 3, 10) = 6% exactly for every fixture. */
function atrCtx(input: CreateProposalInput) {
    return { dailyAtr: 0.04 * (input.entryLimit ?? input.entry ?? 100) };
}

/** createProposal with the standard take-policy context. */
async function create(input: CreateProposalInput) {
    return createProposal(input, atrCtx(input));
}

describe('proposal store lifecycle', () => {
    test('create → get roundtrip, uppercased symbol, open status', async () => {
        const p = await create(validInput());
        expect(p.id).toMatch(/^P-[0-9A-F]{4}$/);
        expect(p.status).toBe('open');
        expect(p.symbol).toBe('NVDA');
        expect(p.tif).toBe('DAY'); // default: intraday bracket
        const fetched = await getProposal(p.id.toLowerCase());
        expect(fetched?.id).toBe(p.id);
        expect(fetched?.executedAt).toBeNull();
        expect(fetched?.realizedPnl).toBeNull();
    });

    test('GTC tif persists (swing brackets — intraday is DAY-only since flat-by-close)', async () => {
        const p = await create(validInput({ symbol: 'GTCS', tradeClass: 'swing', tif: 'GTC' }));
        expect((await getProposal(p.id))?.tif).toBe('GTC');
    });

    test('STP_LMT with entryLimit passes the gate end-to-end (regression)', async () => {
        // Regression: createProposal did not forward entryLimit to the risk
        // gate, so EVERY momentum STP_LMT create was refused with
        // "requires entryLimit" even when the caller supplied it.
        const p = await create(validInput({
            // Take policy: basis = the limit cap 100.65, x = 6% → target
            // round(100.65 × 1.06) = 106.69; stop within 3.02 of the cap.
            // DAY since flat-by-close (intraday GTC entries are refused).
            symbol: 'QCRH', entryType: 'STP_LMT',
            entry: 100.35, entryLimit: 100.65, stop: 98.00, target: 106.69,
            quantity: 26, tif: 'DAY',
        }));
        const stored = await getProposal(p.id);
        expect(stored?.entryType).toBe('STP_LMT');
        expect(stored?.entryLimit).toBe(100.65);
        // …and it is still refused when the cap is genuinely missing.
        await expect(create(validInput({
            symbol: 'QCRH', entryType: 'STP_LMT',
            entry: 100.35, stop: 98.00, target: 106.37, quantity: 26,
        }))).rejects.toThrow(/entryLimit/);
    });

    test('creation is refused by the risk gate on bad numbers', async () => {
        // R/R 0.8:1 < 2.0 minimum
        await expect(create(validInput({ target: 104 }))).rejects.toThrow(/risk-gate/);
        // entry required even for MKT
        await expect(create(validInput({ entryType: 'MKT', entry: undefined }))).rejects.toThrow(/risk-gate/);
    });

    test('stale open proposals expire', async () => {
        const p = await create(validInput({ expiresMinutes: 0.001 as unknown as number }));
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

        const p = await create(validInput());
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
        const p = await create(validInput({ symbol: 'KEEP' }));
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

        const win = await create(validInput({ symbol: 'PNLW' }));
        await setProposalStatus(win.id, 'executed', { orderIds: [501, 502, 503], executedAt: Date.now() });
        await closeProposal(win.id, { exitReason: 'target', realizedPnl: 120.25 });

        const loss = await create(validInput({ symbol: 'PNLL' }));
        await setProposalStatus(loss.id, 'executed', { orderIds: [511, 512, 513], executedAt: Date.now() });
        await closeProposal(loss.id, { exitReason: 'stop', realizedPnl: -45.75 });

        const unknown = await create(validInput({ symbol: 'PNLU' }));
        await setProposalStatus(unknown.id, 'executed', { orderIds: [521, 522, 523], executedAt: Date.now() });
        await closeProposal(unknown.id, { exitReason: 'manual' }); // realizedPnl null — contributes nothing

        expect(await sumRealizedPnlSince(0)).toBeCloseTo(before + 74.5, 2);
        // A cutoff after these closes sees none of them.
        expect(await sumRealizedPnlSince(Date.now() + 60_000)).toBe(0);
    });

    test('sumRealizedPnlSince subtracts commissions — headroom sees NET (audit 2026-08-20)', async () => {
        const before = await sumRealizedPnlSince(0);
        const p = await create(validInput({ symbol: 'PNLC' }));
        await setProposalStatus(p.id, 'executed', { orderIds: [531, 532, 533], executedAt: Date.now() });
        await closeProposal(p.id, { exitReason: 'target', realizedPnl: 100, commissions: 7.25 });
        expect(await sumRealizedPnlSince(0)).toBeCloseTo(before + 92.75, 2);
    });

    test('accept-path slot counting: executing rows count, the claimed row does not count itself (audit 2026-08-20)', async () => {
        const { claimProposalForExecution, releaseProposalClaim } = await import('./trade-proposals.js');
        const baseOpen = await countOpenExecuted();
        const baseExecuted = await countExecutedSince(etDayStartMs());

        // A claimed ('executing') proposal has executed_at NULL — it must
        // still occupy a daily-trade slot for OTHER concurrent accepts
        // (the original SQL matched it against executed_at and counted 0).
        const racing = await create(validInput({ symbol: 'RACE' }));
        expect(await claimProposalForExecution(racing.id)).toBe(true);
        expect(await countExecutedSince(etDayStartMs())).toBe(baseExecuted + 1);
        expect(await countOpenExecuted()).toBe(baseOpen + 1);

        // …but the row must NOT consume its own slots on its own accept,
        // or the practical caps sit one below the configured ones.
        expect(await countExecutedSince(etDayStartMs(), racing.id)).toBe(baseExecuted);
        expect(await countOpenExecuted(racing.id)).toBe(baseOpen);

        await releaseProposalClaim(racing.id);
    });

    test('EOD-keep transition refuses unfilled entries and rows a concurrent close already won', async () => {
        // Unfilled entry: there is no position to keep — nothing converts.
        const unfilled = await create(validInput({ symbol: 'KEEPX' }));
        await setProposalStatus(unfilled.id, 'executed', { orderIds: [311, 312, 313], executedAt: Date.now() });
        expect(await convertToOvernightHold(unfilled.id, { orderIds: [311, 412, 411] })).toBe(false);
        expect((await getProposal(unfilled.id))?.tif).toBe('DAY'); // untouched

        // Already closed: the close wins; the convert must not resurrect it.
        const gone = await create(validInput({ symbol: 'KEEPY' }));
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
        const p = await create(validInput({ symbol: 'RACE' }));

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

    test('one-thesis DB law: same-symbol claims leave exactly one survivor (review-18, ux_one_working_thesis)', async () => {
        const { claimProposalForExecution, releaseProposalClaim, __recreateOneThesisIndexForTests } =
            await import('./trade-proposals.js');
        // Suites simulating a legacy DB drop the index — restore the law
        // before testing it (shared store across suite files).
        await __recreateOneThesisIndexForTests();
        // Two OPEN rows on one symbol are legal (the creation guard counts
        // only WORKING rows); the race is both reaching for 'executing'.
        const a = await create(validInput({ symbol: 'THLAW' }));
        const b = await create(validInput({ symbol: 'THLAW' }));
        const results = await Promise.all([claimProposalForExecution(a.id), claimProposalForExecution(b.id)]);
        expect(results.filter(Boolean).length).toBe(1); // the INDEX decides, not app-level courtesy
        const statuses = [(await getProposal(a.id))?.status, (await getProposal(b.id))?.status].sort();
        expect(statuses).toEqual(['executing', 'open']); // the loser is untouched and retryable
        // Cleanup for cross-file counts: release the winner back to open,
        // then expire both out of the working set.
        await releaseProposalClaim(a.id);
        await releaseProposalClaim(b.id);
        await setProposalStatus(a.id, 'expired');
        await setProposalStatus(b.id, 'expired');
    });

    test('one active thesis per symbol: ANY working row refuses a new proposal (review 2026-08-23)', async () => {
        const a = await create(validInput({ symbol: 'DUPE' }));
        await setProposalStatus(a.id, 'executed', { orderIds: [71, 72, 73], executedAt: Date.now() });

        // Same symbol at ANY level — the old 2% tolerance let a "genuinely
        // different level" stack a second bracket (multiple OCA groups the
        // close and the runner both refuse). An amendment replaces.
        await expect(create(validInput({ symbol: 'DUPE', entry: 101, stop: 98.5, target: 107.06 })))
            .rejects.toThrow(/one active thesis/);
        await expect(create(validInput({ symbol: 'DUPE', entry: 106, stop: 103.4, target: 112.36 })))
            .rejects.toThrow(/one active thesis/);

        // Once the working row is gone, the symbol is proposable again.
        await closeProposal(a.id, { exitReason: 'cancelled' });
        const fresh = await create(validInput({ symbol: 'DUPE', entry: 106, stop: 103.4, target: 112.36 }));
        expect(fresh.status).toBe('open');
    });

    test('listStaleUnfilled finds old unfilled entries, not filled or fresh ones', async () => {
        const { listStaleUnfilled } = await import('./trade-proposals.js');
        const old = await create(validInput({ symbol: 'STAL' }));
        await setProposalStatus(old.id, 'executed', { orderIds: [81, 82, 83], executedAt: Date.now() - 4 * 24 * 3600_000 });
        const fresh = await create(validInput({ symbol: 'STAF' }));
        await setProposalStatus(fresh.id, 'executed', { orderIds: [84, 85, 86], executedAt: Date.now() });
        const filled = await create(validInput({ symbol: 'STAG' }));
        await setProposalStatus(filled.id, 'executed', { orderIds: [87, 88, 89], executedAt: Date.now() - 4 * 24 * 3600_000 });
        await markEntryFilled(filled.id, 100.01);

        const stale = (await listStaleUnfilled(3 * 24 * 3600_000)).map((p) => p.id);
        expect(stale).toContain(old.id);
        expect(stale).not.toContain(fresh.id);
        expect(stale).not.toContain(filled.id);

        for (const id of [old.id, fresh.id, filled.id]) await closeProposal(id, { exitReason: 'cancelled' });
    });

    test('listExpiredUnfilledEntries: expired intraday entries only, grace honored (REQ-ENTRY-001)', async () => {
        const { listExpiredUnfilledEntries } = await import('./trade-proposals.js');
        const now = Date.now();
        const grace = 30 * 60_000;

        // Intraday, 60-min validity, accepted immediately → expired when
        // queried 61 minutes later, grace long since satisfied.
        const expired = await create(validInput({ symbol: 'EXPA', expiresMinutes: 60 }));
        await setProposalStatus(expired.id, 'executed', { orderIds: [91, 92, 93], executedAt: now });
        // Default 120-min validity → still inside its window at +61min.
        const unexpired = await create(validInput({ symbol: 'EXPB' }));
        await setProposalStatus(unexpired.id, 'executed', { orderIds: [94, 95, 96], executedAt: now });
        // Swing class: expired long ago but patient by design, never swept.
        const swing = await create(validInput({ symbol: 'EXPC', tradeClass: 'swing', tif: 'GTC', expiresMinutes: 1 }));
        await setProposalStatus(swing.id, 'executed', { orderIds: [97, 98, 99], executedAt: now });
        // Filled entry: nothing resting to cancel.
        const filled2 = await create(validInput({ symbol: 'EXPD', expiresMinutes: 1 }));
        await setProposalStatus(filled2.id, 'executed', { orderIds: [101, 102, 103], executedAt: now });
        await markEntryFilled(filled2.id, 100.01);
        // Expired by the query time but accepted INSIDE the grace window —
        // the deliberate late accept keeps its resting time.
        const lateAccept = await create(validInput({ symbol: 'EXPE', expiresMinutes: 1 }));
        await setProposalStatus(lateAccept.id, 'executed', { orderIds: [104, 105, 106], executedAt: now });

        // 61 minutes on: EXPA expired+past grace; EXPB still valid.
        const at61 = (await listExpiredUnfilledEntries(now + 61 * 60_000, grace)).map((p) => p.id);
        expect(at61).toContain(expired.id);
        expect(at61).not.toContain(unexpired.id);
        expect(at61).not.toContain(swing.id);
        expect(at61).not.toContain(filled2.id);

        // 5 minutes on: EXPE's window (1 min) has passed but the 30-min
        // accept grace has not — the deliberate late accept keeps resting.
        const at5 = (await listExpiredUnfilledEntries(now + 5 * 60_000, grace)).map((p) => p.id);
        expect(at5).not.toContain(lateAccept.id);
        // …and once the grace passes, it is swept like any expired entry.
        const at40 = (await listExpiredUnfilledEntries(now + 40 * 60_000, grace)).map((p) => p.id);
        expect(at40).toContain(lateAccept.id);

        for (const id of [expired.id, unexpired.id, swing.id, filled2.id, lateAccept.id]) {
            await closeProposal(id, { exitReason: 'cancelled' });
        }
    });

    test('closeProposal only transitions executed proposals', async () => {
        const p = await create(validInput());
        await closeProposal(p.id, { exitReason: 'manual' });
        expect((await getProposal(p.id))?.status).toBe('open'); // untouched
    });
});

describe('performance summary', () => {
    test('aggregates wins, losses, win rate and net P&L', async () => {
        // Window must exclude trades closed by earlier tests in this file.
        await new Promise((r) => setTimeout(r, 5));
        const since = Date.now();

        const win = await create(validInput({ symbol: 'WIN' }));
        await setProposalStatus(win.id, 'executed', { orderIds: [1, 2, 3], executedAt: Date.now() });
        await closeProposal(win.id, { exitReason: 'target', realizedPnl: 100, commissions: 1 });

        const loss = await create(validInput({ symbol: 'LOSS' }));
        await setProposalStatus(loss.id, 'executed', { orderIds: [4, 5, 6], executedAt: Date.now() });
        await closeProposal(loss.id, { exitReason: 'stop', realizedPnl: -50, commissions: 1 });

        const unlabeled = await create(validInput({ symbol: 'MANL' }));
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

        const before = await create(validInput({ symbol: 'OLDL' }));
        await setProposalStatus(before.id, 'executed', { orderIds: [21, 22, 23], executedAt: Date.now() });
        await closeProposal(before.id, { exitReason: 'stop', realizedPnl: -500, commissions: 1 });

        await new Promise((r) => setTimeout(r, 5));
        const baseline = setPerformanceBaseline('gate-stack overhaul');
        expect(getPerformanceBaseline()?.epochMs).toBe(baseline.epochMs);
        await new Promise((r) => setTimeout(r, 5));

        const after = await create(validInput({ symbol: 'NEWW' }));
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
        const p = await create(validInput({ symbol: 'LATE' }));
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
        const s = await create(validInput({ symbol: 'STOPD' }));
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
        const plain = await create(validInput({ symbol: 'CLSA' }));
        expect(plain.tradeClass).toBe('intraday');
        const swing = await create(validInput({
            symbol: 'CLSB', tradeClass: 'swing', tif: 'GTC',
        }));
        expect(swing.tradeClass).toBe('swing');
        expect((await getProposal(swing.id))?.tradeClass).toBe('swing');
        expect(formatProposalLine(swing)).toContain('{swing}');
        expect(formatProposalLine(plain)).not.toContain('{intraday}');
    });

    test('countOpenByClass counts executing/executed only, and can exclude one id', async () => {
        const a = await create(validInput({ symbol: 'CLSC', tradeClass: 'swing', tif: 'GTC' }));
        const b = await create(validInput({ symbol: 'CLSD', tradeClass: 'swing', tif: 'GTC' }));
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
            const p = await create(validInput({ symbol: sym, tradeClass: 'swing', tif: 'GTC' }));
            await setProposalStatus(p.id, 'executed', { executedAt: Date.now() });
            ids.push(p.id);
        }
        // Fourth swing: the store counts 3 executing/executed swings itself —
        // no caller-supplied context can understate the book.
        await expect(
            create(validInput({ symbol: 'CLSH', tradeClass: 'swing', tif: 'GTC' })),
        ).rejects.toThrow(/max 3/);
        // An intraday proposal is unaffected by the full swing book.
        const ok = await create(validInput({ symbol: 'CLSI' }));
        expect(ok.tradeClass).toBe('intraday');
        for (const id of ids) await closeProposal(id, { exitReason: 'manual', realizedPnl: 0 });
    });

    test('per-class ledger appears in the performance summary', async () => {
        const p = await create(validInput({ symbol: 'CLSJ', tradeClass: 'swing', tif: 'GTC' }));
        await setProposalStatus(p.id, 'executed', { executedAt: Date.now() });
        await closeProposal(p.id, { exitReason: 'target', realizedPnl: 25 });
        const s = await getPerformanceSummary(Date.now() - 60_000, { includeAllHistory: true });
        expect(s.byClass.swing).toBeDefined();
        expect(s.byClass.swing.wins).toBeGreaterThanOrEqual(1);
        const report = formatPerformanceReport(s, 'test');
        expect(report).toContain('swing:');
    });
});

describe('assertTestDataDirIsTemp (REQ-TEST-001 — the production DB is unreachable under tests)', () => {
    test('temp paths pass; the production path, subdirs of the repo, and unset all refuse', async () => {
        const { assertTestDataDirIsTemp } = await import('./trade-proposals.js');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const tmp = tmpdir();
        // Inside the OS temp dir (what mkdtemp produces): fine.
        expect(() => assertTestDataDirIsTemp(join(tmp, 'dexter-test-abc'), 'test', tmp)).not.toThrow();
        // The exact production path .env carries: refused.
        expect(() => assertTestDataDirIsTemp('.dexter/data', 'test', tmp)).toThrow(/OUTSIDE the OS temp directory/);
        // An absolute repo path: refused.
        expect(() => assertTestDataDirIsTemp(join(process.cwd(), '.dexter', 'data'), 'test', tmp)).toThrow(/OUTSIDE/);
        // Unset under test: refused (the original guard's case).
        expect(() => assertTestDataDirIsTemp(undefined, 'test', tmp)).toThrow(/set DEXTER_DATA_DIR/);
        // Production runtime (NODE_ENV not 'test'): the guard stays out of the way.
        expect(() => assertTestDataDirIsTemp('.dexter/data', undefined, tmp)).not.toThrow();
        expect(() => assertTestDataDirIsTemp(undefined, 'production', tmp)).not.toThrow();
    });
});

describe('performance baseline denominator (currency incident 2026-08-25)', () => {
    test('the epoch freezes the CALLER-supplied USD NetLiq — never a base-currency file read', () => {
        // The old code copied netliq-baseline.json, which the daily-loss
        // guard keeps in the account's BASE currency (EUR) — the epoch
        // froze €12,257 labeled as dollars and the live-scale band check
        // passed on a unit coincidence while the account was $14.3K.
        const withUsd = setPerformanceBaseline('usd supplied', 14298.53);
        expect(getPerformanceBaseline()?.netLiq).toBe(14298.53);
        expect(withUsd.netLiq).toBe(14298.53);
        // No USD value → NO denominator, loudly absent — never a guess.
        const withoutUsd = setPerformanceBaseline('fetch failed', null);
        expect(withoutUsd.netLiq).toBeUndefined();
        expect(getPerformanceBaseline()?.netLiq).toBeUndefined();
        // Zero/negative are refused as nonsense, same as absent.
        expect(setPerformanceBaseline('zero', 0).netLiq).toBeUndefined();
    });
});

describe('trigger band stamps (REQ-TRIG-002/003 — the 60-74 class is measurable apart)', () => {
    test('triggerBand: 60..74 → 60-74, ≥75 → 75+, below 60 or unknown → null', async () => {
        const { triggerBand } = await import('./trade-proposals.js');
        expect(triggerBand(60)).toBe('60-74');
        expect(triggerBand(74.9)).toBe('60-74');
        expect(triggerBand(75)).toBe('75+');
        expect(triggerBand(112)).toBe('75+');
        expect(triggerBand(59.9)).toBeNull();
        expect(triggerBand(null)).toBeNull();
        expect(triggerBand(undefined)).toBeNull();
        expect(triggerBand(Number.NaN)).toBeNull();
    });

    test('a proposal created with a trigger rank carries rank + band; without, both are null', async () => {
        const banded = await createProposal(validInput({ symbol: 'TRGA', triggerRank: 66 }), { dailyAtr: 4 });
        expect(banded.triggerRank).toBe(66);
        expect(banded.triggerBand).toBe('60-74');
        const plain = await createProposal(validInput({ symbol: 'TRGB' }), { dailyAtr: 4 });
        expect(plain.triggerRank).toBeNull();
        expect(plain.triggerBand).toBeNull();
        expect((await getProposal(banded.id))?.triggerBand).toBe('60-74');
    });

    test('a refusal row carries the trigger rank when supplied', async () => {
        const { recordRefusal, listRefusalsSince } = await import('./trade-proposals.js');
        const since = Date.now() - 1000;
        await recordRefusal({
            symbol: 'TRGC', direction: 'long', entryType: 'LMT', entry: 10, stop: 9, target: 12,
            reason: 'test refusal with rank', triggerRank: 63,
        });
        await recordRefusal({ symbol: 'TRGD', direction: 'short', entryType: 'EVAL', reason: 'evaluation declined: test' });
        const rows = await listRefusalsSince(since);
        expect(rows.find((r) => r.symbol === 'TRGC')?.triggerRank).toBe(63);
        expect(rows.find((r) => r.symbol === 'TRGD')?.triggerRank).toBeNull();
    });
});
