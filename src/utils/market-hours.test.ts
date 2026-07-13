import { describe, expect, test } from 'bun:test';
import { getMarketSession, isMarketHalfDay, isMarketHoliday, MarketSession } from './market-hours.js';

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
