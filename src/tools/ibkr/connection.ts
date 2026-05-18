/**
 * IB Gateway connection manager — singleton that lazily connects to TWS/IB Gateway.
 * Re-exports a shared IBApi instance and helpers for request-id allocation.
 */

import { logger } from '@/utils';
import { EventName, IBApi } from '@stoqey/ib';

let ibApi: IBApi | null = null;
let connected = false;
let connectPromise: Promise<void> | null = null;
let nextReqId = 1;

function getConfig() {
    return {
        host: process.env.IBKR_HOST || '127.0.0.1',
        port: Number(process.env.IBKR_PORT) || 7497,
        clientId: Number(process.env.IBKR_CLIENT_ID) || 0,
        marketDataType: Number(process.env.IBKR_MARKET_DATA_TYPE) || 0,
    };
}

/**
 * Codes IBKR sends through the error channel that are informational, not
 * fatal. Per-tool error handlers should short-circuit on these so the
 * data path can complete normally.
 *
 *   2103–2110, 2148, 2158, 2168, 2169 — market-data farm connection status
 *   10167                              — delayed data is being shown
 *   10090, 10091                        — snapshot received / delayed pending
 */
const NON_FATAL_CODES = new Set<number>([
    2100, 2101, 2102, 2103, 2104, 2105, 2106, 2107, 2108, 2109, 2110,
    2148, 2158, 2168, 2169,
    10090, 10091, 10167,
]);

export function isNonFatalIbkrError(code: number): boolean {
    return NON_FATAL_CODES.has(code);
}

/**
 * Get (or create) a connected IBApi instance.
 * The first call initiates the TCP connection; subsequent calls return the
 * same instance once connected.
 */
export function getIBApi(): Promise<IBApi> {
    if (ibApi && connected) return Promise.resolve(ibApi);

    if (connectPromise) return connectPromise.then(() => ibApi!);

    const cfg = getConfig();
    ibApi = new IBApi({ host: cfg.host, port: cfg.port, clientId: cfg.clientId });

    connectPromise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error(`[IBKR] Connection timeout (${cfg.host}:${cfg.port})`));
            connectPromise = null;
        }, 10_000);

        ibApi!.on(EventName.connected, () => {
            clearTimeout(timeout);
            connected = true;
            logger.info(`[IBKR] Connected to ${cfg.host}:${cfg.port} (clientId ${cfg.clientId})`);
            // Switch market-data feed type if requested. 1=live, 2=frozen,
            // 3=delayed, 4=delayed-frozen. Use 3 for paper accounts without
            // real-time subscriptions.
            if (cfg.marketDataType && cfg.marketDataType >= 1 && cfg.marketDataType <= 4) {
                try {
                    ibApi!.reqMarketDataType(cfg.marketDataType);
                    logger.info(`[IBKR] reqMarketDataType(${cfg.marketDataType})`);
                } catch (err) {
                    logger.warn(`[IBKR] reqMarketDataType failed: ${err}`);
                }
            }
            resolve();
        });

        ibApi!.on(EventName.disconnected, () => {
            connected = false;
            connectPromise = null;
            logger.warn('[IBKR] Disconnected');
        });

        ibApi!.on(EventName.error, (err: Error, code: number, reqId: number) => {
            if (code === -1) {
                connected = false;
                connectPromise = null;
                logger.error(`[IBKR] Connection lost (reqId ${reqId}): ${err.message}`);
                return;
            }
            if (isNonFatalIbkrError(code)) {
                logger.info(`[IBKR] ${code} (reqId ${reqId}): ${err.message}`);
                return;
            }
            logger.error(`[IBKR] Error ${code} (reqId ${reqId}): ${err.message}`);
        });

        ibApi!.connect(cfg.clientId);
    });

    return connectPromise.then(() => ibApi!);
}

/** Allocate a unique request ID for IBKR API calls. */
export function allocReqId(): number {
    return nextReqId++;
}

/** Check if currently connected. */
export function isConnected(): boolean {
    return connected;
}

/** Graceful disconnect. */
export function disconnect(): void {
    if (ibApi) {
        ibApi.disconnect();
        ibApi = null;
        connected = false;
        connectPromise = null;
    }
}
