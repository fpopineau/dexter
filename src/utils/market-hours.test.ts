import { describe, expect, test } from 'bun:test';
import { calendarCoverageStatus, getMarketSession, isMarketHalfDay, isMarketHoliday, MarketSession } from './market-hours.js';

// All dates below are summer (EDT, UTC−4), so HH:00Z = HH−4 ET.

describe('getMarketSession', () => {
    test('regular hours on a normal weekday', () => {
        // Mon 2026-06-29 14:30Z = 10:30 ET
        const info = getMarketSession(new Date('2026-06-29T14:30:00Z'));
        expect(info.session).toBe(MarketSession.REGULAR);
        expect(info.isHoliday).toBe(false);
        expect(info.isHalfDay).toBe(false);
    });

    test('pre-market before the open', () => {
        // Mon 2026-06-29 12:00Z = 08:00 ET
        const info = getMarketSession(new Date('2026-06-29T12:00:00Z'));
        expect(info.session).toBe(MarketSession.PRE_MARKET);
    });

    test('after-hours after the close', () => {
        // Mon 2026-06-29 21:00Z = 17:00 ET
        const info = getMarketSession(new Date('2026-06-29T21:00:00Z'));
        expect(info.session).toBe(MarketSession.AFTER_HOURS);
    });

    test('weekend is closed', () => {
        // Sun 2026-06-28 15:00Z = 11:00 ET
        const info = getMarketSession(new Date('2026-06-28T15:00:00Z'));
        expect(info.session).toBe(MarketSession.CLOSED);
    });

    test('holiday is closed (July 4th observed 2026-07-03)', () => {
        const info = getMarketSession(new Date('2026-07-03T15:00:00Z'));
        expect(info.session).toBe(MarketSession.CLOSED);
        expect(info.isHoliday).toBe(true);
    });

    test('half-day closes at 13:00 ET (2026-07-02)', () => {
        // 12:00 ET → still regular, flagged half-day
        const noon = getMarketSession(new Date('2026-07-02T16:00:00Z'));
        expect(noon.session).toBe(MarketSession.REGULAR);
        expect(noon.isHalfDay).toBe(true);
        // 13:30 ET → already after-hours on a half-day
        const after = getMarketSession(new Date('2026-07-02T17:30:00Z'));
        expect(after.session).toBe(MarketSession.AFTER_HOURS);
    });
});

describe('calendar predicates', () => {
    test('isMarketHoliday', () => {
        expect(isMarketHoliday('2026-12-25')).toBe(true);
        expect(isMarketHoliday('2026-12-28')).toBe(false);
    });

    test('isMarketHalfDay', () => {
        expect(isMarketHalfDay('2026-11-27')).toBe(true);
        expect(isMarketHalfDay('2026-11-24')).toBe(false);
    });
});

describe('isTradeableSession (the bell-race gate, 2026-08-11)', () => {
    test('regular and pre-market sessions accept brackets; post-close and closed do not', async () => {
        const { isTradeableSession, MarketSession } = await import('./market-hours.js');
        expect(isTradeableSession(MarketSession.REGULAR)).toBe(true);
        expect(isTradeableSession(MarketSession.PRE_MARKET)).toBe(true);
        expect(isTradeableSession(MarketSession.AFTER_HOURS)).toBe(false);
        expect(isTradeableSession(MarketSession.CLOSED)).toBe(false);
    });
});

describe('calendarCoverageStatus (WP0.5 — the 2028 cliff)', () => {
    test('mid-coverage years are ok', () => {
        expect(calendarCoverageStatus('2026-08-20').status).toBe('ok');
        expect(calendarCoverageStatus('2027-06-15').status).toBe('ok');
    });

    test('December of the last covered year warns', () => {
        expect(calendarCoverageStatus('2027-12-01').status).toBe('expiring');
        expect(calendarCoverageStatus('2027-12-31').status).toBe('expiring');
    });

    test('past the table every holiday is a phantom trading day — expired', () => {
        const v = calendarCoverageStatus('2028-01-01');
        expect(v.status).toBe('expired');
        expect(v.lastCoveredYear).toBe(2027);
    });
});

describe('intradayEntryCutoffReached (review-21 — no new DAY entries inside the triage window)', () => {
    test('latches at close − 8 min, half-day aware, and holds for the rest of the day', async () => {
        const { intradayEntryCutoffReached } = await import('./market-hours.js');
        const FULL = 16 * 60, HALF = 13 * 60;
        expect(intradayEntryCutoffReached(15 * 60 + 51, FULL)).toBe(false); // 15:51 — accepts still open
        expect(intradayEntryCutoffReached(15 * 60 + 52, FULL)).toBe(true);  // 15:52 — the triage slot itself
        expect(intradayEntryCutoffReached(15 * 60 + 59, FULL)).toBe(true);  // the exact hole review-21 named
        expect(intradayEntryCutoffReached(16 * 60 + 30, FULL)).toBe(true);  // after close (session gate also refuses)
        expect(intradayEntryCutoffReached(9 * 60 + 30, FULL)).toBe(false);  // the open
        expect(intradayEntryCutoffReached(12 * 60 + 52, HALF)).toBe(true);  // half-day triage slot
        expect(intradayEntryCutoffReached(12 * 60 + 51, HALF)).toBe(false);
    });
});
