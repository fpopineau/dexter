/**
 * IBKR Account tool — positions, P&L, buying power, margin, and portfolio.
 *
 * Three actions:
 * - summary: account balances, margin, buying power
 * - positions: current holdings with cost basis and P&L
 * - pnl: real-time daily P&L (realized + unrealized)
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import type { Contract } from '@stoqey/ib';
import { EventName } from '@stoqey/ib';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { allocReqId, getIBApi } from './connection.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ACCOUNT_TIMEOUT_MS = 10_000;

/** Account summary tags we request — covers the most useful fields. */
const SUMMARY_TAGS = [
    'NetLiquidation',
    'TotalCashValue',
    'GrossPositionValue',
    'BuyingPower',
    'AvailableFunds',
    'ExcessLiquidity',
    'InitMarginReq',
    'MaintMarginReq',
    'FullInitMarginReq',
    'FullMaintMarginReq',
    'UnrealizedPnL',
    'RealizedPnL',
].join(',');

// ---------------------------------------------------------------------------
// Descriptions
// ---------------------------------------------------------------------------

export const IBKR_ACCOUNT_DESCRIPTION = `
Query Interactive Brokers account information. Three actions available:

**summary** — Account balances: net liquidation value, cash, buying power,
  margin requirements, unrealized/realized P&L. Optionally specify an account code.

**positions** — All current holdings across all accounts. Returns symbol, quantity,
  average cost, market price, market value, and unrealized P&L per position.

**pnl** — Real-time daily P&L for the account (daily, unrealized, realized).
  Optionally specify an account code.

Requires a running TWS or IB Gateway connection.
`.trim();

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SummarySchema = z.object({
    action: z.literal('summary'),
    account: z.string().optional().describe('Account code (e.g. "U1234567"). Omit to use default/first account.'),
});

const PositionsSchema = z.object({
    action: z.literal('positions'),
});

const PnlSchema = z.object({
    action: z.literal('pnl'),
    account: z.string().optional().describe('Account code. Omit to use default/first account.'),
});

const AccountSchema = z.discriminatedUnion('action', [
    SummarySchema,
    PositionsSchema,
    PnlSchema,
]);

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createIbkrAccount() {
    return new DynamicStructuredTool({
        name: 'ibkr_account',
        description: 'Query IBKR account info: balances/margin (summary), holdings (positions), or daily P&L (pnl).',
        schema: AccountSchema,
        func: async (input) => {
            const api = await getIBApi();

            switch (input.action) {
                case 'summary':
                    return getAccountSummary(api, input.account);
                case 'positions':
                    return getPositions(api);
                case 'pnl':
                    return getAccountPnl(api, input.account);
            }
        },
    });
}

// ---------------------------------------------------------------------------
// Account Summary
// ---------------------------------------------------------------------------

interface SummaryEntry {
    tag: string;
    value: string;
    currency: string;
}

async function getAccountSummary(
    api: import('@stoqey/ib').IBApi,
    accountCode?: string,
): Promise<string> {
    const reqId = allocReqId();
    const entries: SummaryEntry[] = [];
    let detectedAccount = '';

    return new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
            api.cancelAccountSummary(reqId);
            cleanup();
            resolve(formatToolResult({ account: detectedAccount, entries, partial: true }));
        }, ACCOUNT_TIMEOUT_MS);

        const onAccountSummary = (
            id: number,
            account: string,
            tag: string,
            value: string,
            currency: string,
        ) => {
            if (id !== reqId) return;
            if (accountCode && account !== accountCode) return;
            detectedAccount = account;
            entries.push({ tag, value, currency });
        };

        const onAccountSummaryEnd = (id: number) => {
            if (id !== reqId) return;
            clearTimeout(timeout);
            api.cancelAccountSummary(reqId);
            cleanup();

            // Convert to a friendlier object
            const summary: Record<string, string | number> = { account: detectedAccount };
            for (const e of entries) {
                const num = Number(e.value);
                summary[e.tag] = Number.isNaN(num) ? e.value : num;
            }

            resolve(formatToolResult(summary));
        };

        const onError = (err: Error, code: number, id: number) => {
            if (id !== reqId && id !== -1) return;
            clearTimeout(timeout);
            api.cancelAccountSummary(reqId);
            cleanup();
            reject(new Error(`[IBKR] Account summary error ${code}: ${err.message}`));
        };

        function cleanup() {
            api.off(EventName.accountSummary, onAccountSummary);
            api.off(EventName.accountSummaryEnd, onAccountSummaryEnd);
            api.off(EventName.error, onError);
        }

        api.on(EventName.accountSummary, onAccountSummary);
        api.on(EventName.accountSummaryEnd, onAccountSummaryEnd);
        api.on(EventName.error, onError);

        api.reqAccountSummary(reqId, 'All', SUMMARY_TAGS);
    });
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

interface PositionEntry {
    account: string;
    symbol: string;
    secType: string;
    exchange: string;
    currency: string;
    quantity: number;
    avgCost: number;
}

async function getPositions(api: import('@stoqey/ib').IBApi): Promise<string> {
    const positions: PositionEntry[] = [];

    return new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
            api.cancelPositions();
            cleanup();
            resolve(formatToolResult({ positionCount: positions.length, positions, partial: true }));
        }, ACCOUNT_TIMEOUT_MS);

        const onPosition = (
            account: string,
            contract: Contract,
            pos: number,
            avgCost?: number,
        ) => {
            // Skip zero-quantity ghost positions
            if (pos === 0) return;
            positions.push({
                account,
                symbol: contract.symbol ?? '',
                secType: contract.secType ?? '',
                exchange: contract.exchange ?? contract.primaryExch ?? '',
                currency: contract.currency ?? '',
                quantity: pos,
                avgCost: avgCost ?? 0,
            });
        };

        const onPositionEnd = () => {
            clearTimeout(timeout);
            api.cancelPositions();
            cleanup();
            resolve(
                formatToolResult({
                    positionCount: positions.length,
                    positions,
                }),
            );
        };

        const onError = (err: Error, code: number, id: number) => {
            if (id !== -1) return;
            clearTimeout(timeout);
            api.cancelPositions();
            cleanup();
            reject(new Error(`[IBKR] Positions error ${code}: ${err.message}`));
        };

        function cleanup() {
            api.off(EventName.position, onPosition);
            api.off(EventName.positionEnd, onPositionEnd);
            api.off(EventName.error, onError);
        }

        api.on(EventName.position, onPosition);
        api.on(EventName.positionEnd, onPositionEnd);
        api.on(EventName.error, onError);

        api.reqPositions();
    });
}

// ---------------------------------------------------------------------------
// Daily P&L
// ---------------------------------------------------------------------------

async function getAccountPnl(
    api: import('@stoqey/ib').IBApi,
    accountCode?: string,
): Promise<string> {
    const reqId = allocReqId();

    // If no account specified, try to detect it
    const account = accountCode ?? await detectAccount(api);

    return new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
            api.cancelPnL(reqId);
            cleanup();
            reject(new Error('[IBKR] PnL request timed out'));
        }, ACCOUNT_TIMEOUT_MS);

        const onPnl = (
            id: number,
            dailyPnL: number,
            unrealizedPnL?: number,
            realizedPnL?: number,
        ) => {
            if (id !== reqId) return;
            clearTimeout(timeout);
            api.cancelPnL(reqId);
            cleanup();
            resolve(
                formatToolResult({
                    account,
                    dailyPnL,
                    unrealizedPnL: unrealizedPnL ?? 0,
                    realizedPnL: realizedPnL ?? 0,
                }),
            );
        };

        const onError = (err: Error, code: number, id: number) => {
            if (id !== reqId && id !== -1) return;
            clearTimeout(timeout);
            api.cancelPnL(reqId);
            cleanup();
            reject(new Error(`[IBKR] PnL error ${code}: ${err.message}`));
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

// ---------------------------------------------------------------------------
// Account detection helper
// ---------------------------------------------------------------------------

function detectAccount(api: import('@stoqey/ib').IBApi): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error('[IBKR] Could not detect account code. Please specify account explicitly.'));
        }, 5_000);

        const onManagedAccounts = (accountsList: string) => {
            clearTimeout(timeout);
            cleanup();
            // accountsList is comma-separated, take the first one
            const first = accountsList.split(',')[0]?.trim();
            if (first) {
                resolve(first);
            } else {
                reject(new Error('[IBKR] No managed accounts found.'));
            }
        };

        const onError = (err: Error, code: number) => {
            if (code === -1) {
                clearTimeout(timeout);
                cleanup();
                reject(new Error(`[IBKR] Account detection error: ${err.message}`));
            }
        };

        function cleanup() {
            api.off(EventName.managedAccounts, onManagedAccounts);
            api.off(EventName.error, onError);
        }

        api.on(EventName.managedAccounts, onManagedAccounts);
        api.on(EventName.error, onError);

        api.reqManagedAccts();
    });
}
