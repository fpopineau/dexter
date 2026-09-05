/**
 * Loop commands — the WhatsApp grammar of the live-loop control plane
 * (REQ-LIVE-003, live-loop WP1). Consulted by the proposal command router
 * AFTER its own grammar and BEFORE the agent; returns null to fall through.
 *
 *   veto P-XXXX          cancel an unfilled entry (open → rejected;
 *                        executed-unfilled → bracket cancel); filled → refused
 *   kill SYMBOL          close the position at market (safe close path)
 *   live status | ladder | epoch    read-only state (WP1)
 *   live on|off, ladder up, epoch new, promote <variant>
 *                        recognised, answered "not available until WP3/WP4"
 *                        — the producers land there; the grammar seam is
 *                        what WP1 must ship so those WPs stay outside the
 *                        behavior paths.
 */

import { epochStatusLine, killPosition, ladderStatusLine, liveStatusLine, vetoProposal } from '@/services/loop-control.js';

export interface LoopCommandCore {
    veto: (id: string) => Promise<{ ok: boolean; message: string }>;
    kill: (symbol: string) => Promise<{ ok: boolean; message: string }>;
    liveStatus: () => Promise<string>;
    ladderStatus: () => Promise<string>;
    epochStatus: () => Promise<string>;
}

const defaultCore: LoopCommandCore = {
    veto: vetoProposal,
    kill: killPosition,
    liveStatus: async () => liveStatusLine(),
    ladderStatus: async () => ladderStatusLine(),
    epochStatus: async () => epochStatusLine(),
};

const VETO_RE = /^\s*veto\s+(P-[A-Za-z0-9]{4})\s*$/i;
const KILL_RE = /^\s*kill\s+([A-Za-z.]{1,6})\s*$/i;
const LIVE_RE = /^\s*live\s+(on|off|status)(?:\s+(\S+))?\s*$/i;
const LADDER_RE = /^\s*ladder(?:\s+(up))?\s*$/i;
const EPOCH_RE = /^\s*epoch(?:\s+(new))?\s*$/i;
const PROMOTE_RE = /^\s*promote\s+(\S+)\s*$/i;

const NOT_YET_WP4 = (what: string) => `ℹ️ '${what}' is not available until WP4 (live-automation producers). The switch is structurally OFF today.`;
const NOT_YET_WP3 = (what: string) => `ℹ️ '${what}' is not available until WP3 (sequential test, ladder and epoch machinery).`;

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
        if (ladder[1]) return NOT_YET_WP3('ladder up');
        return core.ladderStatus();
    }

    const epoch = EPOCH_RE.exec(body);
    if (epoch) {
        if (epoch[1]) return NOT_YET_WP3('epoch new');
        return core.epochStatus();
    }

    const promote = PROMOTE_RE.exec(body);
    if (promote) return NOT_YET_WP3(`promote ${promote[1]}`);

    return null;
}
