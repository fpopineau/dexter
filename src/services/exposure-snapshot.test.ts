import { describe, expect, test } from 'bun:test';
import { unionExposure } from './exposure-snapshot.js';

// WP4 (REMEDIATION-2026-08-20): caps read proposal rows only — a manual
// TWS position was invisible to every limit. The union takes MAX per
// symbol so whichever side believes there is more exposure wins.

describe('unionExposure', () => {
    test('a broker-only position becomes visible (the audit case)', () => {
        const u = unionExposure(
            [{ symbol: 'NVDA', quantity: 10, valueUsd: 1_000 }],
            [{ symbol: 'TSLA', quantity: 20, avgCost: 250 }],
        );
        expect(u.distinctSymbols).toBe(2);
        expect(u.notionalBySymbol.get('TSLA')).toBe(5_000);
        expect(u.brokerOnlySymbols).toEqual(['TSLA']);
    });

    test('agreement does not double-count: MAX per symbol, not sum', () => {
        const u = unionExposure(
            [{ symbol: 'NVDA', quantity: 10, valueUsd: 1_000 }],
            [{ symbol: 'NVDA', quantity: 10, avgCost: 100 }],
        );
        expect(u.notionalBySymbol.get('NVDA')).toBe(1_000);
        expect(u.distinctSymbols).toBe(1);
        expect(u.brokerOnlySymbols).toEqual([]);
    });

    test('the larger side wins in either direction', () => {
        const u = unionExposure(
            [{ symbol: 'AMD', quantity: 5, valueUsd: 500 }, { symbol: 'MU', quantity: 30, valueUsd: 3_000 }],
            [{ symbol: 'AMD', quantity: 12, avgCost: 100 }, { symbol: 'MU', quantity: 10, avgCost: 100 }],
        );
        expect(u.notionalBySymbol.get('AMD')).toBe(1_200); // broker bigger
        expect(u.notionalBySymbol.get('MU')).toBe(3_000); // DB bigger
    });

    test('stacked DB rows on one symbol SUM on the DB side before the max', () => {
        const u = unionExposure(
            [{ symbol: 'NVDA', quantity: 5, valueUsd: 500 }, { symbol: 'NVDA', quantity: 5, valueUsd: 500 }],
            [{ symbol: 'NVDA', quantity: 10, avgCost: 90 }],
        );
        expect(u.notionalBySymbol.get('NVDA')).toBe(1_000);
    });

    test('shorts count by absolute notional; flat broker rows are ignored', () => {
        const u = unionExposure([], [
            { symbol: 'SHRT', quantity: -20, avgCost: 50 },
            { symbol: 'FLAT', quantity: 0, avgCost: 10 },
        ]);
        expect(u.notionalBySymbol.get('SHRT')).toBe(1_000);
        expect(u.distinctSymbols).toBe(1);
    });
});
