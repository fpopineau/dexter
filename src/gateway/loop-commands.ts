/**
 * Loop commands — the WhatsApp grammar of the live-loop control plane
 * (REQ-LIVE-003 WP1; REQ-EPOCH-001/004, REQ-LADDER-001, REQ-DIGEST-001
 * WP3). Consulted by the proposal command router AFTER its own grammar and
 * BEFORE the agent; returns null to fall through.
 *
 *   veto P-XXXX                  cancel an unfilled entry; filled → refused
 *   kill SYMBOL                  close the position at market (safe path)
 *   live status | ladder | epoch read-only state
 *   ladder up [confirm]          apply the queued step-up (two-step)
 *   epoch new [carry] [confirm]  start the next epoch (two-step while one runs)
 *   promote <variant> [confirm]  record a ratified promotion (two-step)
 *   digest                       today's loop digest on demand
 *   live on                      the 6-character challenge + evidence (WP4)
 *   live on <token>              confirm within 2 min → switch ON + journal
 *   live off                     immediate OFF + journal
 */

import { epochStatusLine, killPosition, ladderStatusLine, vetoProposal } from '@/services/loop-control.js';

export interface LoopCommandCore {
    veto: (id: string) => Promise<{ ok: boolean; message: string }>;
    kill: (symbol: string) => Promise<{ ok: boolean; message: string }>;
    liveStatus: () => Promise<string>;
    ladderStatus: () => Promise<string>;
    epochStatus: () => Promise<string>;
    ladderUp: (confirm: boolean) => Promise<string>;
    epochNew: (carry: boolean, confirm: boolean) => Promise<string>;
    promote: (variant: string, confirm: boolean) => Promise<string>;
    digest: () => Promise<string>;
    /** REQ-LIVE-004: null token = request the challenge; a token = confirm. */
    liveOn: (token: string | null) => Promise<string>;
    liveOff: () => Promise<string>;
}

const defaultCore: LoopCommandCore = {
    veto: vetoProposal,
    kill: killPosition,
    liveStatus: async () => (await liveSwitch()).status(),
    ladderStatus: async () => ladderStatusLine(),
    epochStatus: async () => epochStatusLine(),
    ladderUp: async (confirm) => (await operator()).ladderUp(confirm),
    epochNew: async (carry, confirm) => (await operator()).epochNew(carry, confirm),
    promote: async (variant, confirm) => (await operator()).promote(variant, confirm),
    digest: async () => (await operator()).digest(),
    liveOn: async (token) => {
        const c = await liveSwitch();
        return (token === null ? c.requestOn() : c.confirmOn(token)).message;
    },
    liveOff: async () => (await liveSwitch()).off().message,
};

async function operator() {
    const { liveLoopOperator } = await import('@/services/loop/operator.js');
    return liveLoopOperator();
}

async function liveSwitch() {
    const { liveLiveSwitchControl } = await import('@/services/loop/live-switch-control.js');
    return liveLiveSwitchControl();
}

const VETO_RE = /^\s*veto\s+(P-[A-Za-z0-9]{4})\s*$/i;
const KILL_RE = /^\s*kill\s+([A-Za-z.]{1,6})\s*$/i;
const LIVE_RE = /^\s*live\s+(on|off|status)(?:\s+(\S+))?\s*$/i;
const LADDER_RE = /^\s*ladder(?:\s+(up)(?:\s+(confirm))?)?\s*$/i;
const EPOCH_RE = /^\s*epoch(?:\s+(new)(?:\s+(carry))?(?:\s+(confirm))?)?\s*$/i;
const PROMOTE_RE = /^\s*promote\s+([^\s]+)(?:\s+(confirm))?\s*$/i;
const DIGEST_RE = /^\s*digest\s*$/i;

/**
 * Try to handle `body` as a loop command. Returns the reply, or null when
 * the message is not a loop command (fall through to the agent).
 */
export async function handleLoopCommand(body: string, core: LoopCommandCore = defaultCore): Promise<string | null> {
    const veto = VETO_RE.exec(body);
    if (veto) return (await core.veto(veto[1].toUpperCase())).message;

    const kill = KILL_RE.exec(body);
    if (kill) return (await core.kill(kill[1].toUpperCase())).message;

    const live = LIVE_RE.exec(body);
    if (live) {
        const verb = live[1].toLowerCase();
        if (verb === 'status') return core.liveStatus();
        if (verb === 'off') return core.liveOff();
        return core.liveOn(live[2] ?? null);
    }

    const ladder = LADDER_RE.exec(body);
    if (ladder) {
        if (ladder[1]) return core.ladderUp(ladder[2] !== undefined);
        return core.ladderStatus();
    }

    const epoch = EPOCH_RE.exec(body);
    if (epoch) {
        if (epoch[1]) return core.epochNew(epoch[2] !== undefined, epoch[3] !== undefined);
        return core.epochStatus();
    }

    const promote = PROMOTE_RE.exec(body);
    if (promote) return core.promote(promote[1], promote[2] !== undefined);

    if (DIGEST_RE.test(body)) return core.digest();

    return null;
}
