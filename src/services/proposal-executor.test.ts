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

// Take-policy fixture (WP-EXIT): ATR 4 → x = 6% → target 106, stop ≤ 3.
const ATR_CTX = { dailyAtr: 4 };

async function openProposal() {
    return createProposal({
        symbol: 'AAPL',
        direction: 'long',
        entryType: 'LMT',
        entry: 100,
        stop: 97.5,
        target: 106,
        quantity: 10,
        rationale: 'executor test',
        source: 'test',
    }, ATR_CTX);
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
                entry: 100, stop: 97.5, target: 106, quantity: 10,
                rationale: 'cancel-by-symbol test', source: 'test',
            }, ATR_CTX);
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

        // two working brackets on one symbol → must cancel by id.
        // (Create BOTH while open — the duplicate-setup guard now refuses
        // creating against an already-executed same-entry proposal, so this
        // state can only arise from near-simultaneous creations.)
        // Review-17: the one-thesis unique index makes this state
        // unrepresentable in NEW DBs — drop it to simulate the legacy DB
        // (index creation failed on pre-existing duplicates) where the
        // ambiguity refusal is the defense that still matters.
        const { __dropOneThesisIndexForTests } = await import('./trade-proposals.js');
        await __dropOneThesisIndexForTests();
        const a = await createProposal({
            symbol: 'CBSA', direction: 'long', entryType: 'LMT',
            entry: 100, stop: 97.5, target: 106, quantity: 10,
            rationale: 'ambiguity test A', source: 'test',
        }, ATR_CTX);
        const b = await createProposal({
            symbol: 'CBSA', direction: 'long', entryType: 'LMT',
            entry: 100, stop: 97.5, target: 106, quantity: 10,
            rationale: 'ambiguity test B', source: 'test',
        }, ATR_CTX);
        await setProposalStatus(a.id, 'executed', { orderIds: [61, 62, 63], executedAt: Date.now() });
        await setProposalStatus(b.id, 'executed', { orderIds: [64, 65, 66], executedAt: Date.now() });
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
        // Pin the threshold: bun auto-loads the project .env into tests, and
        // the operator's AUTO_EXECUTE_MIN_SCORE (currently 1) would let the
        // low-score case through to the real accept path.
        process.env.AUTO_EXECUTE_MIN_SCORE = '80';
        try {
            const unscored = await openProposal();
            const noScore = await autoExecuteProposal(unscored.id);
            expect(noScore.ok).toBe(false);
            expect(noScore.message).toContain('score none is below');
            expect((await getProposal(unscored.id))?.status).toBe('open');

            const low = await createProposal({
                symbol: 'AAPL', direction: 'long', entryType: 'LMT',
                entry: 100, stop: 97.5, target: 106, quantity: 10,
                score: 62, rationale: 'low-confidence test', source: 'test',
            }, ATR_CTX);
            const refused = await autoExecuteProposal(low.id);
            expect(refused.ok).toBe(false);
            expect(refused.message).toContain('score 62 is below the confidence threshold 80');
            expect(refused.message).toContain(`accept ${low.id}`);
            expect((await getProposal(low.id))?.status).toBe('open');
        } finally {
            delete process.env.AUTO_EXECUTE_MIN_SCORE;
        }
    });

    test('confidence threshold is tunable via AUTO_EXECUTE_MIN_SCORE', async () => {
        process.env.AUTO_EXECUTE_PAPER = 'true';
        process.env.IBKR_PORT = '4002';
        process.env.AUTO_EXECUTE_MIN_SCORE = '95';
        try {
            const p = await createProposal({
                symbol: 'AAPL', direction: 'long', entryType: 'LMT',
                entry: 100, stop: 97.5, target: 106, quantity: 10,
                score: 90, rationale: 'threshold test', source: 'test',
            }, ATR_CTX);
            const refused = await autoExecuteProposal(p.id);
            expect(refused.ok).toBe(false);
            expect(refused.message).toContain('below the confidence threshold 95');
        } finally {
            delete process.env.AUTO_EXECUTE_MIN_SCORE;
        }
    });
});

describe('auto-exec score floor (D6, review 2026-08-21 round 3)', () => {
    test('default is 0 — the burn-in samples every scored band', async () => {
        const { autoExecMinScore } = await import('./proposal-executor.js');
        delete process.env.AUTO_EXECUTE_MIN_SCORE;
        expect(autoExecMinScore()).toBe(0);
        process.env.AUTO_EXECUTE_MIN_SCORE = '0'; // explicit 0 must be honored (old guard fell back to 80)
        expect(autoExecMinScore()).toBe(0);
        process.env.AUTO_EXECUTE_MIN_SCORE = '40';
        expect(autoExecMinScore()).toBe(40);
        process.env.AUTO_EXECUTE_MIN_SCORE = '-5'; // invalid → default
        expect(autoExecMinScore()).toBe(0);
        delete process.env.AUTO_EXECUTE_MIN_SCORE;
    });
});

describe('worstEntryNotional (REQ-EXPO-001 — caps price unfilled rows at the worst basis)', () => {
    test('filled rows price at the fill; unfilled at max(trigger, limit cap)', async () => {
        const { worstEntryNotional } = await import('./proposal-executor.js');
        // Filled: fill price wins regardless of planned levels.
        expect(worstEntryNotional({ quantity: 10, entryFillPrice: 101.5, entry: 100, entryLimit: 100.3 })).toBe(1015);
        // Unfilled long STP_LMT: the limit cap (above the trigger) is the
        // worst permitted fill — the larger notional the caps must survive.
        expect(worstEntryNotional({ quantity: 10, entryFillPrice: null, entry: 100, entryLimit: 100.3 })).toBe(1003);
        // Unfilled short STP_LMT (trigger above the limit): the trigger is
        // the larger price — still the larger notional basis.
        expect(worstEntryNotional({ quantity: 10, entryFillPrice: null, entry: 95, entryLimit: 94.7 })).toBe(950);
        // Plain LMT (no cap field): the entry itself.
        expect(worstEntryNotional({ quantity: 10, entryFillPrice: null, entry: 100, entryLimit: null })).toBe(1000);
        // Nothing priceable: zero (the accept gate refuses null-risk rows
        // separately — WP0.3).
        expect(worstEntryNotional({ quantity: 10, entryFillPrice: null, entry: null, entryLimit: null })).toBe(0);
    });
});

describe('classifyOrphanBracketRefs (review-17/18 — the ownership prefix is not reconciliation)', () => {
    test('a P-ref maps to a working row or refuses; BRKT- always refuses; risk-reducing refs stay owned', async () => {
        const { classifyOrphanBracketRefs } = await import('./proposal-executor.js');
        const working = new Set(['P-AB12', 'P-CD34']);
        const o = (orderRef: string | null) => ({ orderRef });
        const orphans = classifyOrphanBracketRefs([
            o('P-AB12:entry'),   // claimed row → owned
            o('P-CD34:stop2'),   // resized leg of a working row → owned
            o('P-9F00:tp'),      // ZOMBIE: no live row behind the bracket
            o('BRKT-501:entry'), // legacy fallback ref — maps to no row ever
            o('protect-NVDA:stop'), // risk-reducing, position-tied → owned
            o('close-NVDA'),
            o('reduce-NVDA'),
            o(null),             // foreign — handled by the isOurOrderRef gate, not here
        ], working);
        expect(orphans.map((x) => x.orderRef)).toEqual(['P-9F00:tp', 'BRKT-501:entry']);
    });
});

describe('verifyAdoptedProtection (review-18 — a protect- REF alone is not protection)', () => {
    const stop = (over: Record<string, unknown> = {}) => ({
        orderId: 900, symbol: 'ADPT', orderRef: 'protect-ADPT:stop', account: 'DU1',
        quantity: 10, action: 'SELL', orderType: 'STP', auxPrice: 95,
        lmtPrice: null, ocaGroup: 'dexter-protect-ADPT-900', ...over,
    });
    const tp = (over: Record<string, unknown> = {}) => ({
        orderId: 901, symbol: 'ADPT', orderRef: 'protect-ADPT:tp', account: 'DU1',
        quantity: 10, action: 'SELL', orderType: 'LMT', auxPrice: null,
        lmtPrice: 110, ocaGroup: 'dexter-protect-ADPT-900', ...over,
    });
    const check = async (orders: unknown[], input: Record<string, unknown> = {}) => {
        const { verifyAdoptedProtection } = await import('./proposal-executor.js');
        return verifyAdoptedProtection({
            symbol: 'ADPT', positionQty: 10, basisPrice: 100, account: 'DU1',
            orders: orders as never, ...input,
        } as never);
    };

    test('a structurally coherent stop passes and prices the REAL planned risk', async () => {
        const r = await check([stop()]);
        expect(r).toEqual({ ok: true, riskUsd: 50 }); // (100 - 95) × 10
    });

    test('a stop already locking profit passes with ZERO planned risk', async () => {
        const r = await check([stop({ auxPrice: 110 })]);
        expect(r).toEqual({ ok: true, riskUsd: 0 });
    });

    test('short position: BUY-side stop above basis prices the risk', async () => {
        const r = await check([stop({ action: 'BUY', auxPrice: 105 })], { positionQty: -10 });
        expect(r).toEqual({ ok: true, riskUsd: 50 }); // (105 - 100) × 10
    });

    test('every structural defect fails closed with its reason', async () => {
        const reasons = await Promise.all([
            check([]),                                        // nothing
            check([stop(), stop({ orderId: 901 })]),          // stacked protects
            check([stop({ account: 'DU2' })]),                // wrong account
            check([stop({ action: 'BUY' })]),                 // entry-side "stop" on a long
            check([stop({ orderType: 'LMT' })]),              // a limit is not a stop
            check([stop({ quantity: 5 })]),                   // covers half the position
            check([stop({ quantity: null })]),                // unknown size = fail closed
            check([stop({ auxPrice: null })]),                // no stop price
        ]);
        expect(reasons.every((r) => r.ok === false)).toBe(true);
        expect((reasons[0] as { reason: string }).reason).toContain('no working protective stop');
        expect((reasons[1] as { reason: string }).reason).toContain('incoherent');
        expect((reasons[5] as { reason: string }).reason).toContain('covers 5 of 10');
    });

    test('the NORMAL protectPosition pair (:stop + :tp, OCA-joined) passes — review-19: it was rejected as two stops', async () => {
        const r = await check([stop(), tp()]);
        expect(r).toEqual({ ok: true, riskUsd: 50 });
    });

    test('review-19 tightenings: oversized stop, STP LMT, and a broken pair all refuse', async () => {
        // Oversized: 20 shares against a 10-share position REVERSES on trigger.
        const oversized = await check([stop({ quantity: 20 })]);
        expect(oversized.ok).toBe(false);
        expect((oversized as { reason: string }).reason).toContain('must match exactly');
        // STP LMT: its fill is not assured through a gap — not protection.
        expect((await check([stop({ orderType: 'STP LMT' })])).ok).toBe(false);
        // A target that is not OCA-joined to the stop: both could fill.
        const unjoined = await check([stop(), tp({ ocaGroup: 'some-other-group' })]);
        expect(unjoined.ok).toBe(false);
        expect((unjoined as { reason: string }).reason).toContain('OCA');
        // A target covering the wrong size.
        expect((await check([stop(), tp({ quantity: 5 })])).ok).toBe(false);
        // A target in the wrong account or on the entry side.
        expect((await check([stop(), tp({ account: 'DU2' })])).ok).toBe(false);
        expect((await check([stop(), tp({ action: 'BUY' })])).ok).toBe(false);
        // A protect- ref that is neither :stop nor :tp is unrecognized.
        const stray = await check([stop(), tp({ orderRef: 'protect-ADPT' })]);
        expect(stray.ok).toBe(false);
        expect((stray as { reason: string }).reason).toContain('unrecognized');
    });

    test('a stop on ANOTHER symbol does not protect this one', async () => {
        expect((await check([stop({ symbol: 'OTHER', orderRef: 'protect-OTHER:stop' })])).ok).toBe(false);
    });
});

describe('directionalBasis (review-19 — max(cost, mark) hid short-side risk)', () => {
    test('long → max(cost, mark); short → min(cost, mark); no mark → cost', async () => {
        const { directionalBasis, verifyAdoptedProtection } = await import('./proposal-executor.js');
        expect(directionalBasis(10, 100, 150)).toBe(150);  // rallied long marks up
        expect(directionalBasis(10, 100, 80)).toBe(100);   // crashed long keeps cost floor
        expect(directionalBasis(-10, 100, 80)).toBe(80);   // profitable short marks DOWN
        expect(directionalBasis(-10, 100, 120)).toBe(100); // losing short keeps cost
        expect(directionalBasis(-10, 100, null)).toBe(100);
        // The reviewer's exact case: short from $100, mark $80, stop $90 —
        // the old $100 basis reported ZERO risk; the real current-to-stop
        // downside is $10/share.
        const r = verifyAdoptedProtection({
            symbol: 'SHRT', positionQty: -10, basisPrice: directionalBasis(-10, 100, 80), account: 'DU1',
            orders: [{
                orderId: 950, symbol: 'SHRT', orderRef: 'protect-SHRT:stop', account: 'DU1',
                quantity: 10, action: 'BUY', orderType: 'STP', auxPrice: 90, lmtPrice: null, ocaGroup: null,
            }],
        });
        expect(r).toEqual({ ok: true, riskUsd: 100 });
    });
});
