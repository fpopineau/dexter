/**
 * Event risk — dated macro binary events and per-symbol earnings markets,
 * from Polymarket's public Gamma API (keyless, no entitlement to lose).
 *
 * Two gaps this fills (2026-08-11):
 *   - RULES.md rule 7 flags single-name earnings within 2 days, but nothing
 *     flagged MACRO binary nights: a keep on CPI-eve rides an 08:30 ET
 *     print no stop can protect against, and no machinery said so.
 *   - The earnings-bet evidence bar requires ">= 1 supporting external
 *     signal", which until now the model had to hunt for by web search.
 *     A liquid "Will X (TICK) beat quarterly earnings?" market is that
 *     signal, with an implied beat probability attached.
 *
 * Probabilities are read as event-uncertainty gauges, not trade signals:
 * a dispersed CPI bracket book means the market genuinely does not know —
 * exactly the night to respect the overnight caps.
 *
 * Failure degrades to null ("could not verify"), never to "no events".
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '@/utils';

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const FETCH_TIMEOUT_MS = 15_000;
const MACRO_CACHE_TTL_MS = 2 * 3600_000; // dates never move intraday; probabilities drift slowly
const MACRO_FETCH_LIMIT = 75;
/** Ignore dust markets: below this 24h volume the "probability" is noise. */
const MIN_MACRO_VOLUME_24H = 10_000;
const MIN_EARNINGS_MARKET_VOLUME = 500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MacroCategory = 'inflation' | 'fed' | 'jobs' | 'gdp' | 'central-bank';

export interface MacroEvent {
    title: string;
    category: MacroCategory;
    /** Resolution date (UTC calendar day encoded in endDate — Polymarket
     *  pins these to midnight UTC of the release day, so the UTC date IS
     *  the ET release day; converting to ET would shift it back a day). */
    date: string;
    /** Whole days from today's ET date to the event date (0 = tonight/today). */
    daysAway: number;
    /** Highest-probability outcome across the event's bracket markets. */
    topOutcome: { label: string; probability: number } | null;
    /** How settled the market's expectation is: low = consensus priced,
     *  high = genuinely open — the dangerous kind of night to be exposed. */
    uncertainty: 'low' | 'moderate' | 'high' | 'unknown';
    volume24h: number;
}

export interface EarningsMarketSignal {
    symbol: string;
    question: string;
    /** Market-implied probability the company beats (Yes price, 0..1). */
    beatProbability: number | null;
    volume: number;
    /** Resolution date (UTC calendar day). */
    endDate: string;
    url: string;
}

// Raw Gamma shapes (tolerantly parsed — the API is not ours).
interface GammaMarket {
    question?: string;
    outcomes?: string;      // JSON-encoded string array
    outcomePrices?: string; // JSON-encoded string array
    lastTradePrice?: number;
    groupItemTitle?: string;
    closed?: boolean;
}

interface GammaEvent {
    title?: string;
    slug?: string;
    endDate?: string;
    closed?: boolean;
    volume?: number;
    volume24hr?: number;
    markets?: GammaMarket[];
}

// ---------------------------------------------------------------------------
// Pure parsing + classification (unit-tested)
// ---------------------------------------------------------------------------

/** Tolerant parse of a Gamma /events (or search .events) payload. */
export function parseGammaEvents(json: unknown): GammaEvent[] {
    if (Array.isArray(json)) return json.filter((e): e is GammaEvent => !!e && typeof e === 'object');
    const events = (json as { events?: unknown })?.events;
    if (Array.isArray(events)) return events.filter((e): e is GammaEvent => !!e && typeof e === 'object');
    return [];
}

/** JSON-encoded "[\"0.47\", \"0.53\"]" → [0.47, 0.53]; anything else → null. */
export function parsePriceArray(encoded: unknown): number[] | null {
    if (typeof encoded !== 'string') return null;
    try {
        const arr = JSON.parse(encoded);
        if (!Array.isArray(arr)) return null;
        const nums = arr.map(Number);
        return nums.every((n) => Number.isFinite(n)) ? nums : null;
    } catch {
        return null;
    }
}

/** Index of the "Yes" outcome in a market's JSON-encoded outcomes array (default 0). */
function yesIndexOf(outcomesEncoded: unknown): number {
    if (typeof outcomesEncoded !== 'string') return 0;
    try {
        const arr = JSON.parse(outcomesEncoded);
        if (!Array.isArray(arr)) return 0;
        const idx = arr.findIndex((o) => String(o).toLowerCase() === 'yes');
        return idx >= 0 ? idx : 0;
    } catch {
        return 0;
    }
}

const MONTHISH = /january|february|march|april|may|june|july|august|september|october|november|december|q[1-4]|week|meeting/i;
/** Cumulative/open-ended questions — resolution date ≠ a scheduled release. */
const CUMULATIVE = /how many|by \.\.\.|by end of|in 20\d\d\?|before 20\d\d|this year|recession/i;

const CATEGORY_PATTERNS: Array<{ category: MacroCategory; pattern: RegExp; requiresDated: boolean }> = [
    { category: 'inflation', pattern: /\b(cpi|inflation|pce)\b/i, requiresDated: true },
    { category: 'fed', pattern: /\bfed (decision|rate)|fomc|federal reserve\b/i, requiresDated: true },
    { category: 'jobs', pattern: /\b(payrolls|jobs report|unemployment rate)\b/i, requiresDated: true },
    { category: 'gdp', pattern: /\bgdp\b/i, requiresDated: true },
    { category: 'central-bank', pattern: /\b(ecb|bank of japan|boj|bank of england|boe) (decision|interest|rates?)|interest rates?: /i, requiresDated: false },
];

/**
 * Classify an event title as a DATED macro release, or null.
 * "Fed Decision in September?" → fed; "How many Fed rate cuts in 2026?" →
 * null (cumulative — its endDate is a deadline, not a release night).
 */
export function classifyMacroTitle(title: string): MacroCategory | null {
    if (CUMULATIVE.test(title)) return null;
    for (const { category, pattern, requiresDated } of CATEGORY_PATTERNS) {
        if (!pattern.test(title)) continue;
        if (requiresDated && !MONTHISH.test(title)) return null;
        return category;
    }
    return null;
}

/** Highest Yes-probability across an event's bracket markets. */
export function topOutcomeOf(markets: GammaMarket[] | undefined): { label: string; probability: number } | null {
    let best: { label: string; probability: number } | null = null;
    for (const m of markets ?? []) {
        const prices = parsePriceArray(m.outcomePrices);
        const p = prices?.[yesIndexOf(m.outcomes)];
        if (p === undefined || !(p > 0)) continue;
        const label = m.groupItemTitle || m.question || '?';
        if (!best || p > best.probability) best = { label, probability: p };
    }
    return best;
}

/** Consensus bands: a 90% top bucket is priced in; a 40% one is a coin toss. */
export function uncertaintyFrom(top: { probability: number } | null): MacroEvent['uncertainty'] {
    if (!top) return 'unknown';
    if (top.probability >= 0.9) return 'low';
    if (top.probability >= 0.65) return 'moderate';
    return 'high';
}

/** ET calendar date 'YYYY-MM-DD' for now (matches earnings-calendar's view of "today"). */
function etToday(now: Date): string {
    return now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/** Whole-day difference between two 'YYYY-MM-DD' strings. */
function daysBetween(fromIso: string, toIso: string): number {
    return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000);
}

/**
 * Dated macro events resolving within [today .. today + withinDays],
 * ranked nearest-first then by 24h volume.
 */
export function selectMacroEvents(raw: GammaEvent[], withinDays: number, now: Date = new Date()): MacroEvent[] {
    const today = etToday(now);
    const out: MacroEvent[] = [];
    for (const e of raw) {
        if (!e.title || !e.endDate || e.closed) continue;
        const category = classifyMacroTitle(e.title);
        if (!category) continue;
        const volume24h = typeof e.volume24hr === 'number' ? e.volume24hr : 0;
        if (volume24h < MIN_MACRO_VOLUME_24H) continue;
        const date = e.endDate.slice(0, 10);
        const daysAway = daysBetween(today, date);
        if (daysAway < 0 || daysAway > withinDays) continue;
        const top = topOutcomeOf(e.markets);
        out.push({
            title: e.title, category, date, daysAway,
            topOutcome: top, uncertainty: uncertaintyFrom(top), volume24h,
        });
    }
    return out.sort((a, b) => a.daysAway - b.daysAway || b.volume24h - a.volume24h);
}

const TICKER_IN_TITLE = /\(([A-Z]{1,5})\)/;
const BEAT_EARNINGS = /beat .*earnings/i;

/**
 * The symbol's open "beat quarterly earnings?" market, if one exists.
 * Strict on the ticker: a fuzzy title search for STUB also returns the
 * Finnish presidential election (candidate "Stubb") — verified 2026-08-11.
 */
export function selectEarningsMarket(raw: GammaEvent[], symbol: string, now: Date = new Date()): EarningsMarketSignal | null {
    const sym = symbol.trim().toUpperCase();
    const today = etToday(now);
    const candidates: EarningsMarketSignal[] = [];
    for (const e of raw) {
        if (!e.title || !e.endDate || e.closed) continue;
        if (!BEAT_EARNINGS.test(e.title)) continue;
        if (TICKER_IN_TITLE.exec(e.title)?.[1] !== sym) continue;
        const endDate = e.endDate.slice(0, 10);
        if (daysBetween(today, endDate) < 0) continue; // stale market for a past print
        const market = (e.markets ?? []).find((m) => m.question && BEAT_EARNINGS.test(m.question) && !m.closed);
        if (!market) continue;
        const prices = parsePriceArray(market.outcomePrices);
        const volume = typeof e.volume === 'number' ? e.volume : 0;
        if (volume < MIN_EARNINGS_MARKET_VOLUME) continue;
        candidates.push({
            symbol: sym,
            question: market.question!,
            beatProbability: prices?.[yesIndexOf(market.outcomes)] ?? (typeof market.lastTradePrice === 'number' ? market.lastTradePrice : null),
            volume,
            endDate,
            url: e.slug ? `https://polymarket.com/event/${e.slug}` : 'https://polymarket.com',
        });
    }
    // Nearest resolution wins — that is the market about the upcoming print.
    return candidates.sort((a, b) => a.endDate.localeCompare(b.endDate))[0] ?? null;
}

// ---------------------------------------------------------------------------
// Fetch + cache
// ---------------------------------------------------------------------------

function cachePath(): string {
    return join(process.env.DEXTER_DATA_DIR || join('.dexter', 'data'), 'event-risk.json');
}

interface MacroCache {
    fetchedAt: number;
    events: GammaEvent[];
}

function loadCache(): MacroCache | null {
    try {
        return JSON.parse(readFileSync(cachePath(), 'utf-8')) as MacroCache;
    } catch {
        return null;
    }
}

function saveCache(cache: MacroCache): void {
    try {
        writeFileSync(cachePath(), JSON.stringify(cache));
    } catch (err) {
        logger.warn(`[event-risk] cache persist failed: ${err}`);
    }
}

async function fetchJson(url: string): Promise<unknown | null> {
    try {
        const res = await fetch(url, {
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } catch (err) {
        logger.warn(`[event-risk] fetch failed: ${err instanceof Error ? err.message : err}`);
        return null;
    }
}

/**
 * Dated macro events within the horizon. Null = data unavailable (the
 * caller must say "could not verify", never "no macro events").
 */
export async function getMacroEventsWithin(withinDays: number, now: Date = new Date()): Promise<MacroEvent[] | null> {
    const cached = loadCache();
    if (cached && Date.now() - cached.fetchedAt < MACRO_CACHE_TTL_MS) {
        return selectMacroEvents(cached.events, withinDays, now);
    }
    const json = await fetchJson(
        `${GAMMA_BASE}/events?closed=false&tag_slug=economy&order=volume24hr&ascending=false&limit=${MACRO_FETCH_LIMIT}`,
    );
    if (json === null) {
        // Stale beats nothing; nothing means "could not verify".
        return cached ? selectMacroEvents(cached.events, withinDays, now) : null;
    }
    const events = parseGammaEvents(json);
    saveCache({ fetchedAt: Date.now(), events });
    return selectMacroEvents(events, withinDays, now);
}

/**
 * The symbol's Polymarket earnings market, or null when none exists (which
 * is the common case — coverage skews to liquid, newsy names). Uncached:
 * called per earnings-bet evaluation, which is rare by construction.
 */
export async function getEarningsMarketSignal(symbol: string, now: Date = new Date()): Promise<EarningsMarketSignal | null> {
    const json = await fetchJson(
        `${GAMMA_BASE}/public-search?q=${encodeURIComponent(symbol.trim().toUpperCase())}&limit_per_type=10`,
    );
    if (json === null) return null;
    return selectEarningsMarket(parseGammaEvents(json), symbol, now);
}

/**
 * One-line macro-night warning for the EOD triage report, or null when the
 * horizon is clear. Kept pure for tests; the triage passes tonight+tomorrow
 * events so a keep is never silently exposed to a binary macro print.
 */
export function macroNightWarning(events: MacroEvent[] | null): string | null {
    if (events === null) return '⚠ macro event calendar unavailable — keeps are NOT verified macro-quiet.';
    const near = events.filter((e) => e.daysAway <= 1);
    if (near.length === 0) return null;
    const parts = near.map((e) => {
        const when = e.daysAway === 0 ? 'today' : 'tomorrow';
        const top = e.topOutcome
            ? ` (top outcome ${Math.round(e.topOutcome.probability * 100)}%: ${e.topOutcome.label})`
            : '';
        return `${e.title} resolves ${when}${top} — ${e.uncertainty} uncertainty`;
    });
    return `⚠ macro event risk: ${parts.join('; ')}. Overnight keeps ride through this print.`;
}
