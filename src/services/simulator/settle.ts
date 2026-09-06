/**
 * Nightly simulator settle (REQ-SIM-001/005/006, live-loop WP2).
 *
 * For every proposal created inside the lookback (any status, production
 * lanes only) and every refusal with complete levels, and for every
 * ACTIVE variant that applies: build the bracket, load covered bars,
 * replay it with the pessimistic fill model, size it at the current ladder
 * rung against the epoch NetLiq, and write ONE row per (variant, source).
 * A row that already settled is never re-simulated; an OPEN GTC row is
 * re-settled every night until it exits or its horizon expires; a DAY row
 * whose flat-by-close bar is still in the future waits for tomorrow.
 *
 * No covered bar source → the row is 'unknown' (recorded, never a
 * fabricated fill). Any per-source failure is isolated and counted.
 *
 * Deterministic and dependency-injected: the harness drives it with fake
 * ledgers, fake bars and a fake store; the live wiring (index.ts) supplies
 * the real ones plus the single-flight run stamp.
 */

import type { RiskRules } from '@/tools/ibkr/risk-rules.js';
import { logger } from '@/utils';
import { laneExitDeadline } from '../lane-contract.js';
import { etFrameMs } from '../outcome-tracker.js';
import { triggerBand, type RefusalRecord, type TradeProposal } from '../trade-proposals.js';
import { DEFAULT_MAX_GAP_MS, frameToEpochMs, type SimBarSource } from './bars.js';
import { commissionsFor, netR, simulateBracket, type CommissionConfig, type SimBar, type SimSpec } from './fill-model.js';
import type { SettleRunCounts } from './report.js';
import type { SimTrade } from './store.js';
import { activeVariants, type SimSource, type VariantContext } from './variants.js';

const DAY_MS = 86_400_000;
/** Open GTC rows stop being re-settled after this many calendar days. */
export const GTC_HORIZON_DAYS = 28;
/** The flat-by-close mark: the EOD triage slot. */
const FLAT_MIN_FULL = 15 * 60 + 52;
const FLAT_MIN_HALF = 12 * 60 + 52;
export const BIAS_NOTE = 'pessimistic: trade-through fills, stop-first ties, gap-aware stops, MKT at next open';

const KNOWN_LANES = ['trigger', 'breadth', 'agent', 'tui', 'whatsapp', 'chase-continuation'];
const isProductionLane = (s: string) => KNOWN_LANES.includes(s) || s.startsWith('cron:');

/** Pure: ET-frame ms of the flat-by-close bar on the ET day of `frameMs`. */
export function flatAtFrameFor(frameMs: number, halfDay: boolean): number {
    const dayStart = Math.floor(frameMs / DAY_MS) * DAY_MS;
    return dayStart + (halfDay ? FLAT_MIN_HALF : FLAT_MIN_FULL) * 60_000;
}

export function sourceFromProposal(p: TradeProposal): SimSource | null {
    if (!isProductionLane(p.source)) return null;
    return {
        kind: 'proposal',
        id: p.id,
        symbol: p.symbol.toUpperCase(),
        direction: p.direction,
        entryType: p.entryType,
        entry: p.entry,
        entryLimit: p.entryLimit,
        stop: p.stop,
        target: p.target,
        quantity: p.quantity,
        tif: p.tif,
        tradeClass: p.tradeClass,
        strategyId: p.strategyId,
        createdAt: etFrameMs(p.createdAt),
        expiresAt: etFrameMs(p.expiresAt),
        executedAt: p.executedAt === null ? null : etFrameMs(p.executedAt),
        takePct: p.takePct,
        dailyAtr: p.dailyAtrAtCreation,
        triggerBand: p.triggerBand,
        lane: p.source,
        gate: null,
        score: p.score,
    };
}

/** The gate a refusal feeds: the classified gate, with the microstructure
 *  gate recognised from its reason (the classifier files it under 'other'). */
function refusalGate(r: RefusalRecord): string {
    if (/microstructure-gate/i.test(r.reason)) return 'microstructure';
    return r.gate;
}

export function sourceFromRefusal(r: RefusalRecord): SimSource | null {
    if (r.entryType !== 'LMT' && r.entryType !== 'MKT' && r.entryType !== 'STP_LMT') return null;
    if (r.stop === null || r.target === null || !(r.stop > 0) || !(r.target > 0)) return null;
    if (r.entryType !== 'MKT' && (r.entry === null || !(r.entry > 0))) return null;
    return {
        kind: 'refusal',
        id: `R-${r.id}`,
        symbol: r.symbol.toUpperCase(),
        direction: r.direction,
        entryType: r.entryType,
        entry: r.entry,
        entryLimit: r.entryLimit,
        stop: r.stop,
        target: r.target,
        quantity: r.quantity ?? 0,
        tif: 'DAY',
        tradeClass: 'intraday',
        strategyId: null,
        createdAt: etFrameMs(r.createdAt),
        expiresAt: null,
        executedAt: null,
        takePct: null,
        dailyAtr: null,
        triggerBand: triggerBand(r.triggerRank),
        lane: 'refusal',
        gate: refusalGate(r),
        score: r.score,
    };
}

export interface SettleStore {
    find(variant: string, kind: 'proposal' | 'refusal', sourceId: string): Promise<SimTrade | null>;
    upsert(row: SimTrade): Promise<void>;
    listOpen(): Promise<SimTrade[]>;
}

export interface SettleDeps {
    /** Epoch ms. */
    now: number;
    lookbackMs: number;
    listProposalsSince(sinceMs: number): Promise<TradeProposal[]>;
    listRefusalsSince(sinceMs: number): Promise<RefusalRecord[]>;
    loadBars(symbol: string, fromT: number, toT: number, opts: { rth: boolean; halfDay: boolean }): Promise<{ bars: SimBar[]; source: SimBarSource } | null>;
    store: SettleStore;
    rules: RiskRules;
    rungPct: number;
    netLiq: number;
    commissions: CommissionConfig;
    isHalfDay(dateIso: string): boolean;
}

function etIsoOfFrame(frameMs: number): string {
    return new Date(frameMs).toISOString().slice(0, 10);
}

/** Pure: whole shares at the rung (mirrors variants.sizeAtRung; local copy
 *  avoids a cycle when settle is driven without the registry). */
function sizeAt(entry: number, stop: number, rungPct: number, netLiq: number): number {
    const risk = Math.abs(entry - stop);
    if (!(risk > 0) || !(netLiq > 0) || !(rungPct > 0)) return 0;
    return Math.floor(((rungPct / 100) * netLiq) / risk);
}

async function settleOne(
    src: SimSource,
    variant: { name: string; spec: (s: SimSource, ctx: VariantContext) => SimSpec | null },
    ctx: VariantContext,
    deps: SettleDeps,
    counts: SettleRunCounts,
    existing: SimTrade | null,
): Promise<void> {
    const nowFrame = etFrameMs(deps.now);
    const spec = variant.spec(src, ctx);
    if (!spec) { counts.skipped++; return; }
    // A DAY row whose flat bar has not happened yet cannot settle tonight;
    // one created AT or AFTER its flat bar (post-cutoff, expired unfilled by
    // policy) has no window to replay. A GTC row (review 2026-09-06, finding
    // 4) carries its LANE deadline as flatAt: it replays up to tonight and
    // stays 'open' until it exits or the deadline bar arrives.
    if (spec.flatAt !== null && src.createdAt >= spec.flatAt) { counts.skipped++; return; }
    if (spec.flatAt !== null && src.tif === 'DAY' && spec.flatAt > nowFrame) { counts.skipped++; return; }
    counts.evaluated++;

    // The bar window ends at the creation-anchored deadline (or tonight) —
    // never later than the mandatory exit, so an overnight twin out at
    // 10:00 does not need the afternoon's bars (third pass, finding 4). A
    // fill-anchored deadline LATER than that (swing / cup filled on a later
    // session) extends the window in a second load below.
    const horizonEnd = spec.flatAt !== null ? Math.min(spec.flatAt, nowFrame) : nowFrame;
    const halfDay = deps.isHalfDay(etIsoOfFrame(src.createdAt));
    // WP7 (REQ-SIM-003 amended): regular-session bars for EVERY row — the
    // brackets never set outsideRth, so a GTC stop cannot fill after hours;
    // coverage is judged per session segment, the overnight gap is no hole.
    let loaded = await deps.loadBars(src.symbol, src.createdAt, horizonEnd, { rth: true, halfDay });
    const basisEntry = spec.entry ?? null;
    const quantity = basisEntry !== null ? sizeAt(basisEntry, spec.stop, deps.rungPct, deps.netLiq) : 0;
    const base: SimTrade = {
        variant: variant.name,
        sourceKind: src.kind,
        sourceId: src.id,
        symbol: src.symbol,
        direction: src.direction,
        tradeClass: src.tradeClass,
        entryType: src.entryType,
        entry: spec.entry,
        entryLimit: spec.entryLimit,
        stop: spec.stop,
        target: spec.target,
        quantity,
        tif: src.tif,
        strategyId: src.strategyId,
        createdAt: deps.now - (nowFrame - src.createdAt), // back to epoch ms (same offset as now)
        executedAt: src.executedAt === null ? null : deps.now - (nowFrame - src.executedAt),
        expiresAt: src.expiresAt === null ? null : deps.now - (nowFrame - src.expiresAt),
        barSource: loaded?.source ?? null,
        fillAt: null, fillPrice: null, exitAt: null, exitPrice: null,
        outcome: 'unknown',
        commissions: null, netUsd: null, netR: null,
        status: 'unknown',
        biasNote: BIAS_NOTE,
        settledAt: deps.now,
        horizonDays: (existing?.horizonDays ?? 0) + 1,
        note: null,
    };
    if (!loaded) {
        counts.unknown++;
        await deps.store.upsert({ ...base, note: 'no covered bar source (stream/archive/IBKR) for the window' });
        return;
    }
    // Fill-anchored lane deadline for GTC rows (second pass, finding 5): a
    // probe pass finds the fill, the lane deadline is recomputed from it (the
    // real row stamps its deadline at first fill), then the row is replayed
    // with that flatAt. Unfilled → the probe result stands.
    let finalSpec = spec;
    if (src.tif === 'GTC' && spec.flatAt !== null) {
        const probe = simulateBracket(loaded.bars, { ...spec, flatAt: null });
        if (probe.fillAt !== null) {
            const anchored = ctx.laneFlatAtFor(src.strategyId, src.tradeClass, probe.fillAt);
            if (anchored !== null && anchored !== spec.flatAt) {
                finalSpec = { ...spec, flatAt: anchored };
                // A later deadline needs more bars (up to tonight); a load
                // that fails leaves the first bars — the row then reads
                // 'open' and settles another night, never a fabricated exit.
                if (anchored > horizonEnd) {
                    const extended = await deps.loadBars(src.symbol, src.createdAt, Math.min(anchored, nowFrame), { rth: true, halfDay });
                    if (extended) loaded = extended;
                }
            }
        }
    }
    const r = simulateBracket(loaded.bars, finalSpec);
    const row: SimTrade = { ...base, barSource: loaded.source, fillAt: r.fillAt, fillPrice: r.fillPrice, exitAt: r.exitAt, exitPrice: r.exitPrice, outcome: r.outcome, note: r.note ?? null };
    // A patient entry whose window is still open tonight is PENDING, not
    // unfilled (third pass, finding 2): the bars ran out before the entry
    // deadline — the row stays open and replays tomorrow.
    if (r.outcome === 'unfilled' && finalSpec.entryDeadline > nowFrame) {
        counts.open++;
        await deps.store.upsert({ ...row, status: 'open', note: 'entry not yet filled — window still open' });
        return;
    }
    if (r.outcome === 'open') {
        if (base.horizonDays * 1 >= GTC_HORIZON_DAYS || src.createdAt < nowFrame - GTC_HORIZON_DAYS * DAY_MS) {
            counts.unknown++;
            await deps.store.upsert({ ...row, outcome: 'unknown', status: 'unknown', note: `horizon expired after ${GTC_HORIZON_DAYS} days still open` });
            return;
        }
        counts.open++;
        await deps.store.upsert({ ...row, status: 'open' });
        return;
    }
    if (r.outcome === 'unknown') {
        counts.unknown++;
        await deps.store.upsert({ ...row, status: 'unknown' });
        return;
    }
    if (r.outcome === 'unfilled' || r.fillPrice === null || quantity <= 0) {
        counts.settled++;
        await deps.store.upsert({
            ...row, status: 'settled', commissions: 0, netUsd: 0, netR: null,
            note: quantity <= 0 && r.outcome !== 'unfilled' ? 'unaffordable at the rung (0 shares)' : row.note,
        });
        return;
    }
    const sides = r.exitPrice !== null ? 2 : 1;
    const commissions = commissionsFor(quantity, sides, deps.commissions);
    const sign = src.direction === 'long' ? 1 : -1;
    const gross = r.exitPrice !== null ? (r.exitPrice - r.fillPrice) * quantity * sign : 0;
    const netUsd = Math.round((gross - commissions) * 100) / 100;
    counts.settled++;
    await deps.store.upsert({
        ...row,
        status: 'settled',
        commissions,
        netUsd,
        netR: netR({ netUsd, entry: basisEntry ?? r.fillPrice, stop: spec.stop, quantity }),
    });
}

export async function runSettleOnce(depsIn: SettleDeps): Promise<SettleRunCounts> {
    const counts: SettleRunCounts = { sources: 0, evaluated: 0, settled: 0, open: 0, unknown: 0, skipped: 0, failed: 0 };
    // One bar load per (symbol, window, session) per run: several variants
    // replay the same source over the same window, and the IBKR fallback
    // is paced — reloading per variant would multiply requests by five.
    const barMemo = new Map<string, Promise<Awaited<ReturnType<SettleDeps['loadBars']>>>>();
    const deps: SettleDeps = {
        ...depsIn,
        loadBars: (symbol, fromT, toT, opts) => {
            const key = `${symbol}|${fromT}|${toT}|${opts.rth}|${opts.halfDay}`;
            let p = barMemo.get(key);
            if (!p) {
                p = depsIn.loadBars(symbol, fromT, toT, opts);
                barMemo.set(key, p);
            }
            return p;
        },
    };
    const since = deps.now - deps.lookbackMs;
    const ctx: VariantContext = {
        rules: deps.rules,
        flatAtFor: (createdAt) => flatAtFrameFor(createdAt, deps.isHalfDay(etIsoOfFrame(createdAt))),
        // Review 2026-09-06 (finding 4): EVERY GTC twin exits at its lane's
        // deadline like the sweeper closes the real row — overnight at 10:00
        // ET next session, swing / cup after their hold days. A legacy row
        // (no lane) takes its class's lane. The variant anchors it on the
        // creation (a lower bound); settleOne re-anchors it on the simulated
        // FILL like the real row (second pass, finding 5).
        laneFlatAtFor: (strategyId, tradeClass, anchorFrame) => {
            const lane = strategyId ?? (tradeClass === 'swing' ? 'swing' : tradeClass === 'earnings-bet' ? 'earnings-bet' : 'intraday');
            const deadline = laneExitDeadline(lane, frameToEpochMs(anchorFrame), deps.rules);
            return deadline === null ? null : etFrameMs(deadline);
        },
    };
    const variants = activeVariants();

    const sources: SimSource[] = [];
    for (const p of await deps.listProposalsSince(since)) {
        const s = sourceFromProposal(p);
        if (s) sources.push(s);
    }
    for (const r of await deps.listRefusalsSince(since)) {
        const s = sourceFromRefusal(r);
        if (s) sources.push(s);
    }
    // Open rows older than the lookback still need their nightly pass: the
    // store row carries enough to rebuild the source. The INCUMBENT row is
    // preferred (it carries the as-proposed levels — a variant row carries
    // its own re-geometry), and the lane comes from the persisted
    // `strategyId` so every variant rebuilds the SAME contract (third pass,
    // finding 3); rows written before the column fall back to the variant
    // name, then the class.
    const allOpen = await deps.store.listOpen();
    const openRows = [...allOpen].sort((a, b) => Number(b.variant === 'incumbent') - Number(a.variant === 'incumbent'));
    const seen = new Set(sources.map((s) => `${s.kind}|${s.id}`));
    for (const o of openRows) {
        if (seen.has(`${o.sourceKind}|${o.sourceId}`)) continue;
        seen.add(`${o.sourceKind}|${o.sourceId}`);
        // The lane is a property of the SOURCE: any open row of the same
        // source that carries it (persisted column, or a lane variant's name
        // on rows written before the column) names it for all — fourth pass,
        // finding 2: the incumbent's class alone is not the lane.
        const group = allOpen.filter((r) => r.sourceKind === o.sourceKind && r.sourceId === o.sourceId);
        const fromColumn = group.find((r) => r.strategyId)?.strategyId ?? null;
        const fromVariant = group.some((r) => r.variant === 'lane-overnight') ? 'overnight'
            : group.some((r) => r.variant === 'lane-cup-and-handle') ? 'cup-and-handle' : null;
        const strategyId: SimSource['strategyId'] = fromColumn ?? fromVariant
            ?? (o.tradeClass === 'swing' ? 'swing' : o.tradeClass === 'earnings-bet' ? 'earnings-bet' : 'intraday');
        sources.push({
            kind: o.sourceKind, id: o.sourceId, symbol: o.symbol, direction: o.direction, entryType: o.entryType, entry: o.entry,
            entryLimit: o.entryLimit, stop: o.stop, target: o.target ?? o.stop, quantity: o.quantity, tif: o.tif, tradeClass: o.tradeClass, strategyId,
            // The real entry window survives the rebuild (fifth pass): the
            // acceptance and expiry are persisted on the row; rows written
            // before those columns count from creation, as before.
            createdAt: etFrameMs(o.createdAt),
            expiresAt: o.expiresAt == null ? null : etFrameMs(o.expiresAt),
            executedAt: o.executedAt == null ? null : etFrameMs(o.executedAt),
            takePct: null, dailyAtr: null, triggerBand: null, lane: 'reopened', gate: null, score: null,
        });
    }
    counts.sources = sources.length;

    for (const src of sources) {
        for (const v of variants) {
            if (!v.applies(src)) continue;
            try {
                const existing = await deps.store.find(v.name, src.kind, src.id);
                if (existing && existing.status !== 'open') { counts.skipped++; continue; }
                await settleOne(src, v, ctx, deps, counts, existing);
            } catch (err) {
                counts.failed++;
                logger.warn(`[simulator] ${v.name} ${src.id} ${src.symbol}: settle failed — ${err instanceof Error ? err.message : err}`);
            }
        }
    }
    return counts;
}

export { DEFAULT_MAX_GAP_MS };
