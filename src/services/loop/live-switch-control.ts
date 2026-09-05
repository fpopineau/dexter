/**
 * Live switch — the WRITER (REQ-LIVE-004/005, live-loop WP4). The reader
 * (`live-switch.ts`) is a behavior path the auto-exec verdict consults;
 * this module is the operator's only way to turn it ON:
 *
 *   live on            → a 6-character challenge with the evidence the
 *                        operator is acting on (epoch, last look, ACCEPT,
 *                        rung, account kind, cold arm, profile, veto window)
 *   live on <token>    → within 2 minutes: `enabled: true` (by operator,
 *                        reason, changedAt) + a journal line
 *   live off           → immediate `enabled: false` + a journal line
 *
 * Nothing in the system ever writes `true` — the only `true` writer is
 * `confirmOn`, reached from the operator's confirmed message (WhatsApp or
 * the dashboard button, same function). The system's own OFF on an epoch
 * stop lives in epoch-control (`writeLiveSwitchOff`).
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { liveSwitchPath, readLiveSwitch, type LiveSwitchState } from '../live-switch.js';
import { readLadderState, BOTTOM_RUNG } from '../ladder-state.js';
import { readEpochRecord } from './epoch-control.js';

export const CHALLENGE_TTL_MS = 2 * 60_000;
/** Unambiguous alphabet (no 0/O, 1/I). */
const TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function makeToken(): string {
    const bytes = randomBytes(6);
    let out = '';
    for (let i = 0; i < 6; i++) out += TOKEN_ALPHABET[bytes[i] % TOKEN_ALPHABET.length];
    return out;
}

export interface LiveSwitchContext {
    /** As the running process sees it. */
    accountKind: 'paper' | 'live' | 'unverified';
    allowLiveEnv: boolean;
    profile: 'paper' | 'live';
    vetoWindowMin: number;
}

export interface LiveSwitchDeps {
    now: () => number;
    dataDir?: string;
    journal: (line: string) => void;
    context: () => LiveSwitchContext;
    token?: () => string;
}

export interface LiveSwitchControl {
    requestOn: () => { ok: boolean; message: string };
    confirmOn: (token: string) => { ok: boolean; message: string };
    off: (reason?: string) => { ok: boolean; message: string };
    status: () => string;
}

function writeSwitch(state: LiveSwitchState, dataDir?: string): void {
    const p = liveSwitchPath(dataDir);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(state, null, 2));
}

/** REQ-LIVE-005: the evidence the operator acts on. */
export function evidenceLines(dataDir: string | undefined, ctx: LiveSwitchContext): string[] {
    const rec = readEpochRecord(dataDir);
    const rung = readLadderState(dataDir)?.rung ?? BOTTOM_RUNG;
    const lines: string[] = [];
    if (!rec) {
        lines.push("epoch: NONE started — no look evidence exists ('epoch new' opens epoch 1).");
    } else {
        const last = rec.looks.length ? rec.looks[rec.looks.length - 1] : null;
        lines.push(`epoch ${rec.id}: ${rec.status.toUpperCase()}${rec.stopReason ? ` — ${rec.stopReason}` : ''} (fp ${rec.fingerprint || '?'}, since ${new Date(rec.startedAt).toISOString().slice(0, 10)})`);
        lines.push(last
            ? `last look n=${last.n}: ${last.decision} (LCB ${last.lcb?.toFixed(3) ?? '—'}, UCB95 ${last.ucb95?.toFixed(3) ?? '—'}, net R ${last.sumR.toFixed(2)}, PF ${Number.isFinite(last.profitFactor) ? last.profitFactor.toFixed(2) : '∞'})`
            : 'no look evaluated yet (first at n=25)');
        lines.push(rec.firstAcceptAt
            ? `ACCEPT recorded ${new Date(rec.firstAcceptAt).toISOString().slice(0, 10)} — the pre-registered cutover evidence is in hand.`
            : 'NO ACCEPT look recorded — the pre-registered cutover evidence is NOT in hand (the switch is your call; the evidence is displayed).');
    }
    lines.push(`rung ${rung}% · account ${ctx.accountKind.toUpperCase()} · IBKR_ALLOW_LIVE ${ctx.allowLiveEnv ? 'true' : 'NOT true (cold arm off — live auto-execution stays refused)'} · profile ${ctx.profile} · veto window ${ctx.vetoWindowMin} min`);
    if (ctx.accountKind !== 'live') lines.push('note: this gateway is not on a live account — the switch has no effect until it connects to one (port 4001).');
    return lines;
}

export function createLiveSwitchControl(deps: LiveSwitchDeps): LiveSwitchControl {
    let pending: { token: string; expiresAt: number } | null = null;
    const gen = deps.token ?? makeToken;

    return {
        requestOn() {
            const ctx = deps.context();
            pending = { token: gen(), expiresAt: deps.now() + CHALLENGE_TTL_MS };
            const current = readLiveSwitch(deps.dataDir);
            return {
                ok: true,
                message: [
                    `🔐 LIVE SWITCH — ${current?.enabled ? 'already ON' : 'currently OFF'}. Evidence:`,
                    ...evidenceLines(deps.dataDir, ctx).map((l) => `• ${l}`),
                    `To turn live auto-execution ON reply 'live on ${pending.token}' within ${CHALLENGE_TTL_MS / 60_000} minutes. Then 'epoch new' (no carry — the live cutover restarts at rung 0.25%).`,
                ].join('\n'),
            };
        },

        confirmOn(tokenRaw) {
            const token = tokenRaw.trim().toUpperCase();
            if (!pending) return { ok: false, message: "⛔ no live challenge pending — send 'live on' first." };
            if (deps.now() > pending.expiresAt) {
                pending = null;
                return { ok: false, message: `⛔ the live challenge EXPIRED (${CHALLENGE_TTL_MS / 60_000}-min window) — send 'live on' again.` };
            }
            if (token !== pending.token) {
                return { ok: false, message: '⛔ token mismatch — the switch stays OFF. Re-type the token from the challenge (still valid until it expires).' };
            }
            pending = null;
            const ctx = deps.context();
            const rec = readEpochRecord(deps.dataDir);
            const last = rec?.looks.length ? rec.looks[rec.looks.length - 1] : null;
            const at = new Date(deps.now()).toISOString();
            writeSwitch({ enabled: true, changedAt: at, by: 'operator', reason: 'live on (challenge confirmed)' }, deps.dataDir);
            deps.journal(`LIVE SWITCH ON by operator ${at} — ${rec ? `${rec.id} ${rec.status}, ${last ? `last look n=${last.n} ${last.decision}` : 'no look yet'}${rec.firstAcceptAt ? ', ACCEPT recorded' : ', NO ACCEPT recorded'}` : 'no epoch'}; account ${ctx.accountKind}, IBKR_ALLOW_LIVE ${ctx.allowLiveEnv}`);
            return {
                ok: true,
                message: [
                    `✅ LIVE SWITCH ON (${at}).`,
                    'Live auto-execution now fires when every other condition holds (IBKR_ALLOW_LIVE, verified live account, live profile, running epoch, no halt).',
                    "Next: 'epoch new' to open the live epoch at rung 0.25%. 'live off' turns it back off at once; 'veto P-XXXX' / 'kill SYM' remain your per-trade controls.",
                ].join('\n'),
            };
        },

        off(reason) {
            pending = null;
            const at = new Date(deps.now()).toISOString();
            const prev = readLiveSwitch(deps.dataDir);
            writeSwitch({ enabled: false, changedAt: at, by: 'operator', reason: reason ?? 'live off' }, deps.dataDir);
            deps.journal(`LIVE SWITCH OFF by operator ${at}${reason ? ` — ${reason}` : ''}`);
            return { ok: true, message: `🛑 LIVE SWITCH OFF (${at})${prev?.enabled ? '' : ' — it was already off'}. Live auto-execution is refused; working orders and exits are untouched ('cancel'/'kill' for those).` };
        },

        status() {
            const ctx = deps.context();
            const s = readLiveSwitch(deps.dataDir);
            const line = !s
                ? 'live switch: OFF (no state file — live auto-execution structurally off)'
                : `live switch: ${s.enabled ? 'ON' : 'OFF'}${s.changedAt ? ` since ${s.changedAt}` : ''}${s.by ? ` by ${s.by}` : ''}${s.reason ? ` — ${s.reason}` : ''}`;
            return [line, ...evidenceLines(deps.dataDir, ctx).slice(-2)].join('\n');
        },
    };
}

let live: LiveSwitchControl | null = null;

/** The gateway's control, bound to the running process (lazy imports keep
 *  the broker layer out of unit tests). */
export async function liveLiveSwitchControl(): Promise<LiveSwitchControl> {
    if (live) return live;
    const [{ getManagedAccounts, isLivePort }, { getAccountProfile }, { liveVetoWindowMin }, { appendJournalLine }] = await Promise.all([
        import('@/tools/ibkr/connection.js'),
        import('@/tools/ibkr/risk-rules.js'),
        import('../proposal-executor.js'),
        import('./journal.js'),
    ]);
    live = createLiveSwitchControl({
        now: Date.now,
        journal: (line) => { appendJournalLine(line); },
        context: () => {
            const accounts = getManagedAccounts();
            const accountKind: LiveSwitchContext['accountKind'] = accounts.length === 0
                ? (isLivePort() ? 'live' : 'unverified')
                : accounts.some((a) => !a.toUpperCase().startsWith('D')) || isLivePort() ? 'live' : 'paper';
            return {
                accountKind,
                allowLiveEnv: (process.env.IBKR_ALLOW_LIVE ?? '').trim().toLowerCase() === 'true',
                profile: getAccountProfile(),
                vetoWindowMin: liveVetoWindowMin(),
            };
        },
    });
    return live;
}
