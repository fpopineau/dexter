import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate the proposals DB BEFORE the store's first call.
const dir = mkdtempSync(join(tmpdir(), 'dexter-proposals-tool-'));
const prevDataDir = process.env.DEXTER_DATA_DIR;
process.env.DEXTER_DATA_DIR = dir;
// Pin auto-execution OFF: test runners load the project .env, where the
// operator keeps AUTO_EXECUTE_PAPER=true — a created proposal would flow
// into the real accept path and hang looking for IBKR.
process.env.AUTO_EXECUTE_PAPER = 'false';

import { createTradeProposalsTool } from './index.js';

afterAll(() => {
    if (prevDataDir === undefined) delete process.env.DEXTER_DATA_DIR;
    else process.env.DEXTER_DATA_DIR = prevDataDir;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* held by sqlite */ }
});

describe('trade_proposals tool — argument coercion', () => {
    // XML-based tool parsers (e.g. vLLM's Qwen3XMLToolParser) deliver every
    // argument as a string. The schemas must coerce numerics instead of
    // rejecting with "expected number, received string".
    test('create accepts stringified numbers (XML tool-parser style)', async () => {
        const tool = createTradeProposalsTool();
        const raw = await tool.invoke({
            action: 'create',
            symbol: 'ZETA',
            direction: 'long',
            entryType: 'LMT',
            entry: '20.80',
            stop: '19.20',
            target: '24.00',
            quantity: '48',
            score: '64',
            expiresMinutes: '120',
            rationale: 'pullback to EMA21 support with partnership catalyst',
        } as never);
        const parsed = JSON.parse(String(raw)) as { data: { created?: { id: string; entry: number; quantity: number } ; error?: string } };
        expect(parsed.data.error).toBeUndefined();
        expect(parsed.data.created?.id).toMatch(/^P-[0-9A-F]{4}$/);
        expect(parsed.data.created?.entry).toBe(20.8);
        expect(parsed.data.created?.quantity).toBe(48);
    });

    test('fractional share counts are refused by the GATE on the whole-share profile', async () => {
        // The schema now admits decimals (the live profile allows them);
        // the paper profile's gate still refuses — same invariant, enforced
        // one layer down where the rules profile is known.
        const tool = createTradeProposalsTool();
        const raw = await tool.invoke({
            action: 'create',
            symbol: 'ZETA',
            direction: 'long',
            entryType: 'LMT',
            entry: '20.80',
            stop: '19.20',
            target: '24.00',
            quantity: '48.5',
            rationale: 'fractional quantity must be refused on paper',
        } as never);
        const parsed = JSON.parse(String(raw));
        expect(parsed.data.error).toContain('positive integer');
    });

    test('performance accepts a stringified day count', async () => {
        const tool = createTradeProposalsTool();
        const raw = await tool.invoke({ action: 'performance', days: '7' } as never);
        const parsed = JSON.parse(String(raw)) as { data: { days: number } };
        expect(parsed.data.days).toBe(7);
    });
});
