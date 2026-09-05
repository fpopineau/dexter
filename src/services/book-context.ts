/**
 * Book context (REQ-SIZE-001/006, WP6) — the pure sums over the open book
 * that BOTH the creation-time sizer/gate and the acceptance-time gate read:
 *
 *   open positions, per-class counts, the notional already committed to
 *   the same symbol, the planned stop-out risk of the open book (with the
 *   rows that cannot be priced LISTED — never counted as zero), the
 *   overnight book's notional and its CLASS-AWARE stressed loss, and the
 *   notional already committed to the same sector.
 *
 * The valuer is injected: creation prices rows at the worst entry basis
 * (no broker call), acceptance at max(basis, broker mark). Adopted rows may
 * carry a verified risk override (their synthetic stop is bookkeeping, not
 * protection). Sharing this module is what keeps the two paths from
 * drifting in formula (AUD-06).
 */

import type { RiskRules, TradeClass } from '@/tools/ibkr/risk-rules.js';
import { plannedWorstLossUsd } from './proposal-risk-gate.js';

export interface BookRow {
    id: string;
    symbol: string;
    source: string;
    quantity: number;
    entry: number | null;
    entryLimit: number | null;
    entryFillPrice: number | null;
    stop: number;
    tif: 'DAY' | 'GTC';
    tradeClass: TradeClass;
    worstCaseGapPct: number | null;
    strategyId?: string | null;
}

export interface UnpriceableRow {
    id: string;
    symbol: string;
    kind: 'no-basis' | 'adopted-unverified';
}

export interface BookContext {
    openPositions: number;
    openSwing: number;
    openEarningsBets: number;
    openOvernightLane: number;
    existingSymbolExposureUsd: number;
    /** Planned stop-out risk of the PRICEABLE rows; see `unpriceableRows`. */
    openPlannedRiskUsd: number;
    unpriceableRows: UnpriceableRow[];
    /** Notional of rows that survive the close (GTC, incl. kept holds). */
    overnightExposureUsd: number;
    /** Class-aware stressed loss of that book (bets at their own gap). */
    overnightStressedLossUsd: number;
    /** Same-sector notional; null when sectors are unknown to the caller. */
    sameSectorExposureUsd: number | null;
    sector: string | null;
}

export interface BookContextInput<T extends BookRow> {
    /** Working + filled rows (executing/executed), EXCLUDING the proposal under evaluation. */
    rows: T[];
    symbol: string;
    rules: RiskRules;
    /** Notional valuer (creation: worst entry basis; acceptance: marked). */
    valueOf: (t: T) => number;
    /** This proposal's sector ('UNKNOWN' bucket allowed); null = unknown to the caller. */
    sector?: string | null;
    /** symbol (upper-case) → sector for the rows; null = the caller resolved no sectors. */
    sectorOf?: Map<string, string> | null;
    /** Verified risk for adopted rows; undefined = not verified (listed unpriceable). */
    adoptedRiskUsd?: Map<string, number>;
}

/** The gap a GTC row is stressed at: bets at max(base stress, their own record/floor). */
export function rowStressPct(t: { tradeClass: TradeClass; worstCaseGapPct: number | null }, rules: RiskRules): number {
    const base = rules.overnight_gap_stress_pct;
    return t.tradeClass === 'earnings-bet'
        ? Math.max(base, Math.max(t.worstCaseGapPct ?? 0, rules.earnings_bet_gap_floor_pct))
        : base;
}

export function buildBookContext<T extends BookRow>(input: BookContextInput<T>): BookContext {
    const sym = input.symbol.toUpperCase();
    const rows = input.rows;
    const unpriceableRows: UnpriceableRow[] = [];
    let openPlannedRiskUsd = 0;
    let existingSymbolExposureUsd = 0;
    let overnightExposureUsd = 0;
    let overnightStressedLossUsd = 0;
    let sameSector = 0;
    let openSwing = 0, openEarningsBets = 0, openOvernightLane = 0;
    const sectorKnown = input.sector != null && input.sectorOf != null;

    for (const t of rows) {
        const value = input.valueOf(t);
        if (t.tradeClass === 'swing') openSwing++;
        if (t.tradeClass === 'earnings-bet') openEarningsBets++;
        if (t.strategyId === 'overnight') openOvernightLane++;
        if (t.symbol.toUpperCase() === sym) existingSymbolExposureUsd += value;
        if (t.source === 'adopted') {
            const verified = input.adoptedRiskUsd?.get(t.symbol.toUpperCase());
            if (verified === undefined) unpriceableRows.push({ id: t.id, symbol: t.symbol, kind: 'adopted-unverified' });
            else openPlannedRiskUsd += verified;
        } else {
            const usd = plannedWorstLossUsd(t, input.rules);
            if (usd === null) unpriceableRows.push({ id: t.id, symbol: t.symbol, kind: 'no-basis' });
            else openPlannedRiskUsd += usd;
        }
        if (t.tif === 'GTC') {
            overnightExposureUsd += value;
            overnightStressedLossUsd += value * (rowStressPct(t, input.rules) / 100);
        }
        if (sectorKnown && input.sectorOf!.get(t.symbol.toUpperCase()) === input.sector) sameSector += value;
    }
    const r2 = (n: number) => Math.round(n * 100) / 100;
    return {
        openPositions: rows.length,
        openSwing,
        openEarningsBets,
        openOvernightLane,
        existingSymbolExposureUsd: r2(existingSymbolExposureUsd),
        openPlannedRiskUsd: r2(openPlannedRiskUsd),
        unpriceableRows,
        overnightExposureUsd: r2(overnightExposureUsd),
        overnightStressedLossUsd: r2(overnightStressedLossUsd),
        sameSectorExposureUsd: sectorKnown ? r2(sameSector) : null,
        sector: input.sector ?? null,
    };
}
