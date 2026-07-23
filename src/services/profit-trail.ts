/**
 * Profit trail — lock in winners automatically.
 *
 * Operator rule (2026-07-23): "any accepted order that reaches ~+5% should
 * be closed automatically on a ~1% pullback." Deterministic watcher, no
 * LLM: during regular hours it polls positions and quotes, tracks each
 * position's best price since watching began, ARMS once unrealized gain
 * reaches `profit_trail_arm_pct`, and market-closes (via closePosition —
 * which also cancels the bracket exits and suppresses auto-protect) when
 * price gives back `profit_trail_pullback_pct` from the peak.
 *
 * Direction-aware (short positions arm on drops and close on bounces).
 * High-water marks persist across restarts in profit-trail.json.
 * Disable with PROFIT_TRAIL=false.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getIBApi } from '@/tools/ibkr/connection.js';
import { createIbkrMarketData } from '@/tools/ibkr/market-data.js';
import { getRiskRules } from '@/tools/ibkr/risk-rules.js';
import { logger } from '@/utils';
import { getMarketSession, MarketSession } from '@/utils/market-hours.js';
import { closePosition, fetchPositions, wasRecentlyClosed } from './position-actions.js';

const POLL_MS = 60_000;
const QUOTE_PACE_MS = 400;

// ---------------------------------------------------------------------------
// Pure state machine (unit-tested)
// ---------------------------------------------------------------------------

export interface TrailEntry {
    symbol: string;
    direction: 'long' | 'short';
    basis: number;      // avg cost
    quantity: number;   // absolute
    best: number;       // best price seen for the position's direction
    armed: boolean;
}

export interface TrailDecision {
    action: 'close';
    gainAtBestPct: number;
    pullbackPct: number;
}

/** Feed one observation; mutates the entry, returns a decision if due. */
export function observeTrail(
    e: TrailEntry,
    price: number,
    armPct: number,
    pullbackPct: number,
): TrailDecision | null {
    if (!(price > 0) || !(e.basis > 0)) return null;

    // Track the best price in the profitable direction.
    if (e.direction === 'long' ? price > e.best : price < e.best) e.best = price;

    const gainAtBest = e.direction === 'long'
        ? (e.best - e.basis) / e.basis
        : (e.basis - e.best) / e.basis;
    if (!e.armed && gainAtBest >= armPct / 100) {
        e.armed = true;
    }
    if (!e.armed) return null;

    const pullback = e.direction === 'long'
        ? (e.best - price) / e.best
        : (price - e.best) / e.best;
    if (pullback >= pullbackPct / 100) {
        return {
            action: 'close',
            gainAtBestPct: Math.round(gainAtBest * 1000) / 10,
            pullbackPct: Math.round(pullback * 1000) / 10,
        };
    }
    return null;
}

// ---------------------------------------------------------------------------
// Persistence — the peak must survive the nightly Gateway/process restarts,
// or every restart silently re-arms from a lower high.
// ---------------------------------------------------------------------------

function statePath(): string {
    return join(process.env.DEXTER_DATA_DIR || join('.dexter', 'data'), 'profit-trail.json');
}

function loadState(): Map<string, TrailEntry> {
    try {
        const raw = JSON.parse(readFileSync(statePath(), 'utf-8')) as TrailEntry[];
        return new Map(raw.map((e) => [e.symbol, e]));
    } catch {
        return new Map();
    }
}

function saveState(state: Map<string, TrailEntry>): void {
    try {
        writeFileSync(statePath(), JSON.stringify([...state.values()], null, 2));
    } catch (err) {
        logger.warn(`[profit-trail] state persist failed: ${err}`);
    }
}

// ---------------------------------------------------------------------------
// Watcher loop
// ---------------------------------------------------------------------------

type TrailAlertCallback = (message: string) => void | Promise<void>;
const alertCallbacks = new Set<TrailAlertCallback>();

/** Register a callback for profit-trail closes (bridged to WhatsApp). */
export function onProfitTrailAlert(cb: TrailAlertCallback): () => void {
    alertCallbacks.add(cb);
    return () => alertCallbacks.delete(cb);
}

export function isProfitTrailEnabled(): boolean {
    return (process.env.PROFIT_TRAIL ?? 'true').trim().toLowerCase() !== 'false';
}

async function fetchLast(symbol: string): Promise<number | null> {
    try {
        const raw = await createIbkrMarketData().invoke({ ticker: symbol, exchange: 'SMART', currency: 'USD' });
        const data = (JSON.parse(String(raw)) as { data?: { last?: number; bid?: number; ask?: number } }).data;
        if (data?.last && Number.isFinite(data.last) && data.last > 0) return data.last;
        if (data?.bid && data?.ask && data.bid > 0 && data.ask > 0) return (data.bid + data.ask) / 2;
        return null;
    } catch {
        return null;
    }
}

async function runCycle(state: Map<string, TrailEntry>): Promise<void> {
    if (getMarketSession().session !== MarketSession.REGULAR) return;

    const rules = getRiskRules();
    const api = await getIBApi();
    const positions = (await fetchPositions(api)).filter((p) => p.quantity !== 0);
    const held = new Set(positions.map((p) => p.symbol));

    // Drop state for positions that no longer exist.
    for (const sym of [...state.keys()]) {
        if (!held.has(sym)) state.delete(sym);
    }

    for (const pos of positions) {
        if (wasRecentlyClosed(pos.symbol)) continue;
        const direction = pos.quantity > 0 ? 'long' : 'short';
        let entry = state.get(pos.symbol);
        // (Re)seed when new or when the position itself changed (re-entry,
        // size change → the old peak belongs to a different trade).
        if (!entry || entry.direction !== direction || Math.abs(entry.basis - pos.avgCost) / pos.avgCost > 0.005) {
            entry = {
                symbol: pos.symbol,
                direction,
                basis: pos.avgCost,
                quantity: Math.abs(pos.quantity),
                best: pos.avgCost,
                armed: false,
            };
            state.set(pos.symbol, entry);
        }

        const price = await fetchLast(pos.symbol);
        await new Promise((r) => setTimeout(r, QUOTE_PACE_MS));
        if (price === null) continue;

        const decision = observeTrail(entry, price, rules.profit_trail_arm_pct, rules.profit_trail_pullback_pct);
        if (!decision) continue;

        logger.info(
            `[profit-trail] ${pos.symbol}: peak gain ${decision.gainAtBestPct}% (best ${entry.best}), ` +
            `pullback ${decision.pullbackPct}% at ${price} — closing`,
        );
        const outcome = await closePosition(pos.symbol);
        state.delete(pos.symbol);
        const message =
            `📉➡️💰 PROFIT TRAIL ${pos.symbol}: peaked +${decision.gainAtBestPct}% (best ${entry.best}, ` +
            `basis ${entry.basis.toFixed(2)}), pulled back ${decision.pullbackPct}% to ${price}. ${outcome.message}`;
        for (const cb of [...alertCallbacks]) {
            try { await cb(message); } catch (err) {
                logger.error(`[profit-trail] alert callback failed: ${err}`);
            }
        }
    }
    saveState(state);
}

let timer: ReturnType<typeof setInterval> | null = null;
let cycleRunning = false;

/** Start the watcher (idempotent; no-op when PROFIT_TRAIL=false). */
export function startProfitTrail(): void {
    if (timer || !isProfitTrailEnabled()) return;
    const state = loadState();
    const rules = getRiskRules();
    timer = setInterval(() => {
        if (cycleRunning) return;
        cycleRunning = true;
        runCycle(state)
            .catch((err) => logger.warn(`[profit-trail] cycle failed: ${err}`))
            .finally(() => { cycleRunning = false; });
    }, POLL_MS);
    logger.info(
        `[profit-trail] started: arm at +${rules.profit_trail_arm_pct}%, ` +
        `close on ${rules.profit_trail_pullback_pct}% pullback from the peak (poll ${POLL_MS / 1000}s, RTH only)`,
    );
}

export function stopProfitTrail(): void {
    if (timer) { clearInterval(timer); timer = null; }
}
