/**
 * Stage the bell-expiry observation bracket (FREEZE-MANIFEST row 2).
 *
 * The observation needs a mixed-TIF bracket that reaches the 16:00 ET
 * bell UNFILLED and from OUTSIDE dexter (dexter's own sweeps/triage
 * cancel its resting DAY entries before the bell by design). The
 * operator has no TWS, and a Client Portal web login bumps the IB
 * Gateway session — so this script places the bracket through the
 * ALREADY-AUTHENTICATED Gateway on its own client id: no login, no
 * session conflict, no dexter refs (the sweeps see a foreign bracket
 * and leave it alone, exactly like a hand-placed one).
 *
 * THE OPERATOR RUNS THIS — it places real (paper) orders:
 *   bun run scripts/ops/stage-bell-expiry.ts --symbol F --limit 9.50
 *     (limit ~20% below the market so the parent cannot fill)
 *   bun run scripts/ops/stage-bell-expiry.ts --cancel 41,42,43
 *     (emergency cleanup if the GTC children SURVIVE the bell)
 *
 * Safety: refuses anything but a single paper (D…) account; quantity
 * is hard-wired to 1 share; the parent is DAY so it dies at the bell
 * either way; exit prices are far from market and dormant until a
 * parent fill that cannot happen.
 */

import { EventName, IBApi, OrderAction, OrderType, TimeInForce } from '@stoqey/ib';

const HOST = process.env.IBKR_HOST ?? '127.0.0.1';
const PORT = Number(process.env.IBKR_PORT) || 4002;
// Never 0 (dexter) or the watchdog's id — this is a third, transient client.
const CLIENT_ID = Number(process.env.STAGE_CLIENT_ID) || 88;
const TIMEOUT_MS = 20_000;

function arg(name: string): string | null {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

function fail(msg: string): never {
    console.error(`REFUSED: ${msg}`);
    process.exit(1);
}

async function withApi<T>(fn: (api: IBApi, account: string) => Promise<T>): Promise<T> {
    const api = new IBApi({ host: HOST, port: PORT, clientId: CLIENT_ID });
    const accounts = await new Promise<string[]>((resolve, reject) => {
        const timer = setTimeout(() => { api.disconnect(); reject(new Error(`no managedAccounts within ${TIMEOUT_MS / 1000}s — is the Gateway up?`)); }, TIMEOUT_MS);
        api.on(EventName.managedAccounts, (list: string) => {
            clearTimeout(timer);
            resolve(list.split(',').map((s) => s.trim()).filter(Boolean));
        });
        api.on(EventName.error, (err: Error, code: number) => {
            // 502 = nothing listening; anything at connect time is fatal here.
            if (code === 502) { clearTimeout(timer); api.disconnect(); reject(err); }
        });
        api.connect(CLIENT_ID);
    });
    if (accounts.length !== 1 || !accounts[0].toUpperCase().startsWith('D')) {
        api.disconnect();
        fail(`this tool stages PAPER observations only — accounts seen: ${accounts.join(', ') || 'none'}`);
    }
    try {
        return await fn(api, accounts[0]);
    } finally {
        api.disconnect();
    }
}

async function stage(symbol: string, limit: number): Promise<void> {
    if (!/^[A-Z][A-Z.]{0,5}$/.test(symbol)) fail(`'${symbol}' is not a ticker`);
    if (!(limit > 0.05)) fail(`limit ${limit} is not a plausible price`);
    await withApi(async (api, account) => {
        const parentId = await new Promise<number>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('no nextValidId')), TIMEOUT_MS);
            api.once(EventName.nextValidId, (id: number) => { clearTimeout(timer); resolve(id); });
            api.reqIds();
        });
        const tpId = parentId + 1;
        const stopId = parentId + 2;
        const contract = { symbol, secType: 'STK' as const, exchange: 'SMART', currency: 'USD' };
        const oca = `stage-${symbol}-${parentId}`;
        // Exit prices are placeholders — the children stay dormant behind a
        // parent that cannot fill; only their GTC TIF matters to the test.
        const common = { account, ocaGroup: oca, ocaType: 1, orderRef: `stage:${symbol}:row2` };
        api.placeOrder(parentId, contract, {
            ...common, action: OrderAction.BUY, orderType: OrderType.LMT, totalQuantity: 1,
            lmtPrice: limit, tif: TimeInForce.DAY, parentId: 0, transmit: false,
        });
        api.placeOrder(tpId, contract, {
            ...common, action: OrderAction.SELL, orderType: OrderType.LMT, totalQuantity: 1,
            lmtPrice: Math.round(limit * 1.5 * 100) / 100, tif: TimeInForce.GTC, parentId, transmit: false,
        });
        api.placeOrder(stopId, contract, {
            ...common, action: OrderAction.SELL, orderType: OrderType.STP, totalQuantity: 1,
            auxPrice: Math.round(limit * 0.5 * 100) / 100, tif: TimeInForce.GTC, parentId, transmit: true,
        });
        // Wait for the broker to react to the parent (ack or rejection).
        const verdict = await new Promise<string>((resolve) => {
            const timer = setTimeout(() => resolve('no broker reaction within 20s — VERIFY in the dashboard orders panel'), TIMEOUT_MS);
            api.on(EventName.orderStatus, (id: number, status: string) => {
                if (id === parentId) { clearTimeout(timer); resolve(`parent status: ${status}`); }
            });
            api.on(EventName.error, (err: Error, code: number, reqId: number) => {
                if ([parentId, tpId, stopId].includes(reqId) && code !== 399 && code < 2000) {
                    clearTimeout(timer); resolve(`REJECTED (code ${code}): ${err.message}`);
                }
            });
        });
        console.log('--- STAGED ---');
        console.log(`symbol: ${symbol}  account: ${account}`);
        console.log(`parent  #${parentId}  BUY 1 LMT @${limit}  DAY   (must NOT fill; dies at the bell)`);
        console.log(`target  #${tpId}  SELL 1 LMT GTC (dormant child)`);
        console.log(`stop    #${stopId}  SELL 1 STP GTC (dormant child)`);
        console.log(verdict);
        console.log('');
        console.log('NOW: screenshot the dashboard working-orders panel (the before-bell evidence).');
        console.log('AT 22:00 Paris: watch the panel — expected: all three vanish together.');
        console.log(`IF the children SURVIVE: bun run scripts/ops/stage-bell-expiry.ts --cancel ${tpId},${stopId}`);
    });
}

async function cancel(ids: number[]): Promise<void> {
    if (ids.length === 0 || ids.some((n) => !Number.isSafeInteger(n) || n <= 0)) fail('give --cancel a comma list of order ids');
    await withApi(async (api) => {
        for (const id of ids) {
            api.cancelOrder(id);
            console.log(`cancel requested for #${id}`);
        }
        // Give the requests a moment on the wire before disconnecting.
        await new Promise((r) => setTimeout(r, 3_000));
        console.log('verify in the dashboard orders panel that they are gone.');
    });
}

const cancelArg = arg('cancel');
if (cancelArg) {
    void cancel(cancelArg.split(',').map((s) => Number(s.trim())));
} else {
    const symbol = arg('symbol')?.toUpperCase();
    const limit = Number(arg('limit'));
    if (!symbol || !Number.isFinite(limit)) {
        console.error('usage: bun run scripts/ops/stage-bell-expiry.ts --symbol F --limit 9.50   (limit ~20% BELOW the market)');
        console.error('       bun run scripts/ops/stage-bell-expiry.ts --cancel 42,43');
        process.exit(1);
    }
    void stage(symbol, limit);
}
