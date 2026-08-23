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
import { withOrderLock } from '@/tools/ibkr/order-lock.js';
import { formulaTakePct } from './proposal-risk-gate.js';
import { logger } from '@/utils';
import { getMarketSession, MarketSession } from '@/utils/market-hours.js';
import { closePosition, fetchOpenOrdersFor, fetchPositions, isOurOrderRef, wasRecentlyClosed } from './position-actions.js';

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
     *  ATR was unavailable and the fallback percentages apply; 'ratchet'
     *  when exit_style: ratchet arms at the take level (REQ-EXIT-008). */
    mode: 'atr' | 'absolute' | 'ratchet';
}

/**
 * Ratchet-mode geometry (REQ-EXIT-008, exit_style: 'ratchet'): arm at the
 * take level x and give back ~1 point of it — the worst post-arm exit is
 * ≈ (x−1)%. RECORDED DEVIATION from the SPEC's stop-modification wording:
 * the lock is enforced by the trail's own close (60s poll, RTH), not by
 * moving the broker STP leg — the original bracket stop stays as the
 * disaster backstop. Broker-side ratcheting is order-mutation machinery
 * this mode does not yet justify while it is config-off.
 */
export function ratchetGeometry(xPct: number): TrailGeometry {
    // Giveback that exits at exactly (x−1)% when closed right at the peak:
    // (1 + x/100) × (1 − g/100) = 1 + (x−1)/100  ⇒  g = 100·(1 − (99+x)/(100+x)).
    const giveback = 100 * (1 - (99 + xPct) / (100 + xPct));
    return {
        armPct: Math.round(xPct * 100) / 100,
        pullbackPct: Math.max(PULLBACK_FLOOR_PCT, Math.round(giveback * 100) / 100),
        mode: 'ratchet',
    };
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

export interface ReleaseDecision {
    /** Dexter-owned LMT target legs — the only orders a release may cancel. */
    cancelIds: number[];
    /** Exit-side orders NOT ours (manual TWS, other clients) — reported, never touched. */
    foreignRefs: string[];
    /** Why nothing may be cancelled. null = release may proceed. */
    blockedReason:
        | 'no-targets' | 'no-own-stop' | 'incomplete-book' | 'stacked-brackets'
        | 'foreign-orders' | 'incoherent-book' | 'stop-undersized'
        | null;
}

/** Semantic leg identity (REQ-TRAIL-003, review 2026-08-23): Dexter stamps
 *  bracket/protect/resize legs `<base>:tp|:stop` (`:tp2|:stop2` for the
 *  WP2 resized pair). Ownership alone is too broad — `reduce-SYM` and
 *  `close-SYM` are Dexter-owned too, and a separately authorized reduction
 *  limit is NOT a target to release. */
const TARGET_LEG_REF = /:tp2?$/;
const STOP_LEG_REF = /:stop2?$/;

/** Pair key: the bracket a leg belongs to — base ref + generation, so
 *  `P-1A2B:tp` pairs `P-1A2B:stop` and `P-1A2B:tp2` pairs `P-1A2B:stop2`,
 *  never across. */
function pairKey(ref: string): string {
    const m = /^(.*):(tp|stop)(2?)$/.exec(ref);
    return m ? `${m[1]}#${m[3]}` : ref;
}

/** Pure: the release decision over a position's exit-side orders
 *  (REQ-TRAIL-001..004 + review 2026-08-23 P2 pair identity).
 *  Rules, in order:
 *  - An INCOMPLETE broker view releases nothing — a leg we cannot see is
 *    a leg we cannot reason about.
 *  - ANY foreign exit-side order blocks the release: `closePosition`
 *    (round 10) refuses to exit around foreign orders, so runner mode
 *    must not enter a state its own exit path refuses.
 *  - The entire Dexter exit book must be EXACTLY one coherent pair: one
 *    `:tp` target + one `:stop` stop, same ref base and generation, same
 *    OCA group, same account — an orphan stop, a groupless leg or a
 *    second pair is an incoherent book (blocked; the WP3 sweep heals it).
 *  - The stop must cover the position: unknown or undersized stop
 *    quantity blocks (a released target with a half-size stop leaves the
 *    remainder unprotected). */
export function decideTargetRelease<T extends {
    orderId: number; orderType: string; orderRef: string | null;
    ocaGroup?: string | null; account?: string | null; quantity?: number | null;
}>(
    view: { orders: T[]; complete: boolean },
    positionQty?: number,
): ReleaseDecision {
    const exitOrders = view.orders;
    const foreignRefs = exitOrders
        .filter((o) => !isOurOrderRef(o.orderRef))
        .map((o) => `#${o.orderId} ${o.orderType} ${o.orderRef ?? '<no ref>'}`);
    if (!view.complete) return { cancelIds: [], foreignRefs, blockedReason: 'incomplete-book' };
    if (foreignRefs.length > 0) return { cancelIds: [], foreignRefs, blockedReason: 'foreign-orders' };
    const targets = exitOrders.filter((o) =>
        o.orderType === 'LMT' && TARGET_LEG_REF.test(o.orderRef ?? ''));
    if (targets.length === 0) return { cancelIds: [], foreignRefs, blockedReason: 'no-targets' };
    const stops = exitOrders.filter((o) =>
        o.orderType.startsWith('STP') && STOP_LEG_REF.test(o.orderRef ?? ''));
    // Every Dexter exit-side order must be one of THE pair's two legs —
    // an extra stop, a reduce-/close- order or a third leg is incoherent.
    if (exitOrders.length !== targets.length + stops.length) {
        return { cancelIds: [], foreignRefs, blockedReason: 'incoherent-book' };
    }
    if (targets.length > 1 || stops.length > 1) {
        return { cancelIds: [], foreignRefs, blockedReason: 'stacked-brackets' };
    }
    const target = targets[0];
    const stop = stops[0];
    if (stops.length === 0 || pairKey(stop.orderRef ?? '') !== pairKey(target.orderRef ?? '')) {
        return { cancelIds: [], foreignRefs, blockedReason: 'no-own-stop' };
    }
    // Same OCA group and account, both KNOWN — unknown identity fails closed.
    if (!target.ocaGroup || !stop.ocaGroup || target.ocaGroup !== stop.ocaGroup
        || !target.account || !stop.account || target.account !== stop.account) {
        return { cancelIds: [], foreignRefs, blockedReason: 'incoherent-book' };
    }
    // The surviving stop must cover the position (unknown qty fails closed).
    if (positionQty !== undefined) {
        if (stop.quantity == null || stop.quantity < positionQty) {
            return { cancelIds: [], foreignRefs, blockedReason: 'stop-undersized' };
        }
    }
    return { cancelIds: [target.orderId], foreignRefs, blockedReason: null };
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
    // Under the global order lock (review 2026-08-23 P1): the snapshot,
    // the decision and the cancel are one atomic step — a WP2 resize must
    // not add a second OCA pair between the read and the cancel.
    return withOrderLock(async () => releaseTargetLegLocked(api, entry));
}

async function releaseTargetLegLocked(
    api: Awaited<ReturnType<typeof getIBApi>>,
    entry: TrailEntry,
): Promise<string | null> {
    const view = await fetchOpenOrdersFor(api, entry.symbol, exitActionFor(entry.direction));
    const decision = decideTargetRelease(view, entry.quantity);
    if (decision.foreignRefs.length > 0) {
        logger.warn(
            `[profit-trail] ${entry.symbol}: foreign exit-side order(s) present (not ours — review in TWS): ${decision.foreignRefs.join(', ')}`,
        );
    }
    if (decision.blockedReason === 'no-targets') return null;
    if (decision.blockedReason !== null) {
        const why: Record<Exclude<ReleaseDecision['blockedReason'], null>, string> = {
            'no-targets': '',
            'no-own-stop': 'no Dexter stop from the SAME bracket survives — runner mode would strip broker-side protection',
            'incomplete-book': 'the open-orders view is INCOMPLETE — a leg we cannot see is a leg we cannot reason about',
            'stacked-brackets': 'multiple working bracket pairs (stacked theses) — releasing targets would build the multi-OCA book closePosition refuses',
            'foreign-orders': 'foreign exit-side orders present — closePosition refuses to exit around them, so runner mode must not start',
            'incoherent-book': 'the Dexter exit book is not exactly one coherent OCA pair (orphan leg, group/account mismatch) — the WP3 sweep heals, runner mode waits',
            'stop-undersized': 'the surviving stop does not cover the full position — releasing the target would leave the remainder unprotected',
        };
        logger.error(`[profit-trail] ${entry.symbol}: target NOT released — ${why[decision.blockedReason]}`);
        return null;
    }
    // Round-4 review (2026-08-21): "released" means the broker CONFIRMED
    // the cancel — announcing runner mode while the fixed target may still
    // be working promises an exit management that is not in effect.
    const released: string[] = [];
    for (const orderId of decision.cancelIds) {
        const outcome = await confirmCancel(api, orderId, CANCEL_CONFIRM_MS);
        if (outcome === 'cancelled') {
            released.push(`#${orderId}`);
            logger.info(`[profit-trail] ${entry.symbol}: runner mode — target order #${orderId} cancelled (confirmed), trail manages the exit`);
        } else if (outcome === 'filled') {
            // The target won the race: profit banked at the fixed target.
            // The tracker handles the fill; runner mode is moot.
            logger.warn(`[profit-trail] ${entry.symbol}: target #${orderId} FILLED during runner-mode release — exit already taken at the fixed target`);
        } else {
            logger.error(`[profit-trail] ${entry.symbol}: target #${orderId} cancel NOT CONFIRMED — the fixed target may still be working; runner mode not announced`);
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
    // Ratchet mode (REQ-EXIT-008): the arm level is the row's stamped take
    // percent; positions without one (adopted, pre-policy) fall back to the
    // ATR formula, then to the standard trail geometry.
    const takeBySymbol = new Map<string, number>();
    try {
        for (const t of await listTrackable()) {
            classesBySymbol.set(t.symbol, [...(classesBySymbol.get(t.symbol) ?? []), t.tradeClass]);
            if (t.takePct !== null && !takeBySymbol.has(t.symbol)) takeBySymbol.set(t.symbol, t.takePct);
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
        const atrPct = atr !== null && entry.basis > 0 ? (atr / entry.basis) * 100 : null;
        // exit_style 'ratchet' (REQ-EXIT-008): arm AT the take level and
        // lock x−1 via the trail. 'target' keeps the standard geometry —
        // there the take is the bracket's own LMT leg, broker-side.
        const ratchetX = rules.exit_style === 'ratchet'
            ? takeBySymbol.get(pos.symbol) ?? (atrPct !== null ? formulaTakePct(atrPct, rules) : null)
            : null;
        const geometry = ratchetX !== null ? ratchetGeometry(ratchetX) : trailGeometry({
            atrPct,
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
                    const how = geometry.mode === 'ratchet'
                        ? `${geometry.pullbackPct}% (ratchet — locks ≈ +${(geometry.armPct - 1).toFixed(1)}%)`
                        : geometry.mode === 'atr'
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
        // Round-10: gate on CONFIRMED flatness — a filled close with an
        // over-close residue still owns a position worth trailing.
        if (outcome.state === 'filled' && outcome.flat === true) state.delete(pos.symbol);
        else logger.warn(`[profit-trail] ${pos.symbol}: close not confirmed flat (state=${outcome.state ?? 'none'}, flat=${outcome.flat ?? 'unknown'}) — trail entry kept (peak ${entry.best})`);
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
