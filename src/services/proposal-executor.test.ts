import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate the proposals DB BEFORE the store's first call.
const dir = mkdtempSync(join(tmpdir(), 'dexter-executor-'));
const prevEnv = {
    DEXTER_DATA_DIR: process.env.DEXTER_DATA_DIR,
    AUTO_EXECUTE_PAPER: process.env.AUTO_EXECUTE_PAPER,
    AUTO_EXECUTE_MAX_PER_DAY: process.env.AUTO_EXECUTE_MAX_PER_DAY,
    IBKR_PORT: process.env.IBKR_PORT,
};
process.env.DEXTER_DATA_DIR = dir;
delete process.env.AUTO_EXECUTE_PAPER;

import { acceptProposal, autoExecuteProposal, cancelProposalBracket, cancelProposalForSymbol, rejectProposal } from './proposal-executor.js';
import { createProposal, getProposal, markEntryFilled, setProposalStatus } from './trade-proposals.js';

afterEach(() => {
    delete process.env.AUTO_EXECUTE_PAPER;
    delete process.env.AUTO_EXECUTE_MAX_PER_DAY;
    if (prevEnv.IBKR_PORT === undefined) delete process.env.IBKR_PORT;
    else process.env.IBKR_PORT = prevEnv.IBKR_PORT;
});

afterAll(() => {
    for (const [k, v] of Object.entries(prevEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    // The proposals module keeps its SQLite handle open; on Windows the file
    // can't be deleted while held. Best-effort cleanup.
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* held by sqlite */ }
});

async function openProposal() {
    return createProposal({
        symbol: 'AAPL',
        direction: 'long',
        entryType: 'LMT',
        entry: 100,
        stop: 95,
        target: 110,
        quantity: 10,
        rationale: 'executor test',
        source: 'test',
    });
}

describe('executor refusal gates (no IBKR needed)', () => {
    test('unknown proposal id is refused', async () => {
        const outcome = await acceptProposal('P-ZZZZ');
        expect(outcome.ok).toBe(false);
        expect(outcome.message).toContain('not found');
    });

    test('reject works and is terminal', async () => {
        const p = await openProposal();
        const rejected = await rejectProposal(p.id);
        expect(rejected.ok).toBe(true);
        expect((await getProposal(p.id))?.status).toBe('rejected');

        // Rejecting again is a no-op refusal…
        expect((await rejectProposal(p.id)).ok).toBe(false);
        // …and a rejected proposal can never execute.
        const accepted = await acceptProposal(p.id);
        expect(accepted.ok).toBe(false);
        expect(accepted.message).toContain('rejected');
    });
});

describe('gate refusals keep proposals retryable', () => {
    test('kill-switch refusal leaves the proposal OPEN, not failed', async () => {
        const { writeFileSync, mkdirSync } = await import('node:fs');
        const { join } = await import('node:path');
        // Latch a halt for today so assertDailyLossOk throws WITHOUT IBKR.
        const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const today = `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`;
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'trading-halt.json'), JSON.stringify({
            date: today, reason: 'test halt', dailyPnL: -9999, netLiquidation: 100_000, trippedAt: 'now',
        }));

        try {
            const p = await openProposal();
            const outcome = await acceptProposal(p.id);
            expect(outcome.ok).toBe(false);
            expect(outcome.message).toContain('KILL-SWITCH');
            expect(outcome.message).toContain('remains OPEN');
            // The refusal must NOT consume the proposal — retry is possible
            // until expiry (the halt may clear, or verification may recover).
            expect((await getProposal(p.id))?.status).toBe('open');
        } finally {
            writeFileSync(join(dir, 'trading-halt.json'), JSON.stringify({ date: '1970-01-01' }));
        }
    });
});

describe('cancelProposalBracket refusals', () => {
    test('refuses open proposals (reject is the right verb) and filled entries', async () => {
        const open = await openProposal();
        const onOpen = await cancelProposalBracket(open.id);
        expect(onOpen.ok).toBe(false);
        expect(onOpen.message).toContain('reject');

        const filled = await openProposal();
        await setProposalStatus(filled.id, 'executed', { orderIds: [41, 42, 43], executedAt: Date.now() });
        await markEntryFilled(filled.id, 100.02);
        const onFilled = await cancelProposalBracket(filled.id);
        expect(onFilled.ok).toBe(false);
        expect(onFilled.message).toContain('unprotected');

        // Clean up: the store module caches its DB across test FILES in a
        // single-process run — a leaked 'executed' row skews other files'
        // countOpenExecuted assertions.
        const { closeProposal } = await import('./trade-proposals.js');
        await closeProposal(filled.id, { exitReason: 'manual' });
    });
});

describe('cancel by symbol', () => {
    test('unknown symbol, filled entry, and ambiguity are all refused with guidance', async () => {
        const { closeProposal } = await import('./trade-proposals.js');
        const make = async (symbol: string) => {
            const p = await createProposal({
                symbol, direction: 'long', entryType: 'LMT',
                entry: 100, stop: 95, target: 110, quantity: 10,
                rationale: 'cancel-by-symbol test', source: 'test',
            });
            await setProposalStatus(p.id, 'executed', { orderIds: [61, 62, 63], executedAt: Date.now() });
            return p;
        };

        const none = await cancelProposalForSymbol('ZZZQ');
        expect(none.ok).toBe(false);
        expect(none.message).toContain('No working bracket');

        // entry filled → same protection refusal as cancel-by-id
        const filled = await make('CBSF');
        await markEntryFilled(filled.id, 100.01);
        const onFilled = await cancelProposalForSymbol('cbsf');
        expect(onFilled.ok).toBe(false);
        expect(onFilled.message).toContain('unprotected');
        await closeProposal(filled.id, { exitReason: 'manual' });

        // two working brackets on one symbol → must cancel by id
        const a = await make('CBSA');
        const b = await make('CBSA');
        const ambiguous = await cancelProposalForSymbol('CBSA');
        expect(ambiguous.ok).toBe(false);
        expect(ambiguous.message).toContain(a.id);
        expect(ambiguous.message).toContain(b.id);
        expect(ambiguous.message).toContain('cancel by id');
        await closeProposal(a.id, { exitReason: 'cancelled' });
        await closeProposal(b.id, { exitReason: 'cancelled' });
    });
});

describe('auto-execution gates (paper-only by construction)', () => {
    test('disabled unless AUTO_EXECUTE_PAPER=true', async () => {
        const p = await openProposal();
        const outcome = await autoExecuteProposal(p.id);
        expect(outcome.ok).toBe(false);
        expect(outcome.message).toContain('disabled');
        // the proposal is untouched — still open for a human to accept
        expect((await getProposal(p.id))?.status).toBe('open');
    });

    test('refuses live ports regardless of any other configuration', async () => {
        process.env.AUTO_EXECUTE_PAPER = 'true';
        process.env.IBKR_PORT = '4001'; // IB Gateway LIVE port
        const p = await openProposal();
        const outcome = await autoExecuteProposal(p.id);
        expect(outcome.ok).toBe(false);
        expect(outcome.message).toContain('paper-only');
        expect((await getProposal(p.id))?.status).toBe('open');
    });

    test('confidence gate: no score or low score stays open for manual accept', async () => {
        process.env.AUTO_EXECUTE_PAPER = 'true';
        process.env.IBKR_PORT = '4002';

        const unscored = await openProposal();
        const noScore = await autoExecuteProposal(unscored.id);
        expect(noScore.ok).toBe(false);
        expect(noScore.message).toContain('score none is below');
        expect((await getProposal(unscored.id))?.status).toBe('open');

        const low = await createProposal({
            symbol: 'AAPL', direction: 'long', entryType: 'LMT',
            entry: 100, stop: 95, target: 110, quantity: 10,
            score: 62, rationale: 'low-confidence test', source: 'test',
        });
        const refused = await autoExecuteProposal(low.id);
        expect(refused.ok).toBe(false);
        expect(refused.message).toContain('score 62 is below the confidence threshold 80');
        expect(refused.message).toContain(`accept ${low.id}`);
        expect((await getProposal(low.id))?.status).toBe('open');
    });

    test('confidence threshold is tunable via AUTO_EXECUTE_MIN_SCORE', async () => {
        process.env.AUTO_EXECUTE_PAPER = 'true';
        process.env.IBKR_PORT = '4002';
        process.env.AUTO_EXECUTE_MIN_SCORE = '95';
        try {
            const p = await createProposal({
                symbol: 'AAPL', direction: 'long', entryType: 'LMT',
                entry: 100, stop: 95, target: 110, quantity: 10,
                score: 90, rationale: 'threshold test', source: 'test',
            });
            const refused = await autoExecuteProposal(p.id);
            expect(refused.ok).toBe(false);
            expect(refused.message).toContain('below the confidence threshold 95');
        } finally {
            delete process.env.AUTO_EXECUTE_MIN_SCORE;
        }
    });
});
