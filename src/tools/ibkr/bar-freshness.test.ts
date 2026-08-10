import { describe, expect, test } from 'bun:test';
import { assessBarFreshness } from './signal-scorer.js';

// Times below are built so the ET rendering is unambiguous: the `now`
// Dates are UTC instants; America/New_York is UTC-4 in August (EDT).

describe('assessBarFreshness (2026-08-05 stale-farm incident)', () => {
    test('fresh 5-min bar during RTH → not stale', () => {
        // now = 14:32 ET (18:32Z), newest bar 14:30 ET
        const f = assessBarFreshness('20260805 14:30:00', new Date('2026-08-05T18:32:00Z'));
        expect(f.stale).toBe(false);
        expect(f.lastBarAgeMin).toBe(2);
    });

    test("the incident shape: yesterday's close served DURING RTH → STALE", () => {
        // The 2026-08-05 farm lag was noticed mid-session after IB Gateway's
        // noon restart. now = 12:30 ET Wednesday, newest bar Tue 15:55 ET.
        const f = assessBarFreshness('20260804 15:55:00', new Date('2026-08-05T16:30:00Z'));
        expect(f.stale).toBe(true);
        expect(f.lastBarAgeMin).toBeGreaterThan(900);
        expect(f.staleNote).toContain('STALE DATA');
        expect(f.staleNote).toContain('Do NOT size a trade');
    });

    test("weekend gap pre-market is FRESH: Friday close on Monday 06:57 ET (NVDA 2026-08-10)", () => {
        // Scorer bars are RTH-only: before 09:30 ET no newer bar CAN exist,
        // so a 3700-minute weekend age is a calendar fact, not a lagging feed.
        const f = assessBarFreshness('20260807 15:55:00', new Date('2026-08-10T10:57:00Z'));
        expect(f.stale).toBe(false);
        expect(f.lastBarAgeMin).toBeGreaterThan(3600);
    });

    test('same old bar on a SATURDAY → not stale (no new bars expected)', () => {
        // 2026-08-08 is a Saturday; now = 10:00 ET Sat
        const f = assessBarFreshness('20260807 19:55:00', new Date('2026-08-08T14:00:00Z'));
        expect(f.stale).toBe(false);
        expect(f.lastBarAgeMin).toBeGreaterThan(0);
    });

    test('overnight (after 20:00 ET) with the close as newest bar → not stale', () => {
        // now = 22:30 ET Wed (02:30Z Thu), newest bar Wed 19:55 ET
        const f = assessBarFreshness('20260805 19:55:00', new Date('2026-08-06T02:30:00Z'));
        expect(f.stale).toBe(false);
    });

    test('RTH boundary: 09:34 ET is grace, 09:36 ET expects fresh bars', () => {
        const closing = '20260804 15:55:00';
        expect(assessBarFreshness(closing, new Date('2026-08-05T13:34:00Z')).stale).toBe(false); // 09:34 ET grace
        expect(assessBarFreshness(closing, new Date('2026-08-05T13:36:00Z')).stale).toBe(true);  // 09:36 ET
    });

    test('daily bars and garbage fail open', () => {
        const daily = assessBarFreshness('20260805', new Date('2026-08-05T18:32:00Z'));
        expect(daily.stale).toBe(false);
        expect(daily.lastBarAgeMin).toBeNull();
        const garbage = assessBarFreshness('finished-20260805', new Date('2026-08-05T18:32:00Z'));
        expect(garbage.stale).toBe(false);
        expect(garbage.lastBarAgeMin).toBeNull();
        expect(assessBarFreshness(undefined).stale).toBe(false);
    });

    test('16-minute lag during RTH crosses the threshold, 14 does not', () => {
        const now = new Date('2026-08-05T18:32:00Z'); // 14:32 ET Wed
        expect(assessBarFreshness('20260805 14:18:00', now).stale).toBe(false); // 14 min
        expect(assessBarFreshness('20260805 14:16:00', now).stale).toBe(true);  // 16 min
    });
});
