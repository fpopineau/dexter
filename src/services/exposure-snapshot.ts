/**
 * Broker-canonical exposure (WP4, REMEDIATION-2026-08-20).
 *
 * Every exposure cap used to read proposal rows only — a manual TWS
 * position, an unadopted order, or any DB/broker drift meant the caps
 * understated the real book. Acceptance now takes the UNION of the DB
 * view and a fresh broker snapshot, per symbol at the MAX of the two:
 * whichever side believes there is more exposure wins.
 *
 * Planned-RISK headroom stays DB-side: a broker-only position has no
 * stop to price. WP3's adoption sweep turns such positions into rows
 * with synthetic levels within one cycle — this union is the backstop
 * for the window in between, guarding the count and notional caps.
 */

import { getIBApi, getVerifiedSingleAccount } from '@/tools/ibkr/connection.js';
import { logger } from '@/utils';
import { fetchPositions } from './position-actions.js';

export interface DbExposureRow {
    symbol: string;
    quantity: number;
    valueUsd: number;
}

export interface BrokerExposureRow {
    symbol: string;
    /** Signed: positive = long, negative = short. */
    quantity: number;
    avgCost: number;
}

export interface ExposureUnion {
    /** Distinct symbols across both views vs per-proposal DB rows —
     *  callers take the max against their row count. */
    distinctSymbols: number;
    /** Per-symbol notional (USD), MAX of the DB and broker views. */
    notionalBySymbol: Map<string, number>;
    /** Symbols the broker holds that NO DB row covers — the drift the
     *  audit called invisible. Surfaced for logging. */
    brokerOnlySymbols: string[];
}

/** Pure: union the two exposure views, max per symbol. */
export function unionExposure(db: DbExposureRow[], broker: BrokerExposureRow[]): ExposureUnion {
    const notionalBySymbol = new Map<string, number>();
    const dbSymbols = new Set<string>();
    for (const row of db) {
        const sym = row.symbol.toUpperCase();
        dbSymbols.add(sym);
        notionalBySymbol.set(sym, (notionalBySymbol.get(sym) ?? 0) + Math.abs(row.valueUsd));
    }
    const brokerOnlySymbols: string[] = [];
    for (const pos of broker) {
        if (pos.quantity === 0) continue;
        const sym = pos.symbol.toUpperCase();
        const notional = Math.abs(pos.quantity) * pos.avgCost;
        // MAX, not sum: the DB rows and the broker position describe the
        // SAME exposure when they agree — summing would double-count.
        notionalBySymbol.set(sym, Math.max(notionalBySymbol.get(sym) ?? 0, notional));
        if (!dbSymbols.has(sym)) brokerOnlySymbols.push(sym);
    }
    return {
        distinctSymbols: notionalBySymbol.size,
        notionalBySymbol,
        brokerOnlySymbols,
    };
}

const SNAPSHOT_TTL_MS = 10_000;
let cache: { at: number; rows: BrokerExposureRow[] } | null = null;

/** Verified-account broker positions, cached 10s (accepts can burst).
 *  THROWS on failure — the accept path fails closed by contract: a
 *  proposal can wait; unknown exposure cannot. */
export async function fetchBrokerExposure(): Promise<BrokerExposureRow[]> {
    if (cache && Date.now() - cache.at < SNAPSHOT_TTL_MS) return cache.rows;
    const api = await getIBApi();
    const account = getVerifiedSingleAccount();
    const rows = (await fetchPositions(api))
        .filter((p) => p.account === account && p.quantity !== 0)
        .map((p) => ({ symbol: p.symbol.toUpperCase(), quantity: p.quantity, avgCost: p.avgCost }));
    cache = { at: Date.now(), rows };
    logger.info(`[exposure-snapshot] broker book: ${rows.length} position(s) in ${account}`);
    return rows;
}

/** Test hook: clear the snapshot cache. */
export function __resetExposureCacheForTests(): void {
    cache = null;
}
