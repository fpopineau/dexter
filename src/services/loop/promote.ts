/**
 * Promotion (REQ-EPOCH-004, live-loop WP3) — a HUMAN decision on Claude's
 * evidence. `promote <variant>` records the ratification (journal + epoch
 * record) and prints the exact change the variant corresponds to plus the
 * restart + `epoch new` steps; it changes no runtime behavior itself — a
 * promotion IS a behavior change and therefore a new fingerprint/epoch.
 */

import { VARIANTS_V1 } from '../simulator/variants.js';
import { readEpochRecord, writeEpochRecord } from './epoch-control.js';

/** What promoting a variant means in config terms. Gate-off variants are
 *  evidence about a gate, not a switch — they need a SPEC change. */
export function promotionInstructions(variant: string): { known: boolean; lines: string[] } {
    const def = VARIANTS_V1.find((v) => v.name === variant);
    if (!def) return { known: false, lines: [`unknown variant '${variant}' — known: ${VARIANTS_V1.map((v) => v.name).join(', ')}`] };
    const steps = (change: string[]) => [
        ...change,
        'then: restart the gateway (the change is a fingerprint surface — the identity moves),',
        "then: reply 'epoch new' to open the next epoch on the promoted policy (rung restarts at 0.25% unless 'epoch new carry').",
    ];
    switch (variant) {
        case 'incumbent':
            return { known: true, lines: ['the incumbent IS the live policy — nothing to promote.'] };
        case 'funnel-75':
            return { known: true, lines: steps(['set OPP_TRIGGER_SCORE=75 in .env (and consider OPP_TRIGGER_MAX_PER_DAY=10),']) };
        case 'exit-ratchet':
            return { known: true, lines: steps(['set exit_style: ratchet in src/config/risk-rules.yaml (REQ-EXIT-008 — recorded deviation: trail-enforced lock),']) };
        case 'exit-x2.0':
            return { known: true, lines: steps(['set take_atr_mult: 2.0 in src/config/risk-rules.yaml (take band 3-10% unchanged),']) };
        case 'stop-x/3':
            return { known: true, lines: steps(['this variant tightens the stop to x/3 — it needs a gate rule (a new REQ-EXIT) before it can be a policy; record the evidence and open a SPEC change,']) };
        case 'class-swing':
            return { known: true, lines: steps(['set swing_enabled: true in src/config/risk-rules.live.yaml — ONLY if the class record clears its own bar (≥30 trades, net > 0, PF ≥ 1.3, LCB > 0) and a swing-specific sample exists after any macro-calendar addition (VALIDATION-PROTOCOL),']) };
        case 'class-earnings-bet':
            return { known: true, lines: steps(['set earnings_bet_enabled: true in src/config/risk-rules.live.yaml — ONLY if the class record clears its own bar (≥30 trades, net > 0, PF ≥ 1.3, LCB > 0),']) };
        case 'weights-calibrated':
            return { known: true, lines: steps(['run `bun run scripts/calibrate-scorer.ts --apply` (writes .dexter/data/scorer-weights.json — a fingerprint surface),']) };
        default:
            if (variant.startsWith('gate-off:')) {
                return { known: true, lines: [`'${variant}' is evidence about the ${variant.slice('gate-off:'.length)} gate, not a switch: relaxing a deterministic gate needs a SPEC change (new REQ) reviewed against the refusal ledger's counterfactuals.`] };
            }
            return { known: true, lines: steps([`apply the change '${variant}' corresponds to (see the variant registry),`]) };
    }
}

export function recordPromotion(variant: string, deps: { now: number; dataDir?: string; journal: (line: string) => void }): string {
    const rec = readEpochRecord(deps.dataDir);
    const info = promotionInstructions(variant);
    if (!info.known) return `⛔ ${info.lines.join(' ')}`;
    if (rec) writeEpochRecord({ ...rec, promotionPending: { variant, at: deps.now } }, deps.dataDir);
    deps.journal(`PROMOTE ${variant} ratified by the operator${rec ? ` during ${rec.id}` : ''} — pending: apply the change, restart, 'epoch new'`);
    return [`📌 Promotion of '${variant}' RECORDED (${new Date(deps.now).toISOString()}).`, 'To make it the live policy:', ...info.lines.map((l) => `• ${l}`)].join('\n');
}
