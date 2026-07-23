import { describe, expect, test } from 'bun:test';
import { dailyBarTime, intradayBarTime } from './dashboard.js';

describe('dashboard time conversion', () => {
    test('daily archive time → chart date string', () => {
        expect(dailyBarTime('20260722')).toBe('2026-07-22');
    });

    test('intraday ET time → unix seconds (EDT months)', () => {
        // 2026-07-22 09:30 EDT = 13:30 UTC
        expect(intradayBarTime('20260722 09:30:00 US/Eastern')).toBe(Date.UTC(2026, 6, 22, 13, 30, 0) / 1000);
    });

    test('winter months use EST (−5h)', () => {
        // 2026-01-15 09:30 EST = 14:30 UTC
        expect(intradayBarTime('20260115 09:30:00 US/Eastern')).toBe(Date.UTC(2026, 0, 15, 14, 30, 0) / 1000);
    });
});
