import { describe, expect, test } from 'bun:test';
import { DEFAULT_RULES, type RiskRules } from '@/tools/ibkr/risk-rules.js';
import { buildBookContext, type BookRow } from './book-context.js';
import { computeQuantity } from './position-sizer.js';
import { checkProposalRisk } from './proposal-risk-gate.js';

/**
 * REQ-SIZE-004: a proposal sized against the book context passes the risk
 * gate evaluated with the SAME context — the sizer and the gate share their
 * formulas (book-context.ts, lane-contract.ts, position-sizer.ts), so the
 * creation gate cannot refuse what the sizer just composed.
 */
const rules: RiskRules = {
    ...DEFAULT_RULES, max_position_pct: 15, max_open_positions: 4, max_daily_trades: 6, max_daily_loss_pct: 1.5, max_sector_exposure_pct: 35,
    max_overnight_position_pct: 15, max_overnight_exposure_pct: 30, overnight_gap_stress_pct: 20, swing_risk_pct: 0.75, max_risk_per_trade_pct: 0.5,
    max_adv_pct: 1.0, min_stop_atr_fraction: 0.4, max_target_atr: 1.5, take_atr_mult: 1.5, take_floor_pct: 3, take_cap_pct: 10,
};
const NETLIQ = 11_700;
const basis = (t: BookRow) => t.quantity * (t.entryFillPrice ?? Math.max(t.entry ?? 0, t.entryLimit ?? 0));

function openRow(over: Partial<BookRow> & { id: string }): BookRow {
    return { symbol: 'AMD', source: 'trigger', quantity: 5, entry: 200, entryLimit: null, entryFillPrice: 200, stop: 196, tif: 'DAY', tradeClass: 'intraday', worstCaseGapPct: null, strategyId: 'intraday', ...over };
}

describe('sizer ↔ gate parity (REQ-SIZE-004)', () => {
    test('intraday: a crowded book (same sector, planned risk, same symbol) — the sized quantity passes the gate with the same context', () => {
        const rows = [
            openRow({ id: 'A' }),                                     // AMD 5×200 = $1,000, risk $20, Technology
            openRow({ id: 'B', symbol: 'NVDA', quantity: 2, entry: 500, entryFillPrice: 500, stop: 490 }), // $1,000, risk $20
            openRow({ id: 'C', symbol: 'MU', quantity: 3, entry: 100, entryFillPrice: 100, stop: 97 }),    // same symbol as the proposal: $300, risk $9
        ];
        const sectorOf = new Map([['AMD', 'Technology'], ['NVDA', 'Technology'], ['MU', 'Technology']]);
        const book = buildBookContext({ rows, symbol: 'MU', rules, valueOf: basis, sector: 'Technology', sectorOf });
        const sized = computeQuantity({
            entry: 100, stop: 98, target: 106, score: 85, netLiquidation: NETLIQ, tradeClass: 'intraday', strategyId: 'intraday',
            book: {
                openPlannedRiskUsd: book.openPlannedRiskUsd, realizedLossTodayUsd: -20, existingSymbolExposureUsd: book.existingSymbolExposureUsd,
                overnightExposureUsd: book.overnightExposureUsd, overnightStressedLossUsd: book.overnightStressedLossUsd,
                sameSectorExposureUsd: book.sameSectorExposureUsd, avgDailyVolume20d: 2_000_000, spreadPct: 0.05,
            },
        }, rules, 0.5);
        expect(sized.quantity).not.toBeNull();
        expect(sized.binding).toBeDefined();
        const gate = checkProposalRisk(
            { symbol: 'MU', direction: 'long', entryType: 'LMT', entry: 100, stop: 98, target: 106, quantity: sized.quantity!, tradeClass: 'intraday', tif: 'DAY' },
            {
                netLiquidation: NETLIQ, openPositions: book.openPositions, executedToday: 2, existingSymbolExposure: book.existingSymbolExposureUsd,
                openPlannedRiskUsd: book.openPlannedRiskUsd, realizedLossTodayUsd: -20, overnightExposureUsd: book.overnightExposureUsd,
                overnightStressedLossUsd: book.overnightStressedLossUsd, sector: 'Technology', sameSectorExposureUsd: book.sameSectorExposureUsd ?? 0,
                dailyAtr: 4, rungPct: 0.5,
            },
            rules,
        );
        expect(gate.violations).toEqual([]);
        // and one share MORE than the sizer allowed is refused by the gate on the binding cap
        const over = checkProposalRisk(
            { symbol: 'MU', direction: 'long', entryType: 'LMT', entry: 100, stop: 98, target: 106, quantity: sized.quantity! + 1, tradeClass: 'intraday', tif: 'DAY' },
            { netLiquidation: NETLIQ, openPositions: book.openPositions, executedToday: 2, existingSymbolExposure: book.existingSymbolExposureUsd, openPlannedRiskUsd: book.openPlannedRiskUsd, realizedLossTodayUsd: -20, sector: 'Technology', sameSectorExposureUsd: book.sameSectorExposureUsd ?? 0, dailyAtr: 4, rungPct: 0.5 },
            rules,
        );
        expect(over.violations.length).toBeGreaterThan(0);
    });

    test('swing class GTC: the stress-composed quantity passes the acceptance-time overnight checks with the same book', () => {
        const rows = [openRow({ id: 'S', symbol: 'AMD', tif: 'GTC', tradeClass: 'swing', strategyId: 'swing', quantity: 3, entry: 200, entryFillPrice: 200, stop: 190 })]; // $600, stress $120
        const book = buildBookContext({ rows, symbol: 'MU', rules, valueOf: basis, sector: 'Technology', sectorOf: new Map([['AMD', 'Technology']]) });
        const sized = computeQuantity({
            entry: 100, stop: 95, target: 112, score: 85, netLiquidation: NETLIQ, tradeClass: 'swing', strategyId: 'swing',
            book: { openPlannedRiskUsd: book.openPlannedRiskUsd, overnightExposureUsd: book.overnightExposureUsd, overnightStressedLossUsd: book.overnightStressedLossUsd, sameSectorExposureUsd: book.sameSectorExposureUsd, spreadPct: 0.05 },
        }, rules, 0.5);
        expect(sized.quantity).not.toBeNull();
        expect(sized.binding).toBe('overnight');
        const gate = checkProposalRisk(
            { symbol: 'MU', direction: 'long', entryType: 'LMT', entry: 100, stop: 95, target: 112, quantity: sized.quantity!, tradeClass: 'swing', tif: 'GTC' },
            { netLiquidation: NETLIQ, openPositions: 1, executedToday: 0, openSwingPositions: 1, openPlannedRiskUsd: book.openPlannedRiskUsd, overnightExposureUsd: book.overnightExposureUsd, overnightStressedLossUsd: book.overnightStressedLossUsd, sector: 'Technology', sameSectorExposureUsd: book.sameSectorExposureUsd ?? 0, dailyAtr: 4, rungPct: 0.5 },
            rules,
        );
        expect(gate.violations).toEqual([]);
    });
});
