/**
 * Simulator bar sources (REQ-SIM-003, live-loop WP2).
 *
 * Order of preference, first COVERED source wins:
 *   1. stream-5s   the gateway's realtime 5-second bars (stream-bars.db) —
 *                  only the streamed top-N symbols have them;
 *   2. archive-1m  the nightly 1-minute archive (market-archive.db,
 *                  extended hours included since 2026-08-25);
 *   3. ibkr-1m     a paced IBKR historical request (the benchmark's path).
 * Coverage = first bar within one gap of the window start, last bar within
 * one gap of the end, no internal gap over the tolerance — judged on the
 * session-filtered bars (DAY rows trade the regular session only). No
 * covered source → null: the caller records 'unknown', never a fill.
 *
 * Times: ET-frame ms everywhere (outcome-tracker convention). Stream bar
 * `time` is unix seconds → etFrameMs; archive strings → barTimeFrameMs.
 */

import { BarSizeSetting } from '@stoqey/ib';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fetchBars } from '@/tools/ibkr/signal-scorer.js';
import { logger } from '@/utils';
import { isMarketHalfDay, isMarketHoliday } from '@/utils/market-hours.js';
import { getIntradayBars } from '../data-archive.js';
import { barTimeFrameMs, etFrameMs, frameToEpochMs } from '../outcome-tracker.js';
import type { SimBar } from './fill-model.js';

export type SimBarSource = 'stream-5s' | 'archive-1m' | 'ibkr-1m';

const DAY_MS = 86_400_000;
const RTH_OPEN_MIN = 9 * 60 + 30;
const RTH_CLOSE_MIN = 16 * 60;
const HALF_DAY_CLOSE_MIN = 13 * 60;

/** ET-frame ms → the epoch ms whose ET wall clock reads that frame (lives
 *  in outcome-tracker next to etFrameMs; re-exported for the loaders). */
export { frameToEpochMs } from '../outcome-tracker.js';

/** Pure: does the bar series cover [fromT, toT] without holes? */
export function coverageOk(bars: SimBar[], fromT: number, toT: number, maxGapMs: number): boolean {
    if (bars.length === 0) return false;
    const sorted = [...bars].sort((a, b) => a.t - b.t);
    if (sorted[0].t > fromT + maxGapMs) return false;
    if (sorted[sorted.length - 1].t < toT - maxGapMs) return false;
    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].t - sorted[i - 1].t > maxGapMs) return false;
    }
    return true;
}

/** Pure: keep regular-session bars (09:30 → 16:00 ET, 13:00 on a half day),
 *  or everything when `rth` is false. Single-day semantics (one half-day
 *  flag); multi-session windows go through `sessionSegments`. */
export function sessionFilter(bars: SimBar[], opts: { rth: boolean; halfDay: boolean }): SimBar[] {
    if (!opts.rth) return bars;
    const close = opts.halfDay ? HALF_DAY_CLOSE_MIN : RTH_CLOSE_MIN;
    return bars.filter((b) => {
        const minutes = Math.floor((b.t % DAY_MS) / 60_000);
        return minutes >= RTH_OPEN_MIN && minutes < close;
    });
}

/** The market calendar the segment builder consults (ET ISO dates). */
export interface SessionCalendar {
    isHoliday(dateIso: string): boolean;
    isHalfDay(dateIso: string): boolean;
}

export const marketCalendar: SessionCalendar = { isHoliday: isMarketHoliday, isHalfDay: isMarketHalfDay };

export interface SessionSegment {
    from: number;
    /** min(window end, session close) — inclusive: the deadline bar at the window end belongs to the segment. */
    to: number;
    /** The session close (exclusive: a bar stamped at the close is a post-close print). */
    close: number;
    dateIso: string;
}

/**
 * Pure (REQ-SIM-003 amended, WP7): the regular-session segments that
 * intersect [fromT, toT] (ET-frame ms) — one per trading day, 09:30 → 16:00
 * (13:00 on a half-day), weekends and holidays skipped. Coverage is judged
 * per segment: the overnight gap between two sessions is NOT a hole. Before
 * this, every GTC twin spanning a close came back 'unknown' (the coverage
 * check saw an 8-hour gap; simulator.db, 2026-09-05).
 */
export function sessionSegments(fromT: number, toT: number, cal: SessionCalendar = marketCalendar): SessionSegment[] {
    const out: SessionSegment[] = [];
    if (!(toT > fromT)) return out;
    for (let dayStart = Math.floor(fromT / DAY_MS) * DAY_MS; dayStart <= toT; dayStart += DAY_MS) {
        const d = new Date(dayStart);
        const dow = d.getUTCDay();
        if (dow === 0 || dow === 6) continue;
        const dateIso = d.toISOString().slice(0, 10);
        if (cal.isHoliday(dateIso)) continue;
        const open = dayStart + RTH_OPEN_MIN * 60_000;
        const close = dayStart + (cal.isHalfDay(dateIso) ? HALF_DAY_CLOSE_MIN : RTH_CLOSE_MIN) * 60_000;
        const from = Math.max(fromT, open);
        const to = Math.min(toT, close);
        if (to > from) out.push({ from, to, close, dateIso });
    }
    return out;
}

/** Pure: every segment covered (start, end, no internal gap over the
 *  tolerance); no segment at all (a window entirely outside the sessions)
 *  is NOT covered — there is nothing to replay honestly. */
export function coverageOkAcross(bars: SimBar[], segments: SessionSegment[], maxGapMs: number): boolean {
    if (segments.length === 0) return false;
    return segments.every((s) => coverageOk(bars.filter((b) => b.t >= s.from - maxGapMs && b.t <= s.to + maxGapMs), s.from, s.to, maxGapMs));
}

/** Pure: keep the bars inside any segment (the regular sessions of the window). */
export function segmentFilter(bars: SimBar[], segments: SessionSegment[]): SimBar[] {
    return bars.filter((b) => segments.some((s) => b.t >= s.from && b.t <= s.to && b.t < s.close));
}

export interface SimBarLoaders {
    stream: (symbol: string, fromT: number, toT: number) => Promise<SimBar[]>;
    archive: (symbol: string, fromT: number, toT: number) => Promise<SimBar[]>;
    ibkr: (symbol: string, fromT: number, toT: number) => Promise<SimBar[]>;
}

export interface LoadOptions {
    /** Regular-session bars only. Every simulator row uses true since WP7:
     *  Dexter's brackets never set `outsideRth`, so a stop cannot fill
     *  after hours; the gap-aware model prices an open through the stop. */
    rth: boolean;
    /** Legacy single-day flag (rth without a calendar). Ignored when a
     *  calendar is supplied — the segments carry each day's own close. */
    halfDay: boolean;
    maxGapMs: { stream: number; archive: number; ibkr: number };
    /** Session calendar for multi-session windows (default: market hours). */
    calendar?: SessionCalendar;
}

export const DEFAULT_MAX_GAP_MS = { stream: 60_000, archive: 5 * 60_000, ibkr: 5 * 60_000 };

/** Try the sources in order; the first one whose session bars cover every
 *  regular-session segment of the window wins. A loader failure counts as
 *  no data. `rth: false` keeps the legacy single-window judgement. */
export async function loadSimBars(
    symbol: string,
    fromT: number,
    toT: number,
    opts: LoadOptions,
    loaders: SimBarLoaders = defaultLoaders,
): Promise<{ bars: SimBar[]; source: SimBarSource } | null> {
    const attempts: Array<[SimBarSource, keyof SimBarLoaders]> = [['stream-5s', 'stream'], ['archive-1m', 'archive'], ['ibkr-1m', 'ibkr']];
    const segments = opts.rth ? sessionSegments(fromT, toT, opts.calendar ?? marketCalendar) : null;
    for (const [source, key] of attempts) {
        let raw: SimBar[];
        try {
            raw = await loaders[key](symbol, fromT, toT);
        } catch (err) {
            logger.warn(`[simulator] ${symbol}: ${source} loader failed — ${err instanceof Error ? err.message : err}`);
            continue;
        }
        const gap = opts.maxGapMs[key];
        const windowed = raw.filter((b) => b.t >= fromT - gap && b.t <= toT + gap);
        if (segments) {
            const bars = segmentFilter(windowed, segments);
            if (coverageOkAcross(bars, segments, gap)) return { bars, source };
        } else {
            const bars = sessionFilter(windowed, opts);
            if (coverageOk(bars, fromT, toT, gap)) return { bars, source };
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Live loaders
// ---------------------------------------------------------------------------

interface SqliteQuery<T> { all(...params: unknown[]): T[] }
interface SqliteDb { query<T>(sql: string): SqliteQuery<T>; close(): void }

async function openReadOnly(path: string): Promise<SqliteDb | null> {
    if (!existsSync(path)) return null;
    try {
        const sqlite = await import('bun:sqlite');
        const raw = new sqlite.Database(path, { readonly: true });
        return {
            query: <T>(sql: string) => ({ all: (...p: unknown[]) => raw.query(sql).all(...(p as never[])) as T[] }),
            close: () => raw.close(),
        };
    } catch {
        const mod = await import('better-sqlite3');
        const raw = new mod.default(path, { readonly: true });
        return {
            query: <T>(sql: string) => ({ all: (...p: unknown[]) => raw.prepare(sql).all(...p) as T[] }),
            close: () => raw.close(),
        };
    }
}

interface StreamRow { time: number; open: number; high: number; low: number; close: number; volume: number | null }

async function loadStreamBars(symbol: string, fromT: number, toT: number): Promise<SimBar[]> {
    const dir = process.env.DEXTER_DATA_DIR ?? join(process.cwd(), '.dexter', 'data');
    const db = await openReadOnly(join(dir, 'stream-bars.db'));
    if (!db) return [];
    try {
        const fromSec = Math.floor(frameToEpochMs(fromT) / 1000) - 60;
        const toSec = Math.ceil(frameToEpochMs(toT) / 1000) + 60;
        const rows = db.query<StreamRow>(
            `SELECT time, open, high, low, close, volume FROM stream_bars WHERE symbol = ? AND time BETWEEN ? AND ? ORDER BY time`,
        ).all(symbol.toUpperCase(), fromSec, toSec);
        return rows.map((r) => ({ t: etFrameMs(r.time * 1000), open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume ?? undefined }));
    } finally {
        db.close();
    }
}

async function loadArchiveBars(symbol: string, fromT: number, toT: number): Promise<SimBar[]> {
    const rows = await getIntradayBars(symbol.toUpperCase(), '1 min');
    const out: SimBar[] = [];
    for (const r of rows) {
        const t = barTimeFrameMs(r.time);
        if (t === null || t < fromT - DAY_MS || t > toT + DAY_MS) continue;
        out.push({ t, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume });
    }
    return out;
}

/** IBKR historical pacing (the benchmark's 300 ms between requests). */
const IBKR_PACE_MS = 300;

async function loadIbkrBars(symbol: string): Promise<SimBar[]> {
    await new Promise((r) => setTimeout(r, IBKR_PACE_MS));
    const bars = await fetchBars(symbol.toUpperCase(), BarSizeSetting.MINUTES_ONE, '2 D', false);
    const out: SimBar[] = [];
    for (const b of bars) {
        const t = barTimeFrameMs(b.time);
        if (t === null || b.open == null || b.high == null || b.low == null || b.close == null) continue;
        out.push({ t, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? undefined });
    }
    return out;
}

export const defaultLoaders: SimBarLoaders = {
    stream: loadStreamBars,
    archive: loadArchiveBars,
    ibkr: (symbol) => loadIbkrBars(symbol),
};
