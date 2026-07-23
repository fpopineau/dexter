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
import { randomBytes } from 'node:crypto';
import { BarSizeSetting } from '@stoqey/ib';
import { acceptProposal, cancelProposalBracket, rejectProposal } from './proposal-executor.js';
import { closePosition, protectPosition } from './position-actions.js';
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
const PROPOSAL_ID_RE = /^P-[A-Za-z0-9]{4}$/i;

/**
 * CSRF protection for trade actions: any website the operator visits can
 * POST to 127.0.0.1, so mutations require this per-startup token, which is
 * embedded in the served page — same-origin JS can read it, a foreign
 * origin cannot (and the custom header forces a CORS preflight we never
 * answer). A restart rotates it; stale tabs get 403 and say "reload".
 */
const ACTION_TOKEN = randomBytes(16).toString('hex');

function readBody(req: IncomingMessage, limit = 10_000): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk: Buffer) => {
            body += chunk.toString('utf-8');
            if (body.length > limit) reject(new Error('body too large'));
        });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

interface ActionPayload {
    action?: string;
    id?: string;
    symbol?: string;
    stop?: number;
    target?: number;
}

/** Route a dashboard action through the SAME deterministic paths as the
 *  WhatsApp command router — every gate applies identically. */
async function runAction(p: ActionPayload): Promise<{ ok: boolean; message: string }> {
    switch (p.action) {
        case 'accept':
        case 'reject':
        case 'cancel': {
            if (!p.id || !PROPOSAL_ID_RE.test(p.id)) return { ok: false, message: 'bad proposal id' };
            const id = p.id.toUpperCase();
            if (p.action === 'accept') return acceptProposal(id);
            if (p.action === 'reject') return rejectProposal(id);
            return cancelProposalBracket(id);
        }
        case 'close': {
            if (!p.symbol || !SYMBOL_RE.test(p.symbol)) return { ok: false, message: 'bad symbol' };
            return closePosition(p.symbol);
        }
        case 'protect': {
            if (!p.symbol || !SYMBOL_RE.test(p.symbol)) return { ok: false, message: 'bad symbol' };
            const stop = Number(p.stop);
            if (!(stop > 0)) return { ok: false, message: 'protect requires a positive stop price' };
            const target = p.target !== undefined && p.target !== null ? Number(p.target) : undefined;
            if (target !== undefined && !(target > 0)) return { ok: false, message: 'bad target price' };
            return protectPosition(p.symbol, stop, target);
        }
        default:
            return { ok: false, message: `unknown action '${p.action}'` };
    }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
        if (url.pathname === '/') {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(DASHBOARD_HTML.replace('__DEXTER_TOKEN__', ACTION_TOKEN));
            return;
        }
        if (url.pathname === '/api/action' && req.method === 'POST') {
            const origin = req.headers.origin;
            const originOk = origin === undefined ||
                origin.startsWith('http://127.0.0.1') || origin.startsWith('http://localhost');
            if (!originOk || req.headers['x-dexter-token'] !== ACTION_TOKEN) {
                res.writeHead(403, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ ok: false, message: 'forbidden — reload the dashboard page' }));
                return;
            }
            const payload = JSON.parse(await readBody(req)) as ActionPayload;
            logger.info(`[dashboard] action ${payload.action} ${payload.id ?? payload.symbol ?? ''}`);
            const outcome = await runAction(payload);
            overviewCache = null; // the book just changed — next poll must see it
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(outcome));
            return;
        }
        if (url.pathname === '/api/overview') {
            // Build BEFORE writeHead: a throw after headers are sent turns
            // into ERR_HTTP_HEADERS_SENT in the catch and kills the process.
            const body = await buildOverview();
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(body);
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
            const body = await buildBars(symbol, size);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(body);
            return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
    } catch (err) {
        logger.warn(`[dashboard] ${url.pathname} failed: ${err}`);
        // The error path must be throw-proof — it runs inside the only
        // safety net this request has.
        try {
            if (!res.headersSent) {
                res.writeHead(500, { 'content-type': 'application/json' });
            }
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        } catch { /* socket gone — nothing left to say */ }
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
    // A dashboard request must never be able to take the gateway down:
    // catch anything that escapes the handler's own try/catch.
    server = createServer((req, res) => {
        handle(req, res).catch((err) => {
            logger.error(`[dashboard] unhandled: ${err}`);
            try { res.destroy(); } catch { /* already gone */ }
        });
    });
    server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
            // Restart overlap: the previous gateway instance still holds the
            // port for a few seconds. Keep retrying instead of giving up —
            // observed live: a second instance started before the first
            // exited and permanently lost its dashboard.
            logger.warn(`[dashboard] port ${port} busy (previous instance still up?) — retrying in 15s`);
            try { server?.close(); } catch { /* not listening */ }
            server = null;
            setTimeout(() => startDashboard(), 15_000);
            return;
        }
        logger.error(`[dashboard] server error: ${err}`);
    });
    server.listen(port, host, () => {
        logger.info(`[dashboard] serving http://${host}:${port}/`);
    });
}

export function stopDashboard(): void {
    if (server) { server.close(); server = null; }
}
