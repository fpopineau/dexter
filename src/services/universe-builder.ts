/**
 * Universe builder — a persistent directory of US common stocks with
 * market-cap estimates, independent of IBKR entitlements.
 *
 * Sources (free, no API key):
 *   - Listing directory: nasdaqtrader.com symbol files (nasdaqlisted.txt +
 *     otherlisted.txt), filtered to plain common stocks.
 *   - Shares outstanding: SEC EDGAR XBRL companyconcept
 *     (dei/EntityCommonStockSharesOutstanding), via the ticker→CIK map.
 *     EDGAR requires a descriptive User-Agent (UNIVERSE_SEC_UA).
 *   - Price: the latest daily close archived by the universe sweep
 *     (market-archive.db) — cap = shares × close.
 *
 * The universe is stored at DEXTER_DATA_DIR/universe.json and consumed by
 * the nightly sweep (universe-sweep.ts) and, later, pattern scanners.
 * Nothing in the default pipeline depends on it — fully opt-in.
 */

import { logger } from '@/utils';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// Types & store
// ---------------------------------------------------------------------------

export interface UniverseEntry {
    symbol: string;
    name: string;
    /** Listing venue: 'NASDAQ' or the otherlisted exchange code (N, A, P, Z…). */
    exchange: string;
    cik?: number;
    /** Shares outstanding (latest EDGAR report). */
    shares?: number;
    /** 'end' date of the EDGAR report the shares came from (YYYY-MM-DD). */
    sharesAsOf?: string;
    /** Epoch ms when shares were last fetched. */
    sharesFetchedAt?: number;
    /** Latest archived daily close. */
    lastClose?: number;
    /** Epoch ms when lastClose was updated. */
    closeAt?: number;
    /** shares × lastClose, USD. */
    capUsd?: number;
}

export interface UniverseStore {
    /** Epoch ms of the last directory refresh. */
    directoryAt: number;
    updatedAt: number;
    entries: Record<string, UniverseEntry>;
}

function universePath(): string {
    const dir = process.env.DEXTER_DATA_DIR ?? join(process.cwd(), '.dexter', 'data');
    return join(dir, 'universe.json');
}

export function loadUniverse(): UniverseStore {
    try {
        const p = universePath();
        if (existsSync(p)) {
            return JSON.parse(readFileSync(p, 'utf-8')) as UniverseStore;
        }
    } catch (err) {
        logger.warn(`[universe] could not read store: ${err}`);
    }
    return { directoryAt: 0, updatedAt: 0, entries: {} };
}

export function saveUniverse(store: UniverseStore): void {
    const p = universePath();
    mkdirSync(dirname(p), { recursive: true });
    store.updatedAt = Date.now();
    writeFileSync(p, JSON.stringify(store, null, 1));
}

// ---------------------------------------------------------------------------
// Listing directory (nasdaqtrader symbol files) — pure parsers
// ---------------------------------------------------------------------------

const NASDAQ_LISTED_URL = 'https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt';
const OTHER_LISTED_URL = 'https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt';

/** Security-name markers for non-common instruments we exclude. */
const NON_COMMON_NAME = /\b(warrant|right|rights|unit|units|preferred|depositary|notes? due|debenture)s?\b/i;

/** Plain 1–5 letter symbols only (no units/warrants/class suffixes with . $ ^). */
export function isPlainCommonStock(symbol: string, name: string): boolean {
    if (!/^[A-Z]{1,5}$/.test(symbol)) return false;
    if (NON_COMMON_NAME.test(name)) return false;
    return true;
}

/** Parse nasdaqlisted.txt (Symbol|Security Name|Category|Test Issue|Status|Lot|ETF|NextShares). */
export function parseNasdaqListed(text: string): Array<{ symbol: string; name: string; exchange: string }> {
    const out: Array<{ symbol: string; name: string; exchange: string }> = [];
    for (const line of text.split('\n').slice(1)) {
        const f = line.split('|');
        if (f.length < 8) continue;
        const [symbol, name, , testIssue, , , etf] = f;
        if (testIssue === 'Y' || etf === 'Y') continue;
        if (!isPlainCommonStock(symbol, name)) continue;
        out.push({ symbol, name: name.trim(), exchange: 'NASDAQ' });
    }
    return out;
}

/** Parse otherlisted.txt (ACT Symbol|Security Name|Exchange|CQS|ETF|Lot|Test Issue|NASDAQ Symbol). */
export function parseOtherListed(text: string): Array<{ symbol: string; name: string; exchange: string }> {
    const out: Array<{ symbol: string; name: string; exchange: string }> = [];
    for (const line of text.split('\n').slice(1)) {
        const f = line.split('|');
        if (f.length < 8) continue;
        const [symbol, name, exchange, , etf, , testIssue] = f;
        if (testIssue === 'Y' || etf === 'Y') continue;
        if (!isPlainCommonStock(symbol, name)) continue;
        out.push({ symbol, name: name.trim(), exchange });
    }
    return out;
}

/**
 * Refresh the listing directory in the store (new symbols added, delisted
 * symbols removed, enrichment on surviving entries preserved).
 */
export async function refreshDirectory(store: UniverseStore): Promise<void> {
    const [nasdaqText, otherText] = await Promise.all([
        fetch(NASDAQ_LISTED_URL).then((r) => r.text()),
        fetch(OTHER_LISTED_URL).then((r) => r.text()),
    ]);
    const listings = [...parseNasdaqListed(nasdaqText), ...parseOtherListed(otherText)];
    if (listings.length < 1000) {
        throw new Error(`[universe] directory refresh looks wrong (${listings.length} listings) — keeping previous`);
    }

    const next: Record<string, UniverseEntry> = {};
    for (const l of listings) {
        const prev = store.entries[l.symbol];
        next[l.symbol] = { ...prev, symbol: l.symbol, name: l.name, exchange: l.exchange };
    }
    const added = Object.keys(next).filter((s) => !store.entries[s]).length;
    const removed = Object.keys(store.entries).filter((s) => !next[s]).length;
    store.entries = next;
    store.directoryAt = Date.now();
    logger.info(`[universe] directory refreshed: ${listings.length} common stocks (+${added}/−${removed})`);
}

// ---------------------------------------------------------------------------
// SEC EDGAR — CIK map and shares outstanding
// ---------------------------------------------------------------------------

const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';

function secUserAgent(): string {
    return process.env.UNIVERSE_SEC_UA || 'dexter-day2day (fabrice.popineau@gmail.com)';
}

/** Parse company_tickers.json ({idx: {cik_str, ticker, title}}) — pure. */
export function parseCikMap(json: unknown): Map<string, number> {
    const map = new Map<string, number>();
    if (json && typeof json === 'object') {
        for (const v of Object.values(json as Record<string, { cik_str?: number; ticker?: string }>)) {
            if (v?.ticker && typeof v.cik_str === 'number') {
                map.set(v.ticker.toUpperCase(), v.cik_str);
            }
        }
    }
    return map;
}

export async function attachCiks(store: UniverseStore): Promise<number> {
    const res = await fetch(SEC_TICKERS_URL, { headers: { 'User-Agent': secUserAgent() } });
    if (!res.ok) throw new Error(`[universe] SEC ticker map fetch failed: ${res.status}`);
    const map = parseCikMap(await res.json());
    let attached = 0;
    for (const entry of Object.values(store.entries)) {
        if (entry.cik === undefined) {
            const cik = map.get(entry.symbol);
            if (cik !== undefined) {
                entry.cik = cik;
                attached++;
            }
        }
    }
    logger.info(`[universe] CIKs attached: ${attached} new (${Object.values(store.entries).filter((e) => e.cik).length} total)`);
    return attached;
}

interface SharesConceptUnit {
    end?: string;
    val?: number;
}

/** Extract the most recent shares-outstanding figure from a companyconcept
 *  response — pure. Returns null when the concept has no usable values. */
export function parseSharesConcept(json: unknown): { shares: number; asOf: string } | null {
    const units = (json as { units?: { shares?: SharesConceptUnit[] } })?.units?.shares;
    if (!Array.isArray(units)) return null;
    let best: { shares: number; asOf: string } | null = null;
    for (const u of units) {
        if (typeof u?.val !== 'number' || u.val <= 0 || typeof u?.end !== 'string') continue;
        if (!best || u.end > best.asOf) best = { shares: u.val, asOf: u.end };
    }
    return best;
}

/** Fetch latest shares outstanding for a CIK. Null when EDGAR has none. */
export async function fetchSharesOutstanding(cik: number): Promise<{ shares: number; asOf: string } | null> {
    const padded = String(cik).padStart(10, '0');
    const url = `https://data.sec.gov/api/xbrl/companyconcept/CIK${padded}/dei/EntityCommonStockSharesOutstanding.json`;
    const res = await fetch(url, { headers: { 'User-Agent': secUserAgent() } });
    if (res.status === 404) return null; // concept not reported
    if (!res.ok) throw new Error(`EDGAR ${res.status}`);
    return parseSharesConcept(await res.json());
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Enrich entries with EDGAR shares outstanding, oldest-first, up to
 * `budget` requests. Entries fresher than `maxAgeMs` are skipped.
 * SEC fair-use pacing: ≥150 ms between requests (≈6–7 req/s).
 */
export async function enrichShares(
    store: UniverseStore,
    opts: { budget: number; maxAgeMs?: number; paceMs?: number } ,
): Promise<{ fetched: number; missing: number }> {
    const maxAge = opts.maxAgeMs ?? 30 * 24 * 3600_000;
    const pace = Math.max(150, opts.paceMs ?? 160);
    const now = Date.now();

    const queue = Object.values(store.entries)
        .filter((e) => e.cik !== undefined && (e.sharesFetchedAt === undefined || now - e.sharesFetchedAt > maxAge))
        .sort((a, b) => (a.sharesFetchedAt ?? 0) - (b.sharesFetchedAt ?? 0))
        .slice(0, Math.max(0, opts.budget));

    let fetched = 0, missing = 0;
    for (const entry of queue) {
        try {
            const result = await fetchSharesOutstanding(entry.cik!);
            entry.sharesFetchedAt = Date.now();
            if (result) {
                entry.shares = result.shares;
                entry.sharesAsOf = result.asOf;
                fetched++;
            } else {
                missing++;
            }
        } catch (err) {
            logger.warn(`[universe] EDGAR shares failed for ${entry.symbol} (CIK ${entry.cik}): ${err}`);
        }
        await sleep(pace);
    }
    if (queue.length) logger.info(`[universe] shares enriched: ${fetched} fetched, ${missing} without concept, ${queue.length} attempted`);
    return { fetched, missing };
}

// ---------------------------------------------------------------------------
// Cap computation and band filtering
// ---------------------------------------------------------------------------

/** Recompute capUsd for entries having both shares and lastClose — pure. */
export function computeCaps(store: UniverseStore): number {
    let computed = 0;
    for (const e of Object.values(store.entries)) {
        if (e.shares !== undefined && e.lastClose !== undefined && e.lastClose > 0) {
            e.capUsd = Math.round(e.shares * e.lastClose);
            computed++;
        }
    }
    return computed;
}

export interface UniverseFilter {
    minCapUsd?: number;
    maxCapUsd?: number;
    /** Entries with unknown cap are excluded unless includeUnknown is set. */
    includeUnknown?: boolean;
}

/** Entries within the cap band, largest first — pure. */
export function getUniverse(store: UniverseStore, filter: UniverseFilter = {}): UniverseEntry[] {
    const { minCapUsd, maxCapUsd, includeUnknown } = filter;
    return Object.values(store.entries)
        .filter((e) => {
            if (e.capUsd === undefined) return includeUnknown === true;
            if (minCapUsd !== undefined && e.capUsd < minCapUsd) return false;
            if (maxCapUsd !== undefined && e.capUsd > maxCapUsd) return false;
            return true;
        })
        .sort((a, b) => (b.capUsd ?? 0) - (a.capUsd ?? 0));
}
