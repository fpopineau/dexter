/**
 * Strategy fingerprint (review-17/18, freeze integrity).
 *
 * The freeze manifest records what the strategy WAS at tag time, but a
 * document cannot detect drift — the sample itself must carry the
 * identity. Every proposal row and every equity sample is stamped with a
 * 12-hex digest of the behavioral surfaces:
 *
 *   - the EFFECTIVE risk rules (post profile override — a profile flip
 *     or a yaml edit changes the JSON and with it the digest);
 *   - the judgment documents the agent actually loads (SOUL.md
 *     user-or-bundled, `.dexter/RULES.md`);
 *   - every discovered skill's SKILL.md content (review-18: built-in and
 *     `.dexter/skills/*` instructions steer live judgment too);
 *   - the configured provider:model pair (settings.json — the per-trade
 *     `model` column pins what proposed each trade; this pins what the
 *     RUNTIME was set to, covering samples with no trades);
 *   - the running code commit (git HEAD, read from the repo the gateway
 *     runs from — a deploy mid-sample changes the digest).
 *
 * The scorecard refuses a window containing more than one fingerprint —
 * a mid-sample edit on ANY of these surfaces ends the window DETECTABLY
 * instead of silently.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadRulesDocument, loadSoulDocument } from '@/agent/prompts.js';
import { discoverSkills } from '../skills/index.js';
import { getSetting } from '../utils/config.js';
import { getRiskRules } from '@/tools/ibkr/risk-rules.js';

/** The running code commit, from .git in the working directory (the
 *  gateway runs from the repo checkout — bun executes the TS in place,
 *  so HEAD IS the running code). 'absent' outside a repo; absence is a
 *  fingerprintable state, not an error. */
export async function readGitHeadSha(cwd = process.cwd()): Promise<string> {
    try {
        const head = (await readFile(join(cwd, '.git', 'HEAD'), 'utf-8')).trim();
        const m = /^ref:\s*(.+)$/.exec(head);
        if (!m) return /^[0-9a-f]{40}$/.test(head) ? head : 'absent'; // detached HEAD
        const ref = m[1].trim();
        try {
            return (await readFile(join(cwd, '.git', ref), 'utf-8')).trim();
        } catch {
            // Packed ref: scan .git/packed-refs for "<sha> <ref>".
            const packed = await readFile(join(cwd, '.git', 'packed-refs'), 'utf-8');
            for (const line of packed.split('\n')) {
                const [sha, name] = line.trim().split(/\s+/);
                if (name === ref && /^[0-9a-f]{40}$/.test(sha ?? '')) return sha;
            }
            return 'absent';
        }
    } catch {
        return 'absent';
    }
}

/** Sorted-by-name digest input of every discovered skill's SKILL.md.
 *  Unreadable content hashes as 'absent' — a skill dir appearing or
 *  vanishing mid-sample must change the digest, never crash. */
async function skillsDigestInput(): Promise<string> {
    let metas: Array<{ name: string; path: string }>;
    try {
        metas = discoverSkills().map((s) => ({ name: s.name, path: s.path }));
    } catch {
        return 'skills:absent';
    }
    metas.sort((a, b) => a.name.localeCompare(b.name));
    const parts: string[] = [];
    for (const meta of metas) {
        const content = await readFile(meta.path, 'utf-8')
            .catch(() => readFile(join(meta.path, 'SKILL.md'), 'utf-8'))
            .catch(() => 'absent');
        parts.push(`${meta.name}\u0000${content}`);
    }
    return parts.join('\u0000');
}

/** 12-hex digest of the effective rules + judgment documents + skills +
 *  provider:model + code SHA. Never throws: an unreadable surface hashes
 *  as 'absent' — absence is itself a fingerprintable state (deleting
 *  RULES.md mid-sample must change the digest, not crash the sampler). */
export async function strategyFingerprint(): Promise<string> {
    const [soul, rules, skills, codeSha] = await Promise.all([
        loadSoulDocument().catch(() => null),
        loadRulesDocument().catch(() => null),
        skillsDigestInput(),
        readGitHeadSha(),
    ]);
    let effectiveRules = 'absent';
    try {
        effectiveRules = JSON.stringify(getRiskRules());
    } catch { /* rules unreadable — 'absent' is the fingerprint of that state */ }
    let providerModel = 'absent';
    try {
        providerModel = `${getSetting('provider', 'absent')}:${getSetting('modelId', 'absent')}`;
    } catch { /* settings unreadable */ }
    return createHash('sha256')
        .update(effectiveRules).update('\u0000')
        .update(soul ?? 'absent').update('\u0000')
        .update(rules ?? 'absent').update('\u0000')
        .update(skills).update('\u0000')
        .update(providerModel).update('\u0000')
        .update(codeSha)
        .digest('hex')
        .slice(0, 12);
}
