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
        description: 'Ranked intraday opportunities 5 minutes after market open (Opportunity Engine).',
        cronExpr: '35 9 * * 1-5',
        message: 'Produce the morning intraday brief. Call the opportunities tool (action "latest"; if missing or older than 10 minutes, action "refresh"). Take the top 5 ranked candidates and for each verify the catalyst with web_search and validate sizing/stops with risk_manager. Register each actionable recommendation (at most 3) with trade_proposals (action create, expiresMinutes 90) and output the ranked list with, for each: direction, entry, stop, target, size, one-line rationale, and the proposal ID with "Reply \'accept <ID>\' to execute (paper)". If no candidate has signalScore >= 60, say so explicitly — never force a trade. Do not place orders yourself.',
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
        description: 'End-of-day review and ranked overnight candidates (Opportunity Engine).',
        cronExpr: '30 15 * * 1-5',
        message: 'Run the pre-close review. First, evaluate open positions (ibkr_account): hold, trim, or close before the bell, applying the overnight limits from the risk rules. Then call the opportunities tool (action "latest"; refresh if older than 15 minutes) and assess the top candidates for overnight holds: check the earnings calendar and news catalysts (web_search), prefer lower-ATR names, and validate each with risk_manager using the overnight position limits. Register at most 2 qualifying overnight setups with trade_proposals (action create, expiresMinutes 45) and present each with direction, entry, stop, target, size, rationale, and the proposal ID with "Reply \'accept <ID>\' to execute (paper)". Be explicit when nothing qualifies. Do not place orders yourself.',
        model: undefined,
        activeStart: '15:00',
        activeEnd: '16:00',
    },
];

export function ensureTradingCronJobs(): void {
    const store = loadCronStore();
    const existingByName = new Map(store.jobs.map((j) => [j.name, j]));
    let changed = false;
    const now = Date.now();

    for (const def of TRADING_JOBS) {
        const existing = existingByName.get(def.name);
        if (existing) {
            // Keep seeded jobs in sync when their prompt evolves in code.
            // Schedule and activeHours are left untouched (user-tunable).
            if (existing.payload.message !== def.message || existing.description !== def.description) {
                existing.payload.message = def.message;
                existing.description = def.description;
                existing.updatedAtMs = now;
                changed = true;
            }
            continue;
        }

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
