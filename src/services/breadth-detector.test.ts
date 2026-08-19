import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { breadthFireAllowed, breadthThresholdRelief, breadthWatchlist, cryptoBreadthEvent, detectBreadth, regimeBreadthEvent } from './breadth-detector.js';

describe('cryptoBreadthEvent (the COIN/MSTR gap, 2026-08-19)', () => {
    test('a crypto-led rally pre-arms the crypto vehicle LONG; a rout pre-arms it SHORT', () => {
        expect(cryptoBreadthEvent({ cryptoLed: true, inputs: { ibitPct: 4.1 } }))
            .toEqual({ direction: 'long', movers: [], semis: [], vehicle: 'IBIT' });
        expect(cryptoBreadthEvent({ cryptoLed: true, inputs: { ibitPct: -5.2 } }))
            .toEqual({ direction: 'short', movers: [], semis: [], vehicle: 'IBIT' });
    });

    test('no crypto flavor (or no IBIT reading) → no event', () => {
        expect(cryptoBreadthEvent({ cryptoLed: false, inputs: { ibitPct: 6 } })).toBeNull();
        expect(cryptoBreadthEvent({ cryptoLed: true, inputs: { ibitPct: null } })).toBeNull();
    });
});

describe('breadthFireAllowed (2026-08-18 timeline: pre-arm must not delay scan evidence)', () => {
    const MIN = 60_000;
    const caps = { scanCooldownMs: 120 * MIN, preArmCooldownMs: 60 * MIN, scanMaxPerDay: 2, preArmMaxPerDay: 2 };
    // ET-morning clock as epoch-like offsets (base far from the 0 = "never"
    // sentinel): 08:12 pre-arm, 09:42 scan, 10:00 pre-arm retry.
    const BASE = 1_000_000 * MIN;
    const t0812 = BASE;
    const t0942 = BASE + 90 * MIN;
    const t1000 = BASE + 108 * MIN;
    const t1045 = BASE + 153 * MIN;

    test('the live case: the 09:42 scan-confirmed fire is NOT blocked by the 08:12 pre-arm stamp', () => {
        expect(breadthFireAllowed({
            kind: 'scan', now: t0942, lastScanAt: 0, lastPreArmAt: t0812,
            scanFiresToday: 0, preArmsToday: 1, ...caps,
        })).toBe(true);
    });

    test('scan fires respect their own cooldown against prior scan fires', () => {
        expect(breadthFireAllowed({
            kind: 'scan', now: t0942 + 30 * MIN, lastScanAt: t0942, lastPreArmAt: 0,
            scanFiresToday: 1, preArmsToday: 0, ...caps,
        })).toBe(false);
    });

    test('a pre-arm retry is blocked by a FRESH scan fire (tape-only repeat is redundant)', () => {
        expect(breadthFireAllowed({
            kind: 'pre-arm', now: t1000, lastScanAt: t0942, lastPreArmAt: t0812,
            scanFiresToday: 1, preArmsToday: 1, ...caps,
        })).toBe(false);
        // …and allowed again once the pre-arm cooldown clears both stamps.
        expect(breadthFireAllowed({
            kind: 'pre-arm', now: t1045, lastScanAt: t0942, lastPreArmAt: t0812,
            scanFiresToday: 1, preArmsToday: 1, ...caps,
        })).toBe(true);
    });

    test('each kind has its own daily cap', () => {
        expect(breadthFireAllowed({
            kind: 'pre-arm', now: t1045, lastScanAt: 0, lastPreArmAt: 0,
            scanFiresToday: 0, preArmsToday: 2, ...caps,
        })).toBe(false);
        expect(breadthFireAllowed({
            kind: 'scan', now: t1045, lastScanAt: 0, lastPreArmAt: 0,
            scanFiresToday: 2, preArmsToday: 0, ...caps,
        })).toBe(false);
        // Pre-arms exhausted never blocks scan evidence.
        expect(breadthFireAllowed({
            kind: 'scan', now: t1045, lastScanAt: 0, lastPreArmAt: t1000,
            scanFiresToday: 0, preArmsToday: 2, ...caps,
        })).toBe(true);
    });
});

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
const ENV_KEYS = ['OPP_BREADTH_VEHICLE_SEMI', 'OPP_BREADTH_VEHICLE_BROAD', 'OPP_BREADTH_VEHICLE_CRYPTO', 'OPP_BREADTH_MIN_WATCHED', 'OPP_BREADTH_THRESHOLD_RELIEF', 'UNIVERSE_EXTRA_SYMBOLS'];
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

    test('a crypto-majority breadth day routes to the crypto vehicle', () => {
        const crypto = new Set(['COIN', 'MSTR', 'HOOD', 'RIOT', 'MSFT']);
        const event = detectBreadth([
            surfaced('COIN', 'TOP_PERC_GAIN'),
            surfaced('MSTR', 'TOP_PERC_GAIN'),
            surfaced('HOOD', 'TOP_PERC_GAIN'),
            surfaced('RIOT', 'TOP_OPEN_PERC_GAIN'),
            surfaced('MSFT', 'TOP_PERC_GAIN'),
        ], crypto, 4);
        expect(event).not.toBeNull();
        expect(event!.vehicle).toBe('IBIT'); // 4 of 5 movers are crypto complex
        expect(event!.direction).toBe('long');
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
