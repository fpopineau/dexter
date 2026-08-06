/**
 * Options-implied earnings move — READ-ONLY options data, no options
 * trading. The ATM straddle expiring just after a print is the market's
 * priced-in expectation for the move; comparing it to the symbol's own
 * historical post-print moves (earnings-reactions.ts) is one of the four
 * earnings-bet signals.
 *
 *   implied move % ≈ (ATM call mid + ATM put mid) / spot × 100
 *
 * Entitlement caveat: like the news API (see smoke-live probe notes), the
 * paper account's OPRA entitlement is unverified — every request degrades
 * gracefully to nulls with a note instead of blocking. The skill treats a
 * missing implied move as a known blind spot, not an error.
 */

import { EventName, SecType, OptionType, type Contract } from '@stoqey/ib';
import { BarSizeSetting } from '@stoqey/ib';
import { getIBApi, allocReqId, isNonFatalIbkrError } from './connection.js';
import { fetchBars } from './signal-scorer.js';
import { logger } from '@/utils';

export interface ImpliedMoveResult {
    symbol: string;
    /** Priced-in move %, or null when options data is unavailable. */
    impliedMovePct: number | null;
    expiration: string | null;
    strike: number | null;
    callMid: number | null;
    putMid: number | null;
    spot: number | null;
    /** Why impliedMovePct is null / any degradation along the way. */
    note?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** Nearest expiration ON/AFTER `afterIso` ('YYYY-MM-DD'); expirations are
 *  IBKR 'YYYYMMDD' strings. Returns null when none qualify. */
export function pickExpiration(expirations: string[], afterIso: string): string | null {
    const floor = afterIso.replace(/-/g, '');
    const sorted = [...new Set(expirations)].filter((e) => /^\d{8}$/.test(e)).sort();
    return sorted.find((e) => e >= floor) ?? null;
}

/** Strike closest to spot (ties → the lower strike). */
export function nearestStrike(strikes: number[], spot: number): number | null {
    const valid = [...new Set(strikes)].filter((s) => Number.isFinite(s) && s > 0).sort((a, b) => a - b);
    if (valid.length === 0 || !(spot > 0)) return null;
    let best = valid[0];
    for (const s of valid) {
        if (Math.abs(s - spot) < Math.abs(best - spot)) best = s;
    }
    return best;
}

/** Usable option price from a snapshot: bid/ask mid when both sides exist,
 *  else last, else close. Null when nothing usable ticked. */
export function midPrice(t: { bid?: number; ask?: number; last?: number; close?: number }): number | null {
    if (t.bid != null && t.ask != null && t.bid > 0 && t.ask > 0 && t.ask >= t.bid) {
        return (t.bid + t.ask) / 2;
    }
    if (t.last != null && t.last > 0) return t.last;
    if (t.close != null && t.close > 0) return t.close;
    return null;
}

// ---------------------------------------------------------------------------
// IBKR plumbing
// ---------------------------------------------------------------------------

const STEP_TIMEOUT_MS = 10_000;

function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
    return Promise.race([
        p,
        new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`${label} timed out after ${STEP_TIMEOUT_MS / 1000}s`)), STEP_TIMEOUT_MS)),
    ]);
}

/** Resolve the stock's conId (needed by reqSecDefOptParams). */
async function fetchConId(symbol: string): Promise<number> {
    const api = await getIBApi();
    const reqId = allocReqId();
    const contract: Contract = { symbol, secType: SecType.STK, exchange: 'SMART', currency: 'USD' };
    return withTimeout(new Promise<number>((resolve, reject) => {
        let conId: number | null = null;
        const onDetails = (id: number, details: { contract?: { conId?: number } }) => {
            if (id !== reqId) return;
            conId ??= details?.contract?.conId ?? null;
        };
        const onEnd = (id: number) => {
            if (id !== reqId) return;
            cleanup();
            if (conId != null) resolve(conId);
            else reject(new Error(`no contract details for ${symbol}`));
        };
        const onError = (err: Error, code: number, id: number) => {
            if (id !== reqId || isNonFatalIbkrError(code)) return;
            cleanup();
            reject(new Error(`contract details error ${code}: ${err.message}`));
        };
        function cleanup() {
            api.off(EventName.contractDetails, onDetails);
            api.off(EventName.contractDetailsEnd, onEnd);
            api.off(EventName.error, onError);
        }
        api.on(EventName.contractDetails, onDetails);
        api.on(EventName.contractDetailsEnd, onEnd);
        api.on(EventName.error, onError);
        api.reqContractDetails(reqId, contract);
    }), `contract details for ${symbol}`);
}

interface OptionChainParams { expirations: string[]; strikes: number[] }

/** SMART option chain parameters for the underlying. */
async function fetchOptionParams(symbol: string, conId: number): Promise<OptionChainParams> {
    const api = await getIBApi();
    const reqId = allocReqId();
    return withTimeout(new Promise<OptionChainParams>((resolve, reject) => {
        const collected: OptionChainParams = { expirations: [], strikes: [] };
        const onParams = (
            id: number, exchange: string, _underlyingConId: number, _tradingClass: string,
            _multiplier: string, expirations: string[], strikes: number[],
        ) => {
            if (id !== reqId) return;
            // SMART aggregates the venues; fall back to anything if SMART
            // never arrives (some feeds only publish per-exchange rows).
            if (exchange === 'SMART' || collected.expirations.length === 0) {
                collected.expirations = expirations ?? [];
                collected.strikes = strikes ?? [];
            }
        };
        const onEnd = (id: number) => {
            if (id !== reqId) return;
            cleanup();
            if (collected.expirations.length > 0) resolve(collected);
            else reject(new Error('no option chain parameters returned'));
        };
        const onError = (err: Error, code: number, id: number) => {
            if (id !== reqId || isNonFatalIbkrError(code)) return;
            cleanup();
            reject(new Error(`option params error ${code}: ${err.message}`));
        };
        function cleanup() {
            api.off(EventName.securityDefinitionOptionParameter, onParams);
            api.off(EventName.securityDefinitionOptionParameterEnd, onEnd);
            api.off(EventName.error, onError);
        }
        api.on(EventName.securityDefinitionOptionParameter, onParams);
        api.on(EventName.securityDefinitionOptionParameterEnd, onEnd);
        api.on(EventName.error, onError);
        api.reqSecDefOptParams(reqId, symbol, '', 'STK', conId);
    }), `option chain for ${symbol}`);
}

/** Snapshot an option's quote and reduce it to one usable price. */
async function fetchOptionMid(
    symbol: string, expiration: string, strike: number, right: OptionType,
): Promise<number | null> {
    const api = await getIBApi();
    const reqId = allocReqId();
    const contract: Contract = {
        symbol,
        secType: SecType.OPT,
        lastTradeDateOrContractMonth: expiration,
        strike,
        right,
        exchange: 'SMART',
        currency: 'USD',
        multiplier: 100,
    };
    try {
        return await withTimeout(new Promise<number | null>((resolve, reject) => {
            const ticks: { bid?: number; ask?: number; last?: number; close?: number } = {};
            const onTick = (id: number, field: number, price: number) => {
                if (id !== reqId || !(price > 0)) return;
                if (field === 1) ticks.bid = price;
                else if (field === 2) ticks.ask = price;
                else if (field === 4) ticks.last = price;
                else if (field === 9) ticks.close = price;
                // Both sides of the book are enough — settle immediately.
                if (ticks.bid != null && ticks.ask != null) settle();
            };
            const onSnapshotEnd = (id: number) => {
                if (id !== reqId) return;
                settle();
            };
            const onError = (err: Error, code: number, id: number) => {
                if (id !== reqId || isNonFatalIbkrError(code)) return;
                cleanup();
                reject(new Error(`option quote error ${code}: ${err.message}`));
            };
            function settle() {
                cleanup();
                resolve(midPrice(ticks));
            }
            function cleanup() {
                api.off(EventName.tickPrice, onTick);
                api.off(EventName.tickSnapshotEnd, onSnapshotEnd);
                api.off(EventName.error, onError);
            }
            api.on(EventName.tickPrice, onTick);
            api.on(EventName.tickSnapshotEnd, onSnapshotEnd);
            api.on(EventName.error, onError);
            // snapshot=true: one-shot, self-cancelling — no streaming line held.
            api.reqMktData(reqId, contract, '', true, false);
        }), `option quote ${symbol} ${expiration} ${strike}${right}`);
    } catch (err) {
        logger.warn(`[implied-move] ${symbol}: ${err instanceof Error ? err.message : err}`);
        return null;
    }
}

/**
 * Compute the options-implied move for a print whose reaction lands on/after
 * `reactionDateIso` (default: tomorrow). Never throws for data problems —
 * degrades to nulls with a note.
 */
export async function fetchImpliedMove(symbol: string, reactionDateIso?: string): Promise<ImpliedMoveResult> {
    const sym = symbol.toUpperCase();
    const none = (note: string): ImpliedMoveResult => ({
        symbol: sym, impliedMovePct: null, expiration: null, strike: null,
        callMid: null, putMid: null, spot: null, note,
    });

    let spot: number;
    try {
        const bars = await fetchBars(sym, BarSizeSetting.DAYS_ONE, '5 D', true);
        const close = bars[bars.length - 1]?.close;
        if (close == null || !(close > 0)) return none('no recent price for the underlying');
        spot = close;
    } catch (err) {
        return none(`underlying price unavailable: ${err instanceof Error ? err.message : err}`);
    }

    const after = reactionDateIso ?? new Date(Date.now() + 24 * 3600_000).toISOString().slice(0, 10);
    try {
        const conId = await fetchConId(sym);
        const chain = await fetchOptionParams(sym, conId);
        const expiration = pickExpiration(chain.expirations, after);
        const strike = nearestStrike(chain.strikes, spot);
        if (!expiration || strike == null) {
            return none('option chain has no usable expiration/strike after the print');
        }
        const [callMid, putMid] = await Promise.all([
            fetchOptionMid(sym, expiration, strike, OptionType.Call),
            fetchOptionMid(sym, expiration, strike, OptionType.Put),
        ]);
        if (callMid == null || putMid == null) {
            return {
                symbol: sym, impliedMovePct: null, expiration, strike,
                callMid, putMid, spot,
                note: 'option quotes unavailable — likely missing OPRA entitlement on this account; ' +
                    'treat the implied move as unknown, not zero',
            };
        }
        return {
            symbol: sym,
            impliedMovePct: Math.round(((callMid + putMid) / spot) * 10000) / 100,
            expiration, strike, callMid, putMid, spot,
        };
    } catch (err) {
        return none(`options data unavailable: ${err instanceof Error ? err.message : err}`);
    }
}
