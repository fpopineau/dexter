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
    };
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
            resolve();
        });

        ibApi!.on(EventName.disconnected, () => {
            connected = false;
            connectPromise = null;
            logger.warn('[IBKR] Disconnected');
        });

        ibApi!.on(EventName.error, (err: Error, code: number, reqId: number) => {
            // Code -1 = connection lost, code 2104/2106/2158 = informational
            if (code === -1) {
                connected = false;
                connectPromise = null;
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
