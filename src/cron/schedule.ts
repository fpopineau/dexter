import { Cron } from 'croner';
import { isMarketHalfDay, isMarketHoliday } from '../utils/market-hours.js';
import type { CronSchedule } from './types.js';

const MIN_REFIRE_GAP_MS = 2_000;
const DAY_MS = 86_400_000;
const ET = 'America/New_York';

// --- Session-relative schedules (market calendar, not a fixed clock) ------------

interface TzParts { dateStr: string; sinceMidnightMs: number; dayOfWeek: number }

/** Wall-clock parts of `ms` in `tz`: ISO date, ms since local midnight, weekday. */
function tzParts(ms: number, tz: string): TzParts {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(new Date(ms));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
    const hour = Number(get('hour')) % 24; // '24' at midnight in some engines
    const dateStr = `${get('year')}-${get('month')}-${get('day')}`;
    return {
        dateStr,
        sinceMidnightMs: hour * 3_600_000 + Number(get('minute')) * 60_000 + Number(get('second')) * 1_000 + (ms % 1000),
        dayOfWeek: new Date(`${dateStr}T12:00:00Z`).getUTCDay(),
    };
}

/** Epoch ms of local midnight of the day containing `ms`. */
function dayStartMs(ms: number, tz: string): number {
    return ms - tzParts(ms, tz).sinceMidnightMs;
}

function isTradingDay(p: TzParts): boolean {
    return p.dayOfWeek !== 0 && p.dayOfWeek !== 6 && !isMarketHoliday(p.dateStr);
}

function closeMinutes(dateStr: string): number {
    return isMarketHalfDay(dateStr) ? 13 * 60 : 16 * 60;
}

/** Epoch ms of the regular-session close of the trading day containing
 *  `nowMs`, or null when that day is not a trading day (weekend, holiday).
 *  The executor refuses to run a session-close job past this instant. */
export function sessionCloseMsFor(nowMs: number, tz: string = ET): number | null {
    const start = dayStartMs(nowMs, tz);
    const p = tzParts(start + 12 * 3_600_000, tz);
    if (!isTradingDay(p)) return null;
    return start + closeMinutes(p.dateStr) * 60_000;
}

/** Next instant `offsetMin` minutes before the close of a trading day,
 *  strictly after `nowMs` (+ the refire gap). Searches 20 calendar days. */
export function nextSessionCloseFire(nowMs: number, offsetMin: number, tz: string = ET): number | undefined {
    let start = dayStartMs(nowMs, tz);
    for (let i = 0; i < 20; i++) {
        const p = tzParts(start + 12 * 3_600_000, tz);
        if (isTradingDay(p)) {
            const fire = start + (closeMinutes(p.dateStr) - offsetMin) * 60_000;
            if (fire > nowMs + MIN_REFIRE_GAP_MS) return fire;
        }
        // +26 h lands in the next calendar day whatever the DST shift; re-anchor to midnight.
        start = dayStartMs(start + 26 * 3_600_000, tz);
    }
    return undefined;
}

/**
 * Compute the next run time for a schedule.
 * Returns undefined if the schedule has expired (one-shot in the past) or is invalid.
 */
export function computeNextRunAtMs(schedule: CronSchedule, nowMs: number): number | undefined {
  switch (schedule.kind) {
    case 'at': {
      const targetMs = new Date(schedule.at).getTime();
      if (isNaN(targetMs)) return undefined;
      return targetMs > nowMs ? targetMs : undefined;
    }

    case 'every': {
      const anchor = schedule.anchorMs ?? nowMs;
      if (schedule.everyMs <= 0) return undefined;
      const elapsed = nowMs - anchor;
      const periods = Math.ceil(elapsed / schedule.everyMs);
      const next = anchor + periods * schedule.everyMs;
      // If next === nowMs (exactly on the interval), push to next period
      return next <= nowMs ? next + schedule.everyMs : next;
    }

    case 'cron': {
      try {
        const tz = schedule.tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
        const cron = new Cron(schedule.expr, { timezone: tz });
        const now = new Date(nowMs);
        let next = cron.nextRun(now);

        // Workaround for croner year-rollback edge case:
        // If result is at or before now, try from the next second
        if (next && next.getTime() <= nowMs) {
          const nextSecond = new Date(nowMs + 1000);
          next = cron.nextRun(nextSecond);
        }

        if (!next) return undefined;
        const nextMs = next.getTime();
        // Ensure minimum gap to prevent spin-loops
        return nextMs > nowMs + MIN_REFIRE_GAP_MS ? nextMs : nowMs + MIN_REFIRE_GAP_MS;
      } catch {
        return undefined; // Invalid cron expression
      }
    }

    case 'session-close': {
      if (!Number.isFinite(schedule.offsetMin) || schedule.offsetMin < 0 || schedule.offsetMin > 6 * 60) return undefined;
      return nextSessionCloseFire(nowMs, schedule.offsetMin, schedule.tz || ET);
    }
  }
}

export const __DAY_MS = DAY_MS;
