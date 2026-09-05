import { describe, expect, test } from 'bun:test';
import { computeNextRunAtMs, nextSessionCloseFire, sessionCloseMsFor } from './schedule.js';

const et = (y: number, mo: number, d: number, h: number, mi: number) => {
    // ET wall clock → epoch: EDT (UTC−4) from mid-March to early November, EST (UTC−5) otherwise (2026 dates used below)
    const edt = (mo > 3 && mo < 11) || (mo === 3 && d >= 8) || (mo === 11 && d < 1);
    return Date.UTC(y, mo - 1, d, h + (edt ? 4 : 5), mi, 0);
};

describe('session-close schedule (review 2026-09-06 — the Pre-Close Review follows the market calendar)', () => {
    test('a full day fires 30 min before 16:00 ET; the same day past it rolls to the next trading day', () => {
        expect(nextSessionCloseFire(et(2026, 9, 10, 10, 0), 30)).toBe(et(2026, 9, 10, 15, 30)); // Thu → Thu 15:30
        expect(nextSessionCloseFire(et(2026, 9, 10, 15, 31), 30)).toBe(et(2026, 9, 11, 15, 30)); // past it → Fri 15:30
        expect(nextSessionCloseFire(et(2026, 9, 11, 17, 0), 30)).toBe(et(2026, 9, 14, 15, 30));  // Fri evening → Mon 15:30
    });

    test('a half-day (2026-11-27) fires 30 min before 13:00 ET; a holiday (Labor Day 2026-09-07) is skipped', () => {
        expect(nextSessionCloseFire(et(2026, 11, 27, 9, 0), 30)).toBe(et(2026, 11, 27, 12, 30));
        expect(nextSessionCloseFire(et(2026, 9, 5, 12, 0), 30)).toBe(et(2026, 9, 8, 15, 30)); // Sat → skips Mon holiday → Tue
    });

    test('offset 0 is the close itself; computeNextRunAtMs dispatches and refuses a nonsense offset', () => {
        expect(nextSessionCloseFire(et(2026, 9, 10, 10, 0), 0)).toBe(et(2026, 9, 10, 16, 0));
        expect(computeNextRunAtMs({ kind: 'session-close', offsetMin: 30, tz: 'America/New_York' }, et(2026, 9, 10, 10, 0))).toBe(et(2026, 9, 10, 15, 30));
        expect(computeNextRunAtMs({ kind: 'session-close', offsetMin: -5 }, et(2026, 9, 10, 10, 0))).toBeUndefined();
        expect(computeNextRunAtMs({ kind: 'session-close', offsetMin: 9 * 60 }, et(2026, 9, 10, 10, 0))).toBeUndefined();
    });

    test('sessionCloseMsFor: the day\'s close (16:00 / 13:00 ET), null on a weekend or holiday — the executor\'s "not past the close" guard', () => {
        expect(sessionCloseMsFor(et(2026, 9, 10, 12, 0))).toBe(et(2026, 9, 10, 16, 0));
        expect(sessionCloseMsFor(et(2026, 11, 27, 12, 0))).toBe(et(2026, 11, 27, 13, 0));
        expect(sessionCloseMsFor(et(2026, 9, 12, 12, 0))).toBeNull(); // Saturday
        expect(sessionCloseMsFor(et(2026, 9, 7, 12, 0))).toBeNull();  // Labor Day
    });
});

describe('seeded-schedule migration (trading-schedules — a legacy seed follows the new seed, a tuned schedule is left alone)', () => {
    test('carriesLegacySchedule', async () => {
        const { carriesLegacySchedule } = await import('./trading-schedules.js');
        const def = { legacySchedules: [{ kind: 'cron' as const, expr: '30 15 * * 1-5', tz: 'America/New_York' }] };
        expect(carriesLegacySchedule({ schedule: { kind: 'cron', expr: '30 15 * * 1-5', tz: 'America/New_York' } }, def)).toBe(true);
        expect(carriesLegacySchedule({ schedule: { kind: 'cron', expr: '15 15 * * 1-5', tz: 'America/New_York' } }, def)).toBe(false); // operator-tuned
        expect(carriesLegacySchedule({ schedule: { kind: 'session-close', offsetMin: 30, tz: 'America/New_York' } }, def)).toBe(false);
        expect(carriesLegacySchedule({ schedule: { kind: 'cron', expr: '0 8 * * 1-5', tz: 'America/New_York' } }, {})).toBe(false);
    });
});
