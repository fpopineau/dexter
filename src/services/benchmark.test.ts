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
    const bars = (specs: Array<[number, number, number]>) => specs.map(([open, high, low]) => ({ open, high, low }));

    test('long LMT: fills on the dip, then target first → target', () => {
        const r = replayBracket(
            bars([[100.5, 101, 99.8], [101, 102, 100.2], [102, 105.2, 101]]),
            'long', 'LMT', 100, 97, 105,
        );
        expect(r.outcome).toBe('target');
        expect(r.fillBar).toBe(0);
    });

    test('long LMT: fills, then stop first → stop', () => {
        expect(replayBracket(
            bars([[100.5, 101, 99.8], [100, 100.5, 96.9]]),
            'long', 'LMT', 100, 97, 105,
        ).outcome).toBe('stop');
    });

    test('stop AND target inside one bar → STOP (pessimistic, never flatter)', () => {
        expect(replayBracket(
            bars([[100.5, 101, 99.8], [100, 105.5, 96.5]]),
            'long', 'LMT', 100, 97, 105,
        ).outcome).toBe('stop');
    });

    test('price never reaches the limit → unfilled', () => {
        const r = replayBracket(
            bars([[102, 104, 101], [103, 106, 102]]),
            'long', 'LMT', 100, 97, 105,
        );
        expect(r.outcome).toBe('unfilled');
        expect(r.fillBar).toBeNull();
        expect(r.mfePct).toBeNull();
    });

    test('fills but neither exit touches → open', () => {
        expect(replayBracket(
            bars([[100.2, 101, 99.5], [100.5, 102, 100]]),
            'long', 'LMT', 100, 97, 105,
        ).outcome).toBe('open');
    });

    test('STP_LMT crossed from within the bar → filled (legacy touch-fill without a limit)', () => {
        const r = replayBracket(
            bars([[99, 99.5, 98], [99.2, 100.6, 99], [100.5, 104.9, 100], [104, 105.3, 103]]),
            'long', 'STP_LMT', 100.5, 98, 105,
        );
        expect(r.outcome).toBe('target');
        expect(r.triggered).toBe(true);
        expect(r.fillBar).toBe(1);
    });

    test('STP_LMT limit band: violent bar opens beyond the limit and never returns → triggered but UNFILLED', () => {
        // The SMCI-critique case: the stop triggers into a vertical move,
        // the buy limit at 100.8 is left behind, price runs to the target
        // without us. The old touch-fill model scored this a WIN.
        const r = replayBracket(
            bars([[101.5, 103, 101.2], [103, 105.5, 102.8]]),
            'long', 'STP_LMT', 100.5, 98, 105, 100.8,
        );
        expect(r.outcome).toBe('unfilled');
        expect(r.triggered).toBe(true);
        expect(r.fillBar).toBeNull();
    });

    test('STP_LMT limit band: opens inside the band → marketable at the open, filled', () => {
        const r = replayBracket(
            bars([[100.6, 101, 100.4], [101, 105.2, 100.9]]),
            'long', 'STP_LMT', 100.5, 98, 105, 100.8,
        );
        expect(r.outcome).toBe('target');
        expect(r.fillBar).toBe(0);
    });

    test('STP_LMT limit band: triggered above the band, a later dip into the band fills the resting limit', () => {
        const r = replayBracket(
            bars([[101.5, 102, 101.2], [101.4, 101.8, 100.7], [101, 105.2, 100.9]]),
            'long', 'STP_LMT', 100.5, 98, 105, 100.8,
        );
        expect(r.outcome).toBe('target');
        expect(r.fillBar).toBe(1); // the dip bar, not the trigger bar
    });

    test('the fill bar itself can resolve the exit', () => {
        // Same bar dips to the limit and to the stop → stop.
        expect(replayBracket(
            bars([[100.2, 100.5, 96.5]]),
            'long', 'LMT', 100, 97, 105,
        ).outcome).toBe('stop');
    });

    test('short mirror: fills on the bounce, breakdown hits target', () => {
        expect(replayBracket(
            bars([[99, 100.2, 98], [99.5, 99, 94.8]]),
            'short', 'LMT', 100, 103, 95,
        ).outcome).toBe('target');
    });

    test('short STP_LMT band: gap through the band → triggered but unfilled', () => {
        // Sell stop 100, limit 99.7: the bar opens at 99.2, already below
        // the limit — the resting sell limit needs a bounce to 99.7 that
        // never comes.
        const r = replayBracket(
            bars([[99.2, 99.4, 96], [96, 96.5, 94.8]]),
            'short', 'STP_LMT', 100, 103, 95, 99.7,
        );
        expect(r.outcome).toBe('unfilled');
        expect(r.triggered).toBe(true);
    });

    test('MKT fills on the first bar', () => {
        const r = replayBracket(
            bars([[100, 105.1, 100]]),
            'long', 'MKT', 100, 97, 105,
        );
        expect(r.outcome).toBe('target');
        expect(r.fillBar).toBe(0);
    });

    test('MFE/MAE: excursions tracked from the fill bar through the exit bar, % of entry', () => {
        // Fill at 100, dip to 99.5 (MAE 0.5%), grind up, exit bar tops 105.2
        // (MFE 5.2% — exit bar included; bar-resolution approximation).
        const r = replayBracket(
            bars([[100.3, 100.8, 99.5], [100.5, 103, 100.2], [102.8, 105.2, 102.5]]),
            'long', 'LMT', 100, 97, 105,
        );
        expect(r.outcome).toBe('target');
        expect(r.maePct).toBeCloseTo(0.5, 2);
        expect(r.mfePct).toBeCloseTo(5.2, 2);
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
        // Acceptance-time chase gate (checkPriceRun) — recorded since 2026-08-13.
        expect(classifyRefusalGate('[chase-gate] price has run: last 36.75 vs entry 35.91 — already past 25% of the way to target 37.31 (chasing). On a runner…')).toBe('chase');
        expect(classifyRefusalGate('[chase-gate] setup invalidated: last 34.9 is at/through the stop 35.21. The setup is dead at these levels…')).toBe('invalidated');
        expect(classifyRefusalGate('something novel')).toBe('other');
    });
});

describe('formatMoverLine', () => {
    const metrics = computeDayMetrics(100, 110, 118, 108, 115)!;
    const base: FunnelStage = { seen: false, maxRank: null, triggered: false, proposed: false, refusedBy: [], executed: false, placedUnfilled: false, entryPlaced: null, realizedPnl: null, capturePct: null };

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

    test('catalyst tags render, absence stays clean', () => {
        expect(formatMoverLine('SNDK', metrics, base, 'earnings')).toContain('📅 earnings');
        expect(formatMoverLine('SNDK', metrics, base, 'earnings-pending')).toContain('📅 reports soon');
        expect(formatMoverLine('PLTR', metrics, base, null)).not.toContain('📅');
    });

    test('refused names the gates', () => {
        const line = formatMoverLine('SNDK', metrics, { ...base, seen: true, triggered: true, refusedBy: ['unaffordable', 'unaffordable'] });
        expect(line).toContain('refused: unaffordable');
        expect(line).not.toContain('unaffordable, unaffordable'); // deduped
    });
});

describe('formatMoverLine — an accepted order that never filled is not an execution (2026-09-08 INTC)', () => {
    test('placed-unfilled reads as "NEVER FILLED — no position" with the entry vs the day range, and never as EXECUTED pnl $0', () => {
        const metrics = computeDayMetrics(95.8, 100.85, 106.09, 100.8, 105.5)!;
        const base: FunnelStage = { seen: true, maxRank: 93, triggered: true, proposed: true, refusedBy: ['noise-stop'], executed: false, placedUnfilled: true, entryPlaced: 99.3, realizedPnl: null, capturePct: null };
        const line = formatMoverLine('INTC', metrics, base);
        expect(line).toContain('entry placed, NEVER FILLED — no position (entry 99.3 vs day low 100.8 / high 106.09)');
        expect(line).not.toContain('EXECUTED');
        expect(line).not.toContain('refused'); // the placed order is the more informative stage
    });
});
