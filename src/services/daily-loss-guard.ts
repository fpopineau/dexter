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

import { getRiskRules } from '@/tools/ibkr/risk-manager.js';
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
    try {
        const p = haltFilePath();
        if (!existsSync(p)) return null;
        const rec = JSON.parse(readFileSync(p, 'utf-8')) as HaltRecord;
        return rec?.date ? rec : null;
    } catch {
        return null;
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
                if (Number.isFinite(n)) value = n;
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
    reason?: string;
    dailyPnL?: number;
    netLiquidation?: number;
    limitPct: number;
    limitDollars?: number;
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
            reason: `Trading halted since ${active.trippedAt}: ${active.reason}`,
            dailyPnL: active.dailyPnL,
            netLiquidation: active.netLiquidation,
            limitPct,
        };
    }

    try {
        const api = await getIBApi();
        const account = await detectAccount(api);
        const [dailyPnL, netLiq] = await Promise.all([
            fetchDailyPnl(api, account),
            fetchNetLiquidation(api, account),
        ]);
        const limitDollars = (limitPct / 100) * netLiq;

        if (dailyPnL <= -limitDollars) {
            const rec: HaltRecord = {
                date: tradingDate(),
                reason: `daily P&L ${dailyPnL.toFixed(0)} breached -${limitPct}% of net liquidation (${netLiq.toFixed(0)})`,
                dailyPnL,
                netLiquidation: netLiq,
                trippedAt: new Date().toISOString(),
            };
            writeHalt(rec);
            logger.error(`[daily-loss-guard] KILL-SWITCH TRIPPED: ${rec.reason}`);
            return { halted: true, reason: rec.reason, dailyPnL, netLiquidation: netLiq, limitPct, limitDollars };
        }

        return { halted: false, dailyPnL, netLiquidation: netLiq, limitPct, limitDollars };
    } catch (err) {
        // Fail-safe: cannot verify → do not allow new risk.
        const reason = `daily P&L could not be verified (${err instanceof Error ? err.message : err})`;
        logger.error(`[daily-loss-guard] ${reason} — refusing new orders`);
        return { halted: true, reason, limitPct };
    }
}

/**
 * Throw unless new risk-increasing orders are allowed right now.
 * Call before placing any new order or accepting a proposal.
 */
export async function assertDailyLossOk(): Promise<void> {
    const status = await getDailyLossStatus();
    if (status.halted) {
        throw new Error(
            `[daily-loss-guard] KILL-SWITCH: new orders are blocked — ${status.reason}. ` +
            `Limit: ${status.limitPct}% of net liquidation per day. ` +
            `The halt persists until the next trading day (or deliberate clearTradingHalt()).`,
        );
    }
}
