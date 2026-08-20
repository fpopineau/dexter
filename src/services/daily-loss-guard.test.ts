import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The guard reads/writes DEXTER_DATA_DIR/trading-halt.json — point it at a
// temp dir BEFORE the first call (module state is lazy).
const dir = mkdtempSync(join(tmpdir(), 'dexter-halt-'));
const prevDataDir = process.env.DEXTER_DATA_DIR;
process.env.DEXTER_DATA_DIR = dir;

import {
    __resetMemoryLatchesForTests,
    assertDailyLossOk,
    clearTradingHalt,
    getActiveHalt,
    readNetLiqBaseline,
    writeNetLiqBaselineIfAbsent,
} from './daily-loss-guard.js';

function etToday(): string {
    const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`;
}

function writeHaltFile(date: string): void {
    writeFileSync(
        join(dir, 'trading-halt.json'),
        JSON.stringify({
            date,
            reason: `daily P&L -2500 breached -2% of net liquidation (100000)`,
            dailyPnL: -2500,
            netLiquidation: 100_000,
            trippedAt: new Date().toISOString(),
        }),
    );
}

beforeAll(() => {
    process.env.DEXTER_DATA_DIR = dir;
});

// Each test models a FRESH process discovering the current file state — the
// process-lifetime memory mirrors must not leak across that boundary.
beforeEach(() => {
    __resetMemoryLatchesForTests();
});

afterAll(() => {
    if (prevDataDir === undefined) delete process.env.DEXTER_DATA_DIR;
    else process.env.DEXTER_DATA_DIR = prevDataDir;
    rmSync(dir, { recursive: true, force: true });
});

describe('daily-loss guard halt latching', () => {
    test('no halt file → no active halt', () => {
        expect(getActiveHalt()).toBeNull();
    });

    test("a halt record from a previous day does not latch today", () => {
        writeHaltFile('2020-01-02');
        expect(getActiveHalt()).toBeNull();
    });

    test("today's halt record is active and blocks new orders", async () => {
        writeHaltFile(etToday());
        const halt = getActiveHalt();
        expect(halt).not.toBeNull();
        expect(halt!.dailyPnL).toBe(-2500);
        // assertDailyLossOk must throw on the latched halt WITHOUT touching
        // IBKR (the halt short-circuits the live P&L check).
        await expect(assertDailyLossOk()).rejects.toThrow(/KILL-SWITCH/);
    });

    test('clearTradingHalt is a deliberate reset', () => {
        writeHaltFile(etToday());
        expect(getActiveHalt()).not.toBeNull();
        expect(clearTradingHalt()).toBe(true);
        expect(getActiveHalt()).toBeNull();
        // idempotent: nothing left to clear
        expect(clearTradingHalt()).toBe(false);
    });
});

describe('NetLiq baseline (PnL-proxy fallback)', () => {
    test('absent → null; first write wins; same-day rewrite is a no-op', () => {
        try { rmSync(join(dir, 'netliq-baseline.json')); } catch { /* absent */ }

        expect(readNetLiqBaseline()).toBeNull();

        const first = writeNetLiqBaselineIfAbsent(1_000_000);
        expect(first.netLiq).toBe(1_000_000);
        expect(readNetLiqBaseline()?.netLiq).toBe(1_000_000);

        // The session's FIRST value is the reference — later values ignored.
        const second = writeNetLiqBaselineIfAbsent(950_000);
        expect(second.netLiq).toBe(1_000_000);
        expect(readNetLiqBaseline()?.netLiq).toBe(1_000_000);
    });

    test('a stale baseline (previous day) reads as absent', () => {
        writeFileSync(join(dir, 'netliq-baseline.json'), JSON.stringify({
            date: '2020-01-02', netLiq: 123, capturedAt: 'past',
        }));
        expect(readNetLiqBaseline()).toBeNull();
        // …and the next write replaces it with today's
        expect(writeNetLiqBaselineIfAbsent(500_000).netLiq).toBe(500_000);
        expect(readNetLiqBaseline()?.date).not.toBe('2020-01-02');
    });

    test('unwritable data dir: memory holds the first baseline — no re-capture of a degraded NetLiq', () => {
        // Point the store at a path UNDER A FILE so mkdir/write must fail —
        // this is the audit 2026-08-20 hole: with no memory mirror, the
        // failed write left readNetLiqBaseline() null, and the next gate
        // check re-captured the CURRENT (already-degraded) NetLiq as the
        // baseline, resetting the P&L proxy to ~0 below the kill-switch.
        const blocker = join(dir, 'not-a-dir');
        writeFileSync(blocker, 'file, not a directory');
        const prev = process.env.DEXTER_DATA_DIR;
        process.env.DEXTER_DATA_DIR = join(blocker, 'sub');
        try {
            const first = writeNetLiqBaselineIfAbsent(1_000_000);
            expect(first.netLiq).toBe(1_000_000);
            // File write failed, but the session still knows its reference…
            expect(readNetLiqBaseline()?.netLiq).toBe(1_000_000);
            // …so a later, post-loss NetLiq must NOT become the new baseline.
            expect(writeNetLiqBaselineIfAbsent(940_000).netLiq).toBe(1_000_000);
        } finally {
            process.env.DEXTER_DATA_DIR = prev;
        }
    });
});
