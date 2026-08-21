/**
 * Profit trail — lock in winners automatically.
 *
 * Operator rule (2026-07-23): a winner that has run should be closed
 * automatically when it starts giving the move back. Deterministic
 * watcher, no LLM: during regular hours it polls positions and quotes,
 * tracks each position's best price since watching began, ARMS once
 * unrealized gain reaches the arm threshold, and market-closes (via
 * closePosition — which also cancels the bracket exits and suppresses
 * auto-protect) when price gives back the trail distance from the peak.
 *
 * ATR-AWARE (2026-08-11): thresholds scale with the symbol's daily ATR
 * (arm at `profit_trail_arm_atr_mult` × ATR, trail at
 * `profit_trail_pullback_atr_mult` × ATR) so the geometry is uniform in
 * R-space. The old absolute pair never armed below ~1.7% ATR and flushed
 * high-ATR runners at ~0.5-0.8R inside single-bar noise. The absolute
 * `profit_trail_arm_pct` / `profit_trail_pullback_pct` remain as the
 * fallback when ATR is unavailable (fail-open to the old behavior, never
 * to no-trail).
 *
 * CLASS-AWARE (2026-08-11): only intraday positions (including 🌙
 * kept-overnight holds) are trailed. Swings live on daily structure — a
 * sub-ATR trail would flush normal pullbacks the pattern plan expects;
 * earnings bets exist to hold through a binary print the trail would
 * front-run. Positions with no tracked proposal keep the trail
 * (protective default for orphans).
 *
 * Direction-aware (short positions arm on drops and close on bounces).
 * High-water marks persist across restarts in profit-trail.json.
 * Disable with PROFIT_TRAIL=false.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getIBApi } from '@/tools/ibkr/connection.js';
import { confirmCancel } from '@/tools/ibkr/order-ack.js';
import { fetchDailyRiskContext } from '@/tools/ibkr/daily-atr.js';
import { createIbkrMarketData } from '@/tools/ibkr/market-data.js';
import { getRiskRules, type TradeClass } from '@/tools/ibkr/risk-rules.js';
import { logger } from '@/utils';
import { getMarketSession, MarketSession } from '@/utils/market-hours.js';
import { closePosition, fetchOpenOrdersFor, fetchPositions, wasRecentlyClosed } from './position-actions.js';

/** Broker-confirmation window for a cancel request (round-4 review). */
const CANCEL_CONFIRM_MS = 5_000;
import { listTrackable } from './trade-proposals.js';
import { OrderAction } from '@stoqey/ib';

const POLL_MS = 60_000;
const QUOTE_PACE_MS = 400;
/** Never trail tighter than this (%): below it, spread + one quote tick
 *  reads as a "pullback" on the 60s poll. */
const PULLBACK_FLOOR_PCT = 0.35;

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
    /** Last observed price (refreshed each RTH cycle). The dashboard derives
     *  the position's INSTANT gain from this — `best` only ratchets, so a
     *  peak-based percentage would keep reading like profit after the price
     *  gave it all back. Optional: absent on entries persisted before the
     *  field existed, until their first observation. */
    last?: number;
}

export interface TrailDecision {
    action: 'close';
    gainAtBestPct: number;
    pullbackPct: number;
}

export interface TrailGeometry {
    armPct: number;
    pullbackPct: number;
    /** 'atr' when derived from the symbol's daily ATR; 'absolute' when the
     *  ATR was unavailable and the fallback percentages apply. */
    mode: 'atr' | 'absolute';
}

/**
 * Effective trail thresholds for one position. ATR known → thresholds in
 * ATR units (uniform R-space geometry across volatility regimes), with a
 * spread-noise floor on the pullback and arm clamped to ≥ 2× pullback so
 * a misconfigured pair can never arm inside its own trail distance.
 * ATR unknown → the absolute fallback pair (old behavior), never no-trail.
 */
export function trailGeometry(input: {
    /** Daily ATR as a % of the position's basis, or null when unavailable. */
    atrPct: number | null;
    armAtrMult: number;
    pullbackAtrMult: number;
    armPctFallback: number;
    pullbackPctFallback: number;
}): TrailGeometry {
    if (input.atrPct !== null && input.atrPct > 0) {
        const pullbackPct = Math.max(PULLBACK_FLOOR_PCT, input.pullbackAtrMult * input.atrPct);
        const armPct = Math.max(2 * pullbackPct, input.armAtrMult * input.atrPct);
        return {
            armPct: Math.round(armPct * 100) / 100,
            pullbackPct: Math.round(pullbackPct * 100) / 100,
            mode: 'atr',
        };
    }
    return { armPct: input.armPctFallback, pullbackPct: input.pullbackPctFallback, mode: 'absolute' };
}

/**
 * Should the trail leave this symbol alone? Any swing or earnings-bet
 * proposal on the symbol exempts the whole position: a swing lives on
 * daily structure (a sub-ATR trail flushes the pullbacks its plan
 * expects), and an earnings bet exists to hold through the print. An
 * intraday scalp stacked on top does not override that — never flush a
 * thesis position to protect a scalp.
 */
export function trailExemptClass(classes: TradeClass[]): boolean {
    return classes.some((c) => c === 'swing' || c === 'earnings-bet');
}

/** Feed one observation; mutates the entry, returns a decision if due. */
export function observeTrail(
    e: TrailEntry,
    price: number,
    armPct: number,
    pullbackPct: number,
): TrailDecision | null {
    if (!(price > 0) || !(e.basis > 0)) return null;

    // Record the observation itself — consumers (dashboard) need the live
    // mark, not just the ratcheting peak.
    e.last = price;

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
        const data = (JSON.parse(String(raw)) as { data?: { last?: number; bid?: number; ask?: number; delayed?: boolean } }).data;
        // A delayed quote must never drive a trail decision (peak tracking
        // and pullback closes assume the price is NOW) — skip the cycle
        // for this symbol instead. Only matters if an instrument loses its
        // live entitlement under IBKR_MARKET_DATA_TYPE=3. Loud on purpose:
        // a silent skip every cycle would blind the trail invisibly.
        if (data?.delayed) {
            logger.warn(`[profit-trail] ${symbol}: quote is DELAYED (entitlement regression?) — trail cannot observe this symbol`);
            return null;
        }
        if (data?.last && Number.isFinite(data.last) && data.last > 0) return data.last;
        if (data?.bid && data?.ask && data.bid > 0 && data.ask > 0) return (data.bid + data.ask) / 2;
        return null;
    } catch {
        return null;
    }
}

/** Pure: which side a position's EXIT orders sit on — a long exits by
 *  SELLING (target = SELL LMT above, stop = SELL STP below); a short exits
 *  by BUYING (target = BUY LMT below, stop = BUY STP above). */
export function exitActionFor(direction: 'long' | 'short'): OrderAction {
    return direction === 'long' ? OrderAction.SELL : OrderAction.BUY;
}

/** Pure: the target legs among a position's exit-side orders. The target
 *  is always the LMT leg regardless of direction; the STP leg is the stop
 *  and must never be selected. */
export function selectTargetLegs<T extends { orderType: string }>(exitOrders: T[]): T[] {
    return exitOrders.filter((o) => o.orderType === 'LMT');
}

/**
 * Runner mode: on arming, cancel the position's fixed TARGET leg so the
 * trail manages the exit — a hard target caps exactly the winners that run
 * (PLTR 2026-08-04: +5.6% banked of a +29% move). The stop leg stays; OCA
 * siblings survive a manual cancel of one leg. Finds the target among the
 * live exit orders (covers both tracked brackets and auto-protect pairs on
 * orphaned positions).
 */
async function releaseTargetLeg(
    api: Awaited<ReturnType<typeof getIBApi>>,
    entry: TrailEntry,
): Promise<string | null> {
    // A partial view (complete=false) just finds fewer targets — each
    // release is individually cancel-confirmed, and a missed target means
    // runner mode is not announced: conservative either way.
    const exits = (await fetchOpenOrdersFor(api, entry.symbol, exitActionFor(entry.direction))).orders;
    const targets = selectTargetLegs(exits);
    if (targets.length === 0) return null;
    // Round-4 review (2026-08-21): "released" means the broker CONFIRMED
    // the cancel — announcing runner mode while the fixed target may still
    // be working promises an exit management that is not in effect.
    const released: string[] = [];
    for (const t of targets) {
        const outcome = await confirmCancel(api, t.orderId, CANCEL_CONFIRM_MS);
        if (outcome === 'cancelled') {
            released.push(`#${t.orderId}`);
            logger.info(`[profit-trail] ${entry.symbol}: runner mode — target order #${t.orderId} cancelled (confirmed), trail manages the exit`);
        } else if (outcome === 'filled') {
            // The target won the race: profit banked at the fixed target.
            // The tracker handles the fill; runner mode is moot.
            logger.warn(`[profit-trail] ${entry.symbol}: target #${t.orderId} FILLED during runner-mode release — exit already taken at the fixed target`);
        } else {
            logger.error(`[profit-trail] ${entry.symbol}: target #${t.orderId} cancel NOT CONFIRMED — the fixed target may still be working; runner mode not announced`);
        }
    }
    return released.length > 0 ? released.join(', ') : null;
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

    // Class exemption: swing / earnings-bet positions are not trailed.
    // Fail-open to trailing (empty map) if the store is unreadable —
    // protecting an orphan beats exempting a swing.
    const classesBySymbol = new Map<string, TradeClass[]>();
    try {
        for (const t of await listTrackable()) {
            classesBySymbol.set(t.symbol, [...(classesBySymbol.get(t.symbol) ?? []), t.tradeClass]);
        }
    } catch (err) {
        logger.warn(`[profit-trail] trackable lookup failed (all positions trailed this cycle): ${err}`);
    }

    for (const pos of positions) {
        if (wasRecentlyClosed(pos.symbol)) continue;
        if (trailExemptClass(classesBySymbol.get(pos.symbol) ?? [])) {
            // A stale entry must not linger: if the class changes back
            // (position re-entered intraday), the peak restarts honestly.
            state.delete(pos.symbol);
            continue;
        }
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

        // Daily ATR (10-min cache in daily-atr) → ATR-relative thresholds;
        // null falls back to the absolute pair.
        const atr = (await fetchDailyRiskContext(pos.symbol)).dailyAtr;
        const geometry = trailGeometry({
            atrPct: atr !== null && entry.basis > 0 ? (atr / entry.basis) * 100 : null,
            armAtrMult: rules.profit_trail_arm_atr_mult,
            pullbackAtrMult: rules.profit_trail_pullback_atr_mult,
            armPctFallback: rules.profit_trail_arm_pct,
            pullbackPctFallback: rules.profit_trail_pullback_pct,
        });

        const wasArmed = entry.armed;
        const decision = observeTrail(entry, price, geometry.armPct, geometry.pullbackPct);

        // Arming transition → runner mode (unless the same tick already
        // decided to close, in which case closePosition cancels everything).
        if (!wasArmed && entry.armed && !decision && rules.profit_trail_replaces_target) {
            try {
                const released = await releaseTargetLeg(api, entry);
                if (released) {
                    const how = geometry.mode === 'atr'
                        ? `${rules.profit_trail_pullback_atr_mult}×ATR = ${geometry.pullbackPct}%`
                        : `${geometry.pullbackPct}% (absolute fallback — ATR unavailable)`;
                    const msg =
                        `🏃 RUNNER ${pos.symbol}: trail armed at +${geometry.armPct}% (best ${entry.best}) — ` +
                        `target order ${released} released; the exit is now the ${how} trail. The stop stays.`;
                    for (const cb of [...alertCallbacks]) {
                        try { await cb(msg); } catch (err) {
                            logger.error(`[profit-trail] alert callback failed: ${err}`);
                        }
                    }
                }
            } catch (err) {
                logger.warn(`[profit-trail] ${pos.symbol}: runner-mode release failed (target stays): ${err}`);
            }
        }

        if (!decision) continue;

        logger.info(
            `[profit-trail] ${pos.symbol}: peak gain ${decision.gainAtBestPct}% (best ${entry.best}), ` +
            `pullback ${decision.pullbackPct}% at ${price} (${geometry.mode} thresholds ${geometry.armPct}/${geometry.pullbackPct}) — closing`,
        );
        const outcome = await closePosition(pos.symbol, 'profit-trail');
        // Round-5 review: forget the trail ONLY when the position is
        // actually flat — discarding the entry on a rejected/ambiguous
        // close loses the recorded peak and would restart trailing from a
        // worse basis. Working/unconfirmed closes keep the entry too: the
        // duplicate-close guard refuses a re-close, and the state prunes
        // itself when the position disappears.
        if (outcome.state === 'filled') state.delete(pos.symbol);
        else logger.warn(`[profit-trail] ${pos.symbol}: close not confirmed flat (${outcome.state ?? 'no state'}) — trail entry kept (peak ${entry.best})`);
        const message =
            `📉➡️💰 PROFIT TRAIL ${pos.symbol}: peaked +${decision.gainAtBestPct}% (best ${entry.best}, ` +
            `basis ${entry.basis.toFixed(2)}), pulled back ${decision.pullbackPct}% to ${price} ` +
            `(trail ${geometry.pullbackPct}%${geometry.mode === 'atr' ? `, ${rules.profit_trail_pullback_atr_mult}×ATR` : ''}). ${outcome.message}`;
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
let liveState: Map<string, TrailEntry> | null = null;

/** Current trail entries (live when the watcher runs, persisted otherwise). */
export function getProfitTrailEntries(): TrailEntry[] {
    return [...(liveState ?? loadState()).values()];
}

/** Start the watcher (idempotent; no-op when PROFIT_TRAIL=false). */
export function startProfitTrail(): void {
    if (timer || !isProfitTrailEnabled()) return;
    const state = loadState();
    liveState = state;
    const rules = getRiskRules();
    timer = setInterval(() => {
        if (cycleRunning) return;
        cycleRunning = true;
        runCycle(state)
            .catch((err) => logger.warn(`[profit-trail] cycle failed: ${err}`))
            .finally(() => { cycleRunning = false; });
    }, POLL_MS);
    logger.info(
        `[profit-trail] started: arm at ${rules.profit_trail_arm_atr_mult}×ATR, ` +
        `close on ${rules.profit_trail_pullback_atr_mult}×ATR pullback from the peak ` +
        `(fallback ${rules.profit_trail_arm_pct}%/${rules.profit_trail_pullback_pct}% when ATR unavailable; ` +
        `swing/earnings-bet exempt; poll ${POLL_MS / 1000}s, RTH only)`,
    );
}

export function stopProfitTrail(): void {
    if (timer) { clearInterval(timer); timer = null; }
}
