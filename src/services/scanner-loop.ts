/**
 * Scanner Loop service — pre-market universe scanning.
 *
 * Runs IBKR market scanners to identify top candidates across multiple
 * scan types, caches results, and optionally subscribes top movers to
 * the ibkr-stream service for real-time tracking.
 *
 * Designed to be called by the agent or a cron job. Stateless per invocation
 * but caches results in memory for subsequent queries within the session.
 */

import { allocReqId, getIBApi } from '@/tools/ibkr/connection.js';
import { logger } from '@/utils';
import type { ContractDetails, ScannerSubscription } from '@stoqey/ib';
import { EventName } from '@stoqey/ib';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScanResult {
    rank: number;
    symbol: string;
    secType: string;
    exchange: string;
    currency: string;
    longName: string;
    distance: string;
    benchmark: string;
    projection: string;
}

export interface ScanSnapshot {
    scanCode: string;
    timestamp: number;
    results: ScanResult[];
}

export type ScanCode =
    | 'TOP_PERC_GAIN'
    | 'TOP_PERC_LOSE'
    | 'MOST_ACTIVE'
    | 'HOT_BY_VOLUME'
    | 'HIGH_OPEN_GAP'
    | 'LOW_OPEN_GAP'
    | 'TOP_OPEN_PERC_GAIN'
    | 'TOP_OPEN_PERC_LOSE'
    | 'TOP_TRADE_COUNT'
    | 'TOP_TRADE_RATE';

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const cache = new Map<string, ScanSnapshot>();

/** Default TTL = 5 minutes. */
const CACHE_TTL_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Scanner execution
// ---------------------------------------------------------------------------

export async function runScan(
    scanCode: ScanCode | string,
    options: {
        instrument?: string;
        locationCode?: string;
        numberOfRows?: number;
        abovePrice?: number;
        aboveVolume?: number;
        marketCapAbove?: number;
    } = {},
): Promise<ScanResult[]> {
    // Check cache
    const cached = cache.get(scanCode);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        return cached.results;
    }

    const api = await getIBApi();
    const reqId = allocReqId();

    const subscription: ScannerSubscription = {
        numberOfRows: options.numberOfRows ?? 25,
        instrument: (options.instrument ?? 'STK') as unknown as ScannerSubscription['instrument'],
        locationCode: (options.locationCode ?? 'STK.US.MAJOR') as unknown as ScannerSubscription['locationCode'],
        scanCode: scanCode as unknown as ScannerSubscription['scanCode'],
        abovePrice: options.abovePrice ?? 5,
        aboveVolume: options.aboveVolume ?? 100_000,
        marketCapAbove: options.marketCapAbove ?? 500_000_000, // $500M+
    };

    const results: ScanResult[] = [];

    return new Promise<ScanResult[]>((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            finalize();
        }, 30_000);

        const onScannerData = (
            id: number,
            rank: number,
            contractDetails: ContractDetails,
            distance: string,
            benchmark: string,
            projection: string,
        ) => {
            if (id !== reqId) return;
            results.push({
                rank,
                symbol: contractDetails.contract?.symbol ?? '',
                secType: contractDetails.contract?.secType ?? '',
                exchange: contractDetails.contract?.exchange ?? '',
                currency: contractDetails.contract?.currency ?? '',
                longName: contractDetails.longName ?? '',
                distance,
                benchmark,
                projection,
            });
        };

        const onScannerDataEnd = (id: number) => {
            if (id !== reqId) return;
            clearTimeout(timeout);
            cleanup();
            finalize();
        };

        const onError = (err: Error, code: number, id: number) => {
            if (id !== reqId) return;
            clearTimeout(timeout);
            cleanup();
            // Common: code 162 = "Historical Market Data Service error message: No scanner results"
            if (code === 162) {
                finalize(); // empty results
            } else {
                reject(new Error(`[scanner-loop] Error ${code}: ${err.message}`));
            }
        };

        function cleanup() {
            api.off(EventName.scannerData, onScannerData);
            api.off(EventName.scannerDataEnd, onScannerDataEnd);
            api.off(EventName.error, onError);
            api.cancelScannerSubscription(reqId);
        }

        function finalize() {
            const snapshot: ScanSnapshot = {
                scanCode,
                timestamp: Date.now(),
                results,
            };
            cache.set(scanCode, snapshot);
            resolve(results);
        }

        api.on(EventName.scannerData, onScannerData);
        api.on(EventName.scannerDataEnd, onScannerDataEnd);
        api.on(EventName.error, onError);

        api.reqScannerSubscription(reqId, subscription);
    });
}

// ---------------------------------------------------------------------------
// Multi-scan convenience
// ---------------------------------------------------------------------------

/** Run multiple scan types in parallel and merge results. */
export async function runPreMarketScans(): Promise<Map<string, ScanResult[]>> {
    const scans: Array<{ code: ScanCode; label: string }> = [
        { code: 'TOP_PERC_GAIN', label: 'Top % Gainers' },
        { code: 'TOP_PERC_LOSE', label: 'Top % Losers' },
        { code: 'MOST_ACTIVE', label: 'Most Active' },
        { code: 'HOT_BY_VOLUME', label: 'Hot by Volume' },
    ];

    const entries = await Promise.all(
        scans.map(async (s) => {
            try {
                const results = await runScan(s.code);
                return [s.label, results] as const;
            } catch (err) {
                logger.warn(`[scanner-loop] ${s.label} scan failed: ${err}`);
                return [s.label, [] as ScanResult[]] as const;
            }
        }),
    );

    return new Map(entries);
}

/**
 * Get unique symbols from the last scan results.
 * Useful for feeding into ibkr-stream subscriptions.
 */
export function getCachedSymbols(): string[] {
    const symbols = new Set<string>();
    for (const snapshot of cache.values()) {
        for (const r of snapshot.results) {
            if (r.symbol) symbols.add(r.symbol);
        }
    }
    return [...symbols];
}

/**
 * Clear the scanner cache.
 */
export function clearCache(): void {
    cache.clear();
}
