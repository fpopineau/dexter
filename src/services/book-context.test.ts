import { describe, expect, test } from 'bun:test';
import { DEFAULT_RULES, type RiskRules } from '@/tools/ibkr/risk-rules.js';
import { buildBookContext, rowStressPct, type BookRow } from './book-context.js';

const rules: RiskRules = { ...DEFAULT_RULES, overnight_gap_stress_pct: 20, earnings_bet_gap_floor_pct: 20 };

function row(over: Partial<BookRow> & { id: string }): BookRow {
    return { symbol: 'MU', source: 'trigger', quantity: 10, entry: 100, entryLimit: null, entryFillPrice: null, stop: 97, tif: 'DAY', tradeClass: 'intraday', worstCaseGapPct: null, strategyId: 'intraday', ...over };
}
const basis = (t: BookRow) => t.quantity * (t.entryFillPrice ?? Math.max(t.entry ?? 0, t.entryLimit ?? 0));

describe('buildBookContext (REQ-SIZE-001/006 — the sums both paths share)', () => {
    test('counts, symbol aggregate, planned risk, overnight notional + class-aware stress, sector', () => {
        const rows: BookRow[] = [
            row({ id: 'A', symbol: 'MU', entryFillPrice: 101 }),                                           // filled intraday MU: risk 10×4=40, value 1010
            row({ id: 'B', symbol: 'AMD', tif: 'GTC', tradeClass: 'swing', strategyId: 'swing', quantity: 5, entry: 200, stop: 190 }), // GTC swing: value 1000, stress 200, risk 50
            row({ id: 'C', symbol: 'NVDA', tif: 'GTC', tradeClass: 'earnings-bet', strategyId: 'earnings-bet', quantity: 2, entry: 500, stop: 480, worstCaseGapPct: 35 }), // bet: value 1000, stress at 35% = 350, risk = gap 2×500×0.35 = 350
            row({ id: 'D', symbol: 'SOXL', tif: 'GTC', tradeClass: 'swing', strategyId: 'overnight', quantity: 3, entry: 50, entryLimit: 52, stop: 47 }), // overnight lane, worst basis 52: value 156, stress 31.2, risk 3×5=15
        ];
        const sectorOf = new Map([['MU', 'Technology'], ['AMD', 'Technology'], ['NVDA', 'Technology'], ['SOXL', 'UNKNOWN']]);
        const b = buildBookContext({ rows, symbol: 'mu', rules, valueOf: basis, sector: 'Technology', sectorOf });
        expect(b.openPositions).toBe(4);
        expect(b.openSwing).toBe(2);
        expect(b.openEarningsBets).toBe(1);
        expect(b.openOvernightLane).toBe(1);
        expect(b.existingSymbolExposureUsd).toBe(1010);
        expect(b.openPlannedRiskUsd).toBeCloseTo(40 + 50 + 350 + 15, 6);
        expect(b.unpriceableRows).toEqual([]);
        expect(b.overnightExposureUsd).toBeCloseTo(1000 + 1000 + 156, 6);
        expect(b.overnightStressedLossUsd).toBeCloseTo(200 + 350 + 31.2, 6);
        expect(b.sameSectorExposureUsd).toBeCloseTo(1010 + 1000 + 1000, 6);
        expect(rowStressPct({ tradeClass: 'earnings-bet', worstCaseGapPct: 10 }, rules)).toBe(20); // floor wins
        expect(rowStressPct({ tradeClass: 'swing', worstCaseGapPct: null }, rules)).toBe(20);
    });

    test('unpriceable rows are LISTED, never zeroed: a MKT row without basis, an adopted row without verified risk; a verified adopted row counts its real risk', () => {
        const rows: BookRow[] = [
            row({ id: 'M', symbol: 'MKT1', entry: null, entryLimit: null, entryFillPrice: null }),
            row({ id: 'AD1', symbol: 'ADPT', source: 'adopted', entryFillPrice: 50, stop: 47.5, quantity: 10 }),
            row({ id: 'AD2', symbol: 'ADPU', source: 'adopted', entryFillPrice: 50, stop: 47.5, quantity: 10 }),
        ];
        const b = buildBookContext({ rows, symbol: 'X', rules, valueOf: basis, adoptedRiskUsd: new Map([['ADPT', 12.5]]) });
        expect(b.openPlannedRiskUsd).toBe(12.5);
        expect(b.unpriceableRows).toEqual([{ id: 'M', symbol: 'MKT1', kind: 'no-basis' }, { id: 'AD2', symbol: 'ADPU', kind: 'adopted-unverified' }]);
        expect(b.sameSectorExposureUsd).toBeNull(); // no sectors supplied
        expect(b.sector).toBeNull();
    });
});
