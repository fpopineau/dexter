/**
 * Position sizer — deterministic, confidence-weighted share sizing.
 *
 * Prep for the small live account (~€3.7K vs the $1M paper account): the
 * LLM should not guess quantities. When a proposal omits quantity, this
 * sizer computes it from three things the operator controls:
 *
 *   risk budget   = netLiquidation × max_risk_per_trade_pct
 *   confidence    = multiplier from the proposal's score (full / half / low
 *                   bands in risk-rules; unscored gets the low multiplier)
 *   stop distance = |entry − stop| (the structural stop the gates enforce)
 *
 *   quantity = floor(budget × confidence / riskPerShare),
 *              capped by max_position_pct of the account.
 *
 * The budget and riskPerShare depend on the trade class: intraday and
 * swing size against the stop distance (0.25% / swing_risk_pct budgets);
 * earnings bets size against the assumed worst-case gap — a stop cannot
 * protect through a print (see TradeClass in risk-rules.ts).
 *
 * Whole shares only — dexter's gates, brackets and tracker assume integer
 * quantities (fractional support is a separate project). A trade the
 * account cannot afford at these rules is REFUSED with the reason, never
 * silently shrunk below viability: min_risk_budget_usd stops trades whose
 * weighted budget is so small that commissions and spread eat the edge.
 *
 * Currency (WP8, remediation 2026-08-20): netLiquidation arrives in USD —
 * the daily-loss guard converts the account's base currency at the
 * boundary (IDEALPRO midpoint, 1h cache) and REFUSES orders when the rate
 * is unavailable for a non-USD base. Every figure in this module is USD.
 */

import { getRiskRules, type RiskRules, type TradeClass } from '@/tools/ibkr/risk-rules.js';
import { currentRung } from './ladder-state.js';
import { stressNotionalCapUsd, type StrategyId } from './lane-contract.js';
import { costViability, estimateRoundTrip } from './trade-costs.js';

/** REQ-SIZE-001: the book the sizer composes against (creation-time, from
 *  the proposals store; every field optional — a missing field skips its
 *  cap, never fakes a zero). */
export interface SizerBook {
    /** Planned stop-out risk of the open book (USD); undefined = an
     *  unpriceable row made it unknown → the headroom cap is skipped. */
    openPlannedRiskUsd?: number;
    /** Today's realized P&L (USD); losses shrink the headroom, wins never expand it. */
    realizedLossTodayUsd?: number;
    /** Notional already committed to THIS symbol by other working/filled rows. */
    existingSymbolExposureUsd?: number;
    /** Notional of rows that survive the close; class-aware stressed loss of that book. */
    overnightExposureUsd?: number;
    overnightStressedLossUsd?: number;
    /** Same-sector notional; undefined/null = sector unknown → skipped. */
    sameSectorExposureUsd?: number | null;
    /** 20-day average daily volume (shares); enables the ADV cap. */
    avgDailyVolume20d?: number | null;
    /** Live bid-ask spread (% of mid) for the cost estimate; null = unknown. */
    spreadPct?: number | null;
}

export type SizeBinding = 'risk' | 'position-cap' | 'symbol-aggregate' | 'headroom' | 'overnight' | 'sector' | 'adv' | 'costs';

export interface SizeInput {
    entry: number;
    stop: number;
    /** Proposal confidence score (0–150); null/undefined = unscored. */
    score?: number | null;
    /** Account net liquidation (base currency). */
    netLiquidation: number;
    /** Trade class; defaults to 'intraday'. Selects the risk budget and,
     *  for 'earnings-bet', switches to worst-case-gap sizing. */
    tradeClass?: TradeClass;
    /** Lane (REQ-LANE-004): 'overnight' funds from overnight_risk_pct. */
    strategyId?: StrategyId | null;
    /** Notional (USD) of the overnight-capable book already working or
     *  held (swing class + kept overnight), supplied server-side — the
     *  gap-stress budget this new position must fit beside. Superseded by
     *  `book.overnightStressedLossUsd` when that is supplied (WP6). */
    overnightBookNotionalUsd?: number | null;
    /** Earnings bets only: the symbol's worst historical adverse post-print
     *  move (%). The sizer floors it at earnings_bet_gap_floor_pct; omitted
     *  → the floor alone is assumed. Ignored for other classes. */
    worstCaseGapPct?: number | null;
    /** REQ-SIZE-002: the rest of the book — every cap the acceptance gate
     *  enforces, composed here so a sized proposal passes it. */
    book?: SizerBook;
    /** Target price — enables the cost-to-target viability check (REQ-SIZE-003). */
    target?: number;
}

export interface SizeResult {
    /** Whole shares to trade, or null when the trade is not viable. */
    quantity: number | null;
    /** Confidence multiplier applied (for logs/messages). */
    multiplier: number;
    /** Weighted risk budget in account currency. */
    riskBudget: number;
    /** Why quantity is null — actionable, shown to the proposing model. */
    reason?: string;
    /** REQ-SIZE-002: the constraint that bound the quantity (or refused). */
    binding?: SizeBinding;
    /** The share count each evaluated constraint allowed. */
    caps?: Partial<Record<SizeBinding, number>>;
    /** REQ-SIZE-003: estimated round-trip cost as % of the gross gain at target. */
    costToTargetPct?: number | null;
}

/** IBKR fractional resolution: 4 decimal places, minimum 0.0001 share. */
export const FRACTIONAL_STEP = 0.0001;

/** Sizer headroom under max_position_pct: absorbs NetLiq/FX drift between
 *  sizing (creation) and the gate's re-check (acceptance). See the
 *  cap-drift comment at the byCap computation. */
export const CAP_DRIFT_MARGIN = 0.995;

/**
 * Is `qty` a placeable share quantity under the active rules?
 * Whole-share mode: positive integers. Fractional mode: positive decimals
 * at IBKR's 0.0001 resolution (finer silently fails at the broker).
 * Shared by the risk gate and the bracket placer so the two can never
 * disagree about what is orderable.
 */
export function isValidQuantity(qty: number, fractional: boolean): boolean {
    if (!Number.isFinite(qty) || !(qty > 0)) return false;
    if (!fractional) return Number.isInteger(qty);
    const scaled = qty / FRACTIONAL_STEP;
    return qty >= FRACTIONAL_STEP && Math.abs(scaled - Math.round(scaled)) < 1e-6;
}

/** Round a computed quantity DOWN to what is placeable under the rules. */
export function floorToPlaceable(qty: number, fractional: boolean): number {
    if (!fractional) return Math.floor(qty);
    return Math.floor(qty / FRACTIONAL_STEP + 1e-9) * FRACTIONAL_STEP;
}

/** Confidence multiplier from the score bands in the risk rules. */
export function confidenceMultiplier(score: number | null | undefined, rules: RiskRules = getRiskRules()): number {
    if (score == null || !Number.isFinite(score)) return rules.sizing_low_mult;
    if (score >= rules.sizing_full_score) return 1;
    if (score >= rules.sizing_half_score) return rules.sizing_half_mult;
    return rules.sizing_low_mult;
}

/** Risk budget percentage for a trade class.
 *
 *  REQ-RISK-009 (live-loop WP1): the INTRADAY budget is overlaid by the
 *  size-ladder rung — effective = min(yaml ceiling, rung). The yaml stays
 *  the ratified ceiling policy; the rung (ladder-state.json, bottom rung
 *  0.25 when absent) is the evidence-earned position on the ladder. Swing
 *  and earnings-bet budgets are untouched in WP1. `rungPct` is injectable
 *  so pure tests pin the arithmetic without a state file. */
export function classRiskPct(tradeClass: TradeClass, rules: RiskRules, rungPct: number = currentRung(), strategyId?: StrategyId | null): number {
    if (strategyId === 'overnight') return rules.overnight_risk_pct; // REQ-LANE-002/004
    switch (tradeClass) {
        case 'swing': return rules.swing_risk_pct;
        case 'earnings-bet': return rules.earnings_bet_risk_pct;
        default: return Math.min(rules.max_risk_per_trade_pct, rungPct);
    }
}

/**
 * Per-share risk for earnings-bet sizing: the assumed adverse gap in
 * dollars. A stop cannot protect through a print, so the "stop distance"
 * for budget math is entry × the assumed worst-case gap — the symbol's
 * worst historical post-print move, floored at earnings_bet_gap_floor_pct.
 */
export function gapRiskPerShare(entry: number, worstCaseGapPct: number | null | undefined, rules: RiskRules): number {
    const assumed = Math.max(worstCaseGapPct ?? 0, rules.earnings_bet_gap_floor_pct);
    return entry * (assumed / 100);
}

/** Compute the whole-share quantity for a proposal, or refuse with a reason. */
export function computeQuantity(input: SizeInput, rules: RiskRules = getRiskRules(), rungPct: number = currentRung()): SizeResult {
    const tradeClass: TradeClass = input.tradeClass ?? 'intraday';
    const stopDistance = Math.abs(input.entry - input.stop);
    // Earnings bets size against the assumed adverse gap, never the stop —
    // the gap does not respect the stop.
    const riskPerShare = tradeClass === 'earnings-bet'
        ? gapRiskPerShare(input.entry, input.worstCaseGapPct, rules)
        : stopDistance;
    const multiplier = confidenceMultiplier(input.score, rules);
    const fullBudget = (classRiskPct(tradeClass, rules, rungPct, input.strategyId) / 100) * input.netLiquidation;
    const riskBudget = Math.round(fullBudget * multiplier * 100) / 100;

    if (tradeClass === 'earnings-bet' && !rules.earnings_bet_enabled) {
        return {
            quantity: null, multiplier, riskBudget,
            reason: 'earnings bets are disabled in this account profile (paper-only until the class is proven)',
        };
    }
    if (!(input.entry > 0) || !(stopDistance > 0)) {
        return { quantity: null, multiplier, riskBudget, reason: 'entry and stop must be positive and distinct' };
    }
    if (!(input.netLiquidation > 0)) {
        return { quantity: null, multiplier, riskBudget, reason: 'account net liquidation unavailable — pass an explicit quantity' };
    }

    if (rules.min_risk_budget_usd > 0 && riskBudget < rules.min_risk_budget_usd) {
        return {
            quantity: null, multiplier, riskBudget,
            reason:
                `confidence-weighted risk budget $${riskBudget.toFixed(0)} is below the ` +
                `$${rules.min_risk_budget_usd} account floor — commissions and spread would eat the edge. ` +
                `Only propose higher-conviction setups (score ≥ ${rules.sizing_full_score}) at this account size`,
        };
    }

    const fractional = rules.fractional_shares;
    const maxPositionValue = (rules.max_position_pct / 100) * input.netLiquidation;
    // Cap-drift margin (P-DBFF, 2026-08-21): the gate re-checks the cap at
    // ACCEPTANCE with fresh broker-canonical USD NetLiq — on a EUR account
    // that denominator moves with every EURUSD tick, so a sizer that lands
    // exactly ON the cap gets refused for one share whenever NetLiq drifts
    // a few basis points down between creation and acceptance. Sizing to
    // 99.5% of the cap absorbs the drift; a GENUINE breach (position that
    // really outgrew the account) is still the gate's to refuse.
    const byRisk = floorToPlaceable(riskBudget / riskPerShare, fractional);
    const byCap = floorToPlaceable((maxPositionValue * CAP_DRIFT_MARGIN) / input.entry, fractional);
    const minQty = fractional ? FRACTIONAL_STEP : 1;

    const book = input.book ?? {};
    const caps: Partial<Record<SizeBinding, number>> = { risk: byRisk, 'position-cap': byCap };
    const reasons: Partial<Record<SizeBinding, string>> = {};

    // REQ-LANE-004 (AUD-06 partial): an overnight-capable position (the
    // swing risk class — overnight, swing and cup lanes) is ALSO bounded at
    // creation by the per-position overnight cap, the overnight book cap and
    // the gap-stress budget the whole overnight book must fit — the 15:52
    // vet used to be the first place a swing sized at 15% met the 7.5%
    // stress reality. REQ-SIZE-002: with the book supplied the stress room
    // is class-aware (each existing row at its own gap) and the notional
    // book cap composes too.
    if (tradeClass === 'swing') {
        const posCap = (rules.max_overnight_position_pct / 100) * input.netLiquidation;
        const bookStressUsd = book.overnightStressedLossUsd
            ?? ((book.overnightExposureUsd ?? input.overnightBookNotionalUsd ?? 0) * (rules.overnight_gap_stress_pct / 100));
        const stressBudget = (rules.max_daily_loss_pct / 100) * input.netLiquidation;
        const stressRoom = rules.overnight_gap_stress_pct > 0
            ? Math.max(0, stressBudget - bookStressUsd) / (rules.overnight_gap_stress_pct / 100)
            : Number.POSITIVE_INFINITY;
        const bookRoom = book.overnightExposureUsd !== undefined
            ? Math.max(0, (rules.max_overnight_exposure_pct / 100) * input.netLiquidation - book.overnightExposureUsd)
            : Number.POSITIVE_INFINITY;
        const overnightCapValue = Math.min(posCap, stressRoom, bookRoom);
        caps.overnight = floorToPlaceable((overnightCapValue * CAP_DRIFT_MARGIN) / input.entry, fractional);
        reasons.overnight =
            `the overnight budget allows at most $${overnightCapValue.toFixed(0)} of notional for this position ` +
            `(per-position overnight cap ${rules.max_overnight_position_pct}%, the ${rules.max_overnight_exposure_pct}% book cap, and the ` +
            `${rules.overnight_gap_stress_pct}% gap-stress vs the ${rules.max_daily_loss_pct}% daily-loss budget minus the $${bookStressUsd.toFixed(0)} ` +
            `of stress the overnight book already carries) — one share at $${input.entry} exceeds it; pick a cheaper name, wait for the book to clear, or skip`;
    }
    // Per-symbol aggregate (REQ-EXPO-001 mirror): the cap counts what is
    // already committed to the name.
    if (book.existingSymbolExposureUsd !== undefined && book.existingSymbolExposureUsd > 0) {
        const room = Math.max(0, maxPositionValue - book.existingSymbolExposureUsd);
        caps['symbol-aggregate'] = floorToPlaceable((room * CAP_DRIFT_MARGIN) / input.entry, fractional);
        reasons['symbol-aggregate'] =
            `$${book.existingSymbolExposureUsd.toFixed(0)} is already committed to this symbol — the ${rules.max_position_pct}% single-symbol cap ` +
            `($${maxPositionValue.toFixed(0)}) leaves $${room.toFixed(0)}, less than one share at $${input.entry}`;
    }
    // Daily-loss headroom (acceptance-gate mirror): planned stop-outs of the
    // open book plus today's realized losses must leave room for this one.
    if (book.openPlannedRiskUsd !== undefined && rules.max_daily_loss_pct > 0) {
        const limit = (rules.max_daily_loss_pct / 100) * input.netLiquidation;
        const realized = Math.min(0, book.realizedLossTodayUsd ?? 0);
        const headroom = Math.max(0, limit + realized - book.openPlannedRiskUsd);
        caps.headroom = floorToPlaceable(headroom / riskPerShare, fractional);
        reasons.headroom =
            `the remaining daily-loss headroom is $${headroom.toFixed(0)} (kill-switch ${rules.max_daily_loss_pct}% = $${limit.toFixed(0)}` +
            `${realized < 0 ? `, $${Math.abs(realized).toFixed(0)} realized in losses today` : ''}, $${book.openPlannedRiskUsd.toFixed(0)} committed to the open book's planned stops) — ` +
            `less than one share's $${riskPerShare.toFixed(2)} stop distance; close or trim something first, or skip`;
    }
    // Sector concentration (acceptance-gate mirror), only when the sector is known.
    if (book.sameSectorExposureUsd !== undefined && book.sameSectorExposureUsd !== null) {
        const room = Math.max(0, (rules.max_sector_exposure_pct / 100) * input.netLiquidation - book.sameSectorExposureUsd);
        caps.sector = floorToPlaceable((room * CAP_DRIFT_MARGIN) / input.entry, fractional);
        reasons.sector =
            `$${book.sameSectorExposureUsd.toFixed(0)} is already committed to this sector — the ${rules.max_sector_exposure_pct}% sector cap leaves $${room.toFixed(0)}, ` +
            `less than one share at $${input.entry}; on a sector-wide move prefer the breadth vehicle`;
    }
    // Liquidity (microstructure mirror): the order must stay under max_adv_pct of the 20-day ADV.
    if (book.avgDailyVolume20d !== undefined && book.avgDailyVolume20d !== null && book.avgDailyVolume20d > 0) {
        caps.adv = floorToPlaceable((rules.max_adv_pct / 100) * book.avgDailyVolume20d, fractional);
        reasons.adv = `even one share exceeds ${rules.max_adv_pct}% of the 20-day ADV (${Math.round(book.avgDailyVolume20d).toLocaleString()} shares) — too thin`;
    }

    // The binding constraint is the smallest cap (priority order on ties).
    const order: SizeBinding[] = ['risk', 'position-cap', 'symbol-aggregate', 'headroom', 'overnight', 'sector', 'adv'];
    let quantity = Number.POSITIVE_INFINITY;
    let binding: SizeBinding = 'risk';
    for (const k of order) {
        const v = caps[k];
        if (v !== undefined && v < quantity) { quantity = v; binding = k; }
    }
    if (quantity < minQty && binding !== 'risk' && binding !== 'position-cap') {
        return { quantity: null, multiplier, riskBudget, binding, caps, reason: reasons[binding] };
    }

    if (quantity < minQty) {
        const maxAffordableEntry = Math.floor(maxPositionValue * 100) / 100;
        const unit = fractional ? `${FRACTIONAL_STEP} share` : 'one share';
        const riskLabel = tradeClass === 'earnings-bet' ? 'assumed worst-case gap' : 'stop distance';
        return {
            quantity: null, multiplier, riskBudget, binding: byCap < minQty ? 'position-cap' : 'risk', caps,
            reason: byCap < minQty
                ? `${unit} at $${input.entry} exceeds the ${rules.max_position_pct}% position cap ` +
                  `($${maxAffordableEntry.toFixed(0)}) — the account cannot afford this symbol; pick one under that price`
                : `the $${riskBudget.toFixed(0)} risk budget does not cover ${unit}'s ${riskLabel} ` +
                  `($${riskPerShare.toFixed(2)})` +
                  (tradeClass === 'earnings-bet'
                      ? ' — the account cannot afford this bet; pick a cheaper or less volatile name, or skip'
                      : ' — tighten to real structure closer in, or skip'),
        };
    }

    // toFixed(4) clears float dust from the resolution math (e.g. 1.4799999…).
    const placeable = fractional ? Number(quantity.toFixed(4)) : quantity;

    // REQ-SIZE-003: net viability — the round trip must be worth paying.
    let costToTargetPct: number | null | undefined;
    if (input.target !== undefined && input.target > 0) {
        const est = estimateRoundTrip({ quantity: placeable, entry: input.entry, target: input.target, spreadPct: book.spreadPct ?? null }, rules);
        costToTargetPct = est.costToTargetPct;
        const viable = costViability(est, rules);
        if (!viable.ok) {
            return { quantity: null, multiplier, riskBudget, binding: 'costs', caps, costToTargetPct, reason: viable.reason };
        }
    }

    return { quantity: placeable, multiplier, riskBudget, binding, caps, costToTargetPct };
}
