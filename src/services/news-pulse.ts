/**
 * News pulse — batched GDELT DOC 2.0 sweep over the names the desk already
 * cares about: the open book, the earnings-reactor watchlist, and the
 * engine's current candidates.
 *
 * Fills the "no news-driven discovery" gap WITHOUT becoming a scoring
 * factor: per the 2026-08-05 research memo, GDELT stock-level sentiment
 * stays out of live scoring until an in-house IC test passes. This service
 * only makes news breadth VISIBLE — to the briefs via the news_pulse tool
 * and as an annotation on the opportunities snapshot — so the judgment
 * layer can chase a catalyst the price/volume scanners surfaced late.
 *
 * GDELT access is deliberately defensive (verified live 2026-08-11/12):
 *   - SEQUENTIAL MICRO-BATCHES (default 3 names per request, 6 s apart) —
 *     GDELT's throttle classifier refuses multi-term OR queries as
 *     "larger queries" regardless of maxrecords (12- and 24-name batches
 *     throttled every time across two days while 1-2-name queries passed
 *     seconds later from the same IP). The API also allows only
 *     1 request / 5 s, so the sweep paces itself and aborts on the first
 *     throttle, keeping whatever batches already landed as a PARTIAL
 *     snapshot (unmeasured symbols report as absent, never as quiet);
 *   - a throttled response is plain text, not JSON — it must read as
 *     "data unavailable" (previous snapshot kept, sweep backs off), never
 *     as "no news";
 *   - articles lag reality by ~15-35 min — this is catalyst confirmation
 *     and breadth, not a fast signal;
 *   - attribution is by company name in the TITLE: precision over recall
 *     (a body-only mention is invisible — accepted bias);
 *   - syndication spam (one wire story on 40 local outlets) is defused by
 *     counting unique TITLES for the article floor.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import axios from 'axios';
import { Cron } from 'croner';
import { logger } from '@/utils';
import { isMarketHoliday } from '@/utils/market-hours.js';
import { etDatePlus, getEarningsForDate, previousTradingDate } from './earnings-calendar.js';
import { getLatestSnapshot } from './opportunity-engine.js';
import { listTrackable } from './trade-proposals.js';
import { loadUniverse } from './universe-builder.js';

const ET = 'America/New_York';
/** :07/:27/:47 — off the quarter-hour GDELT publication beat. */
const SWEEP_CRON = '7,27,47 7-15 * * 1-5';
const GDELT_DOC_API = 'https://api.gdeltproject.org/api/v2/doc/doc';
const FETCH_TIMEOUT_MS = 30_000;

function windowMin(): number {
    return Number(process.env.NEWS_PULSE_WINDOW_MIN) > 0 ? Number(process.env.NEWS_PULSE_WINDOW_MIN) : 180;
}
function minArticles(): number {
    return Number(process.env.NEWS_PULSE_MIN_ARTICLES) > 0 ? Number(process.env.NEWS_PULSE_MIN_ARTICLES) : 4;
}
function minDomains(): number {
    return Number(process.env.NEWS_PULSE_MIN_DOMAINS) > 0 ? Number(process.env.NEWS_PULSE_MIN_DOMAINS) : 3;
}
function maxSymbols(): number {
    return Number(process.env.NEWS_PULSE_MAX_SYMBOLS) > 0 ? Number(process.env.NEWS_PULSE_MAX_SYMBOLS) : 24;
}
/** Names per GDELT request. 3 sits just above the proven-safe 2; larger
 *  OR batches are classified as "larger queries" and throttled. */
function batchSize(): number {
    return Number(process.env.NEWS_PULSE_BATCH_SIZE) > 0 ? Number(process.env.NEWS_PULSE_BATCH_SIZE) : 3;
}
/** Pause between batch requests (the API allows 1 request / 5 s). */
const BATCH_PACE_MS = 6_000;
/** Per-batch record cap — 3 names in a 3 h window rarely fill this. */
const BATCH_MAX_RECORDS = 50;
function backoffMin(): number {
    return Number(process.env.NEWS_PULSE_BACKOFF_MIN) > 0 ? Number(process.env.NEWS_PULSE_BACKOFF_MIN) : 30;
}

export function isNewsPulseEnabled(): boolean {
    return (process.env.NEWS_PULSE ?? 'true').trim().toLowerCase() !== 'false';
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GdeltArticle {
    title: string;
    domain: string;
    seendate: string;
    url: string;
}

export interface SymbolPulse {
    name: string;
    /** Unique headlines mentioning the name in the sweep window. */
    articles: number;
    /** Distinct publishing domains (incl. syndicated copies). */
    domains: number;
    /** articles ≥ floor AND domains ≥ floor — "the news is broad, not one wire". */
    hot: boolean;
    headlines: Array<{ title: string; domain: string; seendate: string }>;
}

export interface NewsPulseSnapshot {
    at: number;
    windowMin: number;
    watched: number;
    symbols: Record<string, SymbolPulse>;
}

// ---------------------------------------------------------------------------
// Pure pieces (unit-tested)
// ---------------------------------------------------------------------------

const LISTING_SUFFIX = / - .*$/;
const LEGAL_SUFFIX = /[,.]?\s+(incorporated|inc|corporation|corp|company|co|limited|ltd|plc|holdings?|group|sa|nv|ag|adr)\.?$/i;
/** Single-word names that are ordinary English words: matching them alone
 *  in headlines would attribute the whole news cycle to one ticker. */
const GENERIC_WORDS = new Set([
    'target', 'apple', 'ball', 'gap', 'coach', 'dollar', 'general', 'best',
    'first', 'key', 'global', 'national', 'united', 'american', 'standard',
    'universal', 'digital', 'energy', 'alliance',
]);

/**
 * Listing name → the phrase news headlines actually use.
 * "Micron Technology, Inc. - Common Stock" → "Micron Technology";
 * "NVIDIA Corporation" → "NVIDIA". Guard: a strip that leaves one short or
 * generic word is refused — "Target Corporation" must stay whole or a
 * title search for "Target" matches everything (precision over recall).
 */
export function cleanCompanyName(raw: string): string | null {
    const base = raw.replace(LISTING_SUFFIX, '').trim();
    if (!base) return null;
    const isSafe = (s: string): boolean => {
        const words = s.replace(/[^a-zA-Z0-9 ]/g, '').trim().split(/\s+/).filter(Boolean);
        if (words.length === 0) return false;
        if (words.length >= 2) return true;
        return words[0].length >= 5 && !GENERIC_WORDS.has(words[0].toLowerCase());
    };
    let cleaned = base;
    for (let i = 0; i < 3; i++) {
        const next = cleaned.replace(LEGAL_SUFFIX, '').trim();
        if (next === cleaned) break;
        if (!isSafe(next)) break; // stop before over-stripping
        cleaned = next;
    }
    return cleaned;
}

/** One batched query: any of the quoted names, English sources only. */
export function buildGdeltQuery(names: string[]): string {
    const quoted = names.map((n) => `"${n.replace(/"/g, '')}"`);
    return `(${quoted.join(' OR ')}) sourcelang:english`;
}

/**
 * GDELT's throttle answer is PLAIN TEXT ("Please limit requests…"), not an
 * HTTP error — anything that fails to parse as JSON means degraded, and the
 * caller must not mistake it for a quiet news day.
 */
export function parseGdeltResponse(text: string):
    | { ok: true; articles: GdeltArticle[] }
    | { ok: false; reason: string } {
    const trimmed = text.trim();
    if (!trimmed.startsWith('{')) {
        return { ok: false, reason: trimmed.slice(0, 120) || 'empty response' };
    }
    try {
        const json = JSON.parse(trimmed) as { articles?: unknown };
        const raw = Array.isArray(json.articles) ? json.articles : [];
        const articles = raw
            .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
            .filter((a) => typeof a.title === 'string' && typeof a.domain === 'string')
            .map((a) => ({
                title: String(a.title),
                domain: String(a.domain),
                seendate: typeof a.seendate === 'string' ? a.seendate : '',
                url: typeof a.url === 'string' ? a.url : '',
            }));
        return { ok: true, articles };
    } catch {
        return { ok: false, reason: 'unparseable JSON' };
    }
}

/** Syndication-stable dedupe key: same headline on 40 outlets = one story. */
function titleKey(title: string): string {
    return title.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Attribute articles to symbols by name-in-title, dedupe syndicated copies
 * for the article count, keep domain breadth from all copies.
 */
export function attributePulse(
    articles: GdeltArticle[],
    watch: Array<{ symbol: string; name: string }>,
    floors: { minArticles: number; minDomains: number },
): Record<string, SymbolPulse> {
    const out: Record<string, SymbolPulse> = {};
    for (const w of watch) {
        const nameLower = w.name.toLowerCase();
        const titles = new Map<string, GdeltArticle>();
        const domains = new Set<string>();
        for (const a of articles) {
            if (!a.title.toLowerCase().includes(nameLower)) continue;
            domains.add(a.domain);
            const key = titleKey(a.title);
            if (!titles.has(key)) titles.set(key, a);
        }
        const unique = [...titles.values()];
        out[w.symbol] = {
            name: w.name,
            articles: unique.length,
            domains: domains.size,
            hot: unique.length >= floors.minArticles && domains.size >= floors.minDomains,
            headlines: unique.slice(0, 3).map((a) => ({ title: a.title, domain: a.domain, seendate: a.seendate })),
        };
    }
    return out;
}

// ---------------------------------------------------------------------------
// Watch set — the names the desk already cares about, most-binding first
// ---------------------------------------------------------------------------

async function buildWatchSet(): Promise<Array<{ symbol: string; name: string }>> {
    const seen = new Map<string, string>();
    const add = (symbol: string, rawName: string | undefined) => {
        const sym = symbol.trim().toUpperCase();
        if (!sym || seen.has(sym) || !rawName) return;
        const name = cleanCompanyName(rawName);
        if (name) seen.set(sym, name);
    };

    let universe: ReturnType<typeof loadUniverse> | null = null;
    const universeName = (sym: string): string | undefined => {
        try {
            universe ??= loadUniverse();
        } catch {
            return undefined;
        }
        return universe.entries[sym]?.name;
    };

    // 1. The open book — news on a held name is always worth surfacing.
    try {
        for (const t of await listTrackable()) add(t.symbol, universeName(t.symbol));
    } catch (err) {
        logger.warn(`[news-pulse] trackable lookup failed: ${err instanceof Error ? err.message : err}`);
    }

    // 2. Earnings reactors (yesterday AMC + today BMO/unknown) — the
    //    calendar carries publishable company names.
    try {
        const [today, prev] = await Promise.all([
            getEarningsForDate(etDatePlus(0)),
            getEarningsForDate(previousTradingDate()),
        ]);
        for (const e of today ?? []) if (e.time === 'pre-market' || e.time === 'unknown') add(e.symbol, e.name);
        for (const e of prev ?? []) if (e.time === 'after-hours' || e.time === 'unknown') add(e.symbol, e.name);
    } catch (err) {
        logger.warn(`[news-pulse] reactor lookup failed: ${err instanceof Error ? err.message : err}`);
    }

    // 3. The engine's current candidates (IBKR longName, universe fallback).
    for (const o of getLatestSnapshot()?.opportunities ?? []) {
        add(o.symbol, (o as { longName?: string }).longName ?? universeName(o.symbol));
    }

    return [...seen.entries()].slice(0, maxSymbols()).map(([symbol, name]) => ({ symbol, name }));
}

// ---------------------------------------------------------------------------
// Sweep + snapshot store
// ---------------------------------------------------------------------------

function snapshotPath(): string {
    return join(process.env.DEXTER_DATA_DIR || join('.dexter', 'data'), 'news-pulse.json');
}

let backoffUntil = 0;

export function getLatestNewsPulse(): NewsPulseSnapshot | null {
    try {
        return JSON.parse(readFileSync(snapshotPath(), 'utf-8')) as NewsPulseSnapshot;
    } catch {
        return null;
    }
}

/** Split the watch set into request-sized name batches. Pure; exported
 *  for tests. */
export function chunkWatch<T>(items: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += Math.max(1, size)) {
        out.push(items.slice(i, i + Math.max(1, size)));
    }
    return out;
}

/**
 * One small GDELT artlist request. Exported for the smoke script — this
 * IS the production request path.
 * axios, not fetch: GDELT tarpits throttled clients (>10 s to first byte,
 * verified 2026-08-11), which trips undici's hard 10 s connect cap under
 * tsx/Node and turns every throttle into an opaque network error. The 429
 * throttle text must reach parseGdeltResponse instead.
 */
export async function fetchGdeltArticles(
    names: string[],
    windowMinutes: number,
    maxRecords = BATCH_MAX_RECORDS,
): Promise<{ ok: true; articles: GdeltArticle[] } | { ok: false; reason: string }> {
    const url =
        `${GDELT_DOC_API}?query=${encodeURIComponent(buildGdeltQuery(names))}` +
        `&mode=artlist&maxrecords=${maxRecords}&timespan=${windowMinutes}min&format=json&sort=datedesc`;
    let text: string;
    try {
        const res = await axios.get<string>(url, {
            timeout: FETCH_TIMEOUT_MS,
            responseType: 'text',
            transformResponse: [(d: string) => d],
            validateStatus: () => true,
            headers: { 'User-Agent': 'dexter-news-pulse (personal trading research)' },
        });
        text = String(res.data ?? '');
    } catch (err) {
        return { ok: false, reason: `fetch failed: ${err instanceof Error ? err.message : err}` };
    }
    return parseGdeltResponse(text);
}

/** One sweep: one GDELT request. Returns the fresh snapshot, or null when
 *  degraded (throttled/unreachable) — the previous snapshot stays current. */
export async function runNewsPulseSweepOnce(): Promise<NewsPulseSnapshot | null> {
    if (Date.now() < backoffUntil) {
        logger.info(`[news-pulse] in throttle backoff for another ${Math.ceil((backoffUntil - Date.now()) / 60_000)} min — sweep skipped`);
        return null;
    }
    const watch = await buildWatchSet();
    if (watch.length === 0) return null;

    // Sequential micro-batches, paced, with one retry per batch: GDELT's
    // "please limit" answer is LOAD-SHEDDING, not a real rate verdict —
    // controlled probes (2026-08-12) saw the identical query throttle and
    // then succeed 8 s later, in both directions. A failed batch is
    // skipped, not sweep-fatal; the long backoff is reserved for a sweep
    // where NOTHING landed (the only signature consistent with a genuine
    // penalty). Unattempted/failed symbols are absent from the snapshot,
    // which the tool reports as "unmeasured", never as quiet.
    const covered: typeof watch = [];
    const articles: GdeltArticle[] = [];
    let failedBatches = 0;
    let lastReason = '';
    for (const [i, batch] of chunkWatch(watch, batchSize()).entries()) {
        if (i > 0) await new Promise((r) => setTimeout(r, BATCH_PACE_MS));
        let parsed = await fetchGdeltArticles(batch.map((w) => w.name), windowMin());
        if (!parsed.ok) {
            await new Promise((r) => setTimeout(r, BATCH_PACE_MS + 2_000));
            parsed = await fetchGdeltArticles(batch.map((w) => w.name), windowMin());
        }
        if (!parsed.ok) {
            failedBatches++;
            lastReason = parsed.reason;
            continue;
        }
        covered.push(...batch);
        articles.push(...parsed.articles);
    }
    if (covered.length === 0) {
        backoffUntil = Date.now() + backoffMin() * 60_000;
        logger.warn(`[news-pulse] every batch failed (${lastReason}) — backing off ${backoffMin()} min`);
        return null;
    }
    if (failedBatches > 0) {
        logger.warn(
            `[news-pulse] partial sweep: ${covered.length}/${watch.length} symbols measured ` +
            `(${failedBatches} batch(es) shed by GDELT after retry) — no backoff, next tick retries fresh`,
        );
    }

    const snapshot: NewsPulseSnapshot = {
        at: Date.now(),
        windowMin: windowMin(),
        watched: covered.length,
        symbols: attributePulse(articles, covered, { minArticles: minArticles(), minDomains: minDomains() }),
    };
    try {
        writeFileSync(snapshotPath(), JSON.stringify(snapshot));
    } catch (err) {
        logger.warn(`[news-pulse] snapshot persist failed: ${err}`);
    }
    const hot = Object.entries(snapshot.symbols).filter(([, p]) => p.hot).map(([s]) => s);
    if (hot.length) logger.info(`[news-pulse] news-hot: ${hot.join(', ')}`);
    return snapshot;
}

let job: Cron | null = null;

/** Start the sweep (:07/:27/:47 ET, weekdays 07:00–16:00). Idempotent. */
export function startNewsPulse(): void {
    if (job || !isNewsPulseEnabled()) return;
    job = new Cron(SWEEP_CRON, { timezone: ET }, () => {
        const today = new Date().toLocaleDateString('en-CA', { timeZone: ET });
        if (isMarketHoliday(today)) return;
        runNewsPulseSweepOnce().catch((err) => logger.error(`[news-pulse] sweep failed: ${err}`));
    });
    logger.info('[news-pulse] scheduled :07/:27/:47 ET weekdays — one batched GDELT sweep over book + reactors + candidates');
}

export function stopNewsPulse(): void {
    if (job) { job.stop(); job = null; }
}
