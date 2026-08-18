/**
 * Trigger alerts — bridges Opportunity Engine event triggers to WhatsApp.
 *
 * On trigger: run a focused, isolated agent evaluation of the candidate
 * (news catalyst, risk validation). If the agent deems it actionable it
 * registers a trade proposal (trade_proposals tool) and the resulting
 * message — including the 'accept <ID>' instruction — is delivered to the
 * most recent WhatsApp session. Non-actionable evaluations reply with the
 * heartbeat token and are suppressed.
 *
 * Execution stays human-only: headless agent runs cannot approve orders,
 * and acceptance flows through the deterministic command router.
 */

import { onBreadthTrigger, onOpportunityTrigger, type Opportunity } from '@/services/opportunity-engine.js';
import { type BreadthEvent } from '@/services/breadth-detector.js';
import { autoExecuteProposal, isAutoExecuteEnabled } from '@/services/proposal-executor.js';
import { listProposals } from '@/services/trade-proposals.js';
import { getSetting } from '@/utils/config.js';
import { logger } from '@/utils';
import { runAgentForMessage } from './agent-runner.js';
import { assertOutboundAllowed, sendMessageWhatsApp } from './channels/whatsapp/index.js';
import { HEARTBEAT_OK_TOKEN } from './heartbeat/suppression.js';
import { loadSessionStore, resolveSessionStorePath, type SessionEntry } from './sessions/store.js';
import { cleanMarkdownForWhatsApp } from './utils.js';

let registered = false;

function findTargetSession(): SessionEntry | null {
    const storePath = resolveSessionStorePath('default');
    const store = loadSessionStore(storePath);
    const entries = Object.values(store).filter((e) => e.lastTo);
    if (entries.length === 0) return null;
    entries.sort((a, b) => b.updatedAt - a.updatedAt);
    return entries[0];
}

function buildPrompt(opp: Opportunity, tapeLine: string): string {
    return [
        `[OPPORTUNITY TRIGGER] ${opp.symbol} just ranked top-3 in the live scanner.`,
        '',
        `Candidate: ${opp.direction.toUpperCase()} ${opp.symbol} (${opp.longName})`,
        `compositeRank ${opp.compositeRank}, signalScore ${opp.signalScore} (${opp.rating}), ` +
        `price ${opp.price}, RVOL ${opp.rvol}, ATR ${opp.atr}, RSI ${opp.rsi}, VWAP ${opp.vwap}, ` +
        `scanners: ${opp.scanSources.join(', ')}.`,
        tapeLine,
        'Weigh the candidate AGAINST the tape: a momentum LONG in a risk-off tape needs an',
        'idiosyncratic catalyst (its own news), not sector beta — counter-tape beta is the losing pattern.',
        '',
        'Evaluate this candidate NOW for an intraday trade:',
        '1. Check for a news catalyst (web_search). A move without a catalyst is suspect.',
        '2. Validate entry/stop/target and position size with risk_manager (stop from ATR).',
        '3. Decision:',
        `   - NOT actionable → reply ${HEARTBEAT_OK_TOKEN} plus ONE line naming the decisive reason ` +
        '(no catalyst / geometry impossible / spread / tape). The reason is LEDGERED and scored against ' +
        "the day's tape by the nightly replay — a decline is a recorded decision, never a free pass.",
        '   - Actionable → register it with trade_proposals (action create, source rationale included;',
        '     OMIT quantity — the position sizer computes it from the score and account equity).',
        '     trade_proposals is the ONLY tool that registers proposals — opportunities is read-only.',
        "     Then reply briefly: the setup, the proposal line, and \"Reply 'accept <ID>' to execute (paper)\".",
        'Never place orders yourself. Keep the alert under 10 lines.',
    ].join('\n');
}

function buildBreadthPrompt(event: BreadthEvent, tapeLine: string): string {
    const up = event.direction === 'long';
    return [
        event.movers.length
            ? `[BREADTH TRIGGER] Sector-wide move: ${event.movers.length} watchlist names are ` +
              `${up ? 'ripping' : 'selling off'} together ` +
              `(${event.movers.join(', ')}${event.semis.length ? `; semis: ${event.semis.join(', ')}` : ''}).`
            : `[BREADTH TRIGGER] Pre-armed by the tape regime — the index proxies say the chip complex is ` +
              `selling off together, before the intraday scans have accumulated movers. Confirm on the tape, ` +
              `not on scan ranks.`,
        tapeLine,
        '',
        `On a correlated move the single-name pipeline bottlenecks (extension guard, trigger cap) — ` +
        `the whole move is expressed in ONE liquid vehicle instead: ${event.vehicle}.`,
        '',
        `Evaluate ${event.vehicle} NOW for a ${up ? 'LONG' : 'SHORT'} intraday entry:`,
        '1. Confirm the breadth story with a news check (web_search) — what is driving the group?',
        `2. Validate entry/stop/target and position size with risk_manager (stop from ${event.vehicle}'s own ATR).`,
        up
            ? '   Prefer a pullback entry (VWAP / prior high) over hitting the offer at the high of day.'
            : '   Prefer a bounce entry (VWAP retest / broken support from below) over hitting bids at the low of day.',
        '   PRE-MARKET is actionable: a DAY bracket cannot rest before the open, so use tif GTC with a',
        `   STP_LMT trigger just ${up ? 'above the pre-market high' : 'below the pre-market low'} (entryLimit ~0.3% beyond,`,
        '   stop at prior-session structure 0.4-0.75x the daily ATR away, target <= 1.5x ATR) — it arms at',
        '   the open and fills only on continuation. "It is pre-market" is NOT a decline reason.',
        '3. Decision:',
        `   - NOT actionable → reply ${HEARTBEAT_OK_TOKEN} plus ONE line naming the decisive reason. ` +
        "The reason is LEDGERED and scored against the day's tape — a decline is a recorded decision, " +
        'never a free pass (2026-08-18: the vehicle was declined twice on a −4.7% semis day, reasons lost).',
        '   - Actionable → register it with trade_proposals (action create, breadth rationale included;',
        '     OMIT quantity — the position sizer computes it from the score and account equity).',
        '     trade_proposals is the ONLY tool that registers proposals — opportunities is read-only.',
        "     Then reply briefly: the setup, the proposal line, and \"Reply 'accept <ID>' to execute (paper)\".",
        'Never place orders yourself. Keep the alert under 10 lines.',
    ].join('\n');
}

/**
 * Run an isolated evaluation for `symbol` and deliver the result: suppress
 * non-actionable answers, send the alert, then optionally auto-execute the
 * proposal the evaluation just registered. Shared by single-name and
 * breadth triggers.
 */
async function evaluateAndDeliver(
    sessionKey: string,
    symbol: string,
    prompt: string,
    /** Context for the judgment-decline ledger: what was being evaluated,
     *  so a suppressed answer leaves an auditable refusal row instead of
     *  vanishing (2026-08-18: eight declines on a −4.7% semis day, zero
     *  recorded reasons — the layer that cost the most was the only one
     *  the nightly replay could not see). */
    declineCtx: { direction: 'long' | 'short'; price?: number | null; score?: number | null },
): Promise<void> {
    const session = findTargetSession();
    if (!session?.lastTo || !session?.lastAccountId) {
        logger.warn('[trigger-alerts] no WhatsApp delivery target, skipping alert');
        return;
    }
    try {
        assertOutboundAllowed({ to: session.lastTo, accountId: session.lastAccountId });
    } catch {
        logger.warn('[trigger-alerts] outbound blocked, skipping alert');
        return;
    }

    const model = getSetting('modelId', 'gpt-5.5') as string;
    const modelProvider = getSetting('provider', 'openai') as string;

    const answer = await runAgentForMessage({
        sessionKey,
        query: prompt,
        model,
        modelProvider,
        maxIterations: 10, // catalyst search + risk check + proposal + reply
        isolatedSession: true,
        channel: 'whatsapp',
    });

    if (!answer.trim() || answer.toUpperCase().includes(HEARTBEAT_OK_TOKEN)) {
        // Ledger the decline WITH the model's reason (the prompt asks for
        // one line after the token). The row carries the trigger price as
        // the entry so the replay can ask "what did the symbol do after we
        // said no" — stop/target stay null, nothing is fabricated.
        const reason = answer
            .replace(new RegExp(HEARTBEAT_OK_TOKEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 300) || 'no reason given';
        logger.info(`[trigger-alerts] ${symbol}: evaluation not actionable, suppressed (${reason.slice(0, 120)})`);
        const { recordRefusal } = await import('@/services/trade-proposals.js');
        await recordRefusal({
            symbol,
            direction: declineCtx.direction,
            entryType: 'EVAL',
            entry: declineCtx.price ?? null,
            score: declineCtx.score ?? null,
            reason: `evaluation declined: ${reason}`,
        }).catch(() => { /* ledger is best-effort */ });
        return;
    }

    await sendMessageWhatsApp({
        to: session.lastTo,
        body: cleanMarkdownForWhatsApp(answer).trim(),
        accountId: session.lastAccountId,
    });
    logger.info(`[trigger-alerts] ${symbol}: alert delivered`);

    // Optional paper-only auto-execution (AUTO_EXECUTE_PAPER=true):
    // pick the freshest open proposal the evaluation just registered for
    // this symbol and run it through the auto-executor (paper assertion,
    // daily cap, then the standard gates). Outcome is reported back.
    if (isAutoExecuteEnabled()) {
        const open = await listProposals('open');
        const candidate = open
            .filter((p) => p.symbol === symbol && Date.now() - p.createdAt < 10 * 60_000)
            .sort((a, b) => b.createdAt - a.createdAt)[0];
        if (candidate) {
            const outcome = await autoExecuteProposal(candidate.id);
            logger.info(`[trigger-alerts] ${symbol}: auto-execute ${candidate.id} → ${outcome.ok ? 'ok' : 'refused'}`);
            await sendMessageWhatsApp({
                to: session.lastTo,
                body: cleanMarkdownForWhatsApp(outcome.message).trim(),
                accountId: session.lastAccountId,
            });
        }
    }
}

/** Subscribe trigger alerts (idempotent). Called at gateway startup. */
export function registerTriggerAlerts(): void {
    if (registered) return;
    registered = true;

    onOpportunityTrigger(async (opp) => {
        const { getMarketRegime } = await import('@/services/market-regime.js');
        const tape = (await getMarketRegime().catch(() => null))?.line ?? 'TAPE unknown (regime unavailable)';
        await evaluateAndDeliver(`trigger:${opp.symbol}`, opp.symbol, buildPrompt(opp, tape),
            { direction: opp.direction, price: opp.price, score: opp.signalScore });
    });

    // Sector-wide melt-ups → one evaluation of the sector vehicle, outside
    // the single-name trigger cap (Jul 30: nine correlated movers, cap
    // exhausted by midday, AMD/INTC/DELL/TSM/ARM never evaluated).
    onBreadthTrigger(async (event) => {
        const { getMarketRegime } = await import('@/services/market-regime.js');
        const tape = (await getMarketRegime().catch(() => null))?.line ?? 'TAPE unknown (regime unavailable)';
        await evaluateAndDeliver(`breadth:${event.vehicle}:${event.direction}`, event.vehicle,
            buildBreadthPrompt(event, tape), { direction: event.direction });
    });

    logger.info('[trigger-alerts] registered');
}
