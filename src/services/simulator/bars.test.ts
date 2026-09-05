import { describe, expect, test } from 'bun:test';
import { coverageOk, coverageOkAcross, frameToEpochMs, loadSimBars, segmentFilter, sessionFilter, sessionSegments, type SimBarLoaders } from './bars.js';
import type { SimBar } from './fill-model.js';
import { etFrameMs } from '../outcome-tracker.js';

const M = 60_000;
const D = Date.UTC(2026, 8, 10, 0, 0, 0); // ET-frame midnight
const at = (h: number, m: number): number => D + h * 3_600_000 + m * M;
const bars = (times: number[]): SimBar[] => times.map((t) => ({ t, open: 1, high: 1, low: 1, close: 1 }));

describe('coverageOk (REQ-SIM-003 — bars must span the window without gaps)', () => {
    test('covered: first bar near the start, last bar near the end, no gap over the tolerance', () => {
        const b = bars([at(9, 31), at(9, 32), at(9, 33), at(9, 34), at(9, 35)]);
        expect(coverageOk(b, at(9, 30), at(9, 35), 2 * M)).toBe(true);
    });

    test('a hole inside, a late start or an early end fails coverage', () => {
        expect(coverageOk(bars([at(9, 31), at(9, 32), at(9, 40), at(9, 41)]), at(9, 30), at(9, 41), 2 * M)).toBe(false);
        expect(coverageOk(bars([at(9, 40), at(9, 41)]), at(9, 30), at(9, 41), 2 * M)).toBe(false);
        expect(coverageOk(bars([at(9, 31), at(9, 32)]), at(9, 30), at(9, 45), 2 * M)).toBe(false);
        expect(coverageOk([], at(9, 30), at(9, 45), 2 * M)).toBe(false);
    });
});

describe('sessionSegments + coverageOkAcross (REQ-SIM-003 amended — the overnight gap is not a hole)', () => {
    const cal = { isHoliday: (d: string) => d === '2026-09-07', isHalfDay: (d: string) => d === '2026-11-27' };
    const DAY = 86_400_000;
    // 2026-09-10 is a Thursday; 11 Friday; 14 Monday.
    test('a 15:35 → next-day 10:00 window splits into two regular-session segments', () => {
        const segs = sessionSegments(at(15, 35), D + DAY + 10 * 3_600_000, cal);
        expect(segs.map((s) => [s.dateIso, s.from, s.to, s.close])).toEqual([
            ['2026-09-10', at(15, 35), at(16, 0), at(16, 0)],
            ['2026-09-11', D + DAY + 9.5 * 3_600_000, D + DAY + 10 * 3_600_000, D + DAY + 16 * 3_600_000],
        ]);
    });

    test('weekends and holidays are skipped; a half-day closes at 13:00; a window outside every session has no segment', () => {
        // Friday 09-11 15:00 → Monday 09-14 10:00: Sat/Sun produce nothing
        const fri = D + DAY;
        const segs = sessionSegments(fri + 15 * 3_600_000, fri + 3 * DAY + 10 * 3_600_000, cal);
        expect(segs.map((s) => s.dateIso)).toEqual(['2026-09-11', '2026-09-14']);
        // Labor Day 2026-09-07 (Mon) is a holiday in this calendar: Fri 09-04 → Tue 09-08
        const fri4 = D - 6 * DAY;
        expect(sessionSegments(fri4 + 15 * 3_600_000, fri4 + 4 * DAY + 10 * 3_600_000, cal).map((s) => s.dateIso)).toEqual(['2026-09-04', '2026-09-08']);
        // half-day 2026-11-27 (Fri): the segment ends at 13:00
        const nov27 = Date.UTC(2026, 10, 27);
        const h = sessionSegments(nov27 + 9 * 3_600_000, nov27 + 16 * 3_600_000, cal);
        expect(h).toEqual([{ dateIso: '2026-11-27', from: nov27 + 9.5 * 3_600_000, to: nov27 + 13 * 3_600_000, close: nov27 + 13 * 3_600_000 }]);
        // 17:00 → 19:00 same day: outside the session
        expect(sessionSegments(at(17, 0), at(19, 0), cal)).toEqual([]);
        expect(coverageOkAcross(bars([at(17, 0)]), [], M)).toBe(false);
    });

    test('coverage across: both segments covered → ok; a hole inside one session → not ok; the gap between sessions is ignored', () => {
        const segs = sessionSegments(at(15, 57), D + DAY + 9.5 * 3_600_000 + 3 * M, cal);
        const day1 = [at(15, 57), at(15, 58), at(15, 59)];
        const day2 = [0, 1, 2, 3].map((i) => D + DAY + 9.5 * 3_600_000 + i * M);
        expect(coverageOkAcross(bars([...day1, ...day2]), segs, 2 * M)).toBe(true);
        expect(coverageOkAcross(bars([...day1, day2[0], day2[3]]), segs, 2 * M)).toBe(false); // hole inside session 2
        expect(coverageOkAcross(bars(day2), segs, 2 * M)).toBe(false);                        // session 1 missing
        // 15:56 precedes the window, 16:00 is a post-close print, the 09:33 deadline bar (window end) is kept
        expect(segmentFilter(bars([at(15, 56), ...day1, at(16, 0), ...day2]), segs).map((b) => b.t)).toEqual([...day1, ...day2]);
    });

    test('loadSimBars with rth judges per segment: a two-session archive window is covered (the old single-window check refused it)', async () => {
        const from = at(15, 58);
        const to = D + DAY + 9.5 * 3_600_000 + 2 * M;
        const twoSessions = bars([at(15, 58), at(15, 59), D + DAY + 9.5 * 3_600_000, D + DAY + 9.5 * 3_600_000 + M, D + DAY + 9.5 * 3_600_000 + 2 * M]);
        const loaders: SimBarLoaders = { stream: async () => [], archive: async () => twoSessions, ibkr: async () => [] };
        const r = await loadSimBars('MU', from, to, { rth: true, halfDay: false, maxGapMs: { stream: M, archive: 2 * M, ibkr: 2 * M }, calendar: cal }, loaders);
        expect(r?.source).toBe('archive-1m');
        expect(r?.bars).toHaveLength(5);
        // the legacy single-window judgement (rth false) still sees the overnight gap as a hole
        expect(await loadSimBars('MU', from, to, { rth: false, halfDay: false, maxGapMs: { stream: M, archive: 2 * M, ibkr: 2 * M } }, loaders)).toBeNull();
    });
});

describe('sessionFilter', () => {
    test('regular-session filter keeps 09:30-16:00 ET (13:00 on a half day); extended keeps everything', () => {
        const b = bars([at(8, 0), at(9, 30), at(12, 59), at(13, 30), at(15, 59), at(16, 0), at(17, 0)]);
        expect(sessionFilter(b, { rth: true, halfDay: false }).map((x) => x.t)).toEqual([at(9, 30), at(12, 59), at(13, 30), at(15, 59)]);
        expect(sessionFilter(b, { rth: true, halfDay: true }).map((x) => x.t)).toEqual([at(9, 30), at(12, 59)]);
        expect(sessionFilter(b, { rth: false, halfDay: false })).toHaveLength(7);
    });
});

describe('frameToEpochMs inverts etFrameMs', () => {
    test('round trip on a summer and a winter instant', () => {
        for (const epoch of [Date.UTC(2026, 6, 15, 14, 0, 0), Date.UTC(2026, 0, 15, 14, 0, 0)]) {
            const frame = etFrameMs(epoch);
            expect(frameToEpochMs(frame)).toBe(epoch);
        }
    });
});

describe('loadSimBars — source order: stream 5s → archive 1-min → IBKR 1-min; the first COVERED source wins', () => {
    const win = { from: at(10, 0), to: at(10, 5) };
    const full = bars([at(10, 0), at(10, 1), at(10, 2), at(10, 3), at(10, 4), at(10, 5)]);
    const gappy = bars([at(10, 0), at(10, 5)]);

    test('stream bars win when they cover the window', async () => {
        const calls: string[] = [];
        const loaders: SimBarLoaders = {
            stream: async () => { calls.push('stream'); return full; },
            archive: async () => { calls.push('archive'); return full; },
            ibkr: async () => { calls.push('ibkr'); return full; },
        };
        const r = await loadSimBars('MU', win.from, win.to, { rth: true, halfDay: false, maxGapMs: { stream: 2 * M, archive: 2 * M, ibkr: 2 * M } }, loaders);
        expect(r?.source).toBe('stream-5s');
        expect(calls).toEqual(['stream']);
    });

    test('a gappy stream falls back to the archive; a gappy archive falls back to IBKR; nothing covered → null', async () => {
        const mk = (s: SimBar[], a: SimBar[], i: SimBar[] | null): SimBarLoaders => ({
            stream: async () => s, archive: async () => a, ibkr: async () => { if (i === null) throw new Error('paced out'); return i; },
        });
        const opts = { rth: true, halfDay: false, maxGapMs: { stream: 2 * M, archive: 2 * M, ibkr: 2 * M } };
        expect((await loadSimBars('MU', win.from, win.to, opts, mk(gappy, full, full)))?.source).toBe('archive-1m');
        expect((await loadSimBars('MU', win.from, win.to, opts, mk(gappy, gappy, full)))?.source).toBe('ibkr-1m');
        expect(await loadSimBars('MU', win.from, win.to, opts, mk(gappy, gappy, gappy))).toBeNull();
        expect(await loadSimBars('MU', win.from, win.to, opts, mk(gappy, gappy, null))).toBeNull(); // loader failure = no data, never a fabricated fill
    });
});
