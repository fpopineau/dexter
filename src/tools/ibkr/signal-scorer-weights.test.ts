import { describe, expect, test } from 'bun:test';
import { DEFAULT_WEIGHTS, weightsSourceLabel } from './signal-scorer.js';

describe('weightsSourceLabel (weight provenance in every score)', () => {
    test('defaults are labeled as equal weights, no zero-factor noise', () => {
        const label = weightsSourceLabel({ weights: DEFAULT_WEIGHTS, source: 'defaults', calibratedAt: null });
        expect(label).toBe('defaults (equal weights)');
    });

    test('file weights carry the calibration date', () => {
        const label = weightsSourceLabel({
            weights: { momentum: 0.4, meanReversion: 0.3, volume: 0.2, trend: 0.1 },
            source: 'file',
            calibratedAt: '2026-08-11T00:00:00.000Z',
        });
        expect(label).toContain('scorer-weights.json');
        expect(label).toContain('calibrated 2026-08-11');
    });

    test('zeroed factors are called out by name — the 2026-07-07 silent-zero lesson', () => {
        const label = weightsSourceLabel({
            weights: { momentum: 0.75, meanReversion: 0.25, volume: 0, trend: 0 },
            source: 'file',
            calibratedAt: '2026-07-07T07:44:57.153Z',
        });
        expect(label).toContain('volume, trend weighted ZERO');
        expect(label).toContain('contribute nothing');
    });

    test('calibration overrides are labeled as such', () => {
        const label = weightsSourceLabel({ weights: DEFAULT_WEIGHTS, source: 'override', calibratedAt: null });
        expect(label).toContain('override');
    });

    test('a RESET file must not read as calibrated (WP0.2, audit 2026-08-20)', () => {
        // The live scorer-weights.json is a deliberate reset to equal
        // weights; printing "calibrated <date>" for it is an integrity leak
        // in the exact surface built to prevent one.
        const label = weightsSourceLabel({
            weights: DEFAULT_WEIGHTS,
            source: 'file',
            calibratedAt: '2026-08-11T00:00:00.000Z',
            reset: true,
        });
        expect(label).not.toContain('calibrated');
        expect(label).toContain('reset 2026-08-11');
        expect(label).toContain('awaiting recalibration');
    });
});
