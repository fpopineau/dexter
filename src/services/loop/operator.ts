/**
 * Operator commands of the loop control plane (REQ-EPOCH-001/004,
 * REQ-LADDER-001, REQ-DIGEST-001, live-loop WP3) — the MUTATING half of the
 * WhatsApp grammar. Every act that changes the loop's state is two-step:
 * the first message shows the evidence and asks for `… confirm`; the
 * confirmation must arrive within CONFIRM_TTL_MS or it lapses. Reads
 * (`ladder`, `epoch`, `digest`) are one-step.
 *
 *   ladder up [confirm]          apply the queued step-up (evidence shown)
 *   epoch new [carry] [confirm]  start the next epoch (NetLiq frozen; the
 *                                rung resets unless `carry`)
 *   promote <variant> [confirm]  record the operator's ratification and
 *                                print the change + restart + `epoch new`
 *   digest                       today's four-section digest, on demand
 */

import type { LoopStatus } from './looks.js';
import { readEpochRecord, startEpoch } from './epoch-control.js';
import { stepUp, ladderStatusLine } from './ladder-control.js';
import { promotionInstructions, recordPromotion } from './promote.js';
import { readLadderState, BOTTOM_RUNG } from '../ladder-state.js';

export const CONFIRM_TTL_MS = 10 * 60_000;

export interface OperatorDeps {
    now: () => number;
    dataDir?: string;
    /** USD NetLiq (null = broker unavailable — the act is refused). */
    netLiqUsd: () => Promise<number | null>;
    /** The running gateway's strategy fingerprint (null = unresolved). */
    fingerprint: () => Promise<string | null>;
    /** A fresh looks pass (the evidence for ladder / promote). */
    looks: () => Promise<LoopStatus>;
    setBaseline: (note: string, netLiqUsd: number | null) => void;
    journal: (line: string) => void;
    digest: () => Promise<string>;
    /** REQ-LADDER-003 / REQ-LIVE-006: on a live account the cutover epoch
     *  always restarts at the bottom rung — `carry` is refused. */
    liveAccount: () => boolean;
}

export interface LoopOperator {
    ladderUp: (confirm: boolean) => Promise<string>;
    epochNew: (carry: boolean, confirm: boolean) => Promise<string>;
    promote: (variant: string, confirm: boolean) => Promise<string>;
    digest: () => Promise<string>;
}

export function createOperator(deps: OperatorDeps): LoopOperator {
    const pending = new Map<string, number>();

    const arm = (key: string): void => { pending.set(key, deps.now() + CONFIRM_TTL_MS); };
    const armed = (key: string): boolean => {
        const until = pending.get(key);
        if (until === undefined) return false;
        pending.delete(key);
        return until >= deps.now();
    };
    const lapsed = (what: string) => `⛔ '${what} confirm' without a live request (none pending, or it lapsed after ${CONFIRM_TTL_MS / 60_000} min). Send '${what}' first.`;

    return {
        async ladderUp(confirm) {
            const status = await deps.looks();
            const el = status.ladder.eligibility;
            if (!el || !el.eligible || el.nextRung === null) {
                return `⛔ ladder step-up not available: ${el?.reason ?? 'no evidence'}.\n${ladderStatusLine(deps.dataDir, el)}`;
            }
            if (!confirm) {
                arm('ladder up');
                return [
                    `📈 Ladder step-up ELIGIBLE: rung ${status.ladder.rung}% → ${el.nextRung}% (${el.reason}).`,
                    `Evidence: n ${status.sample?.n ?? 0}, ΣR ${status.sample?.sumR.toFixed(2) ?? '—'}, PF ${status.sample && Number.isFinite(status.sample.profitFactor) ? status.sample.profitFactor.toFixed(2) : '—'}, epoch ${status.epoch?.id ?? '—'} ${status.epoch?.status ?? ''}.`,
                    `After the step the automatic step-down arms at −5% of the marked NetLiq. Reply 'ladder up confirm' within ${CONFIRM_TTL_MS / 60_000} min to apply.`,
                ].join('\n');
            }
            if (!armed('ladder up')) return lapsed('ladder up');
            const markedNetLiq = await deps.netLiqUsd();
            const r = stepUp({
                now: deps.now(), dataDir: deps.dataDir, journal: deps.journal, markedNetLiq,
                evidence: { n: status.sample?.n ?? 0, sumR: status.sample?.sumR ?? 0, stopActive: status.epoch?.status === 'stopped' },
            });
            return r.message;
        },

        async epochNew(carry, confirm) {
            if (carry && deps.liveAccount()) {
                return "⛔ 'epoch new carry' refused on a LIVE account — the live cutover always restarts at rung 0.25% (REQ-LADDER-003). Send 'epoch new'.";
            }
            const current = readEpochRecord(deps.dataDir);
            const key = `epoch new${carry ? ' carry' : ''}`;
            if (current?.status === 'running' && !confirm) {
                arm(key);
                return [
                    `⚠️ ${current.id} is RUNNING (n looks done: ${current.looksDone.length}${current.firstAcceptAt ? ', ACCEPT recorded' : ''}). Starting a new epoch supersedes it: the performance baseline resets, the looks restart from n=0${carry ? ` and the rung is CARRIED (${readLadderState(deps.dataDir)?.rung ?? BOTTOM_RUNG}%)` : ' and the rung resets to 0.25%'}.`,
                    `Reply '${key} confirm' within ${CONFIRM_TTL_MS / 60_000} min to proceed.`,
                ].join('\n');
            }
            if (current?.status === 'running' && confirm && !armed(key)) return lapsed(key);
            const [netLiq, fp] = await Promise.all([deps.netLiqUsd(), deps.fingerprint()]);
            if (netLiq === null || !(netLiq > 0)) {
                return '⛔ epoch new refused: USD NetLiq unavailable from IBKR — the −5% hard stop needs the frozen denominator. Retry when the account summary responds.';
            }
            if (fp === null) {
                return '⛔ epoch new refused: the strategy identity is UNRESOLVED (rules/code/provider) — an epoch must record the fingerprint it trades. Check the gateway log (strategy-fingerprint).';
            }
            const rec = startEpoch({
                now: deps.now(), dataDir: deps.dataDir, netLiqUsd: netLiq, fingerprint: fp, carryRung: carry,
                policyLabel: current?.promotionPending?.variant ?? 'incumbent',
                setBaseline: deps.setBaseline, journal: deps.journal,
            });
            const rung = readLadderState(deps.dataDir)?.rung ?? BOTTOM_RUNG;
            return [
                `🚀 ${rec.id} STARTED ${new Date(rec.startedAt).toISOString()}`,
                `fingerprint ${rec.fingerprint} · constants ${rec.constantsHash} · policy ${rec.policyLabel}`,
                `NetLiq frozen $${netLiq.toFixed(2)} (hard stop at $${(netLiq * 0.95).toFixed(2)}) · rung ${rung}%`,
                `Looks at n = 25/50/75/100 (nightly, automatic). New entries are OPEN.`,
            ].join('\n');
        },

        async promote(variant, confirm) {
            const info = promotionInstructions(variant);
            if (!info.known) return `⛔ ${info.lines.join(' ')}`;
            const key = `promote ${variant}`;
            if (!confirm) {
                const status = await deps.looks();
                const line = status.shadow.find((s) => s.variant === variant);
                const evidence = line?.summary
                    ? `n ${line.summary.n} (${line.summary.days}d), ΣR ${line.summary.sumR.toFixed(2)}, meanR ${line.summary.meanR?.toFixed(3) ?? '—'}${line.diff ? `, vs incumbent daily ΔR LCB ${line.diff.lcb.toFixed(3)} (median ${line.diff.median.toFixed(3)})` : ''} — ${line.candidate ? 'PROMOTION CANDIDATE (≥30 trades, ≥10 days, LCB > 0)' : 'NOT a candidate yet (needs ≥30 trades, ≥10 days, LCB > 0)'}`
                    : `no simulator rows for '${variant}' in this epoch`;
                arm(key);
                return [
                    `🔎 promote '${variant}' — evidence: ${evidence}.`,
                    `Claude recommends; you decide. Promotion is a behavior change: the identity moves and a NEW epoch starts.`,
                    ...info.lines.map((l) => `• ${l}`),
                    `Reply '${key} confirm' within ${CONFIRM_TTL_MS / 60_000} min to record the ratification.`,
                ].join('\n');
            }
            if (!armed(key)) return lapsed(key);
            return recordPromotion(variant, { now: deps.now(), dataDir: deps.dataDir, journal: deps.journal });
        },

        digest: () => deps.digest(),
    };
}

let liveOperator: LoopOperator | null = null;

/** The gateway's operator, bound to the live ledgers (lazy — the imports
 *  pull the broker layer, which unit tests never touch). */
export async function liveLoopOperator(): Promise<LoopOperator> {
    if (liveOperator) return liveOperator;
    const [{ getNetLiquidation }, { strategyFingerprint }, { setPerformanceBaseline }, { appendJournalLine }, nightly, { getManagedAccounts, isLivePort }] = await Promise.all([
        import('../daily-loss-guard.js'),
        import('../strategy-fingerprint.js'),
        import('../trade-proposals.js'),
        import('./journal.js'),
        import('./nightly.js'),
        import('@/tools/ibkr/connection.js'),
    ]);
    liveOperator = createOperator({
        now: Date.now,
        liveAccount: () => isLivePort() || getManagedAccounts().some((a) => !a.toUpperCase().startsWith('D')),
        netLiqUsd: () => getNetLiquidation().catch(() => null),
        fingerprint: () => strategyFingerprint().catch(() => null),
        looks: () => nightly.runLooksLive(),
        setBaseline: (note, netLiq) => { setPerformanceBaseline(note, netLiq); },
        journal: (line) => { appendJournalLine(line); },
        digest: async () => {
            const { formatDigestWhatsApp } = await import('./digest.js');
            return formatDigestWhatsApp((await nightly.buildLoopDigestLive()).digest);
        },
    });
    return liveOperator;
}
