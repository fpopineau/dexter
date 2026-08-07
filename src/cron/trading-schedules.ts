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
    /** Agent iteration budget — sized to the job's workflow depth. */
    maxIterations: number;
    activeStart: string;
    activeEnd: string;
}

const TRADING_JOBS: TradingJobDef[] = [
    {
        name: 'Pre-Market Brief',
        description: 'Morning market briefing: performance recap, overnight recap, calendar, gap analysis, watchlist levels.',
        cronExpr: '0 8 * * 1-5',
        message: 'Run pre-market brief. Start with the trading performance recap: call trade_proposals (action performance, days 1) and report the closed trades, win/loss, net P&L, and anything still executing — include the provided report verbatim, then one sentence of interpretation (e.g. stops hit on longs in a weak tape). Then call earnings_calendar (action day) for today AND tomorrow: name the big reporters and their timing (pre-market reporters can gap the open TODAY; after-hours reporters gap TOMORROW), and check current positions plus the watchlist against them (action check) — holding through a report must be called out explicitly. Then summarize overnight moves, pre-market movers, and watchlist key levels. Finally check swing_patterns (action latest) — last night\'s pullback/flat-base/cup-and-handle candidates. Work DOWN the ranked list until you have evaluated 2-3 VIABLE names or exhausted the list: skip immediately, in one line each and with no further analysis, any symbol already held or carrying a working bracket (duplicate) and any symbol reporting within the ~2-week holding window (earnings_calendar check) — a dead top tier must not end the hunt while clean candidates sit below it. For each viable name, verify the news, run the company-snapshot skill (REQUIRED for swing proposals — an unneutralized RED FLAGS line kills the candidate), and where clean, register a GTC swing proposal (tradeClass "swing", entryType STP_LMT, trigger = suggestedEntry, entryLimit ~0.3% above, stop near suggestedStop, target at a real objective giving >= 2:1, quantity OMITTED so the swing risk budget sizes it). These are patient orders that only fill on strength — clearly separate them from intraday ideas in your message.',
        model: undefined, // use default (Claude for deep reasoning)
        maxIterations: 12,
        activeStart: '07:00',
        activeEnd: '09:30',
    },
    {
        name: 'Market Open Scan',
        description: 'Ranked intraday opportunities 5 minutes after market open (Opportunity Engine).',
        cronExpr: '35 9 * * 1-5',
        message: 'Produce the morning intraday brief. Call the opportunities tool (action "latest"; if missing or older than 10 minutes, action "refresh"). Take the top 5 ranked candidates and for each verify the catalyst with web_search and validate sizing/stops with risk_manager. Register each actionable recommendation (at most 3) with trade_proposals (action create, expiresMinutes 90) and output the ranked list with, for each: direction, entry, stop, target, size, one-line rationale, and the proposal ID with "Reply \'accept <ID>\' to execute (paper)". If no candidate has signalScore >= 60, say so explicitly — never force a trade. Do not place orders yourself.',
        model: undefined,
        maxIterations: 24,
        activeStart: '09:30',
        activeEnd: '10:30',
    },
    {
        name: 'Midday Check',
        description: 'Midday position review and opportunity scan.',
        cronExpr: '0 12 * * 1-5',
        message: 'Review open positions and scan for midday opportunities. Check for mean-reversion setups and any developing trends.',
        model: undefined,
        maxIterations: 12,
        activeStart: '11:00',
        activeEnd: '13:00',
    },
    {
        name: 'Pre-Close Review',
        description: 'End-of-day review and ranked overnight candidates (Opportunity Engine).',
        cronExpr: '30 15 * * 1-5',
        message: 'Run the pre-close review. First, evaluate open positions (ibkr_account) and their LIVE protection (ibkr_orders action list — open orders at the broker are the ONLY truth about brackets; the proposals store does not contain auto-protect GTC exits, so never call a position unprotected from proposal state alone): hold, trim, or close before the bell, applying the overnight limits from the risk rules — check EVERY position with earnings_calendar (action check, withinDays 2) and call out explicitly any position that would hold through a report (holding through a print is ONLY valid as an explicit earnings-bet; anything else must exit before the close) — and flag any position whose bracket exits are DAY orders about to expire (they leave the position unprotected overnight; suggest \'protect <SYMBOL> <stop> [target]\' to re-arm GTC exits). Second, the earnings-bet check (we are inside the entry window): call earnings_calendar (action day) for today\'s after-hours reporters and tomorrow\'s pre-market reporters; for the 2-3 most liquid interesting names, invoke the earnings-bet skill and run its evidence bar (earnings_bet_intel reactions — need >= 8 prints, >= 75% consistency on a side — plus at least one external signal: surprise streak, implied vs historical move, news, positioning). Where a name qualifies, register ONE labeled proposal (trade_proposals create, tradeClass "earnings-bet", tif "GTC", worstCaseGapPct from the reactions record, quantity OMITTED, expiresMinutes 60) — the gate allows only one open bet; say plainly when no reporter qualifies, that is the normal outcome most days. Then call the opportunities tool (action "latest"; refresh if older than 15 minutes) and assess the top candidates for overnight holds — and report in ONE line any watchlist symbol that topped recent scan cycles just under the trigger threshold (e.g. score 75-79): visibility, not action; a +10% day on a watchlist name must never pass in silence. For the candidates: check earnings_calendar and news catalysts (web_search), prefer lower-ATR names, and validate each with risk_manager using the overnight position limits. Register at most 2 qualifying overnight setups with trade_proposals (action create, expiresMinutes 45, tif "GTC" so the bracket survives the close) and present each with direction, entry, stop, target, size, rationale, and the proposal ID with "Reply \'accept <ID>\' to execute (paper)". Be explicit when nothing qualifies. Do not place orders yourself.',
        model: undefined,
        maxIterations: 24,
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
            // Keep seeded jobs in sync when their prompt or iteration budget
            // evolves in code. Schedule and activeHours are left untouched
            // (user-tunable).
            if (existing.payload.message !== def.message ||
                existing.description !== def.description ||
                existing.payload.maxIterations !== def.maxIterations) {
                existing.payload.message = def.message;
                existing.description = def.description;
                existing.payload.maxIterations = def.maxIterations;
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
                maxIterations: def.maxIterations,
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
