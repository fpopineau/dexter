import { describe, expect, test } from 'bun:test';
import { etCloseInstantMs, isPatternScanStale, lastCompletedTradingDayEt } from './pattern-scanner.js';

// August 2026 dates, EDT (-04:00). Thu 2026-08-06 is the reference "today";
// Mon 08-03 / Fri 07-31 / Sat 08-01 / Sun 08-02 cover the weekend walk.
// No US market holidays in this window — keeps the tests independent of
// the holiday table.
const at = (iso: string) => new Date(iso);

describe('lastCompletedTradingDayEt', () => {
    test('weekday pre-market → the previous trading day', () => {
        expect(lastCompletedTradingDayEt(at('2026-08-06T05:45:00-04:00'))).toBe('2026-08-05');
    });

    test('weekday during the session → still the previous trading day', () => {
        expect(lastCompletedTradingDayEt(at('2026-08-06T15:59:00-04:00'))).toBe('2026-08-05');
    });

    test('weekday at/after the close → today', () => {
        expect(lastCompletedTradingDayEt(at('2026-08-06T16:00:00-04:00'))).toBe('2026-08-06');
        expect(lastCompletedTradingDayEt(at('2026-08-06T18:01:00-04:00'))).toBe('2026-08-06');
    });

    test('Monday pre-market → Friday', () => {
        expect(lastCompletedTradingDayEt(at('2026-08-03T07:00:00-04:00'))).toBe('2026-07-31');
    });

    test('weekend → Friday', () => {
        expect(lastCompletedTradingDayEt(at('2026-08-01T12:00:00-04:00'))).toBe('2026-07-31'); // Sat
        expect(lastCompletedTradingDayEt(at('2026-08-02T12:00:00-04:00'))).toBe('2026-07-31'); // Sun
    });
});

describe('isPatternScanStale', () => {
    const thuPreMarket = at('2026-08-06T05:45:00-04:00');
    const thuAfterClose = at('2026-08-06T18:01:00-04:00');

    test('no snapshot is always stale', () => {
        expect(isPatternScanStale(null, thuPreMarket)).toBe(true);
        expect(isPatternScanStale(undefined, thuPreMarket)).toBe(true);
        expect(isPatternScanStale(NaN, thuPreMarket)).toBe(true);
    });

    test('a scan from Wednesday evening is fresh on Thursday pre-market', () => {
        const wedEvening = Date.parse('2026-08-05T18:30:00-04:00');
        expect(isPatternScanStale(wedEvening, thuPreMarket)).toBe(false);
    });

    test('a scan from this morning is fresh during the day…', () => {
        const thuMorning = Date.parse('2026-08-06T05:47:00-04:00');
        expect(isPatternScanStale(thuMorning, thuPreMarket)).toBe(false);
        expect(isPatternScanStale(thuMorning, at('2026-08-06T15:00:00-04:00'))).toBe(false);
    });

    test('…but STALE after that same day\'s close — a pre-close scan lacks the session', () => {
        // The 2026-08-06 live case: the 05:47 ET rescue scan (bars ≤ Aug 4)
        // must not satisfy the catch-up at the 22:0x UTC restart, or a
        // killed sweep leaves tomorrow's brief on two-day-old bars.
        const thuMorning = Date.parse('2026-08-06T05:47:00-04:00');
        expect(isPatternScanStale(thuMorning, thuAfterClose)).toBe(true);
        // An after-close scan the same evening is fresh.
        const thuEvening = Date.parse('2026-08-06T18:10:00-04:00');
        expect(isPatternScanStale(thuEvening, thuAfterClose)).toBe(false);
    });

    test('etCloseInstantMs handles EDT and EST offsets', () => {
        expect(etCloseInstantMs('2026-08-06')).toBe(Date.parse('2026-08-06T16:00:00-04:00')); // EDT
        expect(etCloseInstantMs('2026-01-15')).toBe(Date.parse('2026-01-15T16:00:00-05:00')); // EST
    });

    test('the six-day dry spell: a Jul-31 scan is stale on Aug 6', () => {
        const jul31 = Date.parse('2026-07-31T06:48:00-04:00');
        expect(isPatternScanStale(jul31, thuPreMarket)).toBe(true);
    });

    test('the collision-recovery case: after the close, yesterday\'s scan is stale', () => {
        // The 22:0x UTC restart that kills the sweep boots a gateway that
        // sees Wednesday's snapshot vs Thursday's completed session → rescan.
        const wedEvening = Date.parse('2026-08-05T18:30:00-04:00');
        expect(isPatternScanStale(wedEvening, thuAfterClose)).toBe(true);
    });

    test('Monday morning accepts Friday-evening scans', () => {
        const friEvening = Date.parse('2026-07-31T18:15:00-04:00');
        expect(isPatternScanStale(friEvening, at('2026-08-03T07:00:00-04:00'))).toBe(false);
    });
});
