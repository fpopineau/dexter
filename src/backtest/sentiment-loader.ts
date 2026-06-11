/**
 * GDELT sentiment loader — reads monthly Parquet files and matches
 * headlines to ticker symbols for backtesting sentiment signals.
 *
 * GDELT data format (parquet columns):
 *   date, event_type, goldstein_scale, num_articles, url,
 *   GLOBALEVENTID, Actor1Name, Actor2Name, Actor1CountryCode,
 *   Actor2CountryCode, headline
 *
 * Matching approach: keyword-based entity→ticker mapping.
 * Headlines are matched against company names / ticker symbols.
 * Goldstein scale (-10 to +10) is the primary sentiment signal.
 */

import { logger } from '@/utils';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SentimentRecord {
    date: string;
    ticker: string;
    headline: string;
    goldsteinScale: number;
    numArticles: number;
    eventType: number;
    actor1: string;
    actor2: string;
}

/** Aggregated sentiment for a ticker on a given date. */
export interface DailySentiment {
    date: string;
    ticker: string;
    /** Average Goldstein scale across matched headlines. */
    avgGoldstein: number;
    /** Total article count (sum of num_articles). */
    totalArticles: number;
    /** Number of matched headlines. */
    headlineCount: number;
    /** Max absolute Goldstein — measures event intensity. */
    maxAbsGoldstein: number;
}

// ---------------------------------------------------------------------------
// Entity → Ticker mapping
// ---------------------------------------------------------------------------

/**
 * Mapping of company keywords to ticker symbols.
 * This is a curated seed list; expand as needed or load from SEC EDGAR.
 * Keywords must be UPPERCASE for case-insensitive matching.
 */
const ENTITY_MAP: Record<string, string[]> = {
    AAPL: ['APPLE', 'IPHONE', 'IPAD', 'MACBOOK', 'TIM COOK'],
    MSFT: ['MICROSOFT', 'WINDOWS', 'AZURE', 'SATYA NADELLA'],
    GOOGL: ['GOOGLE', 'ALPHABET', 'YOUTUBE', 'SUNDAR PICHAI'],
    AMZN: ['AMAZON', 'AWS', 'JEFF BEZOS', 'ANDY JASSY'],
    META: ['META PLATFORMS', 'FACEBOOK', 'INSTAGRAM', 'WHATSAPP', 'MARK ZUCKERBERG'],
    TSLA: ['TESLA', 'ELON MUSK', 'SPACEX'],
    NVDA: ['NVIDIA', 'JENSEN HUANG', 'GEFORCE', 'CUDA'],
    JPM: ['JPMORGAN', 'JP MORGAN', 'JAMIE DIMON'],
    BAC: ['BANK OF AMERICA'],
    WMT: ['WALMART'],
    JNJ: ['JOHNSON & JOHNSON', 'JOHNSON AND JOHNSON'],
    V: ['VISA INC'],
    MA: ['MASTERCARD'],
    UNH: ['UNITEDHEALTH'],
    HD: ['HOME DEPOT'],
    PG: ['PROCTER & GAMBLE', 'PROCTER AND GAMBLE'],
    DIS: ['DISNEY', 'WALT DISNEY'],
    NFLX: ['NETFLIX'],
    INTC: ['INTEL CORP', 'INTEL '],
    AMD: ['AMD ', 'ADVANCED MICRO'],
    CRM: ['SALESFORCE'],
    ORCL: ['ORACLE CORP', 'ORACLE '],
    CSCO: ['CISCO'],
    BA: ['BOEING'],
    GS: ['GOLDMAN SACHS'],
    MS: ['MORGAN STANLEY'],
    C: ['CITIGROUP', 'CITIBANK'],
    XOM: ['EXXON', 'EXXONMOBIL'],
    CVX: ['CHEVRON'],
    PFE: ['PFIZER'],
    ABBV: ['ABBVIE'],
    MRK: ['MERCK '],
    LLY: ['ELI LILLY'],
    COST: ['COSTCO'],
    AVGO: ['BROADCOM'],
    ADBE: ['ADOBE'],
    TXN: ['TEXAS INSTRUMENTS'],
    QCOM: ['QUALCOMM'],
    PYPL: ['PAYPAL'],
    SQ: ['BLOCK INC', 'SQUARE INC'],
    UBER: ['UBER'],
    ABNB: ['AIRBNB'],
    COIN: ['COINBASE'],
    RIVN: ['RIVIAN'],
    PLTR: ['PALANTIR'],
    SNOW: ['SNOWFLAKE'],
    NET: ['CLOUDFLARE'],
    DDOG: ['DATADOG'],
    ZS: ['ZSCALER'],
    CRWD: ['CROWDSTRIKE'],
};

// Build reverse index: keyword → ticker
const keywordIndex = new Map<string, string>();
for (const [ticker, keywords] of Object.entries(ENTITY_MAP)) {
    // Also match the ticker symbol itself in headlines
    keywordIndex.set(ticker, ticker);
    for (const kw of keywords) {
        keywordIndex.set(kw, ticker);
    }
}

// Sort keywords by length descending for longest-match-first
const sortedKeywords = [...keywordIndex.keys()].sort((a, b) => b.length - a.length);

/**
 * Register additional entity→ticker mappings at runtime.
 * Useful for loading SEC EDGAR mappings in Phase 6.
 */
export function registerEntities(mapping: Record<string, string[]>): void {
    for (const [ticker, keywords] of Object.entries(mapping)) {
        keywordIndex.set(ticker, ticker);
        for (const kw of keywords) {
            keywordIndex.set(kw.toUpperCase(), ticker);
        }
    }
    // Rebuild sorted list
    sortedKeywords.length = 0;
    sortedKeywords.push(...[...keywordIndex.keys()].sort((a, b) => b.length - a.length));
}

// ---------------------------------------------------------------------------
// Headline → Ticker matching
// ---------------------------------------------------------------------------

function matchTicker(headline: string, actor1?: string, actor2?: string): string | null {
    const upper = headline.toUpperCase();
    const actorUpper = ((actor1 ?? '') + ' ' + (actor2 ?? '')).toUpperCase();

    for (const kw of sortedKeywords) {
        if (upper.includes(kw) || actorUpper.includes(kw)) {
            return keywordIndex.get(kw) ?? null;
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Parquet loading
// ---------------------------------------------------------------------------

const DEFAULT_GDELT_DIR =
    process.env.GDELT_DATA_DIR || join('GDELT', 'gdelt_cleaned', 'parts_monthly');

/**
 * Load GDELT sentiment for a date range, matched to tickers.
 *
 * @param startDate 'YYYY-MM-DD' or 'YYYY-MM'
 * @param endDate   'YYYY-MM-DD' or 'YYYY-MM'
 * @param tickers   Optional filter — only return these tickers. If empty, return all matched.
 * @param gdeltDir  Override GDELT parquet directory.
 */
export async function loadSentiment(
    startDate: string,
    endDate: string,
    tickers?: string[],
    gdeltDir: string = DEFAULT_GDELT_DIR,
): Promise<SentimentRecord[]> {
    const tickerSet = tickers?.length ? new Set(tickers.map((t) => t.toUpperCase())) : null;

    // Determine which monthly files to load
    const startMonth = startDate.substring(0, 7); // 'YYYY-MM'
    const endMonth = endDate.substring(0, 7);
    const files = getMonthlyFiles(gdeltDir, startMonth, endMonth);

    if (files.length === 0) {
        logger.warn(`[sentiment-loader] No GDELT files found for ${startMonth} to ${endMonth}`);
        return [];
    }

    logger.info(`[sentiment-loader] Loading ${files.length} monthly GDELT files`);

    const results: SentimentRecord[] = [];

    for (const file of files) {
        const records = await loadParquetFile(file, startDate, endDate, tickerSet);
        results.push(...records);
    }

    logger.info(`[sentiment-loader] Matched ${results.length} sentiment records`);
    return results;
}

/**
 * Aggregate sentiment records into daily per-ticker summaries.
 */
export function aggregateDaily(records: SentimentRecord[]): DailySentiment[] {
    const grouped = new Map<string, SentimentRecord[]>();

    for (const r of records) {
        const key = `${r.date}|${r.ticker}`;
        const arr = grouped.get(key);
        if (arr) arr.push(r);
        else grouped.set(key, [r]);
    }

    const result: DailySentiment[] = [];
    for (const [key, recs] of grouped) {
        const [date, ticker] = key.split('|');
        const avgGoldstein = recs.reduce((a, r) => a + r.goldsteinScale, 0) / recs.length;
        const totalArticles = recs.reduce((a, r) => a + r.numArticles, 0);
        const maxAbsGoldstein = Math.max(...recs.map((r) => Math.abs(r.goldsteinScale)));

        result.push({
            date,
            ticker,
            avgGoldstein,
            totalArticles,
            headlineCount: recs.length,
            maxAbsGoldstein,
        });
    }

    return result.sort((a, b) => a.date.localeCompare(b.date) || a.ticker.localeCompare(b.ticker));
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getMonthlyFiles(dir: string, startMonth: string, endMonth: string): string[] {
    try {
        const entries = readdirSync(dir);
        return entries
            .filter((f) => f.startsWith('gdelt_headlines_') && f.endsWith('.parquet'))
            .filter((f) => {
                const month = f.replace('gdelt_headlines_', '').replace('.parquet', '');
                return month >= startMonth && month <= endMonth;
            })
            .sort()
            .map((f) => join(dir, f));
    } catch {
        return [];
    }
}

async function loadParquetFile(
    filePath: string,
    startDate: string,
    endDate: string,
    tickerFilter: Set<string> | null,
): Promise<SentimentRecord[]> {
    // Dynamic import — hyparquet is ESM
    const { parquetReadObjects } = await import('hyparquet');

    const buf = readFileSync(filePath);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const file = { byteLength: ab.byteLength, slice: (s: number, e?: number) => ab.slice(s, e) };

    const rows: Record<string, unknown>[] = await parquetReadObjects({
        file,
        columns: ['date', 'event_type', 'goldstein_scale', 'num_articles', 'headline', 'Actor1Name', 'Actor2Name'],
    });

    const results: SentimentRecord[] = [];

    for (const row of rows) {
        // Parse date — GDELT stores as Date object or ISO string
        let dateStr: string;
        const rawDate = row.date;
        if (rawDate instanceof Date) {
            dateStr = rawDate.toISOString().substring(0, 10);
        } else if (typeof rawDate === 'string') {
            dateStr = rawDate.substring(0, 10);
        } else {
            continue;
        }

        // Date range filter
        if (dateStr < startDate.substring(0, 10)) continue;
        if (dateStr > endDate.substring(0, 10)) continue;

        const headline = String(row.headline ?? '');
        if (!headline) continue;

        const actor1 = String(row.Actor1Name ?? '');
        const actor2 = String(row.Actor2Name ?? '');
        const ticker = matchTicker(headline, actor1, actor2);
        if (!ticker) continue;
        if (tickerFilter && !tickerFilter.has(ticker)) continue;

        results.push({
            date: dateStr,
            ticker,
            headline,
            goldsteinScale: Number(row.goldstein_scale ?? 0),
            numArticles: Number(row.num_articles ?? typeof row.num_articles === 'bigint' ? Number(row.num_articles) : 1),
            eventType: Number(row.event_type ?? 0),
            actor1,
            actor2,
        });
    }

    return results;
}
