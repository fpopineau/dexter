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
import { requestAccountSummary } from '@/tools/ibkr/account-summary.js';
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
    /** Currency the record's figures are denominated in (the guard's
     *  internal math is BASE currency, WP8). Absent = USD (records
     *  predating 2026-08-26, and USD-base accounts). */
    currency?: string;
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

// In-memory latch mirror: the file is the durable latch, but a failed write
// must not mean NO latch — without this, an unrealized-P&L recovery later in
// the day would recompute below the limit and silently reopen trading on a
// day the kill-switch fired (audit 2026-08-06 finding 7, closed 2026-08-20).
// Process-lifetime only: a restart with an unwritable data dir still loses
// the latch — that residual window is accepted and documented.
let memoryHalt: HaltRecord | null = null;

function writeHalt(rec: HaltRecord): void {
    // Mirror unconditionally (also on manual clear, which writes an epoch
    // date) so memory and file can never disagree within this process.
    memoryHalt = rec;
    try {
        const p = haltFilePath();
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, JSON.stringify(rec, null, 2));
    } catch (err) {
        logger.error(`[daily-loss-guard] failed to persist halt record — latched in memory for this process: ${err}`);
    }
}

/** Active halt for TODAY, if any. */
export function getActiveHalt(): HaltRecord | null {
    const rec = readHalt();
    if (rec && rec.date === tradingDate()) return rec;
    // File says no halt (missing or unwritable earlier) — the memory mirror
    // still latches today. The mirror also holds a manual clear, so a
    // cleared halt does not resurrect from memory.
    if (memoryHalt && memoryHalt.date === tradingDate()) return memoryHalt;
    return null;
}

/** Test hook: forget process-lifetime latches (memory mirrors only). */
export function __resetMemoryLatchesForTests(): void {
    memoryHalt = null;
    memoryBaseline = null;
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

// Memory mirror for the baseline, same rationale as memoryHalt: if the file
// write fails, re-capturing the CURRENT (already-degraded) NetLiq as the new
// baseline on the next call would reset the P&L proxy to ~0 and could keep
// the kill-switch from ever tripping (audit 2026-08-20).
let memoryBaseline: NetLiqBaseline | null = null;

/** Today's baseline, or null when absent/stale. */
export function readNetLiqBaseline(): NetLiqBaseline | null {
    try {
        const p = baselinePath();
        if (existsSync(p)) {
            const rec = JSON.parse(readFileSync(p, 'utf-8')) as NetLiqBaseline;
            if (rec?.date === tradingDate() && Number.isFinite(rec.netLiq)) return rec;
        }
    } catch {
        // fall through to the memory mirror
    }
    if (memoryBaseline?.date === tradingDate() && Number.isFinite(memoryBaseline.netLiq)) {
        return memoryBaseline;
    }
    return null;
}

/** Persist a baseline for today unless one already exists (first wins —
 *  the earliest NetLiq of the session is the reference). */
export function writeNetLiqBaselineIfAbsent(netLiq: number): NetLiqBaseline {
    const existing = readNetLiqBaseline();
    if (existing) return existing;
    const rec: NetLiqBaseline = { date: tradingDate(), netLiq, capturedAt: new Date().toISOString() };
    memoryBaseline = rec;
    try {
        const p = baselinePath();
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, JSON.stringify(rec, null, 2));
        logger.info(`[daily-loss-guard] NetLiq baseline captured for ${rec.date}: ${netLiq.toFixed(0)}`);
    } catch (err) {
        logger.error(`[daily-loss-guard] failed to persist NetLiq baseline — held in memory for this process: ${err}`);
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
        // Baseline stays BASE currency (WP8): the P&L proxy subtracts it
        // from base NetLiq — mixing units here would fabricate daily P&L.
        const { value } = await fetchNetLiquidation(api, account);
        writeNetLiqBaselineIfAbsent(value);
    } catch (err) {
        logger.warn(`[daily-loss-guard] baseline capture failed (will retry on first gate check): ${err}`);
    }
}

/** Deliberate operator re-anchor of TODAY's baseline at current equity
 *  (base currency). Exists for exactly one situation: an out-of-band
 *  account change (deposit/withdrawal/paper resize) made the session
 *  baseline factually wrong, so the daily-loss proxy measures the
 *  administrative change as a "loss" (2026-08-26: a €10K resize read as
 *  −15% and latched a false halt; clearing the latch without re-anchoring
 *  would re-trip on the next gate check). Returns the new base-currency
 *  baseline, or null when equity is unreadable (nothing overwritten). */
export async function reanchorNetLiqBaseline(): Promise<number | null> {
    try {
        const api = await getIBApi();
        const account = await detectAccount(api);
        const { value } = await fetchNetLiquidation(api, account);
        if (!(value > 0)) return null;
        const rec: NetLiqBaseline = { date: tradingDate(), netLiq: value, capturedAt: new Date().toISOString() };
        writeFileSync(baselinePath(), JSON.stringify(rec, null, 2));
        memoryBaseline = rec;
        logger.warn(`[daily-loss-guard] baseline RE-ANCHORED by operator at ${value.toFixed(2)} (base currency) for ${rec.date}`);
        return value;
    } catch (err) {
        logger.warn(`[daily-loss-guard] baseline re-anchor failed: ${err}`);
        return null;
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

/** Base-currency NetLiquidation WITH its currency tag (WP8 — the tag was
 *  discarded before, which is how EUR ran through USD cap math). */
async function fetchNetLiquidation(
    api: import('@stoqey/ib').IBApi,
    account: string,
): Promise<{ value: number; currency: string }> {
    // Leak fix 2026-09-03: the subscription lifecycle now lives in the
    // shared requester (single-flight + exactly-once cancel) — this
    // function only interprets the rows. The guard polls every ~60 s and
    // used to open its own subscription each time, overlapping the
    // dashboard's and the sampler's until IBKR's cap answered 322.
    const rows = await requestAccountSummary(api, 'NetLiquidation', PNL_TIMEOUT_MS);
    let value: number | null = null;
    let currency = 'USD';
    for (const r of rows) {
        if (r.tag !== 'NetLiquidation') continue;
        if (account && r.account !== account) continue;
        const n = Number(r.value);
        // Finite is not enough: the IBKR error sentinel is finite and
        // would turn every %-of-NetLiq cap into a no-op downstream.
        if (Number.isFinite(n) && n > 0 && n < 1e12) {
            value = n;
            if (typeof r.currency === 'string' && r.currency.trim()) currency = r.currency.trim().toUpperCase();
        }
    }
    if (value === null) throw new Error('[daily-loss-guard] NetLiquidation unavailable');
    return { value, currency };
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
        const { value, currency } = await fetchNetLiquidation(api, account);
        // WP8: consumers of this number do USD arithmetic — convert at the
        // boundary. Unavailable rate → null (reporting callers warn loudly).
        const { convertToUsd } = await import('@/tools/ibkr/fx.js');
        return await convertToUsd(value, currency);
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
        // Currency audit 2026-08-26: the trip record's numbers are BASE
        // currency (the guard's internal math is deliberately base, WP8)
        // — echoing them here made the halted dashboard read "€10,589
        // labeled $" while the epoch said $12,347. Convert for DISPLAY;
        // an unavailable rate degrades to undefined (dashboard hides the
        // figure) rather than showing a mislabeled one. The latch itself
        // is untouched.
        // The record CARRIES its currency (absent = USD, no lookup needed
        // — also keeps this branch broker-free for latch tests and dead
        // connections; a latched status must never block on IBKR).
        let netLiqUsd: number | undefined =
            Number.isFinite(active.netLiquidation) ? active.netLiquidation : undefined;
        let dailyPnLUsd: number | undefined =
            Number.isFinite(active.dailyPnL) ? active.dailyPnL : undefined;
        if (active.currency && active.currency !== 'USD') {
            try {
                const { convertToUsd } = await import('@/tools/ibkr/fx.js');
                if (netLiqUsd !== undefined) netLiqUsd = await convertToUsd(netLiqUsd, active.currency);
                if (dailyPnLUsd !== undefined) dailyPnLUsd = await convertToUsd(dailyPnLUsd, active.currency);
            } catch {
                // Rate unavailable: hide rather than mislabel.
                netLiqUsd = undefined;
                dailyPnLUsd = undefined;
            }
        }
        return {
            halted: true,
            latched: true,
            reason: `Trading halted since ${active.trippedAt}: ${active.reason}`,
            dailyPnL: dailyPnLUsd,
            netLiquidation: netLiqUsd,
            limitPct,
        };
    }

    // NetLiquidation is the load-bearing quantity: the limit derives from
    // it, and it doubles as the P&L fallback. If IT is unavailable, refuse.
    // WP8: the internal halt math stays in BASE currency (reqPnL and the
    // session baseline are base too — internally consistent); only the
    // EXPORTED netLiquidation converts to USD below, because it feeds the
    // gate caps and the position sizer, which are USD arithmetic.
    let netLiq: number;
    let netLiqCurrency: string;
    let api: import('@stoqey/ib').IBApi;
    let account: string;
    try {
        api = await getIBApi();
        account = await detectAccount(api);
        ({ value: netLiq, currency: netLiqCurrency } = await fetchNetLiquidation(api, account));
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
            currency: netLiqCurrency,
        };
        writeHalt(rec);
        logger.error(`[daily-loss-guard] KILL-SWITCH TRIPPED: ${rec.reason}`);
        return { halted: true, latched: true, reason: rec.reason, dailyPnL, netLiquidation: netLiq, limitPct, limitDollars };
    }

    // WP8: the exported figure is USD — this is what the gate caps, the
    // position sizer and the headroom math consume. A non-USD base with no
    // FX rate refuses fail-safe: a cap computed in the wrong currency is
    // worse than a refused accept (transient — retries when FX is back).
    let netLiqUsd: number;
    let dailyPnLUsd: number;
    let limitDollarsUsd: number;
    try {
        const { convertToUsd } = await import('@/tools/ibkr/fx.js');
        netLiqUsd = await convertToUsd(netLiq, netLiqCurrency);
        // Currency audit 2026-08-26: dailyPnL and limitDollars exported RAW
        // base currency next to a converted netLiquidation — 'halt status'
        // printed a € limit with $ framing. The internal halt math above
        // stays base-consistent (WP8); only the EXPORTS convert. (The
        // just-tripped return above still carries base figures for one
        // status call; the next call reads the latch record, which
        // converts from its stored currency tag.)
        dailyPnLUsd = await convertToUsd(dailyPnL, netLiqCurrency);
        limitDollarsUsd = await convertToUsd(limitDollars, netLiqCurrency);
    } catch (err) {
        const reason = `NetLiquidation is in ${netLiqCurrency} and the FX rate is unavailable (${err instanceof Error ? err.message : err})`;
        logger.error(`[daily-loss-guard] ${reason} — refusing new orders`);
        return { halted: true, latched: false, reason, limitPct };
    }

    return { halted: false, dailyPnL: dailyPnLUsd, netLiquidation: netLiqUsd, limitPct, limitDollars: limitDollarsUsd };
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
