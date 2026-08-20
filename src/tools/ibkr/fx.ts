/**
 * FX conversion at the account boundary (WP8, REMEDIATION-2026-08-20).
 *
 * The account's base currency is EUR while every price, cap and risk
 * budget is USD. The old code documented the mixing and moved on — safe
 * only because EUR/USD > 1 makes treating EUR as USD UNDER-size, and
 * silently inverting if the rate ever crosses parity. One conversion,
 * here, at the boundary: everything downstream is USD.
 *
 * Rate source: IDEALPRO cash midpoint (bid/ask tickPrice), cached 1h —
 * position sizing does not need tick-fresh FX. Unavailable rate for a
 * non-USD base THROWS: callers fail closed (a cap computed in the wrong
 * currency is worse than a refused accept).
 */

import { EventName, SecType, type Contract } from '@stoqey/ib';
import { allocReqId, getIBApi } from './connection.js';
import { logger } from '@/utils';

const RATE_TTL_MS = 60 * 60_000;
const rateCache = new Map<string, { rate: number; at: number }>();

/** Pure: base-currency amount × (USD per unit) — the direction test pins
 *  MULTIPLY (EUR at 1.08 grows the USD figure; divide was the bug class). */
export function convertBaseToUsd(amount: number, usdPerUnit: number): number {
    return Math.round(amount * usdPerUnit * 100) / 100;
}

/** USD per 1 unit of `currency` (identity for USD), cached 1h. */
export async function usdRate(currency: string): Promise<number> {
    const cur = currency.trim().toUpperCase();
    if (cur === 'USD' || cur === '') return 1;
    const hit = rateCache.get(cur);
    if (hit && Date.now() - hit.at < RATE_TTL_MS) return hit.rate;

    const api = await getIBApi();
    const rate = await new Promise<number>((resolve, reject) => {
        const reqId = allocReqId();
        let bid: number | null = null;
        let ask: number | null = null;
        const timer = setTimeout(() => {
            finish(null);
        }, 5_000);
        function finish(mid: number | null) {
            clearTimeout(timer);
            api.off(EventName.tickPrice, onTick);
            try { api.cancelMktData(reqId); } catch { /* gone */ }
            if (mid !== null && mid > 0) resolve(mid);
            else reject(new Error(`[fx] ${cur}.USD rate unavailable`));
        }
        const onTick = (id: number, field: number, price: number) => {
            if (id !== reqId || !(price > 0)) return;
            if (field === 1) bid = price; // bid
            if (field === 2) ask = price; // ask
            if (field === 4 && bid === null && ask === null) { finish(price); return; } // last as fallback
            if (bid !== null && ask !== null) finish((bid + ask) / 2);
        };
        api.on(EventName.tickPrice, onTick);
        const contract: Contract = {
            symbol: cur,
            secType: SecType.CASH,
            currency: 'USD',
            exchange: 'IDEALPRO',
        };
        api.reqMktData(reqId, contract, '', false, false);
    });
    rateCache.set(cur, { rate, at: Date.now() });
    logger.info(`[fx] ${cur}.USD = ${rate.toFixed(4)} (cached 1h)`);
    return rate;
}

/** Convert a base-currency amount to USD. THROWS when the rate is
 *  unavailable for a non-USD base — fail closed, never mis-currency. */
export async function convertToUsd(amount: number, currency: string): Promise<number> {
    return convertBaseToUsd(amount, await usdRate(currency));
}

/** Test hook: clear the rate cache. */
export function __resetFxCacheForTests(): void {
    rateCache.clear();
}
