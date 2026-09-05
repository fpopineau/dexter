/**
 * Shadow-variant registry v1 (REQ-SIM-004/005, live-loop WP2).
 *
 * A variant is a pure mapping from a normalised source row (a proposal or
 * a refusal with complete levels) to the bracket the simulator replays.
 * The registry is code-defined and versioned; adding a variant is an
 * observability change. None needs an extra LLM call — every variant is a
 * subset or a re-geometry of proposals the judgment layer already made.
 *
 *   incumbent          every proposal, as proposed (the as-traded twin)
 *   funnel-75          what the OLD trigger bar would have traded: trigger
 *                      rows in the '75+' band plus every non-trigger lane
 *   gate-off:<gate>    the refusal replayed as proposed — the value of one
 *                      deterministic gate, in full P&L
 *   exit-ratchet       no fixed target; arm at +x, lock x−1, trail (REQ-EXIT-008)
 *   exit-x2.0          target at clamp(2.0 × ATR%, take band) from entry
 *   stop-x/3           stop tightened to x/3 from entry
 *   class-swing / class-earnings-bet   the disabled-on-live classes
 *   weights-calibrated INACTIVE until WP3 supplies calibrated weights
 *
 * Sizing: every variant is re-derived at the CURRENT ladder rung against
 * the epoch NetLiq (sizeAtRung) so variants compare like with like; R is
 * rung-invariant, USD is informational.
 */

import type { RiskRules } from '@/tools/ibkr/risk-rules.js';
import { formulaTakePct } from '../proposal-risk-gate.js';
import type { SimSpec } from './fill-model.js';

/** Grace the stale-entry sweeper grants past a proposal's expiry. */
export const ENTRY_GRACE_MS = 30 * 60_000;
/** Deadline for a GTC entry that never filled (the 3-day zombie sweep). */
export const GTC_ENTRY_HORIZON_MS = 3 * 86_400_000;

export interface SimSource {
    kind: 'proposal' | 'refusal';
    id: string;
    symbol: string;
    direction: 'long' | 'short';
    entryType: 'LMT' | 'MKT' | 'STP_LMT';
    entry: number | null;
    entryLimit: number | null;
    stop: number;
    target: number;
    quantity: number;
    tif: 'DAY' | 'GTC';
    tradeClass: 'intraday' | 'swing' | 'earnings-bet';
    /** ET-frame ms. */
    createdAt: number;
    /** ET-frame ms; null for refusals (they use the default validity). */
    expiresAt: number | null;
    takePct: number | null;
    dailyAtr: number | null;
    triggerBand: '60-74' | '75+' | null;
    /** Proposal source lane (trigger / breadth / cron:<name> / whatsapp / agent). */
    lane: string;
    /** Refusals: the classified gate. */
    gate: string | null;
    score: number | null;
}

export interface VariantContext {
    rules: RiskRules;
    /** ET-frame ms of the flat-by-close bar for the ET day containing `createdAt`. */
    flatAtFor: (createdAt: number) => number;
}

export interface VariantDef {
    name: string;
    /** Human line for the digest. */
    description: string;
    status: 'active' | `inactive: ${string}`;
    applies: (src: SimSource) => boolean;
    /** The bracket to replay; null = this source cannot be expressed (skip). */
    spec: (src: SimSource, ctx: VariantContext) => SimSpec | null;
}

const DEFAULT_VALIDITY_MS = 120 * 60_000;

function hasLevels(src: SimSource): boolean {
    return Number.isFinite(src.stop) && src.stop > 0 && Number.isFinite(src.target) && src.target > 0
        && (src.entryType === 'MKT' || (src.entry !== null && src.entry > 0));
}

function entryDeadline(src: SimSource): number {
    if (src.tif === 'GTC') return src.createdAt + GTC_ENTRY_HORIZON_MS;
    return (src.expiresAt ?? src.createdAt + DEFAULT_VALIDITY_MS) + ENTRY_GRACE_MS;
}

function baseSpec(src: SimSource, ctx: VariantContext, overrides: Partial<SimSpec> = {}): SimSpec {
    return {
        direction: src.direction,
        entryType: src.entryType,
        entry: src.entry,
        entryLimit: src.entryLimit,
        stop: src.stop,
        target: src.target,
        createdAt: src.createdAt,
        entryDeadline: entryDeadline(src),
        flatAt: src.tif === 'GTC' ? null : ctx.flatAtFor(src.createdAt),
        ...overrides,
    };
}

/** The effective take percent x of an intraday row: the stamped take_pct,
 *  else the ATR formula; null when neither is computable. */
function effectiveX(src: SimSource, rules: RiskRules): number | null {
    if (src.takePct !== null && src.takePct > 0) return src.takePct;
    const basis = src.entry ?? null;
    if (src.dailyAtr === null || !(src.dailyAtr > 0) || basis === null || !(basis > 0)) return null;
    return formulaTakePct((src.dailyAtr / basis) * 100, rules);
}

function isIntraday(src: SimSource): boolean {
    return src.kind === 'proposal' && src.tradeClass === 'intraday';
}

const GATE_OFF_GATES = ['noise-stop', 'entry-pricing', 'chase', 'extension', 'risk-reward', 'microstructure'] as const;

export const VARIANTS_V1: readonly VariantDef[] = [
    {
        name: 'incumbent',
        description: 'every proposal as proposed — the as-traded twin (calibration line vs actual fills)',
        status: 'active',
        applies: (s) => s.kind === 'proposal' && hasLevels(s),
        spec: (s, ctx) => baseSpec(s, ctx),
    },
    {
        name: 'funnel-75',
        description: 'what the pre-2026-09-05 trigger bar would have traded: 75+ band rows + every non-trigger lane',
        status: 'active',
        applies: (s) => s.kind === 'proposal' && hasLevels(s) && (s.lane !== 'trigger' || s.triggerBand === '75+'),
        spec: (s, ctx) => baseSpec(s, ctx),
    },
    ...GATE_OFF_GATES.map((gate): VariantDef => ({
        name: `gate-off:${gate}`,
        description: `refusals of the ${gate} gate replayed as proposed — the gate's value in full P&L`,
        status: 'active',
        applies: (s) => s.kind === 'refusal' && s.gate === gate && hasLevels(s),
        spec: (s, ctx) => baseSpec(s, ctx),
    })),
    {
        name: 'exit-ratchet',
        description: 'intraday rows: no fixed target; arm at +x, lock x−1, trail pullback-mult × ATR (REQ-EXIT-008)',
        status: 'active',
        applies: (s) => isIntraday(s) && hasLevels(s),
        spec: (s, ctx) => {
            const x = effectiveX(s, ctx.rules);
            if (x === null || s.dailyAtr === null || !(s.dailyAtr > 0)) return null;
            return baseSpec(s, ctx, {
                target: null,
                ratchet: { armPct: x, lockPct: Math.max(0, x - 1), trailAbs: ctx.rules.profit_trail_pullback_atr_mult * s.dailyAtr },
            });
        },
    },
    {
        name: 'exit-x2.0',
        description: 'intraday rows: target at clamp(2.0 × ATR%, take band) from entry',
        status: 'active',
        applies: (s) => isIntraday(s) && hasLevels(s),
        spec: (s, ctx) => {
            const basis = s.entry;
            if (basis === null || s.dailyAtr === null || !(s.dailyAtr > 0)) return null;
            const atrPct = (s.dailyAtr / basis) * 100;
            const x2 = Math.min(ctx.rules.take_cap_pct, Math.max(ctx.rules.take_floor_pct, 2.0 * atrPct));
            const target = s.direction === 'long' ? basis * (1 + x2 / 100) : basis * (1 - x2 / 100);
            return baseSpec(s, ctx, { target });
        },
    },
    {
        name: 'stop-x/3',
        description: 'intraday rows: stop tightened to x/3 from entry, target unchanged (size re-derived)',
        status: 'active',
        applies: (s) => isIntraday(s) && hasLevels(s),
        spec: (s, ctx) => {
            const x = effectiveX(s, ctx.rules);
            const basis = s.entry;
            if (x === null || basis === null) return null;
            const stop = s.direction === 'long' ? basis * (1 - x / 300) : basis * (1 + x / 300);
            return baseSpec(s, ctx, { stop });
        },
    },
    {
        name: 'class-swing',
        description: 'swing-class proposals (disabled on live) — their own record, GTC carried',
        status: 'active',
        applies: (s) => s.kind === 'proposal' && s.tradeClass === 'swing' && hasLevels(s),
        spec: (s, ctx) => baseSpec(s, ctx),
    },
    {
        name: 'class-earnings-bet',
        description: 'earnings-bet proposals (disabled on live) — their own record, GTC carried',
        status: 'active',
        applies: (s) => s.kind === 'proposal' && s.tradeClass === 'earnings-bet' && hasLevels(s),
        spec: (s, ctx) => baseSpec(s, ctx),
    },
    {
        name: 'weights-calibrated',
        description: 'candidates re-ranked with calibrated scorer weights (WP3 supplies the weights)',
        status: 'inactive: awaiting calibrated weights (WP3)',
        applies: () => false,
        spec: () => null,
    },
];

export function variantByName(name: string): VariantDef | undefined {
    return VARIANTS_V1.find((v) => v.name === name);
}

export function activeVariants(): VariantDef[] {
    return VARIANTS_V1.filter((v) => v.status === 'active');
}

/** REQ-SIM-005: whole shares at the rung against the sizing base. */
export function sizeAtRung(input: { entry: number; stop: number; rungPct: number; netLiq: number }): number {
    const risk = Math.abs(input.entry - input.stop);
    if (!(risk > 0) || !(input.netLiq > 0) || !(input.rungPct > 0)) return 0;
    return Math.floor(((input.rungPct / 100) * input.netLiq) / risk);
}
