/**
 * Local trading dashboard — charts and the live book, served by dexter.
 *
 * Why in-process: any external viewer (TradingView broker integration, a
 * second Gateway) competes for the paper username's single brokerage
 * session and disconnects the Gateway (observed live 2026-07-23). This
 * dashboard reads dexter's OWN data — the archive, the proposal store, the
 * existing API session — so there is no second session to steal.
 *
 * Binds 127.0.0.1 by default. No auth — do not expose it beyond localhost
 * without adding some (DASHBOARD_HOST is deliberately explicit).
 *
 *   http://127.0.0.1:8484/
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { BarSizeSetting } from '@stoqey/ib';
import { getDailyBars, getIntradayBars } from './data-archive.js';
import { getDailyLossStatus } from './daily-loss-guard.js';
import { getLatestPatternScan } from './pattern-scanner.js';
import { fetchPositions } from './position-actions.js';
import { getProfitTrailEntries } from './profit-trail.js';
import { listProposals } from './trade-proposals.js';
import { getIBApi } from '@/tools/ibkr/connection.js';
import { createIbkrOrders } from '@/tools/ibkr/orders.js';
import { fetchBars } from '@/tools/ibkr/signal-scorer.js';
import { logger } from '@/utils';
import { DASHBOARD_HTML } from './dashboard-page.js';

// ---------------------------------------------------------------------------
// Time conversion (pure, tested)
// ---------------------------------------------------------------------------

/** '20260722' → '2026-07-22' (lightweight-charts daily time). */
export function dailyBarTime(t: string): string {
    return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
}

/**
 * '20260722 09:30:00 US/Eastern' → unix seconds. ET offset approximated by
 * month (Mar–Oct ≈ EDT −4h, else EST −5h) — a few edge days a year are an
 * hour off on the axis, which is irrelevant for visual charting.
 */
export function intradayBarTime(t: string): number {
    const y = Number(t.slice(0, 4)), mo = Number(t.slice(4, 6)), d = Number(t.slice(6, 8));
    const hh = Number(t.slice(9, 11)), mm = Number(t.slice(12, 14)), ss = Number(t.slice(15, 17));
    const offsetHours = mo >= 3 && mo <= 10 ? 4 : 5;
    return Date.UTC(y, mo - 1, d, hh + offsetHours, mm, ss) / 1000;
}

// ---------------------------------------------------------------------------
// Data assembly
// ---------------------------------------------------------------------------

interface OverviewCache { at: number; body: string }
let overviewCache: OverviewCache | null = null;
const OVERVIEW_TTL_MS = 15_000;

async function buildOverview(): Promise<string> {
    if (overviewCache && Date.now() - overviewCache.at < OVERVIEW_TTL_MS) return overviewCache.body;

    const [positions, ordersRaw, proposals, lossStatus] = await Promise.all([
        getIBApi().then((api) => fetchPositions(api)).catch(() => []),
        createIbkrOrders().invoke({ action: 'list' }).then((r) => JSON.parse(String(r))).catch(() => null),
        listProposals(undefined, 40).catch(() => []),
        getDailyLossStatus().catch(() => null),
    ]);

    const body = JSON.stringify({
        at: Date.now(),
        positions,
        orders: ordersRaw?.data?.orders ?? [],
        proposals,
        trail: getProfitTrailEntries(),
        loss: lossStatus,
        patterns: getLatestPatternScan()?.candidates?.slice(0, 10) ?? [],
    });
    overviewCache = { at: Date.now(), body };
    return body;
}

async function buildBars(symbol: string, size: string): Promise<string> {
    if (size === '1d') {
        const bars = await getDailyBars(symbol);
        return JSON.stringify({
            symbol, size,
            bars: bars.map((b) => ({ time: dailyBarTime(b.time), open: b.open, high: b.high, low: b.low, close: b.close })),
        });
    }
    // Intraday: live fetch over the existing session (2 days of 1-min bars),
    // falling back to the archive when live market data is unavailable
    // (competing session, disconnected Gateway) — stale beats blank.
    try {
        const bars = await fetchBars(symbol, BarSizeSetting.MINUTES_ONE, '2 D', true);
        if (bars.length === 0) throw new Error('live fetch returned no bars');
        return JSON.stringify({
            symbol, size,
            bars: bars
                .filter((b) => b.time && b.open != null)
                .map((b) => ({ time: intradayBarTime(b.time!), open: b.open, high: b.high, low: b.low, close: b.close })),
        });
    } catch (err) {
        const archived = await getIntradayBars(symbol, '1 min');
        if (archived.length === 0) throw err; // surface the real reason
        return JSON.stringify({
            symbol, size,
            stale: true,
            note: `live market data unavailable (${err instanceof Error ? err.message : err}) — showing archived bars`,
            bars: archived.map((b) => ({ time: intradayBarTime(b.time), open: b.open, high: b.high, low: b.low, close: b.close })),
        });
    }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const SYMBOL_RE = /^[A-Za-z.]{1,6}$/;

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
        if (url.pathname === '/') {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(DASHBOARD_HTML);
            return;
        }
        if (url.pathname === '/api/overview') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(await buildOverview());
            return;
        }
        if (url.pathname === '/api/bars') {
            const symbol = (url.searchParams.get('symbol') ?? '').toUpperCase();
            const size = url.searchParams.get('size') === '1d' ? '1d' : '1min';
            if (!SYMBOL_RE.test(symbol)) {
                res.writeHead(400, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: 'bad symbol' }));
                return;
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(await buildBars(symbol, size));
            return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
    } catch (err) {
        logger.warn(`[dashboard] ${url.pathname} failed: ${err}`);
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
}

let server: Server | null = null;

export function isDashboardEnabled(): boolean {
    return (process.env.DASHBOARD ?? 'true').trim().toLowerCase() !== 'false';
}

/** Start the dashboard HTTP server (idempotent). */
export function startDashboard(): void {
    if (server || !isDashboardEnabled()) return;
    const port = Number(process.env.DASHBOARD_PORT) || 8484;
    const host = process.env.DASHBOARD_HOST || '127.0.0.1';
    if (host !== '127.0.0.1' && host !== 'localhost') {
        logger.warn(`[dashboard] binding ${host} — the dashboard has NO auth; only do this on a trusted network`);
    }
    server = createServer((req, res) => { void handle(req, res); });
    server.on('error', (err) => logger.error(`[dashboard] server error: ${err}`));
    server.listen(port, host, () => {
        logger.info(`[dashboard] serving http://${host}:${port}/`);
    });
}

export function stopDashboard(): void {
    if (server) { server.close(); server = null; }
}
