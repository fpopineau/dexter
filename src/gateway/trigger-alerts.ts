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

function buildPrompt(opp: Opportunity): string {
    return [
        `[OPPORTUNITY TRIGGER] ${opp.symbol} just ranked top-3 in the live scanner.`,
        '',
        `Candidate: ${opp.direction.toUpperCase()} ${opp.symbol} (${opp.longName})`,
        `compositeRank ${opp.compositeRank}, signalScore ${opp.signalScore} (${opp.rating}), ` +
        `price ${opp.price}, RVOL ${opp.rvol}, ATR ${opp.atr}, RSI ${opp.rsi}, VWAP ${opp.vwap}, ` +
        `scanners: ${opp.scanSources.join(', ')}.`,
        '',
        'Evaluate this candidate NOW for an intraday trade:',
        '1. Check for a news catalyst (web_search). A move without a catalyst is suspect.',
        '2. Validate entry/stop/target and position size with risk_manager (stop from ATR).',
        '3. Decision:',
        `   - NOT actionable → respond with exactly: ${HEARTBEAT_OK_TOKEN}`,
        '   - Actionable → register it with trade_proposals (action create, source rationale included;',
        '     OMIT quantity — the position sizer computes it from the score and account equity).',
        '     trade_proposals is the ONLY tool that registers proposals — opportunities is read-only.',
        "     Then reply briefly: the setup, the proposal line, and \"Reply 'accept <ID>' to execute (paper)\".",
        'Never place orders yourself. Keep the alert under 10 lines.',
    ].join('\n');
}

function buildBreadthPrompt(event: BreadthEvent): string {
    return [
        `[BREADTH TRIGGER] Sector-wide move: ${event.movers.length} watchlist names are ripping together ` +
        `(${event.movers.join(', ')}${event.semis.length ? `; semis: ${event.semis.join(', ')}` : ''}).`,
        '',
        `On a correlated move the single-name pipeline bottlenecks (extension guard, trigger cap) — ` +
        `the whole move is expressed in ONE liquid vehicle instead: ${event.vehicle}.`,
        '',
        `Evaluate ${event.vehicle} NOW for a LONG intraday entry:`,
        '1. Confirm the breadth story with a news check (web_search) — what is driving the group?',
        `2. Validate entry/stop/target and position size with risk_manager (stop from ${event.vehicle}'s own ATR).`,
        '   Prefer a pullback entry (VWAP / prior high) over hitting the offer at the high of day.',
        '3. Decision:',
        `   - NOT actionable → respond with exactly: ${HEARTBEAT_OK_TOKEN}`,
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
async function evaluateAndDeliver(sessionKey: string, symbol: string, prompt: string): Promise<void> {
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
        logger.info(`[trigger-alerts] ${symbol}: evaluation not actionable, suppressed`);
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
        await evaluateAndDeliver(`trigger:${opp.symbol}`, opp.symbol, buildPrompt(opp));
    });

    // Sector-wide melt-ups → one evaluation of the sector vehicle, outside
    // the single-name trigger cap (Jul 30: nine correlated movers, cap
    // exhausted by midday, AMD/INTC/DELL/TSM/ARM never evaluated).
    onBreadthTrigger(async (event) => {
        await evaluateAndDeliver(`breadth:${event.vehicle}`, event.vehicle, buildBreadthPrompt(event));
    });

    logger.info('[trigger-alerts] registered');
}
