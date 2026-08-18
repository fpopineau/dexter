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
        message: 'Run pre-market brief. FIRST prime the data farms: pull ibkr_market_data for SPY; if the quote is missing or the spread is absurd, wait a minute and retry once — until the canary looks sane, treat every other quote as suspect. Then start with the trading performance recap: call trade_proposals (action performance, days 1) and report the closed trades, win/loss, net P&L, and anything still executing — include the provided report verbatim, then one sentence of interpretation (e.g. stops hit on longs in a weak tape). Then call earnings_calendar (action day) for today AND tomorrow: name the big reporters and their timing (pre-market reporters can gap the open TODAY; after-hours reporters gap TOMORROW), and check current positions plus the watchlist against them (action check) — holding through a report must be called out explicitly. Then call event_risk (action macro, withinDays 1): name any dated macro binary (CPI, FOMC, jobs) resolving today or tomorrow with its market-implied top outcome and uncertainty grade — a high-uncertainty macro print tempers gap-plan aggression and the day\'s overnight bias. Call news_pulse (no args): name any book/reactor/watchlist symbol flagged hot with its top headline — a news-hot reactor or gapper is a priority candidate for the gap plan; a gapper with NO pulse needs its catalyst verified the hard way before any proposal. Then summarize overnight moves, pre-market movers, and watchlist key levels. Next, the GAP PLAN — BOTH DIRECTIONS: for the 1-2 pre-market gappers with a VERIFIED catalyst (web_search) and real pre-market dollar volume (not a 40k-share drift), pull extended-hours bars (technical_analysis with useRTH false) to read the pre-market high/low and gap shape (holding above/below the gap midpoint vs fading). UP-gaps, where clean: register a confirmation-based DAY proposal — trade_proposals create, entryType STP_LMT, trigger just above the PRE-MARKET HIGH, entryLimit ~0.3% above the trigger, stop at RTH structure from the PRIOR session (never at thin pre-market wicks), target an honest objective >= 2:1, quantity OMITTED, expiresMinutes 150 so unfilled plans die by ~10:30. DOWN-gaps — and on a risk-off tape PREFER this side over up-gap longs: register the mirror SHORT, entryType STP_LMT, trigger just below the PRE-MARKET LOW, entryLimit ~0.3% below the trigger, stop ABOVE at prior-session structure — and expect the OPENING BOUNCE: a −4% gapper routinely squeezes +2% in the first minutes before rolling over (MU 2026-08-18: opened 957, spiked 978.7, then bled −5%), so a stop tighter than ~0.6x the daily ATR above the trigger dies to the squeeze; if no structure sits in the 0.6-0.75x ATR band, use tif GTC with the trigger below the pre-market low so the entry arms at the open and only fills on real continuation. Both directions fill only on continuation - state plainly that a no-fill is a good outcome (the first-15-minutes loss pattern is real; the trigger IS the confirmation). Never propose a MKT entry pre-open. Finally check swing_patterns (action latest) — last night\'s pullback/flat-base/cup-and-handle candidates. Work DOWN the ranked list until you have evaluated 2-3 VIABLE names or exhausted the list: skip immediately, in one line each and with no further analysis, any symbol already held or carrying a working bracket (duplicate) and any symbol reporting within the ~2-week holding window (earnings_calendar check) — a dead top tier must not end the hunt while clean candidates sit below it. Validate swing candidates on the PRIOR session\'s daily bars (technical_analysis barSize "1 day") — swing levels are daily structure, and pre-market quotes on thin names are EXPECTED to be absurd: they must never invalidate a candidate or feed its score. For each viable name, verify the news, run the company-snapshot skill (REQUIRED for swing proposals — an unneutralized RED FLAGS line kills the candidate), and where clean, register a GTC swing proposal (tradeClass "swing", entryType STP_LMT, trigger = suggestedEntry, entryLimit ~0.3% above, stop near suggestedStop, target at a real objective giving >= 2:1, quantity OMITTED so the swing risk budget sizes it). These are patient orders that only fill on strength — clearly separate them from intraday ideas in your message.',
        model: undefined, // use default (Claude for deep reasoning)
        maxIterations: 12,
        activeStart: '07:00',
        activeEnd: '09:30',
    },
    {
        name: 'Market Open Scan',
        description: 'Ranked intraday opportunities 5 minutes after market open (Opportunity Engine).',
        cronExpr: '35 9 * * 1-5',
        message: 'Produce the morning intraday brief. Call the opportunities tool (action "latest"; if missing or older than 10 minutes, action "refresh"). Take the top 5 ranked candidates and for each verify the catalyst with web_search and validate sizing/stops with risk_manager. Register each actionable recommendation (at most 3) with trade_proposals (action create, expiresMinutes 90) — this job runs INSIDE the opening range (before ~09:50), so entries must be confirmation-based: entryType STP_LMT with the trigger above the opening-range high (below the OR low for shorts), never an immediate LMT/MKT fill into the gap-fade zone (the documented first-15-minutes loss pattern; with paper auto-execution an immediate entry fills at ~09:36). Output the ranked list with, for each: direction, entry, stop, target, size, one-line rationale, and the proposal ID with "Reply \'accept <ID>\' to execute (paper)". If no candidate has signalScore >= 60, say so explicitly — never force a trade. Do not place orders yourself.',
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
        message: 'Run the pre-close review. First, evaluate open positions (ibkr_account) and their LIVE protection (ibkr_orders action list — open orders at the broker are the ONLY truth about brackets; the proposals store does not contain auto-protect GTC exits, so never call a position unprotected from proposal state alone): hold, trim, or close before the bell, applying the overnight limits from the risk rules — check EVERY position with earnings_calendar (action check, withinDays 2) and call out explicitly any position that would hold through a report (holding through a print is ONLY valid as an explicit earnings-bet; anything else must exit before the close) — and flag any position whose bracket exits are DAY orders about to expire (they leave the position unprotected overnight; suggest \'protect <SYMBOL> <stop> [target]\' to re-arm GTC exits). Second, the earnings-bet check (we are inside the entry window): call earnings_calendar (action day) for today\'s after-hours reporters and tomorrow\'s pre-market reporters; for the 2-3 most liquid interesting names, invoke the earnings-bet skill and run its evidence bar (earnings_bet_intel reactions — need >= 8 prints, >= 75% consistency on a side — plus at least one external signal: the reactions output\'s externalSignal (an open Polymarket beat market with real volume) counts, as do surprise streak, implied vs historical move, news, positioning). Where a name qualifies, register ONE labeled proposal (trade_proposals create, tradeClass "earnings-bet", tif "GTC", worstCaseGapPct from the reactions record, quantity OMITTED, expiresMinutes 25 so an unaccepted bet dies by 15:55, never surviving into the print) — the gate allows only one open bet; say plainly when no reporter qualifies, that is the normal outcome most days. Then call the opportunities tool (action "latest"; refresh if older than 15 minutes) and assess the top candidates for overnight holds — and report in ONE line any watchlist symbol that topped recent scan cycles just under the trigger threshold (e.g. score 75-79): visibility, not action; a +10% day on a watchlist name must never pass in silence. For the candidates: check earnings_calendar and news catalysts (web_search), prefer lower-ATR names, and validate each with risk_manager using the overnight position limits. Also call event_risk (action macro, withinDays 1): on a macro binary night (high-uncertainty CPI/FOMC/jobs print tomorrow), a qualifying overnight setup must name the event in its rationale — prefer passing on marginal ones. Register at most 2 qualifying overnight setups with trade_proposals (action create, expiresMinutes 45, tif "GTC" so the bracket survives the close) and present each with direction, entry, stop, target, size, rationale, and the proposal ID with "Reply \'accept <ID>\' to execute (paper)". Be explicit when nothing qualifies. Do not place orders yourself.',
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
