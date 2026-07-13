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

import { acceptProposal, autoExecuteProposal, rejectProposal } from './proposal-executor.js';
import { createProposal, getProposal } from './trade-proposals.js';

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
});
