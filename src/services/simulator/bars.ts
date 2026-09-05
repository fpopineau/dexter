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
import { getIntradayBars } from '../data-archive.js';
import { barTimeFrameMs, etFrameMs } from '../outcome-tracker.js';
import type { SimBar } from './fill-model.js';

export type SimBarSource = 'stream-5s' | 'archive-1m' | 'ibkr-1m';

const DAY_MS = 86_400_000;
const RTH_OPEN_MIN = 9 * 60 + 30;
const RTH_CLOSE_MIN = 16 * 60;
const HALF_DAY_CLOSE_MIN = 13 * 60;

/** ET-frame ms → the epoch ms whose ET wall clock reads that frame. */
export function frameToEpochMs(frameMs: number): number {
    // etFrameMs(epoch) = epoch + offset(epoch); the offset is stable across
    // the day except at a DST transition, so one correction step suffices.
    const guess = frameMs - (etFrameMs(frameMs) - frameMs);
    const err = etFrameMs(guess) - frameMs;
    return err === 0 ? guess : guess - err;
}

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
 *  or everything when `rth` is false. */
export function sessionFilter(bars: SimBar[], opts: { rth: boolean; halfDay: boolean }): SimBar[] {
    if (!opts.rth) return bars;
    const close = opts.halfDay ? HALF_DAY_CLOSE_MIN : RTH_CLOSE_MIN;
    return bars.filter((b) => {
        const minutes = Math.floor((b.t % DAY_MS) / 60_000);
        return minutes >= RTH_OPEN_MIN && minutes < close;
    });
}

export interface SimBarLoaders {
    stream: (symbol: string, fromT: number, toT: number) => Promise<SimBar[]>;
    archive: (symbol: string, fromT: number, toT: number) => Promise<SimBar[]>;
    ibkr: (symbol: string, fromT: number, toT: number) => Promise<SimBar[]>;
}

export interface LoadOptions {
    rth: boolean;
    halfDay: boolean;
    maxGapMs: { stream: number; archive: number; ibkr: number };
}

export const DEFAULT_MAX_GAP_MS = { stream: 60_000, archive: 5 * 60_000, ibkr: 5 * 60_000 };

/** Try the sources in order; the first one whose session-filtered bars
 *  cover the window wins. A loader failure counts as no data. */
export async function loadSimBars(
    symbol: string,
    fromT: number,
    toT: number,
    opts: LoadOptions,
    loaders: SimBarLoaders = defaultLoaders,
): Promise<{ bars: SimBar[]; source: SimBarSource } | null> {
    const attempts: Array<[SimBarSource, keyof SimBarLoaders]> = [['stream-5s', 'stream'], ['archive-1m', 'archive'], ['ibkr-1m', 'ibkr']];
    for (const [source, key] of attempts) {
        let raw: SimBar[];
        try {
            raw = await loaders[key](symbol, fromT, toT);
        } catch (err) {
            logger.warn(`[simulator] ${symbol}: ${source} loader failed — ${err instanceof Error ? err.message : err}`);
            continue;
        }
        const bars = sessionFilter(raw.filter((b) => b.t >= fromT - opts.maxGapMs[key] && b.t <= toT + opts.maxGapMs[key]), opts);
        if (coverageOk(bars, fromT, toT, opts.maxGapMs[key])) return { bars, source };
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
