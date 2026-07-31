/**
 * End-of-day triage — decide, per unresolved DAY position, whether it
 * deserves the night.
 *
 * Operator policy (2026-07-30): do NOT flatten intraday positions at the
 * close by default. Instead, at 15:52 ET each filled DAY-bracket position
 * is triaged:
 *
 *   CLOSE before the bell  — losing vs the entry fill AND the last hour's
 *                            momentum still running against the position
 *                            ("the horizon is fading");
 *   KEEP                   — everything else: winners, and losers that are
 *                            stabilizing/recovering. At the bell the DAY
 *                            exits expire and auto-protect converts the
 *                            position to a 🌙 protected overnight hold.
 *
 * Deterministic, no LLM. Disable with EOD_TRIAGE=false.
 */

import { BarSizeSetting } from '@stoqey/ib';
import { Cron } from 'croner';
import { getIBApi } from '@/tools/ibkr/connection.js';
import { fetchBars } from '@/tools/ibkr/signal-scorer.js';
import { logger } from '@/utils';
import { isMarketHoliday } from '@/utils/market-hours.js';
import { closePosition, fetchPositions } from './position-actions.js';
import { listTrackable } from './trade-proposals.js';

const ET = 'America/New_York';
const TRIAGE_CRON = '52 15 * * 1-5';
const FADE_LOOKBACK_MIN = 60;

// ---------------------------------------------------------------------------
// Pure decision (unit-tested)
// ---------------------------------------------------------------------------

export interface EodDecision {
    action: 'close' | 'keep';
    reason: string;
}

/**
 * Close only when BOTH hold: the position is losing against its entry
 * fill, and price has kept moving against it over the fade lookback.
 * Unknown momentum (no hour-ago price) never closes — when in doubt, the
 * position keeps its overnight chance.
 */
export function decideEodAction(input: {
    direction: 'long' | 'short';
    entryFill: number;
    last: number;
    hourAgo: number | null;
}): EodDecision {
    const { direction, entryFill, last, hourAgo } = input;
    if (!(last > 0) || !(entryFill > 0)) return { action: 'keep', reason: 'price unavailable — keeping (fail-open to hold)' };

    const pnlPct = direction === 'long'
        ? ((last - entryFill) / entryFill) * 100
        : ((entryFill - last) / entryFill) * 100;
    if (pnlPct >= 0) {
        return { action: 'keep', reason: `winning ${pnlPct.toFixed(2)}% — holds overnight (protected at the bell)` };
    }

    if (hourAgo === null || !(hourAgo > 0)) {
        return { action: 'keep', reason: `losing ${pnlPct.toFixed(2)}% but momentum unknown — keeping` };
    }
    const drift = direction === 'long' ? last - hourAgo : hourAgo - last;
    if (drift < 0) {
        const driftPct = (Math.abs(drift) / hourAgo) * 100;
        return {
            action: 'close',
            reason: `losing ${pnlPct.toFixed(2)}% and still fading (${driftPct.toFixed(2)}% against us over the last hour) — closing before the bell`,
        };
    }
    return { action: 'keep', reason: `losing ${pnlPct.toFixed(2)}% but stabilizing/recovering over the last hour — keeping` };
}

// ---------------------------------------------------------------------------
// Notifications (bridged to WhatsApp by the gateway)
// ---------------------------------------------------------------------------

type TriageCallback = (message: string) => void | Promise<void>;
const callbacks = new Set<TriageCallback>();

/** Register a callback for triage reports (idempotent per cb). */
export function onEodTriage(cb: TriageCallback): () => void {
    callbacks.add(cb);
    return () => callbacks.delete(cb);
}

async function notify(message: string): Promise<void> {
    for (const cb of [...callbacks]) {
        try { await cb(message); } catch (err) {
            logger.error(`[eod-triage] callback failed: ${err}`);
        }
    }
}

// ---------------------------------------------------------------------------
// The 15:52 run
// ---------------------------------------------------------------------------

export function isEodTriageEnabled(): boolean {
    return (process.env.EOD_TRIAGE ?? 'true').trim().toLowerCase() !== 'false';
}

export async function runEodTriageOnce(): Promise<void> {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: ET });
    if (isMarketHoliday(today)) return;

    // Filled DAY-bracket proposals still working = positions whose exits
    // die at the bell.
    const candidates = (await listTrackable()).filter((t) => t.tif === 'DAY' && t.entryFillPrice != null);
    if (candidates.length === 0) return;

    const api = await getIBApi();
    const positions = await fetchPositions(api);
    const lines: string[] = [];

    for (const t of candidates) {
        const pos = positions.find((p) => p.symbol === t.symbol && p.quantity !== 0);
        if (!pos) continue; // already flat (target/stop just filled, or closed)

        let last: number | null = null;
        let hourAgo: number | null = null;
        try {
            const bars = (await fetchBars(t.symbol, BarSizeSetting.MINUTES_ONE, '1 D', true))
                .filter((b) => b.close != null);
            last = bars[bars.length - 1]?.close ?? null;
            hourAgo = bars[Math.max(0, bars.length - 1 - FADE_LOOKBACK_MIN)]?.close ?? null;
        } catch (err) {
            logger.warn(`[eod-triage] ${t.symbol}: bars unavailable (${err instanceof Error ? err.message : err})`);
        }

        const decision = last !== null
            ? decideEodAction({ direction: t.direction, entryFill: t.entryFillPrice!, last, hourAgo })
            : { action: 'keep' as const, reason: 'price unavailable — keeping (fail-open to hold)' };

        logger.info(`[eod-triage] ${t.id} ${t.symbol}: ${decision.action} — ${decision.reason}`);
        if (decision.action === 'close') {
            const outcome = await closePosition(t.symbol);
            lines.push(`• ${t.symbol} (${t.id}): ${decision.reason}. ${outcome.ok ? 'Closed.' : outcome.message}`);
        } else {
            lines.push(`• ${t.symbol} (${t.id}): ${decision.reason}.`);
        }
    }

    if (lines.length) {
        await notify(`🌇 EOD triage (15:52 ET) — unresolved DAY positions:\n${lines.join('\n')}`);
    }
}

let job: Cron | null = null;

/** Start the 15:52 ET triage (idempotent; no-op when disabled). */
export function startEodTriage(): void {
    if (job || !isEodTriageEnabled()) return;
    job = new Cron(TRIAGE_CRON, { timezone: ET }, () => {
        runEodTriageOnce().catch((err) => logger.error(`[eod-triage] run failed: ${err}`));
    });
    logger.info('[eod-triage] scheduled 15:52 ET: close losing-and-fading DAY positions; keep the rest for protected overnight');
}

export function stopEodTriage(): void {
    if (job) { job.stop(); job = null; }
}
