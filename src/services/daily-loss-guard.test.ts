import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The guard reads/writes DEXTER_DATA_DIR/trading-halt.json — point it at a
// temp dir BEFORE the first call (module state is lazy).
const dir = mkdtempSync(join(tmpdir(), 'dexter-halt-'));
const prevDataDir = process.env.DEXTER_DATA_DIR;
process.env.DEXTER_DATA_DIR = dir;

import {
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
        const { rmSync: rm } = require('node:fs') as typeof import('node:fs');
        try { rm(join(dir, 'netliq-baseline.json')); } catch { /* absent */ }

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
        const { writeFileSync: wf } = require('node:fs') as typeof import('node:fs');
        wf(join(dir, 'netliq-baseline.json'), JSON.stringify({
            date: '2020-01-02', netLiq: 123, capturedAt: 'past',
        }));
        expect(readNetLiqBaseline()).toBeNull();
        // …and the next write replaces it with today's
        expect(writeNetLiqBaselineIfAbsent(500_000).netLiq).toBe(500_000);
        expect(readNetLiqBaseline()?.date).not.toBe('2020-01-02');
    });
});
