/**
 * LLM spend meter and daily cap (REQ-LLM-001/002, live-loop WP1).
 *
 * The widened funnel (bar 60, 30 triggers/day) triples evaluations; the cap
 * is the cost guard. Every agent run's accumulated token usage is metered
 * per ET day and per lane (trigger / breadth / mover / cron:<name> /
 * whatsapp / …) into `llm-spend.json`, priced with the operator's two
 * per-million-token knobs. Once the day's USD reaches the cap, EVALUATION
 * lanes refuse to START a run (one refusal row per refused trigger, gate
 * 'spend-cap'); a run already in flight finishes. Deterministic services
 * (exits, triage, guardian, sweepers, replay) never call the LLM and are
 * outside the meter by construction.
 *
 * Config discipline (WP0.1 pattern): a cap > 0 with missing prices is a
 * boot error — a silent $0 price would make the cap a no-op.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from '@/utils';

export interface SpendPrices {
    inUsdPerMtok: number;
    outUsdPerMtok: number;
}

export interface LaneSpend {
    runs: number;
    inputTokens: number;
    outputTokens: number;
    usd: number;
}

export interface SpendLedger {
    /** ET calendar day the ledger covers. */
    date: string;
    totalUsd: number;
    byLane: Record<string, LaneSpend>;
}

export type SpendVerdict = { ok: true } | { ok: false; reason: string };

export class SpendCapError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SpendCapError';
    }
}

type Env = Record<string, string | undefined>;

export const DEFAULT_DAILY_SPEND_CAP_USD = 10;

export function dailySpendCapUsd(env: Env = process.env): number {
    const raw = env.LLM_DAILY_SPEND_CAP_USD;
    if (raw === undefined || raw.trim() === '') return DEFAULT_DAILY_SPEND_CAP_USD;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DAILY_SPEND_CAP_USD;
}

/** Both prices as positive numbers, else null (the cap cannot bill). */
export function readSpendPrices(env: Env = process.env): SpendPrices | null {
    const inP = Number(env.LLM_PRICE_IN_USD_PER_MTOK);
    const outP = Number(env.LLM_PRICE_OUT_USD_PER_MTOK);
    if (!Number.isFinite(inP) || !(inP > 0) || !Number.isFinite(outP) || !(outP > 0)) return null;
    return { inUsdPerMtok: inP, outUsdPerMtok: outP };
}

/** Boot check: a live cap needs prices. Throws with the knob names. */
export function assertSpendConfig(env: Env = process.env): void {
    const cap = dailySpendCapUsd(env);
    if (cap <= 0) return;
    if (readSpendPrices(env) === null) {
        throw new Error(
            `[llm-spend] LLM_DAILY_SPEND_CAP_USD=${cap} requires LLM_PRICE_IN_USD_PER_MTOK and LLM_PRICE_OUT_USD_PER_MTOK ` +
            `(positive USD per million tokens) — set both, or set LLM_DAILY_SPEND_CAP_USD=0 to disable the cap`,
        );
    }
}

export function priceUsd(usage: { inputTokens: number; outputTokens: number }, prices: SpendPrices): number {
    const inTok = Number.isFinite(usage.inputTokens) ? Math.max(0, usage.inputTokens) : 0;
    const outTok = Number.isFinite(usage.outputTokens) ? Math.max(0, usage.outputTokens) : 0;
    return (inTok / 1e6) * prices.inUsdPerMtok + (outTok / 1e6) * prices.outUsdPerMtok;
}

/** Lanes whose runs are DISCOVERY/evaluation and may be refused at the
 *  cap. Operator-facing lanes (whatsapp, tui, agent) are never refused —
 *  a human asking a question is not the cost the cap exists to bound. */
export function isEvaluationLane(lane: string | null | undefined): boolean {
    if (!lane) return false;
    return lane === 'trigger' || lane === 'breadth' || lane === 'mover' || lane.startsWith('cron:');
}

export function etToday(now: Date = new Date()): string {
    return now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/** Pure: the ledger for `today` — the same object when the date matches,
 *  a fresh empty ledger otherwise (yesterday is not carried). */
export function rollLedger(ledger: SpendLedger | null, today: string): SpendLedger {
    if (ledger && ledger.date === today) return ledger;
    return { date: today, totalUsd: 0, byLane: {} };
}

/** Pure: add one run's usage under `lane`. */
export function addUsage(
    ledger: SpendLedger,
    lane: string,
    usage: { inputTokens: number; outputTokens: number },
    prices: SpendPrices,
): SpendLedger {
    const usd = priceUsd(usage, prices);
    const prev = ledger.byLane[lane] ?? { runs: 0, inputTokens: 0, outputTokens: 0, usd: 0 };
    return {
        date: ledger.date,
        totalUsd: ledger.totalUsd + usd,
        byLane: {
            ...ledger.byLane,
            [lane]: {
                runs: prev.runs + 1,
                inputTokens: prev.inputTokens + Math.max(0, usage.inputTokens || 0),
                outputTokens: prev.outputTokens + Math.max(0, usage.outputTokens || 0),
                usd: prev.usd + usd,
            },
        },
    };
}

/** Pure: may a run on `lane` start? */
export function spendVerdict(input: { lane: string | null; ledger: SpendLedger | null; capUsd: number }): SpendVerdict {
    if (input.capUsd <= 0) return { ok: true };
    if (!isEvaluationLane(input.lane)) return { ok: true };
    const spent = input.ledger?.totalUsd ?? 0;
    if (spent < input.capUsd) return { ok: true };
    return {
        ok: false,
        reason: `spend cap: today's LLM spend $${spent.toFixed(2)} has reached LLM_DAILY_SPEND_CAP_USD $${input.capUsd.toFixed(2)} — ` +
            `evaluation lane '${input.lane}' refused to start (exits, triage and the guardian are unaffected)`,
    };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function spendLedgerPath(dataDir = process.env.DEXTER_DATA_DIR ?? join(process.cwd(), '.dexter', 'data')): string {
    return join(dataDir, 'llm-spend.json');
}

export function readSpendLedger(dataDir?: string): SpendLedger | null {
    const p = spendLedgerPath(dataDir);
    if (!existsSync(p)) return null;
    try {
        const raw = JSON.parse(readFileSync(p, 'utf-8')) as Partial<SpendLedger>;
        if (!raw || typeof raw.date !== 'string' || typeof raw.totalUsd !== 'number' || typeof raw.byLane !== 'object' || raw.byLane === null) return null;
        return { date: raw.date, totalUsd: raw.totalUsd, byLane: raw.byLane as Record<string, LaneSpend> };
    } catch {
        return null;
    }
}

export function writeSpendLedger(dataDir: string | undefined, ledger: SpendLedger): void {
    const p = spendLedgerPath(dataDir);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, typeof ledger === 'string' ? ledger : JSON.stringify(ledger, null, 2));
}

/** Meter one finished run. Never throws — a metering failure must not
 *  fail the run it measures; it is logged. Without prices nothing can be
 *  billed, so the ledger still counts tokens at $0 (the boot check makes
 *  that configuration impossible while a cap is active). */
export function recordLlmUsage(
    lane: string | null,
    usage: { inputTokens: number; outputTokens: number } | undefined,
    opts: { prices?: SpendPrices | null; dataDir?: string; today?: string } = {},
): void {
    if (!usage) return;
    try {
        const prices = opts.prices === undefined ? readSpendPrices() : opts.prices;
        const ledger = rollLedger(readSpendLedger(opts.dataDir), opts.today ?? etToday());
        const next = addUsage(ledger, lane ?? 'agent', usage, prices ?? { inUsdPerMtok: 0, outUsdPerMtok: 0 });
        writeSpendLedger(opts.dataDir, next);
    } catch (err) {
        logger.warn(`[llm-spend] metering failed: ${err instanceof Error ? err.message : err}`);
    }
}

/** Gate for the agent runner: throws SpendCapError when the lane may not
 *  start under today's ledger. */
export function assertEvaluationAllowed(lane: string | null, opts: { dataDir?: string; today?: string; env?: Env } = {}): void {
    const ledger = rollLedger(readSpendLedger(opts.dataDir), opts.today ?? etToday());
    const v = spendVerdict({ lane, ledger, capUsd: dailySpendCapUsd(opts.env) });
    if (!v.ok) throw new SpendCapError(v.reason);
}
