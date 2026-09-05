/**
 * Nightly loop runner (live-loop WP3) — the tail of the nightly pipeline
 * (settle → LOOKS → DIGEST), also the `digest` command and `/api/loop`.
 * Wires the live ledgers into the pure looks and digest builders and
 * delivers the digest / alerts through callbacks (outcome-alerts bridges
 * them to WhatsApp). Observability + control plane only.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '@/utils';
import { readEquitySeries } from '../equity-series.js';
import { readSpendLedger } from '../llm-spend.js';
import { getSnapshotSymbolsSince } from '../opportunity-engine.js';
import { listSimTrades } from '../simulator/store.js';
import { etDayStartMs, listProposals, listRefusalsSince } from '../trade-proposals.js';
import { buildDigest, formatDigestWhatsApp, type LoopDigest } from './digest.js';
import { appendJournalLine } from './journal.js';
import { loadEpochSample } from './sample.js';
import { runNightlyLooks, type LoopStatus } from './looks.js';

import { emitLoopAlert, emitLoopDigest } from './alerts.js';

export { onLoopAlert, onLoopDigest } from './alerts.js';

function dataDir(): string {
    return process.env.DEXTER_DATA_DIR ?? join(process.cwd(), '.dexter', 'data');
}

/** The EOD triage run stamp says 'failed' for today (an unresolved anomaly). */
export function triageFailedToday(today: string, dir = dataDir()): boolean {
    try {
        const p = join(dir, 'eod-triage-run.json');
        if (!existsSync(p)) return false;
        const s = JSON.parse(readFileSync(p, 'utf-8')) as { date?: string; status?: string };
        return s.date === today && s.status === 'failed';
    } catch {
        return false;
    }
}

function loadTriggerEventsToday(dayStartMs: number, dir = dataDir()): { single: number; breadth: number } {
    try {
        const p = join(dir, 'trigger-events.json');
        if (!existsSync(p)) return { single: 0, breadth: 0 };
        const events = JSON.parse(readFileSync(p, 'utf-8')) as Array<{ at: number; kind: string }>;
        const today = events.filter((e) => e.at >= dayStartMs);
        return { single: today.filter((e) => e.kind === 'single').length, breadth: today.filter((e) => e.kind === 'breadth').length };
    } catch {
        return { single: 0, breadth: 0 };
    }
}

export function etToday(now = Date.now()): string {
    return new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/** Run the looks with the live ledgers. */
export async function runLooksLive(now = Date.now()): Promise<LoopStatus> {
    const today = etToday(now);
    return runNightlyLooks({
        now,
        loadSample: loadEpochSample,
        listSimRows: (sinceMs) => listSimTrades({ sinceMs }),
        equitySeries: readEquitySeries,
        triageFailedToday: () => triageFailedToday(today),
        journal: (line) => { appendJournalLine(line); },
        alert: emitLoopAlert,
    });
}

/** Build today's digest from the live ledgers (looks included). */
export async function buildLoopDigestLive(now = Date.now()): Promise<{ status: LoopStatus; digest: LoopDigest }> {
    const status = await runLooksLive(now);
    const today = etToday(now);
    const dayStart = etDayStartMs(now);
    const proposals = (await listProposals(undefined, 500)).filter((p) => p.createdAt >= dayStart || (p.entryFilledAt ?? 0) >= dayStart || (p.closedAt ?? 0) >= dayStart);
    const refusals = await listRefusalsSince(dayStart).catch(() => []);
    const scanned = await getSnapshotSymbolsSince(dayStart).catch(() => [] as string[]);
    const twinRows = await listSimTrades({ sinceMs: dayStart - 86_400_000, variant: 'incumbent' }).catch(() => []);
    const twins = new Map(twinRows.filter((r) => r.sourceKind === 'proposal').map((r) => [r.sourceId, r]));
    const digest = buildDigest({
        today,
        dayStartMs: dayStart,
        status,
        proposalsToday: proposals,
        refusalsToday: refusals,
        triggersToday: loadTriggerEventsToday(dayStart),
        scannedToday: scanned.length,
        spend: readSpendLedger(),
        twins,
    });
    return { status, digest };
}

let lastDigest: { at: number; status: LoopStatus; digest: LoopDigest } | null = null;

/** The nightly pipeline tail: looks → digest → delivery. Never throws. */
export async function runLoopNightly(): Promise<void> {
    try {
        const { status, digest } = await buildLoopDigestLive();
        lastDigest = { at: Date.now(), status, digest };
        const message = formatDigestWhatsApp(digest);
        logger.info(`[loop] nightly: ${status.epoch ? `${status.epoch.id} ${status.epoch.status}` : 'no epoch'}, n ${status.sample?.n ?? 0}, looks this pass ${status.looksThisPass.map((l) => `${l.lookN}:${l.decision}`).join(',') || 'none'}`);
        await emitLoopDigest(message);
    } catch (err) {
        logger.error(`[loop] nightly looks/digest FAILED: ${err instanceof Error ? err.message : err}`);
        emitLoopAlert(`⚠️ Loop nightly looks/digest FAILED — ${err instanceof Error ? err.message : err}`);
    }
}

/** `/api/loop`: the last nightly result, or a fresh build (cached 60 s). */
export async function loopStatusForApi(): Promise<{ at: number; status: LoopStatus; digest: LoopDigest }> {
    if (lastDigest && Date.now() - lastDigest.at < 60_000) return lastDigest;
    const { status, digest } = await buildLoopDigestLive();
    lastDigest = { at: Date.now(), status, digest };
    return lastDigest;
}
