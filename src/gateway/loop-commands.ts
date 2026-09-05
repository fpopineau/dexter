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
 *   live on|off                  WP4 (the switch writer) — named, not silent
 */

import { epochStatusLine, killPosition, ladderStatusLine, liveStatusLine, vetoProposal } from '@/services/loop-control.js';

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
}

const defaultCore: LoopCommandCore = {
    veto: vetoProposal,
    kill: killPosition,
    liveStatus: async () => liveStatusLine(),
    ladderStatus: async () => ladderStatusLine(),
    epochStatus: async () => epochStatusLine(),
    ladderUp: async (confirm) => (await operator()).ladderUp(confirm),
    epochNew: async (carry, confirm) => (await operator()).epochNew(carry, confirm),
    promote: async (variant, confirm) => (await operator()).promote(variant, confirm),
    digest: async () => (await operator()).digest(),
};

async function operator() {
    const { liveLoopOperator } = await import('@/services/loop/operator.js');
    return liveLoopOperator();
}

const VETO_RE = /^\s*veto\s+(P-[A-Za-z0-9]{4})\s*$/i;
const KILL_RE = /^\s*kill\s+([A-Za-z.]{1,6})\s*$/i;
const LIVE_RE = /^\s*live\s+(on|off|status)(?:\s+(\S+))?\s*$/i;
const LADDER_RE = /^\s*ladder(?:\s+(up)(?:\s+(confirm))?)?\s*$/i;
const EPOCH_RE = /^\s*epoch(?:\s+(new)(?:\s+(carry))?(?:\s+(confirm))?)?\s*$/i;
const PROMOTE_RE = /^\s*promote\s+([^\s]+)(?:\s+(confirm))?\s*$/i;
const DIGEST_RE = /^\s*digest\s*$/i;

const NOT_YET_WP4 = (what: string) => `ℹ️ '${what}' is not available until WP4 (live-automation producers). The switch is structurally OFF today.`;

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
        return NOT_YET_WP4(`live ${verb}`);
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
