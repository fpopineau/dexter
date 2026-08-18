import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { breadthThresholdRelief, breadthWatchlist, detectBreadth, regimeBreadthEvent } from './breadth-detector.js';

describe('regimeBreadthEvent (tape pre-arm of the short vehicle, 2026-08-18)', () => {
    test('a semis-led risk-off tape synthesizes the short-vehicle evaluation with no scan movers', () => {
        const e = regimeBreadthEvent({ tag: 'risk-off', semisLed: true });
        expect(e).toEqual({ direction: 'short', movers: [], semis: [], vehicle: 'SOXL' });
    });

    test('risk-off without semis leadership stays with the single-name pipeline', () => {
        expect(regimeBreadthEvent({ tag: 'risk-off', semisLed: false })).toBeNull();
    });

    test('any other tape never pre-arms — even with a stray semisLed flag', () => {
        expect(regimeBreadthEvent({ tag: 'neutral', semisLed: true })).toBeNull();
        expect(regimeBreadthEvent({ tag: 'risk-on', semisLed: true })).toBeNull();
        expect(regimeBreadthEvent({ tag: 'unknown', semisLed: false })).toBeNull();
    });
});

const WATCH = new Set(['MU', 'MSFT', 'AMD', 'INTC', 'DELL', 'TSM', 'ARM', 'ASML', 'SMCI', 'WMT', 'BAC']);

function surfaced(symbol: string, ...sources: string[]) {
    return { symbol, sources };
}

// detectBreadth reads vehicle envs — pin them so a user .env (bun auto-loads
// it into tests) can never steer assertions.
const ENV_KEYS = ['OPP_BREADTH_VEHICLE_SEMI', 'OPP_BREADTH_VEHICLE_BROAD', 'OPP_BREADTH_MIN_WATCHED', 'OPP_BREADTH_THRESHOLD_RELIEF', 'UNIVERSE_EXTRA_SYMBOLS'];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
    for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    }
});

describe('detectBreadth (Jul 30 melt-up shape)', () => {
    test('nine correlated watchlist gainers → semis vehicle', () => {
        const event = detectBreadth([
            surfaced('MU', 'TOP_PERC_GAIN', 'HOT_BY_VOLUME'),
            surfaced('MSFT', 'TOP_PERC_GAIN'),
            surfaced('AMD', 'TOP_PERC_GAIN'),
            surfaced('INTC', 'TOP_PERC_GAIN'),
            surfaced('DELL', 'TOP_PERC_GAIN'),
            surfaced('TSM', 'TOP_PERC_GAIN'),
            surfaced('ARM', 'HIGH_OPEN_GAP'),
            surfaced('ASML', 'TOP_OPEN_PERC_GAIN'),
            surfaced('SMCI', 'TOP_PERC_GAIN'),
            surfaced('SOXS', 'TOP_PERC_LOSE'),
        ], WATCH, 4);
        expect(event).not.toBeNull();
        expect(event!.movers.length).toBe(9);
        // 7 of 9 movers are semis → SOXL
        expect(event!.semis).toEqual(['MU', 'AMD', 'INTC', 'TSM', 'ARM', 'ASML', 'SMCI']);
        expect(event!.vehicle).toBe('SOXL');
    });

    test('broad (non-semi) breadth routes to QQQ', () => {
        const event = detectBreadth([
            surfaced('MSFT', 'TOP_PERC_GAIN'),
            surfaced('DELL', 'TOP_PERC_GAIN'),
            surfaced('WMT', 'TOP_PERC_GAIN'),
            surfaced('BAC', 'TOP_PERC_GAIN'),
        ], WATCH, 4);
        expect(event).not.toBeNull();
        expect(event!.vehicle).toBe('QQQ');
    });

    test('below the threshold → null (ordinary tape)', () => {
        const event = detectBreadth([
            surfaced('MU', 'TOP_PERC_GAIN'),
            surfaced('MSFT', 'TOP_PERC_GAIN'),
            surfaced('AMD', 'TOP_PERC_GAIN'),
        ], WATCH, 4);
        expect(event).toBeNull();
    });

    test('direction-blind scanners never count as gainers', () => {
        // Active/volume presence says nothing about direction — a watchlist
        // name surfaced only by MOST_ACTIVE could be crashing.
        const event = detectBreadth([
            surfaced('MU', 'MOST_ACTIVE'),
            surfaced('MSFT', 'HOT_BY_VOLUME'),
            surfaced('AMD', 'TOP_TRADE_RATE'),
            surfaced('INTC', 'MOST_ACTIVE'),
        ], WATCH, 4);
        expect(event).toBeNull();
    });

    test('non-watchlist gainers are ignored (idiosyncratic small caps ≠ regime)', () => {
        const event = detectBreadth([
            surfaced('AEHR', 'TOP_PERC_GAIN'),
            surfaced('QCRH', 'TOP_PERC_GAIN'),
            surfaced('INSW', 'TOP_PERC_GAIN'),
            surfaced('BWLP', 'TOP_PERC_GAIN'),
        ], WATCH, 4);
        expect(event).toBeNull();
    });

    test('long events carry direction long', () => {
        const event = detectBreadth([
            surfaced('MU', 'TOP_PERC_GAIN'), surfaced('AMD', 'TOP_PERC_GAIN'),
            surfaced('INTC', 'TOP_PERC_GAIN'), surfaced('TSM', 'TOP_PERC_GAIN'),
        ], WATCH, 4);
        expect(event!.direction).toBe('long');
    });

    test('a correlated SELLOFF is a breadth event too — direction short', () => {
        const event = detectBreadth([
            surfaced('MU', 'TOP_PERC_LOSE'),
            surfaced('AMD', 'TOP_PERC_LOSE'),
            surfaced('TSM', 'TOP_OPEN_PERC_LOSE'),
            surfaced('ARM', 'TOP_PERC_LOSE'),
            surfaced('MSFT', 'TOP_PERC_LOSE'),
        ], WATCH, 4);
        expect(event).not.toBeNull();
        expect(event!.direction).toBe('short');
        expect(event!.movers.length).toBe(5);
        // semis majority → semis vehicle, to be SHORTED
        expect(event!.vehicle).toBe('SOXL');
    });

    test('mixed tape: dominant side wins, ties go long', () => {
        // 4 up vs 5 down → short side wins
        const down = detectBreadth([
            surfaced('MU', 'TOP_PERC_GAIN'), surfaced('AMD', 'TOP_PERC_GAIN'),
            surfaced('INTC', 'TOP_PERC_GAIN'), surfaced('TSM', 'TOP_PERC_GAIN'),
            surfaced('ARM', 'TOP_PERC_LOSE'), surfaced('MSFT', 'TOP_PERC_LOSE'),
            surfaced('DELL', 'TOP_PERC_LOSE'), surfaced('SMCI', 'TOP_PERC_LOSE'),
            surfaced('ASML', 'TOP_PERC_LOSE'),
        ], WATCH, 4);
        expect(down!.direction).toBe('short');
        // 4 vs 4 tie → long
        const tie = detectBreadth([
            surfaced('MU', 'TOP_PERC_GAIN'), surfaced('AMD', 'TOP_PERC_GAIN'),
            surfaced('INTC', 'TOP_PERC_GAIN'), surfaced('TSM', 'TOP_PERC_GAIN'),
            surfaced('ARM', 'TOP_PERC_LOSE'), surfaced('MSFT', 'TOP_PERC_LOSE'),
            surfaced('DELL', 'TOP_PERC_LOSE'), surfaced('SMCI', 'TOP_PERC_LOSE'),
        ], WATCH, 4);
        expect(tie!.direction).toBe('long');
    });

    test('a selloff below the threshold stays null (no panic shorting)', () => {
        const event = detectBreadth([
            surfaced('MU', 'TOP_PERC_LOSE'), surfaced('AMD', 'TOP_PERC_LOSE'),
        ], WATCH, 4);
        expect(event).toBeNull();
    });

    test('vehicle env overrides are honored', () => {
        process.env.OPP_BREADTH_VEHICLE_SEMI = 'smh';
        const event = detectBreadth([
            surfaced('MU', 'TOP_PERC_GAIN'),
            surfaced('AMD', 'TOP_PERC_GAIN'),
            surfaced('INTC', 'TOP_PERC_GAIN'),
            surfaced('TSM', 'TOP_PERC_GAIN'),
        ], WATCH, 4);
        expect(event!.vehicle).toBe('SMH');
    });
});

describe('breadthThresholdRelief (SNAP-at-68 regression)', () => {
    test('defaults to 10 — a 75 bar becomes 65 for watchlist movers on breadth days', () => {
        expect(breadthThresholdRelief()).toBe(10);
    });

    test('env override, including 0 to disable', () => {
        process.env.OPP_BREADTH_THRESHOLD_RELIEF = '5';
        expect(breadthThresholdRelief()).toBe(5);
        process.env.OPP_BREADTH_THRESHOLD_RELIEF = '0';
        expect(breadthThresholdRelief()).toBe(0);
    });
});

describe('breadthWatchlist', () => {
    test('merges UNIVERSE_EXTRA_SYMBOLS into the built-in core', () => {
        process.env.UNIVERSE_EXTRA_SYMBOLS = ' pool , PZZA ';
        const list = breadthWatchlist();
        expect(list.has('POOL')).toBe(true);
        expect(list.has('PZZA')).toBe(true);
        expect(list.has('NVDA')).toBe(true); // built-in core
        expect(list.has('MSFT')).toBe(true);
    });
});
