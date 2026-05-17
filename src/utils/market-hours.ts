/**
 * Market session awareness — detect current trading session, half-days, holidays.
 * All times are US Eastern (America/New_York).
 */

// ---------------------------------------------------------------------------
// Session definitions
// ---------------------------------------------------------------------------

export enum MarketSession {
    PRE_MARKET = 'pre-market',     // 04:00–09:30 ET
    REGULAR = 'regular',           // 09:30–16:00 ET
    AFTER_HOURS = 'after-hours',   // 16:00–20:00 ET
    OVERNIGHT = 'overnight',       // 20:00–04:00 ET
    CLOSED = 'closed',             // Weekend or holiday
}

export interface SessionInfo {
    session: MarketSession;
    /** Minutes until next session change. */
    minutesUntilChange: number;
    /** Label for next session. */
    nextSession: MarketSession;
    /** Is today a half-day (early close at 13:00)? */
    isHalfDay: boolean;
    /** Is today a full market holiday? */
    isHoliday: boolean;
    /** Formatted current time in ET. */
    currentTimeET: string;
}

// ---------------------------------------------------------------------------
// US market holidays (NYSE/NASDAQ) for 2025–2027
// Format: YYYY-MM-DD. Add years as needed.
// ---------------------------------------------------------------------------

const HOLIDAYS = new Set([
    // 2025
    '2025-01-01', '2025-01-20', '2025-02-17', '2025-04-18',
    '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01',
    '2025-11-27', '2025-12-25',
    // 2026
    '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03',
    '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07',
    '2026-11-26', '2026-12-25',
    // 2027
    '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26',
    '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06',
    '2027-11-25', '2027-12-24',
]);

/** Half-days: early close at 13:00 ET (day before July 4th, day after Thanksgiving, Christmas Eve). */
const HALF_DAYS = new Set([
    // 2025
    '2025-07-03', '2025-11-28', '2025-12-24',
    // 2026
    '2026-07-02', '2026-11-27', '2026-12-24',
    // 2027
    '2027-07-02', '2027-11-26', '2027-12-23',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a Date (or now) to US Eastern time components. */
function toET(date?: Date): { year: number; month: number; day: number; hour: number; minute: number; dayOfWeek: number; dateStr: string; formatted: string } {
    const d = date ?? new Date();
    const etStr = d.toLocaleString('en-US', { timeZone: 'America/New_York' });
    const et = new Date(etStr);
    const year = et.getFullYear();
    const month = et.getMonth() + 1;
    const day = et.getDate();
    const hour = et.getHours();
    const minute = et.getMinutes();
    const dayOfWeek = et.getDay(); // 0=Sun, 6=Sat
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const formatted = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} ET`;
    return { year, month, day, hour, minute, dayOfWeek, dateStr, formatted };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the current market session and timing info.
 */
export function getMarketSession(date?: Date): SessionInfo {
    const et = toET(date);
    const { hour, minute, dayOfWeek, dateStr, formatted } = et;
    const totalMin = hour * 60 + minute;

    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const isHoliday = HOLIDAYS.has(dateStr);
    const isHalfDay = HALF_DAYS.has(dateStr);
    const regularClose = isHalfDay ? 13 * 60 : 16 * 60; // 13:00 or 16:00

    // Weekend or holiday — market closed
    if (isWeekend || isHoliday) {
        return {
            session: MarketSession.CLOSED,
            minutesUntilChange: 0, // not meaningful
            nextSession: MarketSession.PRE_MARKET,
            isHalfDay: false,
            isHoliday,
            currentTimeET: formatted,
        };
    }

    // Pre-market: 04:00–09:30
    if (totalMin >= 240 && totalMin < 570) {
        return {
            session: MarketSession.PRE_MARKET,
            minutesUntilChange: 570 - totalMin,
            nextSession: MarketSession.REGULAR,
            isHalfDay,
            isHoliday: false,
            currentTimeET: formatted,
        };
    }

    // Regular: 09:30–16:00 (or 13:00 on half-days)
    if (totalMin >= 570 && totalMin < regularClose) {
        const afterHoursOrOvernight = isHalfDay ? MarketSession.AFTER_HOURS : MarketSession.AFTER_HOURS;
        return {
            session: MarketSession.REGULAR,
            minutesUntilChange: regularClose - totalMin,
            nextSession: afterHoursOrOvernight,
            isHalfDay,
            isHoliday: false,
            currentTimeET: formatted,
        };
    }

    // After-hours: close–20:00
    if (totalMin >= regularClose && totalMin < 1200) {
        return {
            session: MarketSession.AFTER_HOURS,
            minutesUntilChange: 1200 - totalMin,
            nextSession: MarketSession.OVERNIGHT,
            isHalfDay,
            isHoliday: false,
            currentTimeET: formatted,
        };
    }

    // Overnight: 20:00–04:00 (wraps midnight)
    if (totalMin >= 1200 || totalMin < 240) {
        const minsUntilPreMarket = totalMin >= 1200 ? (1440 - totalMin) + 240 : 240 - totalMin;
        return {
            session: MarketSession.OVERNIGHT,
            minutesUntilChange: minsUntilPreMarket,
            nextSession: MarketSession.PRE_MARKET,
            isHalfDay: false,
            isHoliday: false,
            currentTimeET: formatted,
        };
    }

    // Fallback (shouldn't reach)
    return {
        session: MarketSession.CLOSED,
        minutesUntilChange: 0,
        nextSession: MarketSession.PRE_MARKET,
        isHalfDay: false,
        isHoliday: false,
        currentTimeET: formatted,
    };
}

/**
 * Check if the US stock market is currently in regular trading hours.
 */
export function isMarketOpen(date?: Date): boolean {
    return getMarketSession(date).session === MarketSession.REGULAR;
}

/**
 * Check if a given date string (YYYY-MM-DD) is a market holiday.
 */
export function isMarketHoliday(dateStr: string): boolean {
    return HOLIDAYS.has(dateStr);
}

/**
 * Check if a given date string (YYYY-MM-DD) is a half-day.
 */
export function isMarketHalfDay(dateStr: string): boolean {
    return HALF_DAYS.has(dateStr);
}
