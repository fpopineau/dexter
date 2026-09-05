import { describe, expect, test } from 'bun:test';
import { coverageOk, frameToEpochMs, loadSimBars, sessionFilter, type SimBarLoaders } from './bars.js';
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
