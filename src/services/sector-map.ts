/**
 * Sector map — symbol → sector from Nasdaq's keyless per-symbol summary
 * endpoint (the same surface the company-snapshot card reads).
 *
 * Exists so max_sector_exposure_pct stops being a phantom: the config key
 * dated from the research era but was enforced NOWHERE, while two skills
 * told the model risk_manager validated it (audit 2026-08-11). The
 * acceptance gate now sums same-sector exposure through this map.
 *
 * Sectors are Nasdaq's coarse taxonomy ("Technology", "Health Care", …).
 * ETFs and index vehicles have no sector → null → the sector cap simply
 * does not apply to them (a breadth-day SOXL/QQQ vehicle is not "one more
 * semis name" — concentration in vehicles is the operator's call).
 * Failure degrades to null ("could not verify" — the gate skips with a
 * note), never to a wrong sector.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '@/utils';

const FETCH_TIMEOUT_MS = 10_000;
/** Sectors are static facts; re-verify rarely. */
const HIT_TTL_MS = 30 * 24 * 3600_000;
/** Nulls (ETFs, fetch misses) retry daily — a miss must not stick for a month. */
const MISS_TTL_MS = 24 * 3600_000;

export interface SectorInfo {
    sector: string;
    industry: string | null;
}

interface CacheEntry {
    at: number;
    info: SectorInfo | null;
}

// ---------------------------------------------------------------------------
// Pure parsing (unit-tested)
// ---------------------------------------------------------------------------

/** Parse Nasdaq's summary JSON into sector info. Unknown shapes → null. */
export function parseNasdaqSummary(json: unknown): SectorInfo | null {
    const summary = (json as { data?: { summaryData?: Record<string, { value?: unknown }> } })
        ?.data?.summaryData;
    const sector = summary?.Sector?.value;
    if (typeof sector !== 'string' || !sector.trim()) return null;
    const industry = summary?.Industry?.value;
    return {
        sector: sector.trim(),
        industry: typeof industry === 'string' && industry.trim() ? industry.trim() : null,
    };
}

// ---------------------------------------------------------------------------
// Fetch + cache
// ---------------------------------------------------------------------------

function cachePath(): string {
    return join(process.env.DEXTER_DATA_DIR || join('.dexter', 'data'), 'sector-map.json');
}

function loadCache(): Record<string, CacheEntry> {
    try {
        return JSON.parse(readFileSync(cachePath(), 'utf-8')) as Record<string, CacheEntry>;
    } catch {
        return {};
    }
}

function saveCache(cache: Record<string, CacheEntry>): void {
    try {
        writeFileSync(cachePath(), JSON.stringify(cache));
    } catch (err) {
        logger.warn(`[sector-map] cache persist failed: ${err}`);
    }
}

/**
 * The symbol's sector, or null when it has none (ETFs) or the data is
 * unavailable. Cached 30 days on hits, 1 day on nulls.
 */
export async function getSectorInfo(symbol: string): Promise<SectorInfo | null> {
    const sym = symbol.trim().toUpperCase();
    if (!sym) return null;
    const cache = loadCache();
    const hit = cache[sym];
    if (hit && Date.now() - hit.at < (hit.info ? HIT_TTL_MS : MISS_TTL_MS)) return hit.info;

    let info: SectorInfo | null = null;
    try {
        const res = await fetch(`https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/summary?assetclass=stocks`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json',
            },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        info = parseNasdaqSummary(await res.json());
    } catch (err) {
        logger.warn(`[sector-map] ${sym} fetch failed: ${err instanceof Error ? err.message : err}`);
        // Do not cache transport failures as long-lived nulls: return the
        // stale entry if one exists, else a short-lived null.
        if (hit) return hit.info;
    }
    cache[sym] = { at: Date.now(), info };
    saveCache(cache);
    return info;
}
