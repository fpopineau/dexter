import { describe, expect, test } from 'bun:test';
import { computeDayMetrics, formatMoverLine, replayBracket, type FunnelStage } from './benchmark.js';
import { classifyRefusalGate } from './trade-proposals.js';

describe('computeDayMetrics — gap vs intraday split', () => {
    test('a gapper: +15% day of which +10% gap → only +4.5% was capturable', () => {
        const m = computeDayMetrics(100, 110, 116, 108, 115)!;
        expect(m.dayPct).toBe(15);
        expect(m.gapPct).toBe(10);
        expect(m.intradayPct).toBeCloseTo(4.55, 2);
    });

    test('a grinder: flat open, all intraday', () => {
        const m = computeDayMetrics(100, 100.5, 113, 100, 112)!;
        expect(m.gapPct).toBe(0.5);
        expect(m.intradayPct).toBeCloseTo(11.44, 2);
    });

    test('bad inputs → null', () => {
        expect(computeDayMetrics(0, 10, 11, 9, 10)).toBeNull();
    });
});

describe('replayBracket — counterfactual refusal replay', () => {
    const bars = (specs: Array<[number, number]>) => specs.map(([high, low]) => ({ high, low }));

    test('long LMT: fills on the dip, then target first → target', () => {
        expect(replayBracket(
            bars([[101, 99.8], [102, 100.2], [105.2, 101]]),
            'long', 'LMT', 100, 97, 105,
        )).toBe('target');
    });

    test('long LMT: fills, then stop first → stop', () => {
        expect(replayBracket(
            bars([[101, 99.8], [100.5, 96.9]]),
            'long', 'LMT', 100, 97, 105,
        )).toBe('stop');
    });

    test('stop AND target inside one bar → STOP (pessimistic, never flatter)', () => {
        expect(replayBracket(
            bars([[101, 99.8], [105.5, 96.5]]),
            'long', 'LMT', 100, 97, 105,
        )).toBe('stop');
    });

    test('price never reaches the limit → unfilled', () => {
        expect(replayBracket(
            bars([[104, 101], [106, 102]]),
            'long', 'LMT', 100, 97, 105,
        )).toBe('unfilled');
    });

    test('fills but neither exit touches → open', () => {
        expect(replayBracket(
            bars([[101, 99.5], [102, 100]]),
            'long', 'LMT', 100, 97, 105,
        )).toBe('open');
    });

    test('STP_LMT momentum entry triggers on strength (long: high ≥ trigger)', () => {
        expect(replayBracket(
            bars([[99.5, 98], [100.6, 99], [104.9, 100], [105.3, 103]]),
            'long', 'STP_LMT', 100.5, 98, 105,
        )).toBe('target');
    });

    test('the fill bar itself can resolve the exit', () => {
        // Same bar dips to the limit and to the stop → stop.
        expect(replayBracket(
            bars([[100.5, 96.5]]),
            'long', 'LMT', 100, 97, 105,
        )).toBe('stop');
    });

    test('short mirror: fills on the bounce, breakdown hits target', () => {
        expect(replayBracket(
            bars([[100.2, 98], [99, 94.8]]),
            'short', 'LMT', 100, 103, 95,
        )).toBe('target');
    });

    test('MKT fills on the first bar', () => {
        expect(replayBracket(
            bars([[105.1, 100]]),
            'long', 'MKT', 100, 97, 105,
        )).toBe('target');
    });
});

describe('classifyRefusalGate', () => {
    test('maps the live refusal messages to gate labels', () => {
        expect(classifyRefusalGate('stop is $1.54 from entry — inside intraday noise for a stock with daily ATR…')).toBe('noise-stop');
        expect(classifyRefusalGate('entry $434 is 3.7× daily ATR above the 10-day EMA — chasing an extended move')).toBe('extension');
        expect(classifyRefusalGate('risk/reward 1.6:1 is below the minimum 2:1')).toBe('risk-reward');
        expect(classifyRefusalGate('duplicate setup — P-CDAD already has a working bracket at 303')).toBe('duplicate');
        expect(classifyRefusalGate('sizer refused: one share at $1390 exceeds the 20% position cap — the account cannot afford this symbol')).toBe('unaffordable');
        expect(classifyRefusalGate('sizer refused: confidence-weighted risk budget $13 is below the $15 account floor')).toBe('sizer-floor');
        expect(classifyRefusalGate('a stop-out would cost $5000 — over the 0.25% risk budget')).toBe('risk-budget');
        expect(classifyRefusalGate('10 positions already open — max 10')).toBe('max-positions');
        expect(classifyRefusalGate('something novel')).toBe('other');
    });
});

describe('formatMoverLine', () => {
    const metrics = computeDayMetrics(100, 110, 118, 108, 115)!;
    const base: FunnelStage = { seen: false, maxRank: null, triggered: false, proposed: false, refusedBy: [], executed: false, realizedPnl: null, capturePct: null };

    test('never seen is loud', () => {
        expect(formatMoverLine('ARM', metrics, base)).toContain('NEVER SEEN');
    });

    test('seen-but-never-triggered shows the max rank (threshold calibration)', () => {
        const line = formatMoverLine('SNAP', metrics, { ...base, seen: true, maxRank: 68 });
        expect(line).toContain('max rank 68');
        expect(line).toContain('never triggered');
    });

    test('executed shows P&L and capture efficiency', () => {
        const line = formatMoverLine('PLTR', metrics, { ...base, seen: true, triggered: true, proposed: true, executed: true, realizedPnl: 235.76, capturePct: 24 });
        expect(line).toContain('EXECUTED');
        expect(line).toContain('+$236');
        expect(line).toContain('captured 24%');
    });

    test('refused names the gates', () => {
        const line = formatMoverLine('SNDK', metrics, { ...base, seen: true, triggered: true, refusedBy: ['unaffordable', 'unaffordable'] });
        expect(line).toContain('refused: unaffordable');
        expect(line).not.toContain('unaffordable, unaffordable'); // deduped
    });
});
