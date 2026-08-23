/**
 * Strategy fingerprint (review-17, freeze integrity).
 *
 * The freeze manifest records what the strategy WAS at tag time, but a
 * document cannot detect drift — the sample itself must carry the
 * identity. Every proposal row and every equity sample is stamped with a
 * 12-hex digest of the behavioral surfaces that can change WITHOUT a code
 * deploy: the effective risk rules (post profile override — a profile
 * flip or a yaml edit changes the JSON and with it the digest) and the
 * judgment documents the agent actually loads (SOUL.md user-or-bundled,
 * .dexter/RULES.md). The scorecard refuses a sample containing more than
 * one fingerprint — a mid-sample rules edit ends the window DETECTABLY
 * instead of silently.
 *
 * Division of labor with the other purity checks: code drift is pinned by
 * the manifest's behavioral baseline commit (git's job); model/provider
 * drift by the per-trade `model` column; exit_style rides in the rules
 * JSON. This digest covers the config-and-judgment surface between them.
 */

import { createHash } from 'node:crypto';
import { loadRulesDocument, loadSoulDocument } from '@/agent/prompts.js';
import { getRiskRules } from '@/tools/ibkr/risk-rules.js';

/** 12-hex digest of the effective rules + judgment documents. Never
 *  throws: an unreadable document hashes as 'absent' — absence is itself
 *  a fingerprintable state (deleting RULES.md mid-sample must change the
 *  digest, not crash the sampler). */
export async function strategyFingerprint(): Promise<string> {
    const [soul, rules] = await Promise.all([
        loadSoulDocument().catch(() => null),
        loadRulesDocument().catch(() => null),
    ]);
    const effectiveRules = JSON.stringify(getRiskRules());
    return createHash('sha256')
        .update(effectiveRules).update('\u0000')
        .update(soul ?? 'absent').update('\u0000')
        .update(rules ?? 'absent')
        .digest('hex')
        .slice(0, 12);
}
