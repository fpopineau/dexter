import { describe, expect, test } from 'bun:test';
import { classifyRegime, regimeThresholdAdjust, type RegimeInputs, type RegimeThresholds } from './market-regime.js';

const T: RegimeThresholds = { qqqSoloPct: 1.2, qqqPct: 0.75, tltPct: 0.4, spyPct: 0.6, semisSpreadPct: 0.5, cryptoPct: 3, cryptoSpreadPct: 2 };

const inputs = (qqq: number | null, spy: number | null, smh: number | null, tlt: number | null, ibit: number | null = null): RegimeInputs =>
    ({ qqqPct: qqq, spyPct: spy, smhPct: smh, tltPct: tlt, ibitPct: ibit });

describe('classifyRegime (the "yields drive chip selloff" morning, 2026-08-18)', () => {
    test('the headline tape: QQQ down with TLT confirming, SMH lagging → risk-off, semis-led, yield-driven', () => {
        const r = classifyRegime(inputs(-1.4, -0.9, -2.3, -0.8), T);
        expect(r.tag).toBe('risk-off');
        expect(r.semisLed).toBe(true);   // SMH − QQQ = −0.9, past the −0.5 spread
        expect(r.yieldDriven).toBe(true);
        expect(r.line).toContain('risk-off');
        expect(r.line).toContain('semis-led');
        expect(r.line).toContain('yield-driven');
        expect(r.line).toContain('QQQ -1.4%');
    });

    test('a big QQQ move needs no confirmation; a moderate one does', () => {
        expect(classifyRegime(inputs(-1.3, 0, 0, 0), T).tag).toBe('risk-off');       // solo
        expect(classifyRegime(inputs(-0.9, -0.2, 0, -0.1), T).tag).toBe('neutral');  // unconfirmed
        expect(classifyRegime(inputs(-0.9, -0.2, 0, -0.5), T).tag).toBe('risk-off'); // TLT confirms
        expect(classifyRegime(inputs(-0.9, -0.7, 0, -0.1), T).tag).toBe('risk-off'); // SPY confirms
    });

    test('risk-on mirrors, and never flags semis-led/yield-driven', () => {
        expect(classifyRegime(inputs(1.3, 0, 0, 0), T).tag).toBe('risk-on');
        expect(classifyRegime(inputs(0.9, 0.7, 0, 0), T).tag).toBe('risk-on');
        const r = classifyRegime(inputs(1.5, 0.8, 0.5, 0.5), T); // SMH lags a rally by 1.0
        expect(r.semisLed).toBe(false);
        expect(r.yieldDriven).toBe(false);
    });

    test('no QQQ → unknown, regardless of how loud the other proxies are', () => {
        const r = classifyRegime(inputs(null, -5, -5, -5), T);
        expect(r.tag).toBe('unknown');
        expect(r.line).toContain('TAPE unknown');
    });

    test('missing SMH/TLT degrade the flavor flags, not the tag', () => {
        const r = classifyRegime(inputs(-1.4, -0.9, null, null), T);
        expect(r.tag).toBe('risk-off');
        expect(r.semisLed).toBe(false);
        expect(r.yieldDriven).toBe(false);
    });
});

describe('crypto-led flavor (the COIN/MSTR morning, 2026-08-19)', () => {
    test('IBIT ripping while QQQ drifts → crypto-led rally, on any tag', () => {
        const r = classifyRegime(inputs(0.2, 0.1, 0, 0, 4.1), T);
        expect(r.tag).toBe('neutral');
        expect(r.cryptoLed).toBe(true);
        expect(r.line).toContain('crypto-led rally');
        expect(r.line).toContain('IBIT +4.1%');
    });

    test('a crypto rout flags with its direction', () => {
        const r = classifyRegime(inputs(-0.3, -0.2, 0, 0, -5.2), T);
        expect(r.cryptoLed).toBe(true);
        expect(r.line).toContain('crypto-led rout');
    });

    test('IBIT moving WITH the index is beta, not a crypto event', () => {
        expect(classifyRegime(inputs(3.5, 3.0, 0, 0, 4.0), T).cryptoLed).toBe(false); // spread 0.5 < 2
    });

    test('missing IBIT or missing QQQ → no crypto flavor from half-blind inputs', () => {
        expect(classifyRegime(inputs(0.2, 0, 0, 0, null), T).cryptoLed).toBe(false);
        expect(classifyRegime(inputs(null, 0, 0, 0, 6), T).cryptoLed).toBe(false);
    });
});

describe('regimeThresholdAdjust (the defensive tilt)', () => {
    test('risk-off raises the bar for longs and lowers it for shorts', () => {
        expect(regimeThresholdAdjust('risk-off', 'long', 10, 10)).toBe(10);
        expect(regimeThresholdAdjust('risk-off', 'short', 10, 10)).toBe(-10);
    });

    test('every other tape — including unknown — applies zero tilt', () => {
        for (const tag of ['neutral', 'risk-on', 'unknown'] as const) {
            expect(regimeThresholdAdjust(tag, 'long', 10, 10)).toBe(0);
            expect(regimeThresholdAdjust(tag, 'short', 10, 10)).toBe(0);
        }
    });
});
