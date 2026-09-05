/**
 * Lane contract (REQ-LANE-001..004, four-lane program WP5, 2026-09-05).
 *
 * The STRATEGY a proposal expresses (intraday, overnight, swing,
 * cup-and-handle, earnings-bet) is separated from the RISK CLASS the
 * machinery operates on (`TradeClass`). The mapping is a deterministic
 * table: strategy → risk class → TIF → holding horizon → exit policy →
 * budget → hold limit. The model may NAME a strategy; it cannot pick a
 * combination that dodges a gate — an inconsistent triple is refused at
 * creation. The TIF is an execution property fixed by the contract.
 *
 *   intraday        intraday class, DAY, same-session, take-x (the 15:52
 *                   triage owns the close — no deadline of its own)
 *   overnight       swing class, GTC exits, next-session; entries in the
 *                   last `overnight_entry_window_min` minutes before the
 *                   close (15:00 ET full day, 12:00 half-day), expiry clamped
 *                   to the close (an unfilled entry dies with the day); exit
 *                   at `overnight_exit_minutes_et` of the NEXT trading
 *                   session (Friday → Monday is one session, longer clock)
 *   swing           swing class, GTC, multi-session, structural exits,
 *                   hard deadline fill + `swing_max_hold_days` at 15:50 ET
 *   cup-and-handle  swing class, GTC, multi-session, `cup_max_hold_days`
 *   earnings-bet    unchanged (its own experiment): GTC, gap-sized
 *
 * Deadlines are stamped at ENTRY FILL from the market calendar (weekends,
 * holidays, half-days → 12:50 ET) and enforced by lane-deadline-sweeper.ts.
 * The stress cap composes the overnight gap budget into sizing for the
 * swing class (AUD-06 partial): notional ≤ (daily-loss budget − stress
 * already carried by the overnight book) / stress%.
 */

import { isMarketHalfDay, isMarketHoliday } from '@/utils/market-hours.js';
import type { RiskRules, TradeClass } from '@/tools/ibkr/risk-rules.js';

export const STRATEGY_IDS = ['intraday', 'overnight', 'swing', 'cup-and-handle', 'earnings-bet'] as const;
export type StrategyId = (typeof STRATEGY_IDS)[number];
export type HoldingHorizon = 'same-session' | 'next-session' | 'multi-session';
export type ExitPolicyId = 'take-x' | 'ratchet' | 'bracket+deadline' | 'structural+deadline' | 'bracket';

export interface LaneDef {
    strategyId: StrategyId;
    tradeClass: TradeClass;
    tif: 'DAY' | 'GTC';
    holdingHorizon: HoldingHorizon;
    /** Which rules key funds the lane ('intraday' = min(rung, ceiling)). */
    budget: 'intraday' | 'overnight_risk_pct' | 'swing_risk_pct' | 'earnings_bet_risk_pct';
    /** Rules key holding the max hold in trading days (multi-session lanes). */
    holdDaysKey: 'swing_max_hold_days' | 'cup_max_hold_days' | null;
}

export const LANE_TABLE: Record<StrategyId, LaneDef> = {
    'intraday': { strategyId: 'intraday', tradeClass: 'intraday', tif: 'DAY', holdingHorizon: 'same-session', budget: 'intraday', holdDaysKey: null },
    'overnight': { strategyId: 'overnight', tradeClass: 'swing', tif: 'GTC', holdingHorizon: 'next-session', budget: 'overnight_risk_pct', holdDaysKey: null },
    'swing': { strategyId: 'swing', tradeClass: 'swing', tif: 'GTC', holdingHorizon: 'multi-session', budget: 'swing_risk_pct', holdDaysKey: 'swing_max_hold_days' },
    'cup-and-handle': { strategyId: 'cup-and-handle', tradeClass: 'swing', tif: 'GTC', holdingHorizon: 'multi-session', budget: 'swing_risk_pct', holdDaysKey: 'cup_max_hold_days' },
    'earnings-bet': { strategyId: 'earnings-bet', tradeClass: 'earnings-bet', tif: 'GTC', holdingHorizon: 'next-session', budget: 'earnings_bet_risk_pct', holdDaysKey: null },
};

export function isStrategyId(v: unknown): v is StrategyId {
    return typeof v === 'string' && (STRATEGY_IDS as readonly string[]).includes(v);
}

/** REQ-LANE-001: an omitted strategy derives from the risk class. */
export function deriveStrategyId(tradeClass: TradeClass): StrategyId {
    return tradeClass === 'swing' ? 'swing' : tradeClass === 'earnings-bet' ? 'earnings-bet' : 'intraday';
}

/** Exit policy of a lane under the active rules. */
export function laneExitPolicy(strategyId: StrategyId, rules: Pick<RiskRules, 'exit_style'>): ExitPolicyId {
    switch (strategyId) {
        case 'intraday': return rules.exit_style === 'ratchet' ? 'ratchet' : 'take-x';
        case 'overnight': return 'bracket+deadline';
        case 'swing':
        case 'cup-and-handle': return 'structural+deadline';
        case 'earnings-bet': return 'bracket';
        default: {
            const _exhaustive: never = strategyId;
            throw new Error(`unhandled strategy ${String(_exhaustive)}`);
        }
    }
}

const SETUP_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Normalise a model-supplied setup id; null when absent or malformed. */
export function normaliseSetupId(raw: string | null | undefined, strategyId: StrategyId): string | null {
    const s = (raw ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
    if (s && SETUP_ID_RE.test(s)) return s;
    return strategyId === 'cup-and-handle' ? 'cup-and-handle' : null;
}

// ---------------------------------------------------------------------------
// ET calendar helpers (local — trade-proposals imports this module, so the
// ET day math cannot come from there without a cycle).
// ---------------------------------------------------------------------------

const ET = 'America/New_York';
const DAY_MS = 86_400_000;

function etParts(ms: number): { dateStr: string; minutes: number; dayOfWeek: number } {
    const et = new Date(new Date(ms).toLocaleString('en-US', { timeZone: ET }));
    const dateStr = `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`;
    return { dateStr, minutes: et.getHours() * 60 + et.getMinutes(), dayOfWeek: et.getDay() };
}

/** Start of the ET calendar day containing `ms`, in epoch ms. */
export function etDayStartMsOf(ms: number): number {
    const et = new Date(new Date(ms).toLocaleString('en-US', { timeZone: ET }));
    const sinceMidnight = et.getHours() * 3_600_000 + et.getMinutes() * 60_000 + et.getSeconds() * 1_000 + et.getMilliseconds();
    return ms - sinceMidnight;
}

export function isTradingDay(dateStr: string, dayOfWeek: number): boolean {
    return dayOfWeek !== 0 && dayOfWeek !== 6 && !isMarketHoliday(dateStr);
}

/** Start (ET midnight) of the next trading day strictly after the day of `ms`. */
export function nextTradingDayStartMs(ms: number): number {
    let start = etDayStartMsOf(ms);
    for (let i = 0; i < 15; i++) {
        // +26h lands in the next calendar day whatever the DST shift; re-anchor.
        start = etDayStartMsOf(start + 26 * 3_600_000);
        const { dateStr, dayOfWeek } = etParts(start + 12 * 3_600_000);
        if (isTradingDay(dateStr, dayOfWeek)) return start;
    }
    throw new Error('[lane-contract] no trading day within 15 calendar days');
}

/** Regular-session close of the ET day containing `ms`, in minutes after midnight. */
export function sessionCloseMinutes(ms: number): number {
    const { dateStr } = etParts(ms);
    return isMarketHalfDay(dateStr) ? 13 * 60 : 16 * 60;
}

/** A deadline inside the session: `minutes` after ET midnight of the day
 *  starting at `dayStartMs`, pulled to close − 10 min on a half-day. */
function deadlineOn(dayStartMs: number, minutes: number): number {
    const noon = dayStartMs + 12 * 3_600_000;
    const close = sessionCloseMinutes(noon);
    const m = Math.min(minutes, close - 10);
    return dayStartMs + m * 60_000;
}

/** REQ-LANE-003: the lane's exit deadline for an entry filled at `fillAtMs`;
 *  null for lanes whose close is owned elsewhere (intraday: the 15:52
 *  triage; earnings-bet: the bracket). */
export function laneExitDeadline(
    strategyId: StrategyId,
    fillAtMs: number,
    rules: Pick<RiskRules, 'overnight_exit_minutes_et' | 'swing_max_hold_days' | 'cup_max_hold_days'>,
): number | null {
    const lane = LANE_TABLE[strategyId];
    if (lane.holdingHorizon === 'same-session') return null;
    if (strategyId === 'earnings-bet') return null;
    if (strategyId === 'overnight') {
        return deadlineOn(nextTradingDayStartMs(fillAtMs), rules.overnight_exit_minutes_et);
    }
    const days = lane.holdDaysKey ? rules[lane.holdDaysKey] : 0;
    let start = etDayStartMsOf(fillAtMs);
    for (let i = 0; i < days; i++) start = nextTradingDayStartMs(start + 12 * 3_600_000);
    return deadlineOn(start, 15 * 60 + 50);
}

// ---------------------------------------------------------------------------
// Contract resolution at creation
// ---------------------------------------------------------------------------

export interface ResolvedLaneContract {
    strategyId: StrategyId;
    setupId: string | null;
    tradeClass: TradeClass;
    tif: 'DAY' | 'GTC';
    holdingHorizon: HoldingHorizon;
    exitPolicyId: ExitPolicyId;
}

export type LaneResolution = { ok: true; contract: ResolvedLaneContract } | { ok: false; violations: string[] };

/** REQ-LANE-001/002/003: resolve and validate the contract of a new proposal. */
export function resolveLaneContract(
    input: {
        strategyId?: StrategyId | null;
        tradeClass?: TradeClass | null;
        tif: 'DAY' | 'GTC';
        setupId?: string | null;
        createdAtMs: number;
        expiresAtMs: number;
    },
    rules: Pick<RiskRules, 'exit_style' | 'overnight_entry_window_min'>,
): LaneResolution {
    const tradeClass: TradeClass = input.tradeClass ?? 'intraday';
    const strategyId: StrategyId = input.strategyId ?? deriveStrategyId(tradeClass);
    const lane = LANE_TABLE[strategyId];
    const violations: string[] = [];
    if (lane.tradeClass !== tradeClass) {
        violations.push(`strategy '${strategyId}' rides the '${lane.tradeClass}' risk class, not '${tradeClass}' — the class is fixed by the contract (omit tradeClass or set it to '${lane.tradeClass}')`);
    }
    if (lane.tif !== input.tif) {
        violations.push(`strategy '${strategyId}' requires tif ${lane.tif} (${lane.holdingHorizon}); the TIF is an execution property of the contract, not a choice`);
    }
    if (strategyId === 'overnight') {
        const { dateStr, minutes, dayOfWeek } = etParts(input.createdAtMs);
        if (!isTradingDay(dateStr, dayOfWeek)) {
            violations.push('overnight setups are registered on a trading day, inside the entry window');
        } else {
            const close = sessionCloseMinutes(input.createdAtMs);
            const from = close - rules.overnight_entry_window_min;
            if (minutes < from) {
                violations.push(`overnight entry window opens at ${String(Math.floor(from / 60)).padStart(2, '0')}:${String(from % 60).padStart(2, '0')} ET — it is ${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')} ET now`);
            }
            if (minutes >= close) violations.push('the session has closed — an overnight setup cannot be registered after the bell');
            const closeMs = etDayStartMsOf(input.createdAtMs) + close * 60_000;
            if (input.expiresAtMs > closeMs) {
                violations.push(`an overnight entry must expire by the close (${String(Math.floor(close / 60)).padStart(2, '0')}:${String(close % 60).padStart(2, '0')} ET) so an unfilled entry never arms the next session — set expiresMinutes ≤ ${Math.max(1, Math.floor((closeMs - input.createdAtMs) / 60_000))}`);
            }
        }
    }
    if (violations.length) return { ok: false, violations };
    return {
        ok: true,
        contract: {
            strategyId,
            setupId: normaliseSetupId(input.setupId, strategyId),
            tradeClass,
            tif: lane.tif,
            holdingHorizon: lane.holdingHorizon,
            exitPolicyId: laneExitPolicy(strategyId, rules),
        },
    };
}

// ---------------------------------------------------------------------------
// Stress-composed notional cap (REQ-LANE-004)
// ---------------------------------------------------------------------------

/** Max notional (USD) a NEW overnight-capable position may carry so that an
 *  assumed adverse gap on the whole overnight book (existing + this one)
 *  fits one daily-loss budget. Null when the stress is disabled (0). */
export function stressNotionalCapUsd(
    rules: Pick<RiskRules, 'max_daily_loss_pct' | 'overnight_gap_stress_pct'>,
    netLiqUsd: number,
    existingOvernightNotionalUsd = 0,
): number | null {
    const stress = rules.overnight_gap_stress_pct;
    if (!(stress > 0) || !(netLiqUsd > 0)) return null;
    const budget = (rules.max_daily_loss_pct / 100) * netLiqUsd;
    const used = Math.max(0, existingOvernightNotionalUsd) * (stress / 100);
    return Math.max(0, (budget - used) / (stress / 100));
}
