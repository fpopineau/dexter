/**
 * IB Gateway connection manager — singleton that lazily connects to TWS/IB Gateway.
 * Re-exports a shared IBApi instance and helpers for request-id allocation.
 *
 * Resilience: on unexpected disconnect, automatically reconnects with
 * exponential backoff (1s → 60s, with jitter), indefinitely, until either
 * the connection succeeds or disconnect() is called explicitly. Services
 * that hold per-connection state (e.g. realtime-bar subscriptions) should
 * register an onReconnect() callback to re-establish it.
 *
 * Safety: assertOrderingAllowed() implements the paper/live lock used by
 * the orders tool — it refuses order placement on conventional live ports
 * (4001 IB Gateway, 7496 TWS) and on managed accounts that do not carry
 * the IBKR paper prefix 'D' (e.g. DU1234567), unless IBKR_ALLOW_LIVE=true.
 */

import { logger } from '@/utils';
import { EventName, IBApi } from '@stoqey/ib';

let ibApi: IBApi | null = null;
let connected = false;
let connectPromise: Promise<IBApi> | null = null;
let nextReqId = 1;

let manualDisconnect = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let managedAccounts: string[] = [];

const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 60_000;
const CONNECT_TIMEOUT_MS = 10_000;

/** Conventional live-trading ports: 4001 = IB Gateway live, 7496 = TWS live. */
const LIVE_PORTS = new Set<number>([4001, 7496]);

type ReconnectCallback = () => void | Promise<void>;
const reconnectCallbacks = new Set<ReconnectCallback>();

/**
 * Register a callback invoked after a successful automatic reconnection.
 * Use this to re-establish per-connection state (subscriptions, open
 * requests). Returns an unregister function.
 */
export function onReconnect(cb: ReconnectCallback): () => void {
    reconnectCallbacks.add(cb);
    return () => reconnectCallbacks.delete(cb);
}

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
    // 365 — "no scanner subscription found for ticker id": emitted when a
    // scanner subscription is cancelled after it failed to establish
    // (scanner-loop's cleanup cancels unconditionally). Informational.
    365,
    10090, 10091, 10167,
]);

export function isNonFatalIbkrError(code: number): boolean {
    return NON_FATAL_CODES.has(code);
}

// ---------------------------------------------------------------------------
// Paper / live safety lock
// ---------------------------------------------------------------------------

/** True when IBKR_PORT points at a conventional live-trading port. */
export function isLivePort(): boolean {
    return LIVE_PORTS.has(getConfig().port);
}

/** Managed account codes received on the current connection (may be empty
 *  before the first managedAccounts event). */
export function getManagedAccounts(): string[] {
    return [...managedAccounts];
}

/**
 * Block until the connection's account codes are known, then re-run the
 * paper/live assertion against them. Closes the fail-open window where an
 * order is placed after `connected` but before `managedAccounts` arrives —
 * on a live account behind a non-standard port, the prefix check would
 * otherwise never have run. Call from order-placement paths (post-connect).
 */
export async function assertAccountsVerified(timeoutMs = 5_000): Promise<void> {
    const allowLive = (process.env.IBKR_ALLOW_LIVE ?? '').trim().toLowerCase() === 'true';
    const start = Date.now();
    while (managedAccounts.length === 0 && Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, 100));
    }
    if (managedAccounts.length === 0 && !allowLive) {
        throw new Error(
            '[IBKR] SAFETY LOCK: account codes not received yet — cannot verify the connection is a paper account; retry in a moment',
        );
    }
    assertOrderingAllowed();
}

function maskAccount(acct: string): string {
    if (acct.length <= 4) return acct;
    return `${acct.slice(0, 2)}…${acct.slice(-2)}`;
}

/**
 * Throw unless order placement is safe. Two independent checks, either of
 * which blocks unless IBKR_ALLOW_LIVE=true:
 *   1. The configured port is a conventional live port (4001/7496).
 *   2. Any managed account on the connection lacks the paper prefix 'D'.
 * Check 2 only applies once account codes have been received; the port
 * check is purely static and always applies.
 */
export function assertOrderingAllowed(): void {
    const allowLive = (process.env.IBKR_ALLOW_LIVE ?? '').trim().toLowerCase() === 'true';
    if (allowLive) {
        logger.warn('[IBKR] IBKR_ALLOW_LIVE=true — live-trading safety lock is DISABLED');
        return;
    }
    const cfg = getConfig();
    if (LIVE_PORTS.has(cfg.port)) {
        throw new Error(
            `[IBKR] SAFETY LOCK: refusing to place orders on live port ${cfg.port} ` +
            `(4001 = IB Gateway live, 7496 = TWS live). Use a paper port (4002/7497), ` +
            `or set IBKR_ALLOW_LIVE=true only if you explicitly intend to trade live.`,
        );
    }
    const liveAccounts = managedAccounts.filter((a) => !a.toUpperCase().startsWith('D'));
    if (liveAccounts.length > 0) {
        throw new Error(
            `[IBKR] SAFETY LOCK: connected account(s) ${liveAccounts.map(maskAccount).join(', ')} ` +
            `do not look like paper accounts (paper accounts start with 'D'). ` +
            `Set IBKR_ALLOW_LIVE=true only if you explicitly intend to trade live.`,
        );
    }
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

function scheduleReconnect(): void {
    if (manualDisconnect || connected || reconnectTimer) return;
    const base = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempts);
    const delay = base + Math.floor(Math.random() * 0.25 * base);
    reconnectAttempts++;
    logger.warn(`[IBKR] Scheduling reconnect attempt ${reconnectAttempts} in ${Math.round(delay / 1000)}s`);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (manualDisconnect || connected) return;
        doConnect()
            .then(async () => {
                logger.info(`[IBKR] Reconnected after ${reconnectAttempts} attempt(s) — notifying subscribers`);
                for (const cb of [...reconnectCallbacks]) {
                    try {
                        await cb();
                    } catch (err) {
                        logger.error(`[IBKR] onReconnect callback failed: ${err}`);
                    }
                }
            })
            .catch(() => {
                scheduleReconnect();
            });
    }, delay);
}

function doConnect(): Promise<IBApi> {
    if (ibApi && connected) return Promise.resolve(ibApi);
    if (connectPromise) return connectPromise;

    manualDisconnect = false;
    const cfg = getConfig();
    const api = new IBApi({ host: cfg.host, port: cfg.port, clientId: cfg.clientId });
    ibApi = api;

    connectPromise = new Promise<IBApi>((resolve, reject) => {
        const timeout = setTimeout(() => {
            if (connectPromise) connectPromise = null;
            reject(new Error(`[IBKR] Connection timeout (${cfg.host}:${cfg.port})`));
        }, CONNECT_TIMEOUT_MS);

        api.on(EventName.connected, () => {
            if (api !== ibApi) return; // stale instance
            clearTimeout(timeout);
            connected = true;
            reconnectAttempts = 0;
            logger.info(`[IBKR] Connected to ${cfg.host}:${cfg.port} (clientId ${cfg.clientId})`);
            if (LIVE_PORTS.has(cfg.port)) {
                logger.warn(`[IBKR] Port ${cfg.port} is a LIVE trading port — order placement is locked unless IBKR_ALLOW_LIVE=true`);
            }
            // Switch market-data feed type if requested. 1=live, 2=frozen,
            // 3=delayed, 4=delayed-frozen. Use 3 for paper accounts without
            // real-time subscriptions.
            if (cfg.marketDataType && cfg.marketDataType >= 1 && cfg.marketDataType <= 4) {
                try {
                    api.reqMarketDataType(cfg.marketDataType);
                    logger.info(`[IBKR] reqMarketDataType(${cfg.marketDataType})`);
                } catch (err) {
                    logger.warn(`[IBKR] reqMarketDataType failed: ${err}`);
                }
            }
            resolve(api);
        });

        api.on(EventName.managedAccounts, (accountsList: string) => {
            if (api !== ibApi) return;
            managedAccounts = accountsList
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
            const masked = managedAccounts.map(maskAccount).join(', ');
            const paper = managedAccounts.every((a) => a.toUpperCase().startsWith('D'));
            logger.info(`[IBKR] Managed accounts: ${masked} (${paper ? 'paper' : 'LIVE or mixed'})`);
        });

        api.on(EventName.disconnected, () => {
            if (api !== ibApi) return;
            connected = false;
            connectPromise = null;
            logger.warn('[IBKR] Disconnected');
            scheduleReconnect();
        });

        api.on(EventName.error, (err: Error, code: number, reqId: number) => {
            if (api !== ibApi) return;
            if (code === -1) {
                connected = false;
                connectPromise = null;
                logger.error(`[IBKR] Connection lost (reqId ${reqId}): ${err.message}`);
                scheduleReconnect();
                return;
            }
            if (isNonFatalIbkrError(code)) {
                logger.info(`[IBKR] ${code} (reqId ${reqId}): ${err.message}`);
                return;
            }
            logger.error(`[IBKR] Error ${code} (reqId ${reqId}): ${err.message}`);
        });

        api.connect(cfg.clientId);
    });

    return connectPromise;
}

/**
 * Get (or create) a connected IBApi instance.
 * The first call initiates the TCP connection; subsequent calls return the
 * same instance once connected. After an unexpected disconnect, the manager
 * reconnects automatically in the background; callers simply get the fresh
 * instance once it is up.
 */
export function getIBApi(): Promise<IBApi> {
    return doConnect();
}

/** Allocate a unique request ID for IBKR API calls. */
export function allocReqId(): number {
    return nextReqId++;
}

/** Check if currently connected. */
export function isConnected(): boolean {
    return connected;
}

/** Graceful disconnect. Disables automatic reconnection until the next getIBApi(). */
export function disconnect(): void {
    manualDisconnect = true;
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    reconnectAttempts = 0;
    managedAccounts = [];
    if (ibApi) {
        try {
            ibApi.disconnect();
        } catch { /* already gone */ }
        ibApi = null;
        connected = false;
        connectPromise = null;
    }
}
