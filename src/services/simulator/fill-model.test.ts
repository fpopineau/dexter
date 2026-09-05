import { describe, expect, test } from 'bun:test';
import { commissionsFor, netR, simulateBracket, type SimBar, type SimSpec } from './fill-model.js';

const M = 60_000;
const T0 = Date.UTC(2026, 8, 10, 9, 30, 0); // ET frame: 09:30
const bar = (i: number, o: number, h: number, l: number, c: number): SimBar => ({ t: T0 + i * M, open: o, high: h, low: l, close: c });

const base: SimSpec = {
    direction: 'long', entryType: 'LMT', entry: 100, entryLimit: null, stop: 97, target: 106,
    createdAt: T0, entryDeadline: T0 + 120 * M, flatAt: null,
};

describe('simulateBracket — entries (REQ-SIM-002, pessimistic by construction)', () => {
    test('LMT fills only when a bar trades THROUGH the limit (strict), at the limit price, never before the creation bar', () => {
        const touch = [bar(0, 101, 102, 100, 101), bar(1, 101, 102, 100, 101)]; // low == limit: a touch, not a trade-through
        expect(simulateBracket(touch, base).outcome).toBe('unfilled');
        const through = [bar(1, 101, 102, 99.9, 101), bar(2, 101, 103, 100.5, 102)];
        const r = simulateBracket(through, base);
        expect(r.fillPrice).toBe(100);
        expect(r.fillAt).toBe(T0 + 1 * M);
        // the creation bar itself never fills (t must be AFTER createdAt)
        const creationBarOnly = [bar(0, 101, 102, 99, 101)];
        expect(simulateBracket(creationBarOnly, base).outcome).toBe('unfilled');
    });

    test('MKT fills at the NEXT bar open after creation', () => {
        const r = simulateBracket([bar(0, 100, 101, 99, 100.5), bar(1, 100.7, 101, 100, 100.9)], { ...base, entryType: 'MKT', entry: null });
        expect(r.fillAt).toBe(T0 + 1 * M);
        expect(r.fillPrice).toBe(100.7);
    });

    test('STP_LMT: trigger touched and price inside the band → fills at the LIMIT (worst permitted); a gap past the band waits for a trade back into it', () => {
        const spec: SimSpec = { ...base, entryType: 'STP_LMT', entry: 101, entryLimit: 101.4 };
        const crossedWithin = [bar(1, 100.5, 101.2, 100.4, 101.1), bar(2, 101, 101.5, 100.9, 101.3)];
        const a = simulateBracket(crossedWithin, spec);
        expect(a.fillAt).toBe(T0 + 1 * M);
        expect(a.fillPrice).toBe(101.4);
        const gapBeyond = [bar(1, 102, 102.5, 101.8, 102.2), bar(2, 102, 102.2, 101.3, 101.5)];
        const b = simulateBracket(gapBeyond, spec);
        expect(b.fillAt).toBe(T0 + 2 * M); // trades back into the band on bar 2
        expect(b.fillPrice).toBe(101.4);
    });

    test('an entry that never fills before the deadline is unfilled', () => {
        const bars = [bar(1, 101, 102, 100.5, 101), bar(200, 101, 102, 99, 100)]; // the through-trade comes after the deadline
        expect(simulateBracket(bars, base).outcome).toBe('unfilled');
    });
});

describe('simulateBracket — exits', () => {
    const filled = [bar(1, 101, 101.5, 99.5, 100.2)]; // fills at 100 on bar 1

    test('target needs a strict trade-through; a touch is not a fill', () => {
        expect(simulateBracket([...filled, bar(2, 100.5, 106, 100.4, 105.9)], base).outcome).toBe('open');
        const r = simulateBracket([...filled, bar(2, 100.5, 106.01, 100.4, 105.9)], base);
        expect(r.outcome).toBe('target');
        expect(r.exitPrice).toBe(106);
    });

    test('stop fills at the stop, or at the OPEN when the bar gaps through it (gap-aware)', () => {
        const touch = simulateBracket([...filled, bar(2, 99, 99.5, 97, 98)], base);
        expect(touch.outcome).toBe('stop');
        expect(touch.exitPrice).toBe(97);
        const gap = simulateBracket([...filled, bar(2, 95, 96, 94, 95.5)], base);
        expect(gap.outcome).toBe('stop');
        expect(gap.exitPrice).toBe(95); // worse than the stop — the open
    });

    test('stop and target in one bar → STOP (ties never flatter the sim)', () => {
        const r = simulateBracket([...filled, bar(2, 100, 107, 96, 101)], base);
        expect(r.outcome).toBe('stop');
    });

    test('the fill bar itself can resolve the exit', () => {
        const r = simulateBracket([bar(1, 101, 101.5, 96.5, 97)], base); // fills at 100, then trades through the stop
        expect(r.outcome).toBe('stop');
        expect(r.fillAt).toBe(r.exitAt);
    });

    test('DAY rows still open at the flat-at bar close there as eod-flat; GTC rows stay open when bars run out', () => {
        const flatAt = T0 + 5 * M;
        const bars = [...filled, bar(2, 100.2, 100.8, 100, 100.5), bar(5, 100.6, 100.9, 100.3, 100.7), bar(6, 100.7, 101, 100.5, 100.9)];
        const day = simulateBracket(bars, { ...base, flatAt });
        expect(day.outcome).toBe('eod-flat');
        expect(day.exitAt).toBe(flatAt);
        expect(day.exitPrice).toBe(100.7);
        const gtc = simulateBracket(bars, { ...base, flatAt: null });
        expect(gtc.outcome).toBe('open');
    });

    test('MFE/MAE are measured from the fill through the exit bar', () => {
        const r = simulateBracket([...filled, bar(2, 100.5, 103, 98.5, 99), bar(3, 99, 99.5, 96.9, 97)], base);
        expect(r.outcome).toBe('stop');
        expect(r.mfePct).toBeCloseTo(3, 5);   // 103 vs 100
        expect(r.maePct).toBeCloseTo(3.1, 5); // 96.9 vs 100
    });

    test('short side mirrors: LMT fills when a bar trades through ABOVE, target below, stop above', () => {
        const short: SimSpec = { ...base, direction: 'short', entry: 100, stop: 103, target: 94 };
        const r = simulateBracket([bar(1, 99.5, 100.1, 99, 99.8), bar(2, 99.5, 99.8, 93.9, 94.2)], short);
        expect(r.fillPrice).toBe(100);
        expect(r.outcome).toBe('target');
        expect(r.exitPrice).toBe(94);
    });
});

describe('simulateBracket — ratchet exit (exit-ratchet variant, REQ-EXIT-008 geometry)', () => {
    const ratchet: SimSpec = { ...base, target: null, ratchet: { armPct: 6, lockPct: 5, trailAbs: 1.5 } };
    const filled = [bar(1, 101, 101.5, 99.5, 100.2)];

    test('unarmed: only the original stop can exit', () => {
        const r = simulateBracket([...filled, bar(2, 100.5, 104, 100, 103), bar(3, 103, 103.5, 96.9, 97)], ratchet);
        expect(r.outcome).toBe('stop');
        expect(r.exitPrice).toBe(97);
    });

    test('armed at +x%: the stop ratchets to max(lock, peak − trail); the pullback exit is a target when above the fill', () => {
        // peak 108 → trail stop 106.5 > lock 105 → exits when low ≤ 106.5
        const r = simulateBracket([...filled, bar(2, 100.5, 106.2, 100.4, 106), bar(3, 106.5, 108, 106.2, 107.5), bar(4, 107, 107.2, 106.3, 106.4)], ratchet);
        expect(r.outcome).toBe('target');
        expect(r.exitPrice).toBe(106.5);
        expect(r.exitAt).toBe(T0 + 4 * M);
    });

    test('the lock floor holds when the trail would sit below it', () => {
        // peak 106.3 → trail 104.8 < lock 105 → stop = 105
        const r = simulateBracket([...filled, bar(2, 100.5, 106.3, 100.4, 106), bar(3, 105.5, 105.8, 104.9, 105.2)], ratchet);
        expect(r.outcome).toBe('target');
        expect(r.exitPrice).toBe(105);
    });
});

describe('commissions and R', () => {
    test('per side max(min, qty × per-share); two sides when exited, one when unfilled-never (zero)', () => {
        const cfg = { perShareUsd: 0.005, minUsd: 1 };
        expect(commissionsFor(10, 2, cfg)).toBe(2);          // 2 × max(1, 0.05)
        expect(commissionsFor(400, 2, cfg)).toBe(4);         // 2 × 2.00
        expect(commissionsFor(400, 1, cfg)).toBe(2);
        expect(commissionsFor(400, 0, cfg)).toBe(0);
    });

    test('netR divides net USD by the planned risk (|entry − stop| × qty); zero risk → null', () => {
        expect(netR({ netUsd: 60, entry: 100, stop: 97, quantity: 10 })).toBeCloseTo(2, 6);
        expect(netR({ netUsd: -30, entry: 100, stop: 97, quantity: 10 })).toBeCloseTo(-1, 6);
        expect(netR({ netUsd: 5, entry: 100, stop: 100, quantity: 10 })).toBeNull();
        expect(netR({ netUsd: 5, entry: 100, stop: 97, quantity: 0 })).toBeNull();
    });
});
