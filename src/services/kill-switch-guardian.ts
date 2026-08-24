/**
 * Kill-switch guardian (review 2026-08-23 P1) — the daily-loss latch was
 * evaluated only ON DEMAND (proposal accepts, `halt status`), so a 3%
 * breach that recovered between accepts never latched, and a latched halt
 * left already-working entry parents free to fill.
 *
 * Every minute this calls `getDailyLossStatus()` — the guard itself
 * latches (writes trading-halt.json) whenever a status check observes a
 * breach, so continuous observation IS continuous enforcement. On the
 * latch transition the guardian:
 *
 *   1. alerts (bridged to WhatsApp by the gateway), and
 *   2. cancels every UNFILLED entry parent through the sweeper's safe
 *      primitive (REQ-ENTRY-003: parent leg only, orderRef-verified on a
 *      complete book, order-locked, broker-confirmed) — working entries
 *      are NEW RISK; protective exits are never touched, and every
 *      risk-reducing action (close/protect/cancel/trim) stays available.
 *
 * A halted-but-NOT-latched status (P&L unverifiable, FX missing) blocks
 * new risk at the gates already; the guardian does NOT cancel on it — a
 * broker hiccup must not strip working orders. One handling per ET day
 * (the halt itself is daily); disable with KILL_SWITCH_GUARDIAN=false.
 */

import { logger } from '@/utils';
import { getIBApi } from '@/tools/ibkr/connection.js';
import { confirmCancelDetailed } from '@/tools/ibkr/order-ack.js';
import { withOrderLock } from '@/tools/ibkr/order-lock.js';
import { fetchOpenOrderSnaps } from './broker-adopt.js';
import { getDailyLossStatus } from './daily-loss-guard.js';

const GUARDIAN_INTERVAL_MS = 60_000;
const ET = 'America/New_York';

type GuardianAlertCallback = (message: string) => void | Promise<void>;
const alertCallbacks = new Set<GuardianAlertCallback>();

/** Register a callback for guardian alerts (bridged to WhatsApp). */
export function onKillSwitchAlert(cb: GuardianAlertCallback): () => void {
    alertCallbacks.add(cb);
    return () => alertCallbacks.delete(cb);
}

export function isGuardianEnabled(): boolean {
    return (process.env.KILL_SWITCH_GUARDIAN ?? 'true').trim().toLowerCase() !== 'false';
}

/** Consecutive fail-safe (halted-but-unlatched) observations before the
 *  guardian treats an UNVERIFIABLE account like a latch for entry cleanup
 *  (review 2026-08-23: pending entries are future risk — but a single
 *  30-second broker hiccup must not strip working orders). 5 × 60s. */
export const FAILSAFE_PERSIST_TICKS = 5;

export interface GuardianStep {
    /** Send the once-per-day alert. */
    alert: boolean;
    /** Attempt entry-parent cleanup THIS tick. Cleanup repeats every tick
     *  until the working-entry book is empty (review 2026-08-23 P1: the
     *  old one-shot marked the day handled BEFORE cancels succeeded — a
     *  timeout left a resting entry free to fill after the halt). */
    cleanup: boolean;
}

/** Pure: what this tick should do. Alerting is once per ET day (noise);
 *  cleanup is EVERY tick while the halt condition stands and entries may
 *  remain — idempotent by construction (an empty book cancels nothing). */
export function decideGuardianStep(
    status: { halted: boolean; latched?: boolean },
    alertedDay: string | null,
    today: string,
    unverifiedStreak: number,
): GuardianStep {
    const latched = status.halted && status.latched === true;
    const persistentFailsafe = status.halted && status.latched !== true && unverifiedStreak >= FAILSAFE_PERSIST_TICKS;
    if (!latched && !persistentFailsafe) return { alert: false, cleanup: false };
    return { alert: alertedDay !== today, cleanup: true };
}

/** Pure: the broker book's Dexter ENTRY parents — the only orders a halt
 *  cleanup may cancel (WP1 stamps `<proposalId>:entry` on every bracket
 *  parent; exits are `:tp`/`:stop`, protects `protect-`, closes `close-`). */
export function selectEntryParents<T extends { orderId: number; orderRef: string | null }>(orders: T[]): T[] {
    return orders.filter((o) => /^P-[0-9A-F]{4}:entry$/.test(o.orderRef ?? ''));
}

let alertedDay: string | null = null;
let unverifiedStreak = 0;
let tickRunning = false;

async function tick(): Promise<void> {
    if (tickRunning) return; // overlap guard: a slow broker call must not stack ticks
    tickRunning = true;
    try {
        // The status call itself latches on breach — observation is enforcement.
        const status = await getDailyLossStatus();
        unverifiedStreak = status.halted && status.latched !== true ? unverifiedStreak + 1 : 0;
        const today = new Date().toLocaleDateString('en-CA', { timeZone: ET });
        const step = decideGuardianStep(status, alertedDay, today, unverifiedStreak);
        if (!step.cleanup) return;

        // BROKER-truth enumeration (review 2026-08-23, omission 7): DB rows
        // missed 'executing' claims and orphaned parents the DB forgot —
        // the halt must neutralize what the BROKER says is working. Every
        // `<id>:entry` ref on the book is a Dexter entry parent by WP1
        // construction; children are never touched (they die with a
        // still-working parent, and protect a filled one).
        let cancelled = 0, remaining = 0;
        try {
            await withOrderLock(async () => {
                const api = await getIBApi();
                const snap = await fetchOpenOrderSnaps(api);
                if (!snap.complete) {
                    remaining = -1; // partial view — a parent we cannot see is not proven absent
                    logger.error('[kill-switch-guardian] open-orders snapshot INCOMPLETE — entry cleanup retries next tick');
                    return;
                }
                for (const o of selectEntryParents(snap.orders)) {
                    try {
                        const { outcome, filledQty } = await confirmCancelDetailed(api, o.orderId, 5_000);
                        if (outcome === 'cancelled' && !(filledQty !== null && filledQty > 0)) cancelled++;
                        else {
                            remaining++;
                            logger.warn(`[kill-switch-guardian] entry #${o.orderId} (${o.orderRef}): ${outcome}${filledQty ? `, ${filledQty} filled` : ''} — position may be live, tracker owns it`);
                        }
                    } catch (err) {
                        remaining++;
                        logger.warn(`[kill-switch-guardian] entry #${o.orderId}: cancel failed (retries next tick) — ${err}`);
                    }
                }
            });
        } catch (err) {
            remaining = -1; // enumeration itself failed — retry next tick, say so
            logger.error(`[kill-switch-guardian] could not enumerate working entries (retries next tick): ${err}`);
        }
        if (cancelled > 0 || remaining !== 0) {
            logger.error(`[kill-switch-guardian] halt cleanup: ${cancelled} entry parent(s) cancelled, ${remaining === -1 ? 'enumeration failed' : `${remaining} remaining (retrying every ${GUARDIAN_INTERVAL_MS / 1000}s)`}`);
        }

        if (step.alert) {
            alertedDay = today;
            const why = status.latched === true
                ? `LATCHED: ${status.reason}`
                : `UNVERIFIABLE for ${unverifiedStreak} minute(s): ${status.reason} — treating working entries as new risk`;
            const msg =
                `🛑 KILL-SWITCH (guardian) ${why}\n` +
                `Working entry parents cancelled: ${cancelled}${remaining ? ` (${remaining === -1 ? 'book unreadable' : remaining} remaining — the guardian retries every minute until the book is clean)` : ' — book clean'}. ` +
                `Protective exits untouched; 'close SYMBOL' / 'protect' / 'cancel' stay available. No new risk today.`;
            for (const cb of [...alertCallbacks]) {
                try { await cb(msg); } catch (err) {
                    logger.error(`[kill-switch-guardian] alert callback failed: ${err}`);
                }
            }
        }
    } finally {
        tickRunning = false;
    }
}

let timer: ReturnType<typeof setInterval> | null = null;
// Review-35: tracked so stop can clear it — the untracked startup tick
// survived shutdown and could cancel broker orders from a dead lifecycle.
let startupTimer: ReturnType<typeof setTimeout> | null = null;

/** Start the guardian (idempotent; KILL_SWITCH_GUARDIAN=false disables). */
export function startKillSwitchGuardian(): void {
    if (timer || !isGuardianEnabled()) return;
    timer = setInterval(() => {
        tick().catch((err) => logger.warn(`[kill-switch-guardian] tick failed: ${err}`));
    }, GUARDIAN_INTERVAL_MS);
    if (process.env.NODE_ENV !== 'test') {
        // Startup tick (review 2026-08-23): a halt latched before a restart
        // must be enforced as soon as the connection settles, not a minute in.
        const t: ReturnType<typeof setTimeout> = setTimeout(() => {
            if (startupTimer !== t) return; // review-35: stopped while queued — clearTimeout can't recall a dispatched callback
            startupTimer = null;
            tick().catch((err) => logger.warn(`[kill-switch-guardian] startup tick failed: ${err}`));
        }, 5_000);
        startupTimer = t;
    }
    logger.info(`[kill-switch-guardian] started: daily-loss status every ${GUARDIAN_INTERVAL_MS / 1000}s — a breach latches on OBSERVATION; a latch (or a ${FAILSAFE_PERSIST_TICKS}-min unverifiable account) cancels working entry parents until the book is clean`);
}

export function stopKillSwitchGuardian(): void {
    if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
    if (timer) { clearInterval(timer); timer = null; }
}
