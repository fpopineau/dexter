/**
 * Daily-loss guard (kill-switch) — blocks NEW order placement once the
 * account's daily P&L breaches max_daily_loss_pct from risk-rules.yaml.
 *
 * Properties:
 *   - Latching: once tripped, the halt persists for the rest of the trading
 *     day (America/New_York date), even if P&L recovers. Stored on disk in
 *     .dexter/data/trading-halt.json so it survives restarts.
 *   - Fail-safe: if daily P&L cannot be determined (no IBKR connection,
 *     timeout), order placement is REFUSED — uncertainty never trades.
 *   - Scope: only blocks risk-increasing actions (new orders / proposal
 *     acceptance). Cancels remain allowed by callers.
 *   - Manual reset: clearTradingHalt() (exposed for deliberate operator use).
 */

import { getRiskRules } from '@/tools/ibkr/risk-rules.js';
import { allocReqId, getIBApi, getManagedAccounts, isNonFatalIbkrError } from '@/tools/ibkr/connection.js';
import { logger } from '@/utils';
import { EventName } from '@stoqey/ib';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const PNL_TIMEOUT_MS = 10_000;

interface HaltRecord {
    /** Trading date (YYYY-MM-DD, America/New_York). */
    date: string;
    reason: string;
    dailyPnL: number;
    netLiquidation: number;
    trippedAt: string;
}

function haltFilePath(): string {
    const dir = process.env.DEXTER_DATA_DIR ?? join(process.cwd(), '.dexter', 'data');
    return join(dir, 'trading-halt.json');
}

/** Current trading date in America/New_York. */
function tradingDate(): string {
    const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`;
}

function readHalt(): HaltRecord | null {
    const p = haltFilePath();
    if (!existsSync(p)) return null;
    try {
        const rec = JSON.parse(readFileSync(p, 'utf-8')) as HaltRecord;
        return rec?.date ? rec : null;
    } catch (err) {
        // FAIL CLOSED: a halt file that exists but cannot be read may be a
        // corrupted latch — treating it as "no halt" would silently unlock
        // trading on the very day the kill-switch fired.
        logger.error(`[daily-loss-guard] halt file unreadable — failing closed: ${err}`);
        return {
            date: tradingDate(),
            reason: 'halt file exists but is unreadable/corrupt — failing closed; inspect or delete trading-halt.json',
            dailyPnL: NaN,
            netLiquidation: NaN,
            trippedAt: new Date().toISOString(),
        };
    }
}

function writeHalt(rec: HaltRecord): void {
    try {
        const p = haltFilePath();
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, JSON.stringify(rec, null, 2));
    } catch (err) {
        logger.error(`[daily-loss-guard] failed to persist halt record: ${err}`);
    }
}

/** Active halt for TODAY, if any. */
export function getActiveHalt(): HaltRecord | null {
    const rec = readHalt();
    return rec && rec.date === tradingDate() ? rec : null;
}

/** Deliberate operator reset of the current halt. */
export function clearTradingHalt(): boolean {
    const rec = getActiveHalt();
    if (!rec) return false;
    writeHalt({ ...rec, date: '1970-01-01' });
    logger.warn('[daily-loss-guard] trading halt manually cleared');
    return true;
}

// ---------------------------------------------------------------------------
// NetLiquidation baseline — the PnL fallback.
//
// IBKR's reqPnL service is flaky on paper accounts (it can stop answering
// for hours while everything else works). When it fails, daily P&L is
// approximated as: current NetLiquidation − the session's baseline
// NetLiquidation (first value seen today, captured at gateway startup).
// The proxy includes overnight moves and any deposits/withdrawals — an
// acceptable, conservative-enough stand-in for a personal account.
// ---------------------------------------------------------------------------

interface NetLiqBaseline {
    /** Trading date (YYYY-MM-DD, America/New_York). */
    date: string;
    netLiq: number;
    capturedAt: string;
}

function baselinePath(): string {
    const dir = process.env.DEXTER_DATA_DIR ?? join(process.cwd(), '.dexter', 'data');
    return join(dir, 'netliq-baseline.json');
}

/** Today's baseline, or null when absent/stale. */
export function readNetLiqBaseline(): NetLiqBaseline | null {
    try {
        const p = baselinePath();
        if (!existsSync(p)) return null;
        const rec = JSON.parse(readFileSync(p, 'utf-8')) as NetLiqBaseline;
        return rec?.date === tradingDate() && Number.isFinite(rec.netLiq) ? rec : null;
    } catch {
        return null;
    }
}

/** Persist a baseline for today unless one already exists (first wins —
 *  the earliest NetLiq of the session is the reference). */
export function writeNetLiqBaselineIfAbsent(netLiq: number): NetLiqBaseline {
    const existing = readNetLiqBaseline();
    if (existing) return existing;
    const rec: NetLiqBaseline = { date: tradingDate(), netLiq, capturedAt: new Date().toISOString() };
    try {
        const p = baselinePath();
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, JSON.stringify(rec, null, 2));
        logger.info(`[daily-loss-guard] NetLiq baseline captured for ${rec.date}: ${netLiq.toFixed(0)}`);
    } catch (err) {
        logger.error(`[daily-loss-guard] failed to persist NetLiq baseline: ${err}`);
    }
    return rec;
}

/**
 * Capture the session baseline early (called at gateway startup) so the
 * PnL proxy references pre-trading equity, not a mid-day value.
 * Best-effort: failures are logged, never thrown.
 */
export async function captureNetLiqBaseline(): Promise<void> {
    try {
        const api = await getIBApi();
        const account = await detectAccount(api);
        const netLiq = await fetchNetLiquidation(api, account);
        writeNetLiqBaselineIfAbsent(netLiq);
    } catch (err) {
        logger.warn(`[daily-loss-guard] baseline capture failed (will retry on first gate check): ${err}`);
    }
}

// ---------------------------------------------------------------------------
// IBKR daily P&L + net liquidation (compact one-shot fetchers)
// ---------------------------------------------------------------------------

async function detectAccount(api: import('@stoqey/ib').IBApi): Promise<string> {
    const known = getManagedAccounts();
    if (known.length > 0) return known[0];
    return new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error('[daily-loss-guard] could not detect account'));
        }, 5_000);
        const onAccounts = (list: string) => {
            clearTimeout(timeout);
            cleanup();
            const first = list.split(',')[0]?.trim();
            if (first) resolve(first);
            else reject(new Error('[daily-loss-guard] no managed accounts'));
        };
        function cleanup() {
            api.off(EventName.managedAccounts, onAccounts);
        }
        api.on(EventName.managedAccounts, onAccounts);
        api.reqManagedAccts();
    });
}

function fetchDailyPnl(api: import('@stoqey/ib').IBApi, account: string): Promise<number> {
    const reqId = allocReqId();
    return new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => {
            try { api.cancelPnL(reqId); } catch { /* ignore */ }
            cleanup();
            reject(new Error('[daily-loss-guard] PnL request timed out'));
        }, PNL_TIMEOUT_MS);
        const onPnl = (id: number, dailyPnL: number) => {
            if (id !== reqId) return;
            clearTimeout(timeout);
            try { api.cancelPnL(reqId); } catch { /* ignore */ }
            cleanup();
            // NaN / IBKR sentinel (1.797e308) would sail through the
            // `dailyPnL <= -limit` comparison as false and silently defeat
            // the kill-switch (audit 2026-08-06, risk item 8). Fail closed.
            if (!Number.isFinite(dailyPnL) || Math.abs(dailyPnL) > 1e12) {
                reject(new Error(`[daily-loss-guard] broker returned unusable daily P&L (${dailyPnL})`));
                return;
            }
            resolve(dailyPnL);
        };
        const onError = (err: Error, code: number, id: number) => {
            if (id !== reqId && id !== -1) return;
            if (isNonFatalIbkrError(code)) return;
            clearTimeout(timeout);
            cleanup();
            reject(new Error(`[daily-loss-guard] PnL error ${code}: ${err.message}`));
        };
        function cleanup() {
            api.off(EventName.pnl, onPnl);
            api.off(EventName.error, onError);
        }
        api.on(EventName.pnl, onPnl);
        api.on(EventName.error, onError);
        api.reqPnL(reqId, account);
    });
}

function fetchNetLiquidation(api: import('@stoqey/ib').IBApi, account: string): Promise<number> {
    const reqId = allocReqId();
    return new Promise<number>((resolve, reject) => {
        let value: number | null = null;
        const timeout = setTimeout(() => {
            finish();
        }, PNL_TIMEOUT_MS);
        const onSummary = (id: number, acct: string, tag: string, val: string) => {
            if (id !== reqId) return;
            if (tag === 'NetLiquidation' && (!account || acct === account)) {
                const n = Number(val);
                // Finite is not enough: the IBKR error sentinel is finite and
                // would turn every %-of-NetLiq cap into a no-op downstream.
                if (Number.isFinite(n) && n > 0 && n < 1e12) value = n;
            }
        };
        const onEnd = (id: number) => {
            if (id !== reqId) return;
            clearTimeout(timeout);
            finish();
        };
        function finish() {
            try { api.cancelAccountSummary(reqId); } catch { /* ignore */ }
            cleanup();
            if (value !== null) resolve(value);
            else reject(new Error('[daily-loss-guard] NetLiquidation unavailable'));
        }
        function cleanup() {
            api.off(EventName.accountSummary, onSummary);
            api.off(EventName.accountSummaryEnd, onEnd);
        }
        api.on(EventName.accountSummary, onSummary);
        api.on(EventName.accountSummaryEnd, onEnd);
        api.reqAccountSummary(reqId, 'All', 'NetLiquidation');
    });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DailyLossStatus {
    halted: boolean;
    /** True when the halt is the LATCHED daily kill-switch (persists for the
     *  ET day); false when it is a fail-safe refusal because P&L could not
     *  be verified (transient — clears as soon as verification succeeds). */
    latched?: boolean;
    reason?: string;
    dailyPnL?: number;
    netLiquidation?: number;
    limitPct: number;
    limitDollars?: number;
}

/** Best-effort current NetLiquidation (null when unavailable). For
 *  REPORTING consumers (EOD triage cap usage) — order paths must keep
 *  using assertDailyLossOk, which fails safe instead of returning null. */
export async function getNetLiquidation(): Promise<number | null> {
    try {
        const api = await getIBApi();
        const account = await detectAccount(api);
        return await fetchNetLiquidation(api, account);
    } catch {
        return null;
    }
}

/**
 * Check the daily-loss state without throwing.
 * Performs live IBKR queries; on failure returns halted=true (fail-safe).
 */
export async function getDailyLossStatus(): Promise<DailyLossStatus> {
    const rules = getRiskRules();
    const limitPct = rules.max_daily_loss_pct;

    const active = getActiveHalt();
    if (active) {
        return {
            halted: true,
            latched: true,
            reason: `Trading halted since ${active.trippedAt}: ${active.reason}`,
            dailyPnL: active.dailyPnL,
            netLiquidation: active.netLiquidation,
            limitPct,
        };
    }

    // NetLiquidation is the load-bearing quantity: the limit derives from
    // it, and it doubles as the P&L fallback. If IT is unavailable, refuse.
    let netLiq: number;
    let api: import('@stoqey/ib').IBApi;
    let account: string;
    try {
        api = await getIBApi();
        account = await detectAccount(api);
        netLiq = await fetchNetLiquidation(api, account);
    } catch (err) {
        // Fail-safe: cannot verify anything → do not allow new risk.
        const reason = `daily P&L could not be verified (${err instanceof Error ? err.message : err})`;
        logger.error(`[daily-loss-guard] ${reason} — refusing new orders`);
        return { halted: true, latched: false, reason, limitPct };
    }

    // The limit anchors to the SESSION BASELINE equity (pre-trading NetLiq),
    // not the current one: deriving it from current equity shrinks the limit
    // as losses mount, counting the same loss on both sides of the
    // comparison (audit 2026-08-11). Baseline captured at gateway boot; a
    // mid-day first start anchors late — a known fallback-path limitation.
    const baseline = writeNetLiqBaselineIfAbsent(netLiq);
    const limitDollars = (limitPct / 100) * baseline.netLiq;

    // Preferred source: IBKR's own daily P&L. Known-flaky on paper
    // accounts — fall back to the NetLiq-vs-session-baseline proxy.
    let dailyPnL: number;
    let source: 'ibkr' | 'netliq-proxy';
    try {
        dailyPnL = await fetchDailyPnl(api, account);
        source = 'ibkr';
    } catch (err) {
        dailyPnL = Math.round((netLiq - baseline.netLiq) * 100) / 100;
        source = 'netliq-proxy';
        logger.warn(
            `[daily-loss-guard] reqPnL failed (${err instanceof Error ? err.message : err}) — ` +
            `using NetLiq proxy: ${netLiq.toFixed(0)} − baseline ${baseline.netLiq.toFixed(0)} = ${dailyPnL.toFixed(0)}`,
        );
    }

    if (dailyPnL <= -limitDollars) {
        const rec: HaltRecord = {
            date: tradingDate(),
            reason: `daily P&L ${dailyPnL.toFixed(0)}${source === 'netliq-proxy' ? ' (NetLiq proxy vs session baseline)' : ''} ` +
                `breached -${limitPct}% of session-baseline equity (${baseline.netLiq.toFixed(0)})`,
            dailyPnL,
            netLiquidation: netLiq,
            trippedAt: new Date().toISOString(),
        };
        writeHalt(rec);
        logger.error(`[daily-loss-guard] KILL-SWITCH TRIPPED: ${rec.reason}`);
        return { halted: true, latched: true, reason: rec.reason, dailyPnL, netLiquidation: netLiq, limitPct, limitDollars };
    }

    return { halted: false, dailyPnL, netLiquidation: netLiq, limitPct, limitDollars };
}

/**
 * Throw unless new risk-increasing orders are allowed right now.
 * Call before placing any new order or accepting a proposal.
 * Returns the (non-halted) status so callers can reuse the live account
 * numbers (net liquidation) without a second IBKR round-trip.
 */
export async function assertDailyLossOk(): Promise<DailyLossStatus> {
    const status = await getDailyLossStatus();
    if (status.halted) {
        const tail = status.latched
            ? 'The halt persists until the next trading day (or deliberate clearTradingHalt()).'
            : 'This is a FAIL-SAFE refusal (P&L verification failed), not a latched halt — ' +
              'check the IB Gateway connection and retry.';
        throw new Error(
            `[daily-loss-guard] KILL-SWITCH: new orders are blocked — ${status.reason}. ` +
            `Limit: ${status.limitPct}% of net liquidation per day. ${tail}`,
        );
    }
    return status;
}
