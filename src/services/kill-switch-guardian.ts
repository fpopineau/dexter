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
import { getDailyLossStatus } from './daily-loss-guard.js';
import { cancelEntryLeg } from './stale-entry-sweeper.js';
import { listTrackable } from './trade-proposals.js';

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

/** Pure: what this tick should do. Handles once per ET day — the halt is
 *  daily and re-alerting every minute is noise, not safety. */
export function decideGuardianStep(
    status: { halted: boolean; latched?: boolean },
    handledDay: string | null,
    today: string,
): 'handle' | 'none' {
    if (!status.halted || status.latched !== true) return 'none';
    return handledDay === today ? 'none' : 'handle';
}

let handledDay: string | null = null;

async function tick(): Promise<void> {
    // The status call itself latches on breach — observation is enforcement.
    const status = await getDailyLossStatus();
    const today = new Date().toLocaleDateString('en-CA', { timeZone: ET });
    if (decideGuardianStep(status, handledDay, today) !== 'handle') return;
    handledDay = today;

    logger.error(`[kill-switch-guardian] LATCHED: ${status.reason} — cancelling unfilled entry parents`);
    let cancelled = 0, skipped = 0;
    try {
        const unfilled = (await listTrackable()).filter((t) => t.entryFillPrice === null && t.source !== 'adopted');
        for (const p of unfilled) {
            try {
                if (await cancelEntryLeg(p, 'kill-switch latched — a working entry is new risk')) cancelled++;
                else skipped++;
            } catch (err) {
                skipped++;
                logger.warn(`[kill-switch-guardian] ${p.id} ${p.symbol}: entry cancel failed — ${err}`);
            }
        }
    } catch (err) {
        logger.error(`[kill-switch-guardian] could not enumerate working entries: ${err}`);
    }

    const msg =
        `🛑 KILL-SWITCH LATCHED (guardian): ${status.reason}\n` +
        `Working entry parents cancelled: ${cancelled}${skipped ? ` (${skipped} left to the tracker — filled/racing/unconfirmed)` : ''}. ` +
        `Protective exits untouched; 'close SYMBOL' / 'protect' / 'cancel' stay available. No new risk today.`;
    for (const cb of [...alertCallbacks]) {
        try { await cb(msg); } catch (err) {
            logger.error(`[kill-switch-guardian] alert callback failed: ${err}`);
        }
    }
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the guardian (idempotent; KILL_SWITCH_GUARDIAN=false disables). */
export function startKillSwitchGuardian(): void {
    if (timer || !isGuardianEnabled()) return;
    timer = setInterval(() => {
        tick().catch((err) => logger.warn(`[kill-switch-guardian] tick failed: ${err}`));
    }, GUARDIAN_INTERVAL_MS);
    logger.info(`[kill-switch-guardian] started: daily-loss status every ${GUARDIAN_INTERVAL_MS / 1000}s — a breach latches on OBSERVATION, and a latch cancels working entry parents`);
}

export function stopKillSwitchGuardian(): void {
    if (timer) { clearInterval(timer); timer = null; }
}
