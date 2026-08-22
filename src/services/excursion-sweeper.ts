/**
 * Excursion sweeper (WP0.9, REMEDIATION-2026-08-20).
 *
 * The live capture in the outcome tracker only fires inside `finalize`,
 * post-fill, tracker-attached, non-test — which left 4 of 112 closed rows
 * with MFE/MAE. This sweep runs nightly (and once after boot) over closed
 * rows still missing excursion data and fills them from historical bars.
 * Target-reachability tuning (max_target_atr) reads exactly this data —
 * without the backfill it tunes on a 4-row sample.
 *
 * Unlike the live capture, the window is CLOSED on both ends: bars after
 * the exit must not count, or every row's MFE inflates with price action
 * the trade never held through.
 */

import { Cron } from 'croner';
import { BarSizeSetting, type Bar } from '@stoqey/ib';
import { fetchBars } from '@/tools/ibkr/signal-scorer.js';
import { logger } from '@/utils';
import { barTimeFrameMs, computeTradeExcursion, etFrameMs } from './outcome-tracker.js';
import {
    listClosedMissingExcursion,
    listClosedMissingPostExit,
    markExcursionHorizonExpired,
    markPostExitHorizonExpired,
    recordPostExitExcursion,
    recordTakeCounterfactual,
    recordTradeExcursion,
} from './trade-proposals.js';

const ET = 'America/New_York';
/** 02:17 ET nightly — dead air, after the archive/benchmark windows. */
const SWEEP_CRON = '17 2 * * 2-6';
/** Rows per run: bounds IBKR historical pacing; the backlog drains over
 *  a few nights instead of hammering the farm in one. */
const BATCH_LIMIT = 20;
/** IBKR intraday-bar horizon we rely on (30 D of 15-min is safely served).
 *  Fills older than this are skipped permanently — honest nulls. */
const MAX_LOOKBACK_DAYS = 29;
const PACING_DELAY_MS = 2_000;

/** Pure: bars overlapping [fillFrameMs, closeFrameMs], both ends inclusive
 *  of the bar containing the boundary. */
export function barsWithinHold(
    bars: Bar[],
    fillFrameMs: number,
    closeFrameMs: number,
    barMs: number,
): Bar[] {
    return bars.filter((b) => {
        const t = barTimeFrameMs(b.time);
        // Strict lower bound: a bar at exactly fill−barMs spans [t, fill)
        // and ends AT the fill instant — a boundary fill belongs to the
        // bar stamped with its own time, not the one before.
        return t !== null && t > fillFrameMs - barMs && t <= closeFrameMs;
    });
}

/** REQ-EXIT-013 constants: the legacy geometry the take policy replaced —
 *  a 1×ATR stop with a 2×ATR target, judged over ≈3 trading days (a
 *  5-calendar-day window; a holiday-heavy week can shave a session, which
 *  a research instrument tolerates). Never a gate input. */
export const COUNTERFACTUAL_STOP_ATR = 1;
export const COUNTERFACTUAL_TARGET_ATR = 2;
export const COUNTERFACTUAL_WINDOW_MS = 5 * 86_400_000;

/** Pure (REQ-EXIT-013): from the same entry fill, would the legacy
 *  geometry have hit target-first, stop-first, or neither over the given
 *  bars? A bar touching BOTH levels is scored stop-first — the
 *  conservative read of intrabar ambiguity. */
export function legacyCounterfactual(
    direction: 'long' | 'short',
    entryFill: number,
    dailyAtr: number,
    bars: Bar[],
): 'target-first' | 'stop-first' | 'neither' {
    const target = direction === 'long'
        ? entryFill + COUNTERFACTUAL_TARGET_ATR * dailyAtr
        : entryFill - COUNTERFACTUAL_TARGET_ATR * dailyAtr;
    const stop = direction === 'long'
        ? entryFill - COUNTERFACTUAL_STOP_ATR * dailyAtr
        : entryFill + COUNTERFACTUAL_STOP_ATR * dailyAtr;
    for (const b of bars) {
        const hi = b.high, lo = b.low;
        if (hi == null || lo == null) continue;
        const hitTarget = direction === 'long' ? hi >= target : lo <= target;
        const hitStop = direction === 'long' ? lo <= stop : hi >= stop;
        if (hitStop) return 'stop-first';
        if (hitTarget) return 'target-first';
    }
    return 'neither';
}

/** Pure: end of the ET calendar day containing the given ET-frame instant,
 *  at 20:00 (extended hours close) — the post-exit window's right edge. */
export function endOfEtDayFrame(frameMs: number): number {
    return Math.floor(frameMs / 86_400_000) * 86_400_000 + 20 * 3_600_000;
}

/** One sweep pass. Returns counts for logging/tests. */
export async function sweepExcursionsOnce(): Promise<{ filled: number; skipped: number; failed: number }> {
    const rows = await listClosedMissingExcursion(BATCH_LIMIT);
    let filled = 0, skipped = 0, failed = 0;
    for (const p of rows) {
        if (p.entryFillPrice == null || p.entryFilledAt == null || p.closedAt == null) { skipped++; continue; }
        const ageDays = Math.ceil((Date.now() - p.entryFilledAt) / 86_400_000);
        if (ageDays > MAX_LOOKBACK_DAYS) {
            // Beyond the reliable bar horizon: nulls stay honest, and a
            // permanent note marker stops oldest-first from re-selecting
            // the row into every future batch (observed live 2026-08-21:
            // 15 expired rows clogged each 20-row pass).
            skipped++;
            await markExcursionHorizonExpired(p.id);
            logger.info(`[excursion-sweeper] ${p.id} ${p.symbol}: fill ${ageDays}d old, past the bar horizon — marked expired, nulls stand`);
            continue;
        }
        const holdDays = Math.max(1, Math.ceil((p.closedAt - p.entryFilledAt) / 86_400_000));
        const barSize = ageDays <= 2 ? BarSizeSetting.MINUTES_ONE
            : ageDays <= 7 ? BarSizeSetting.MINUTES_FIVE
            : BarSizeSetting.MINUTES_FIFTEEN;
        const barMs = barSize === BarSizeSetting.MINUTES_ONE ? 60_000
            : barSize === BarSizeSetting.MINUTES_FIVE ? 300_000 : 900_000;
        try {
            // Duration must reach back from NOW to the fill (fetch window
            // ends now); extended hours included — for overnight holds the
            // gap IS the excursion.
            const bars = await fetchBars(p.symbol, barSize, `${Math.min(ageDays + 1, 30)} D`, false);
            const held = barsWithinHold(bars, etFrameMs(p.entryFilledAt), etFrameMs(p.closedAt), barMs);
            const { mfePct, maePct } = computeTradeExcursion(p.direction, p.entryFillPrice, held);
            if (mfePct === null || maePct === null) {
                skipped++;
                logger.warn(`[excursion-sweeper] ${p.id} ${p.symbol}: no usable bars in hold window (${bars.length} fetched, hold ${holdDays}d)`);
            } else {
                await recordTradeExcursion(p.id, mfePct, maePct);
                filled++;
                logger.info(`[excursion-sweeper] ${p.id} ${p.symbol}: backfilled MFE ${mfePct}% MAE ${maePct}% (${held.length} bars)`);
            }
        } catch (err) {
            failed++;
            logger.warn(`[excursion-sweeper] ${p.id} ${p.symbol}: bar fetch failed — ${err}`);
        }
        await new Promise((r) => setTimeout(r, PACING_DELAY_MS));
    }
    if (rows.length > 0) {
        logger.info(`[excursion-sweeper] pass done: ${filled} backfilled, ${skipped} skipped, ${failed} failed of ${rows.length}`);
    }

    // --- Take-tracking pass (REQ-EXIT-012/013) ---
    // Same pacing budget, separate selection: closed intraday rows owed the
    // post-exit excursions and/or the legacy-geometry counterfactual.
    const takeRows = await listClosedMissingPostExit(BATCH_LIMIT);
    let takeFilled = 0;
    for (const p of takeRows) {
        if (p.exitFillPrice == null || p.entryFilledAt == null || p.closedAt == null) continue;
        const ageDays = Math.ceil((Date.now() - p.entryFilledAt) / 86_400_000);
        if (ageDays > MAX_LOOKBACK_DAYS) {
            await markPostExitHorizonExpired(p.id);
            logger.info(`[excursion-sweeper] ${p.id} ${p.symbol}: take-tracking window past the bar horizon — marked expired`);
            continue;
        }
        const barSize = ageDays <= 2 ? BarSizeSetting.MINUTES_ONE
            : ageDays <= 7 ? BarSizeSetting.MINUTES_FIVE
            : BarSizeSetting.MINUTES_FIFTEEN;
        const barMs = barSize === BarSizeSetting.MINUTES_ONE ? 60_000
            : barSize === BarSizeSetting.MINUTES_FIVE ? 300_000 : 900_000;
        try {
            const bars = await fetchBars(p.symbol, barSize, `${Math.min(ageDays + 1, 30)} D`, false);
            // REQ-EXIT-012: what the day did AFTER the exit, vs the exit fill.
            if (p.postExitMfePct === null) {
                const exitFrame = etFrameMs(p.closedAt);
                const after = barsWithinHold(bars, exitFrame, endOfEtDayFrame(exitFrame), barMs);
                const { mfePct, maePct } = computeTradeExcursion(p.direction, p.exitFillPrice, after);
                if (mfePct !== null && maePct !== null) {
                    await recordPostExitExcursion(p.id, mfePct, maePct);
                    takeFilled++;
                    logger.info(`[excursion-sweeper] ${p.id} ${p.symbol}: post-exit MFE ${mfePct}% MAE ${maePct}% (${after.length} bars)`);
                }
            }
            // REQ-EXIT-013: the legacy-geometry replay. 'neither' is only
            // final once the window has fully elapsed — an early sweep
            // leaves it null for a later pass.
            if (p.takeCounterfactual === null && p.dailyAtrAtCreation !== null && p.entryFillPrice != null) {
                const startFrame = etFrameMs(p.entryFilledAt);
                const endFrame = startFrame + COUNTERFACTUAL_WINDOW_MS;
                const window = barsWithinHold(bars, startFrame, endFrame, barMs);
                const verdict = legacyCounterfactual(p.direction, p.entryFillPrice, p.dailyAtrAtCreation, window);
                if (verdict !== 'neither' || etFrameMs(Date.now()) > endFrame) {
                    await recordTakeCounterfactual(p.id, verdict);
                    takeFilled++;
                    logger.info(`[excursion-sweeper] ${p.id} ${p.symbol}: counterfactual ${verdict} (legacy 1×/2×ATR over ${window.length} bars)`);
                }
            }
        } catch (err) {
            logger.warn(`[excursion-sweeper] ${p.id} ${p.symbol}: take-tracking bar fetch failed — ${err}`);
        }
        await new Promise((r) => setTimeout(r, PACING_DELAY_MS));
    }
    if (takeRows.length > 0) {
        logger.info(`[excursion-sweeper] take-tracking pass: ${takeFilled} field(s) filled over ${takeRows.length} row(s)`);
    }
    return { filled, skipped, failed };
}

let job: Cron | null = null;

/** Start the nightly sweep + a delayed boot catch-up (idempotent). */
export function startExcursionSweeper(): void {
    if (job) return;
    job = new Cron(SWEEP_CRON, { timezone: ET }, () => {
        sweepExcursionsOnce().catch((err) => logger.error(`[excursion-sweeper] run failed: ${err}`));
    });
    logger.info('[excursion-sweeper] scheduled 02:17 ET: backfill MFE/MAE on closed rows missing excursion data');
    if (process.env.NODE_ENV !== 'test') {
        // Boot catch-up, delayed so the IBKR connection settles first.
        setTimeout(() => {
            sweepExcursionsOnce().catch((err) => logger.error(`[excursion-sweeper] boot catch-up failed: ${err}`));
        }, 45_000);
    }
}

export function stopExcursionSweeper(): void {
    if (job) { job.stop(); job = null; }
}
