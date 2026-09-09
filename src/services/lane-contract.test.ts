import { describe, expect, test } from 'bun:test';
import { DEFAULT_RULES } from '@/tools/ibkr/risk-rules.js';
import {
    deriveStrategyId,
    etDayStartMsOf,
    intradayEntryCutoffViolation,
    LANE_TABLE,
    laneExitDeadline,
    laneExitPolicy,
    nextTradingDayStartMs,
    normaliseSetupId,
    resolveLaneContract,
    STRATEGY_IDS,
    stressNotionalCapUsd,
} from './lane-contract.js';

/** Epoch ms of an ET wall-clock instant (EDT in September: UTC−4). */
function et(y: number, m: number, d: number, hh: number, mm: number): number {
    return Date.UTC(y, m - 1, d, hh + 4, mm, 0, 0);
}
const etOf = (ms: number) => new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });

describe('LANE_TABLE (REQ-LANE-002)', () => {
    test('five lanes; overnight, swing and cup ride the swing class on GTC; intraday is DAY same-session', () => {
        expect(STRATEGY_IDS).toEqual(['intraday', 'overnight', 'swing', 'cup-and-handle', 'earnings-bet']);
        expect(LANE_TABLE.intraday).toMatchObject({ tradeClass: 'intraday', tif: 'DAY', holdingHorizon: 'same-session', budget: 'intraday' });
        expect(LANE_TABLE.overnight).toMatchObject({ tradeClass: 'swing', tif: 'GTC', holdingHorizon: 'next-session', budget: 'overnight_risk_pct' });
        expect(LANE_TABLE.swing).toMatchObject({ tradeClass: 'swing', tif: 'GTC', holdingHorizon: 'multi-session', holdDaysKey: 'swing_max_hold_days' });
        expect(LANE_TABLE['cup-and-handle']).toMatchObject({ tradeClass: 'swing', tif: 'GTC', holdingHorizon: 'multi-session', holdDaysKey: 'cup_max_hold_days' });
        expect(LANE_TABLE['earnings-bet']).toMatchObject({ tradeClass: 'earnings-bet', tif: 'GTC' });
        expect(deriveStrategyId('intraday')).toBe('intraday');
        expect(deriveStrategyId('swing')).toBe('swing');
        expect(deriveStrategyId('earnings-bet')).toBe('earnings-bet');
        expect(laneExitPolicy('intraday', { exit_style: 'target' })).toBe('take-x');
        expect(laneExitPolicy('intraday', { exit_style: 'ratchet' })).toBe('ratchet');
        expect(laneExitPolicy('overnight', DEFAULT_RULES)).toBe('bracket+deadline');
        expect(laneExitPolicy('cup-and-handle', DEFAULT_RULES)).toBe('structural+deadline');
    });

    test('setup ids are normalised; cup defaults to its own setup', () => {
        expect(normaliseSetupId(' Pullback ', 'swing')).toBe('pullback');
        expect(normaliseSetupId('EOD continuation', 'overnight')).toBe('eod-continuation');
        expect(normaliseSetupId('!!', 'swing')).toBeNull();
        expect(normaliseSetupId(undefined, 'cup-and-handle')).toBe('cup-and-handle');
    });
});

/** Epoch ms of an ET wall-clock instant in WINTER (EST: UTC−5). */
function etWinter(y: number, m: number, d: number, hh: number, mm: number): number {
    return Date.UTC(y, m - 1, d, hh + 5, mm, 0, 0);
}

describe('resolveLaneContract (REQ-LANE-001/003)', () => {
    const rules = { ...DEFAULT_RULES, overnight_entry_window_min: 60, intraday_entry_cutoff_min: 60 };
    const thu = et(2026, 9, 10, 15, 30); // Thursday 15:30 ET (inside the overnight window, inside the intraday cutoff)
    const midday = et(2026, 9, 10, 14, 30); // Thursday 14:30 ET (intraday entries still open)

    test('derivation and consistency: an omitted strategy follows the class; a class or TIF the contract does not allow is refused', () => {
        const r = resolveLaneContract({ tif: 'DAY', createdAtMs: midday, expiresAtMs: midday + 60 * 60_000 }, rules);
        expect(r.ok && r.contract).toMatchObject({ strategyId: 'intraday', tradeClass: 'intraday', tif: 'DAY', holdingHorizon: 'same-session', exitPolicyId: 'take-x', setupId: null });
        const swing = resolveLaneContract({ tradeClass: 'swing', tif: 'GTC', setupId: 'flat base', createdAtMs: thu, expiresAtMs: thu + 60 * 60_000 }, rules);
        expect(swing.ok && swing.contract).toMatchObject({ strategyId: 'swing', setupId: 'flat-base', exitPolicyId: 'structural+deadline' });
        const dodge = resolveLaneContract({ strategyId: 'overnight', tradeClass: 'intraday', tif: 'DAY', createdAtMs: thu, expiresAtMs: thu + 10 * 60_000 }, rules);
        expect(dodge.ok).toBe(false);
        if (!dodge.ok) {
            expect(dodge.violations.some((v) => v.includes("rides the 'swing' risk class"))).toBe(true);
            expect(dodge.violations.some((v) => v.includes('requires tif GTC'))).toBe(true);
        }
        const gtcIntraday = resolveLaneContract({ strategyId: 'intraday', tradeClass: 'intraday', tif: 'GTC', createdAtMs: midday, expiresAtMs: midday + 10 * 60_000 }, rules);
        expect(gtcIntraday.ok).toBe(false);
    });

    test('REQ-LANE-010 intraday cutoff: refused inside the last hour (the DOCN 15:10 entry), open before it, pre-market, after the bell and with cutoff 0', () => {
        // DOCN 2026-09-08: registered 15:10 ET, filled 15:46, flattened 15:52.
        const docn = resolveLaneContract({ tif: 'DAY', createdAtMs: et(2026, 9, 8, 15, 10), expiresAtMs: et(2026, 9, 8, 17, 10) }, rules);
        expect(docn.ok).toBe(false);
        if (!docn.ok) expect(docn.violations[0]).toContain('stop 60 min before the bell (15:00 ET) — it is 15:10 ET');
        expect(intradayEntryCutoffViolation(et(2026, 9, 8, 15, 0), rules)).not.toBeNull(); // the boundary minute is inside
        expect(intradayEntryCutoffViolation(et(2026, 9, 8, 14, 59), rules)).toBeNull();
        expect(intradayEntryCutoffViolation(et(2026, 9, 8, 7, 30), rules)).toBeNull(); // pre-market DAY brackets rest until the open
        expect(intradayEntryCutoffViolation(et(2026, 9, 8, 16, 5), rules)).toBeNull(); // the session gate owns post-close placements
        expect(intradayEntryCutoffViolation(et(2026, 9, 12, 15, 30), rules)).toBeNull(); // Saturday: not a session
        expect(intradayEntryCutoffViolation(et(2026, 9, 8, 15, 10), { intraday_entry_cutoff_min: 0 })).toBeNull();
        // Half-day (Black Friday 2026-11-27, EST): the close is 13:00 ET, so the cutoff starts at 12:00 ET.
        expect(intradayEntryCutoffViolation(etWinter(2026, 11, 27, 12, 5), rules)).toContain('(12:00 ET)');
        expect(intradayEntryCutoffViolation(etWinter(2026, 11, 27, 11, 55), rules)).toBeNull();
        // The other lanes are untouched: an overnight setup at 15:10 is exactly what the last hour is for.
        const on = resolveLaneContract({ strategyId: 'overnight', tradeClass: 'swing', tif: 'GTC', setupId: 'eod-continuation', createdAtMs: et(2026, 9, 8, 15, 10), expiresAtMs: et(2026, 9, 8, 15, 35) }, rules);
        expect(on.ok).toBe(true);
    });

    test('overnight window: refused before 15:00 ET, after the close, on a weekend, or with an expiry past the close; accepted inside', () => {
        const early = resolveLaneContract({ strategyId: 'overnight', tradeClass: 'swing', tif: 'GTC', createdAtMs: et(2026, 9, 10, 14, 59), expiresAtMs: et(2026, 9, 10, 15, 30) }, rules);
        expect(early.ok).toBe(false);
        if (!early.ok) expect(early.violations[0]).toContain('window opens at 15:00 ET');
        const late = resolveLaneContract({ strategyId: 'overnight', tradeClass: 'swing', tif: 'GTC', createdAtMs: et(2026, 9, 10, 16, 5), expiresAtMs: et(2026, 9, 10, 16, 30) }, rules);
        expect(late.ok).toBe(false);
        const sat = resolveLaneContract({ strategyId: 'overnight', tradeClass: 'swing', tif: 'GTC', createdAtMs: et(2026, 9, 12, 15, 30), expiresAtMs: et(2026, 9, 12, 15, 50) }, rules);
        expect(sat.ok).toBe(false);
        const longExpiry = resolveLaneContract({ strategyId: 'overnight', tradeClass: 'swing', tif: 'GTC', createdAtMs: thu, expiresAtMs: thu + 45 * 60_000 }, rules);
        expect(longExpiry.ok).toBe(false);
        if (!longExpiry.ok) expect(longExpiry.violations[0]).toContain('expiresMinutes ≤ 30');
        const ok = resolveLaneContract({ strategyId: 'overnight', tradeClass: 'swing', tif: 'GTC', setupId: 'eod-continuation', createdAtMs: thu, expiresAtMs: thu + 25 * 60_000 }, rules);
        expect(ok.ok && ok.contract).toMatchObject({ strategyId: 'overnight', holdingHorizon: 'next-session', exitPolicyId: 'bracket+deadline', setupId: 'eod-continuation' });
        // half-day (Black Friday, EST): the close is 13:00 ET, so the window opens at 12:00 ET
        const halfDay = resolveLaneContract({ strategyId: 'overnight', tradeClass: 'swing', tif: 'GTC', createdAtMs: etWinter(2026, 11, 27, 12, 30), expiresAtMs: etWinter(2026, 11, 27, 12, 55) }, rules);
        expect(halfDay.ok).toBe(true);
        const halfDayEarly = resolveLaneContract({ strategyId: 'overnight', tradeClass: 'swing', tif: 'GTC', createdAtMs: etWinter(2026, 11, 27, 11, 45), expiresAtMs: etWinter(2026, 11, 27, 12, 30) }, rules);
        expect(halfDayEarly.ok).toBe(false);
        if (!halfDayEarly.ok) expect(halfDayEarly.violations[0]).toContain('window opens at 12:00 ET');
        const halfDayLate = resolveLaneContract({ strategyId: 'overnight', tradeClass: 'swing', tif: 'GTC', createdAtMs: etWinter(2026, 11, 27, 12, 30), expiresAtMs: etWinter(2026, 11, 27, 13, 5) }, rules);
        expect(halfDayLate.ok).toBe(false);
    });
});

describe('laneExitDeadline (REQ-LANE-003 — the calendar, not +24h)', () => {
    const rules = { overnight_exit_minutes_et: 600, swing_max_hold_days: 10, cup_max_hold_days: 15 };

    test('overnight: next trading session at 10:00 ET; Friday → Monday; the Labor-Day weekend → Tuesday', () => {
        const thuFill = et(2026, 9, 10, 15, 40);
        expect(etOf(laneExitDeadline('overnight', thuFill, rules)!)).toContain('9/11/2026, 10:00:00');
        const friFill = et(2026, 9, 11, 15, 45);
        expect(etOf(laneExitDeadline('overnight', friFill, rules)!)).toContain('9/14/2026, 10:00:00');
        const preLaborDay = et(2026, 9, 4, 15, 45); // Fri; Mon 2026-09-07 is Labor Day
        expect(etOf(laneExitDeadline('overnight', preLaborDay, rules)!)).toContain('9/8/2026, 10:00:00');
    });

    test('swing: fill + 10 trading days at 15:50 ET; cup + 15; a half-day deadline pulls to 12:50 ET', () => {
        const fill = et(2026, 9, 10, 10, 0); // Thu 9/10 → +10 trading days = Thu 9/24 (9/7 holiday is before the fill)
        expect(etOf(laneExitDeadline('swing', fill, rules)!)).toContain('9/24/2026, 15:50:00');
        expect(etOf(laneExitDeadline('cup-and-handle', fill, rules)!)).toContain('10/1/2026, 15:50:00');
        // 2026-11-27 (Black Friday) is a half day: a swing whose 10th day lands there closes at 12:50.
        const nov = etWinter(2026, 11, 12, 10, 0); // Thu 11/12 → 10 trading days: 13,16,17,18,19,20,23,24,25,27 (26 = Thanksgiving)
        expect(etOf(laneExitDeadline('swing', nov, rules)!)).toContain('11/27/2026, 12:50:00');
        expect(laneExitDeadline('intraday', fill, rules)).toBeNull();
        expect(laneExitDeadline('earnings-bet', fill, rules)).toBeNull();
    });

    test('calendar helpers: next trading day skips weekends and holidays; ET day start is midnight ET', () => {
        expect(etOf(nextTradingDayStartMs(et(2026, 9, 11, 12, 0)))).toContain('9/14/2026, 00:00:00');
        expect(etOf(nextTradingDayStartMs(et(2026, 9, 4, 12, 0)))).toContain('9/8/2026, 00:00:00');
        expect(etOf(etDayStartMsOf(et(2026, 9, 10, 15, 40)))).toContain('9/10/2026, 00:00:00');
    });
});

describe('stressNotionalCapUsd (REQ-LANE-004)', () => {
    test('live shape: 1.5% daily loss / 20% stress → 7.5% of NetLiq; the existing overnight book eats the budget; 0 stress disables', () => {
        const live = { max_daily_loss_pct: 1.5, overnight_gap_stress_pct: 20 };
        expect(stressNotionalCapUsd(live, 11_700)).toBeCloseTo(877.5, 6);
        expect(stressNotionalCapUsd(live, 11_700, 500)).toBeCloseTo(377.5, 6);
        expect(stressNotionalCapUsd(live, 11_700, 5_000)).toBe(0);
        expect(stressNotionalCapUsd({ max_daily_loss_pct: 2, overnight_gap_stress_pct: 0 }, 11_700)).toBeNull();
    });
});
