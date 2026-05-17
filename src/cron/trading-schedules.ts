/**
 * Seed recommended trading cron jobs into the cron store.
 *
 * Called once at gateway startup (alongside ensureHeartbeatCronJob).
 * Idempotent: only creates jobs that don't already exist (by name).
 *
 * Jobs created:
 *   - Pre-Market Brief   (08:00 ET, weekdays)
 *   - Market Open Scan   (09:35 ET, weekdays)
 *   - Midday Check        (12:00 ET, weekdays)
 *   - Pre-Close Review    (15:30 ET, weekdays)
 */

import { randomBytes } from 'node:crypto';
import { computeNextRunAtMs } from './schedule.js';
import { loadCronStore, saveCronStore } from './store.js';
import type { CronJob } from './types.js';

const WEEKDAYS = [1, 2, 3, 4, 5]; // Mon–Fri

interface TradingJobDef {
    name: string;
    description: string;
    cronExpr: string;
    message: string;
    model?: string;
    activeStart: string;
    activeEnd: string;
}

const TRADING_JOBS: TradingJobDef[] = [
    {
        name: 'Pre-Market Brief',
        description: 'Morning market briefing: overnight recap, calendar, gap analysis, watchlist levels.',
        cronExpr: '0 8 * * 1-5',
        message: 'Run pre-market brief. Summarize overnight moves, today\'s earnings/economic calendar, pre-market movers, and watchlist key levels.',
        model: undefined, // use default (Claude for deep reasoning)
        activeStart: '07:00',
        activeEnd: '09:30',
    },
    {
        name: 'Market Open Scan',
        description: 'Day trade setup scan 5 minutes after market open.',
        cronExpr: '35 9 * * 1-5',
        message: 'Scan for day trade setups. Focus on momentum plays from the open, unusual volume, and any gap continuations.',
        model: undefined,
        activeStart: '09:30',
        activeEnd: '10:30',
    },
    {
        name: 'Midday Check',
        description: 'Midday position review and opportunity scan.',
        cronExpr: '0 12 * * 1-5',
        message: 'Review open positions and scan for midday opportunities. Check for mean-reversion setups and any developing trends.',
        model: undefined,
        activeStart: '11:00',
        activeEnd: '13:00',
    },
    {
        name: 'Pre-Close Review',
        description: 'End-of-day position review and overnight planning.',
        cronExpr: '30 15 * * 1-5',
        message: 'Run overnight position review. Evaluate which positions to hold, trim, or close before the bell. Identify swing setups for tomorrow.',
        model: undefined,
        activeStart: '15:00',
        activeEnd: '16:00',
    },
];

export function ensureTradingCronJobs(): void {
    const store = loadCronStore();
    const existingNames = new Set(store.jobs.map((j) => j.name));
    let changed = false;
    const now = Date.now();

    for (const def of TRADING_JOBS) {
        if (existingNames.has(def.name)) continue;

        const schedule = { kind: 'cron' as const, expr: def.cronExpr, tz: 'America/New_York' };
        const job: CronJob = {
            id: randomBytes(8).toString('hex'),
            name: def.name,
            description: def.description,
            enabled: true,
            createdAtMs: now,
            updatedAtMs: now,
            schedule,
            payload: {
                message: def.message,
                model: def.model,
            },
            fulfillment: 'keep',
            activeHours: {
                start: def.activeStart,
                end: def.activeEnd,
                timezone: 'America/New_York',
                daysOfWeek: WEEKDAYS,
            },
            state: {
                nextRunAtMs: computeNextRunAtMs(schedule, now),
                consecutiveErrors: 0,
                scheduleErrorCount: 0,
            },
        };

        store.jobs.push(job);
        changed = true;
    }

    if (changed) saveCronStore(store);
}
