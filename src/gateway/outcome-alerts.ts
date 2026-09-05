/**
 * Outcome alerts — pushes trade-close notifications to WhatsApp.
 *
 * When the outcome tracker closes an executed proposal (target hit, stop
 * hit, cancelled, manual), the result is delivered to the most recent
 * WhatsApp session — same delivery model as trigger alerts. Deterministic,
 * no LLM involved.
 */

import { onAutoProtect, onTradeClosed } from '@/services/outcome-tracker.js';
import { onBenchmarkReport } from '@/services/benchmark.js';
import { onSimulatorReport } from '@/services/simulator/index.js';
import { onEodTriage } from '@/services/eod-triage.js';
import { onKillSwitchAlert } from '@/services/kill-switch-guardian.js';
import { onFlatExitSweep } from '@/services/flat-exit-sweeper.js';
import { onProfitTrailAlert } from '@/services/profit-trail.js';
import { formatProposalLine, type TradeProposal } from '@/services/trade-proposals.js';
import { logger } from '@/utils';
import { assertOutboundAllowed, sendMessageWhatsApp } from './channels/whatsapp/index.js';
import { loadSessionStore, resolveSessionStorePath, type SessionEntry } from './sessions/store.js';

let registered = false;

function findTargetSession(): SessionEntry | null {
    const storePath = resolveSessionStorePath('default');
    const store = loadSessionStore(storePath);
    const entries = Object.values(store).filter((e) => e.lastTo);
    if (entries.length === 0) return null;
    entries.sort((a, b) => b.updatedAt - a.updatedAt);
    return entries[0];
}

function formatCloseMessage(p: TradeProposal): string {
    const icons: Record<string, string> = {
        target: '🎯', stop: '🛑', cancelled: '🚫', manual: '✋', unknown: '❓',
    };
    const icon = icons[p.exitReason ?? 'unknown'] ?? '🏁';
    const lines = [`${icon} Trade closed — ${p.exitReason ?? 'unknown'}`, formatProposalLine(p)];
    if (p.realizedPnl != null) {
        const net = p.realizedPnl - (p.commissions ?? 0);
        lines.push(
            `P&L ${p.realizedPnl >= 0 ? '+' : ''}$${p.realizedPnl.toFixed(2)} gross` +
            (p.commissions ? `, ${net >= 0 ? '+' : ''}$${net.toFixed(2)} net of $${p.commissions.toFixed(2)} commissions` : ''),
        );
    } else if (p.exitReason === 'manual') {
        lines.push('P&L unknown — position was closed or left unprotected outside the bracket. Check ibkr_account.');
    }
    // The why matters most for cancellations (broker rejections carry the
    // reason, e.g. IBKR 201 trading-permission refusals).
    if ((p.exitReason === 'cancelled' || p.exitReason === 'manual') && p.note) {
        lines.push(`Reason: ${p.note.slice(0, 220)}`);
    } else if (p.note?.includes('SUSPECT FILL')) {
        // A stop fill far through its own level (SECZ 2026-08-13: paper-sim
        // phantom at 2× the tape) must reach the operator, not just the log.
        lines.push(p.note.slice(p.note.indexOf('⚠ SUSPECT FILL'), p.note.indexOf('⚠ SUSPECT FILL') + 300));
    }
    lines.push("Send 'performance' for the running summary.");
    return lines.join('\n');
}

/** Subscribe outcome alerts (idempotent). Called at gateway startup. */
export function registerOutcomeAlerts(): void {
    if (registered) return;
    registered = true;

    onTradeClosed(async (proposal) => {
        const session = findTargetSession();
        if (!session?.lastTo || !session?.lastAccountId) {
            logger.warn('[outcome-alerts] no WhatsApp delivery target, skipping close alert');
            return;
        }
        try {
            assertOutboundAllowed({ to: session.lastTo, accountId: session.lastAccountId });
        } catch {
            logger.warn('[outcome-alerts] outbound blocked, skipping close alert');
            return;
        }
        await sendMessageWhatsApp({
            to: session.lastTo,
            body: formatCloseMessage(proposal),
            accountId: session.lastAccountId,
        });
        logger.info(`[outcome-alerts] ${proposal.id} close alert delivered`);
    });

    // Auto-protect outcomes (GTC exits re-attached after a DAY bracket died
    // on an open position, or a warning when that failed).
    onAutoProtect(async (message) => {
        const session = findTargetSession();
        if (!session?.lastTo || !session?.lastAccountId) {
            logger.warn('[outcome-alerts] no WhatsApp delivery target, skipping auto-protect alert');
            return;
        }
        try {
            assertOutboundAllowed({ to: session.lastTo, accountId: session.lastAccountId });
        } catch {
            logger.warn('[outcome-alerts] outbound blocked, skipping auto-protect alert');
            return;
        }
        await sendMessageWhatsApp({ to: session.lastTo, body: message, accountId: session.lastAccountId });
        logger.info('[outcome-alerts] auto-protect alert delivered');
    });

    // EOD triage reports (close losing-and-fading / keep the rest).
    onEodTriage(async (message) => {
        const session = findTargetSession();
        if (!session?.lastTo || !session?.lastAccountId) {
            logger.warn('[outcome-alerts] no WhatsApp delivery target, skipping EOD-triage report');
            return;
        }
        try {
            assertOutboundAllowed({ to: session.lastTo, accountId: session.lastAccountId });
        } catch {
            logger.warn('[outcome-alerts] outbound blocked, skipping EOD-triage report');
            return;
        }
        await sendMessageWhatsApp({ to: session.lastTo, body: message, accountId: session.lastAccountId });
        logger.info('[outcome-alerts] EOD-triage report delivered');
    });

    // Nightly benchmark capture report (top movers vs the pipeline funnel).
    onBenchmarkReport(async (message) => {
        const session = findTargetSession();
        if (!session?.lastTo || !session?.lastAccountId) {
            logger.warn('[outcome-alerts] no WhatsApp delivery target, skipping benchmark report');
            return;
        }
        try {
            assertOutboundAllowed({ to: session.lastTo, accountId: session.lastAccountId });
        } catch {
            logger.warn('[outcome-alerts] outbound blocked, skipping benchmark report');
            return;
        }
        await sendMessageWhatsApp({ to: session.lastTo, body: message, accountId: session.lastAccountId });
        logger.info('[outcome-alerts] benchmark report delivered');
    });

    // Live-loop WP2 (REQ-SIM-006): the nightly simulator settle report —
    // variants accruing, the twin calibration line, or a FAILED settle.
    onSimulatorReport(async (message) => {
        const session = findTargetSession();
        if (!session?.lastTo || !session?.lastAccountId) {
            logger.warn('[outcome-alerts] no WhatsApp delivery target, skipping simulator report');
            return;
        }
        try {
            assertOutboundAllowed({ to: session.lastTo, accountId: session.lastAccountId });
        } catch {
            logger.warn('[outcome-alerts] outbound blocked, skipping simulator report');
            return;
        }
        await sendMessageWhatsApp({ to: session.lastTo, body: message, accountId: session.lastAccountId });
        logger.info('[outcome-alerts] simulator report delivered');
    });

    // Kill-switch guardian (review 2026-08-23): latch + entry-cancel report.
    // Orphaned-exit sweeps (incident 2026-08-26: exits resting on a flat
    // account opened a naked short) — same delivery contract as the
    // kill-switch alerts.
    onFlatExitSweep(async (message) => {
        const session = findTargetSession();
        if (!session?.lastTo || !session?.lastAccountId) {
            logger.warn('[outcome-alerts] no WhatsApp delivery target, skipping flat-exit-sweep alert');
            return;
        }
        try {
            assertOutboundAllowed({ to: session.lastTo, accountId: session.lastAccountId });
        } catch {
            logger.warn('[outcome-alerts] outbound blocked, skipping flat-exit-sweep alert');
            return;
        }
        await sendMessageWhatsApp({ to: session.lastTo, body: message, accountId: session.lastAccountId });
        logger.info('[outcome-alerts] flat-exit-sweep alert delivered');
    });

    onKillSwitchAlert(async (message) => {
        const session = findTargetSession();
        if (!session?.lastTo || !session?.lastAccountId) {
            logger.warn('[outcome-alerts] no WhatsApp delivery target, skipping kill-switch alert');
            return;
        }
        try {
            assertOutboundAllowed({ to: session.lastTo, accountId: session.lastAccountId });
        } catch {
            logger.warn('[outcome-alerts] outbound blocked, skipping kill-switch alert');
            return;
        }
        await sendMessageWhatsApp({ to: session.lastTo, body: message, accountId: session.lastAccountId });
        logger.info('[outcome-alerts] kill-switch alert delivered');
    });

    // Profit-trail closes (winner peaked, pulled back, auto-closed).
    onProfitTrailAlert(async (message) => {
        const session = findTargetSession();
        if (!session?.lastTo || !session?.lastAccountId) {
            logger.warn('[outcome-alerts] no WhatsApp delivery target, skipping profit-trail alert');
            return;
        }
        try {
            assertOutboundAllowed({ to: session.lastTo, accountId: session.lastAccountId });
        } catch {
            logger.warn('[outcome-alerts] outbound blocked, skipping profit-trail alert');
            return;
        }
        await sendMessageWhatsApp({ to: session.lastTo, body: message, accountId: session.lastAccountId });
        logger.info('[outcome-alerts] profit-trail alert delivered');
    });

    logger.info('[outcome-alerts] registered');
}
