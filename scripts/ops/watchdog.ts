/**
 * Independent liveness watchdog — runs OUTSIDE the dexter gateway process
 * so it can report the gateway's own death. Scheduled every 5 minutes by
 * the \Dexter\Watchdog task (scripts/ops/install-tasks.ps1).
 *
 * Checks (one round per invocation, then exit):
 *   ibkr    — real API handshake (reqCurrentTime) against IB Gateway on a
 *             dedicated client id. A TCP-open port is NOT enough: after a
 *             failed weekly re-login the socket listens but the API is
 *             silent (handbook §3.1), and that zombie state must alert.
 *   gateway — a bun.exe process running `bun run gateway` exists.
 *
 * Alerting is deliberately NOT via the gateway's own WhatsApp session
 * (Baileys dies with the gateway — the exact outage this must survive).
 * It uses CallMeBot, an independent HTTP→WhatsApp bridge; see
 * handbook §3.2 for the one-time activation. Optional: a healthchecks.io
 * ping URL turns this into a dead-man's switch that also covers "the
 * whole machine is off" — pings stop, healthchecks alerts.
 *
 * Usage:
 *   bun run scripts/ops/watchdog.ts               one check round
 *   bun run scripts/ops/watchdog.ts --status      print last known state
 *   bun run scripts/ops/watchdog.ts --test-alert  send a test WhatsApp message
 */

import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import * as net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { config as loadDotenv } from 'dotenv';
import { EventName, IBApi } from '@stoqey/ib';
import {
    evaluate,
    initialState,
    type AlertAction,
    type CheckResult,
    type WatchdogState,
} from './watchdog-logic';

const execFileAsync = promisify(execFile);

// Resolve everything from the script location, not cwd — the scheduled
// task must work no matter where Task Scheduler starts it.
const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
loadDotenv({ path: join(REPO_ROOT, '.env'), quiet: true });

const WATCHDOG_DIR = join(REPO_ROOT, '.dexter', 'watchdog');
const STATE_PATH = join(WATCHDOG_DIR, 'state.json');
const LOG_PATH = join(WATCHDOG_DIR, 'watchdog.log');
const LOG_MAX_BYTES = 1_000_000; // rotate to .1 past ~1 MB; two files ≈ months of 5-min lines

const CONFIG = {
    ibkrHost: process.env.IBKR_HOST ?? '127.0.0.1',
    ibkrPort: Number(process.env.IBKR_PORT ?? 4002),
    // Own client id — must never collide with the gateway's IBKR_CLIENT_ID.
    ibkrClientId: Number(process.env.WATCHDOG_IBKR_CLIENT_ID ?? 87),
    failsBeforeAlert: Number(process.env.WATCHDOG_FAILS_BEFORE_ALERT ?? 2),
    realertMinutes: Number(process.env.WATCHDOG_REALERT_MIN ?? 60),
    whatsappPhone: process.env.WATCHDOG_WHATSAPP_PHONE ?? '',
    callmebotApiKey: process.env.WATCHDOG_CALLMEBOT_APIKEY ?? '',
    healthcheckUrl: process.env.WATCHDOG_HEALTHCHECK_URL ?? '',
    tcpTimeoutMs: 3_000,
    apiTimeoutMs: 15_000,
    sendTimeoutMs: 20_000,
};

// --- logging ----------------------------------------------------------------

function log(line: string): void {
    const stamped = `${new Date().toISOString()} ${line}`;
    console.log(stamped);
    try {
        mkdirSync(WATCHDOG_DIR, { recursive: true });
        if (existsSync(LOG_PATH) && statSync(LOG_PATH).size > LOG_MAX_BYTES) {
            renameSync(LOG_PATH, `${LOG_PATH}.1`); // overwrites the previous .1
        }
        appendFileSync(LOG_PATH, `${stamped}\n`, 'utf8');
    } catch {
        // Logging must never take the watchdog down; stdout already has the line.
    }
}

// --- state persistence ------------------------------------------------------

function loadState(nowMs: number): WatchdogState {
    try {
        const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as WatchdogState;
        if (parsed?.version === 1 && parsed.components) return parsed;
    } catch {
        // Missing or corrupt state file — start fresh (worst case: one
        // duplicate alert after the reset, never a missed one).
    }
    return initialState(nowMs);
}

function saveState(state: WatchdogState): void {
    mkdirSync(WATCHDOG_DIR, { recursive: true });
    const tmp = `${STATE_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    renameSync(tmp, STATE_PATH);
}

// --- checks -----------------------------------------------------------------

/** TCP-level probe so a dead process and a zombie API produce distinct diagnoses. */
function probeTcp(host: string, port: number, timeoutMs: number): Promise<'open' | 'closed'> {
    return new Promise((resolve) => {
        const socket = net.connect({ host, port });
        const done = (result: 'open' | 'closed') => {
            socket.destroy();
            resolve(result);
        };
        socket.setTimeout(timeoutMs, () => done('closed'));
        socket.once('connect', () => done('open'));
        socket.once('error', () => done('closed'));
    });
}

/** Full API handshake: connected + a currentTime response within the timeout. */
function probeApi(host: string, port: number, clientId: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
        const api = new IBApi({ host, port, clientId });
        let settled = false;
        const finish = (ok: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try {
                api.disconnect();
            } catch {
                // Already torn down — nothing to release.
            }
            resolve(ok);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        api.on(EventName.currentTime, () => finish(true));
        api.on(EventName.connected, () => api.reqCurrentTime());
        // Informational errors (market-data farm chatter) also arrive here;
        // only the timeout decides failure, the error handler just prevents
        // an unhandled 'error' event from killing the process.
        api.on(EventName.error, () => {});
        try {
            api.connect(clientId);
        } catch {
            finish(false);
        }
    });
}

async function checkIbkr(): Promise<CheckResult> {
    const { ibkrHost: host, ibkrPort: port, ibkrClientId: clientId } = CONFIG;
    if ((await probeTcp(host, port, CONFIG.tcpTimeoutMs)) === 'closed') {
        return { id: 'ibkr', ok: false, detail: `API port ${host}:${port} closed — IB Gateway process down?` };
    }
    const ok = await probeApi(host, port, clientId, CONFIG.apiTimeoutMs);
    return ok
        ? { id: 'ibkr', ok: true, detail: 'API handshake ok' }
        : { id: 'ibkr', ok: false, detail: `port ${port} open but API silent — likely awaiting the 2FA login (handbook §3.1)` };
}

async function checkGatewayProcess(): Promise<CheckResult> {
    // The dexter gateway runs as `bun.exe run gateway` (see run-gateway.cmd).
    // Match the exact tail so this watchdog's own bun process never counts.
    // Absolute powershell path: the scheduled-task environment's PATH is
    // not guaranteed to include it, and a PATH miss must not read as
    // "gateway down".
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const { stdout } = await execFileAsync(
        powershell,
        ['-NoProfile', '-Command', "(Get-CimInstance Win32_Process -Filter \"Name='bun.exe'\").CommandLine"],
        { timeout: 30_000, windowsHide: true },
    );
    const up = stdout.split(/\r?\n/).some((line) => /\brun gateway\s*$/.test(line.trim()));
    return up
        ? { id: 'gateway', ok: true, detail: 'process up' }
        : { id: 'gateway', ok: false, detail: 'no `bun run gateway` process — briefs/triggers/heartbeat are OFF' };
}

// --- alert delivery ---------------------------------------------------------

function formatAlert(a: AlertAction): string {
    const name = a.component === 'ibkr' ? 'IB Gateway API' : 'Dexter gateway';
    switch (a.kind) {
        case 'down':
            return `🔴 [watchdog] ${name} DOWN — ${a.detail}. Re-alerts every ${CONFIG.realertMinutes} min until it recovers.`;
        case 'still-down':
            return `🔴 [watchdog] ${name} still down (${a.downMinutes} min) — ${a.detail}`;
        case 'recovered':
            return `🟢 [watchdog] ${name} recovered after ${a.downMinutes} min down.`;
        default: {
            const _exhaustive: never = a.kind;
            throw new Error(`unhandled alert kind: ${_exhaustive}`);
        }
    }
}

/** Send one WhatsApp message via CallMeBot; bounded to one retry. */
async function sendWhatsApp(text: string): Promise<boolean> {
    if (!CONFIG.whatsappPhone || !CONFIG.callmebotApiKey) {
        log('ALERT-DROPPED (CallMeBot unconfigured — set WATCHDOG_WHATSAPP_PHONE + WATCHDOG_CALLMEBOT_APIKEY in .env): ' + text);
        return false;
    }
    const url = 'https://api.callmebot.com/whatsapp.php?' + new URLSearchParams({
        phone: CONFIG.whatsappPhone,
        apikey: CONFIG.callmebotApiKey,
        text,
    }).toString();
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(CONFIG.sendTimeoutMs) });
            if (res.ok) return true;
            log(`send attempt ${attempt} failed: HTTP ${res.status}`);
        } catch (err) {
            log(`send attempt ${attempt} failed: ${err}`);
        }
        if (attempt === 1) await new Promise((r) => setTimeout(r, 5_000));
    }
    return false;
}

/**
 * Dead-man's switch ping (optional). A plain ping says "machine + watchdog
 * alive"; /fail flags a degraded round so healthchecks.io can alert through
 * its own channels too. If pings stop entirely — box off, watchdog dead —
 * healthchecks alerts after its grace period, covering what a local
 * watchdog structurally cannot.
 */
async function pingHealthcheck(allUp: boolean): Promise<void> {
    if (!CONFIG.healthcheckUrl) return;
    const url = allUp ? CONFIG.healthcheckUrl : `${CONFIG.healthcheckUrl}/fail`;
    try {
        await fetch(url, { signal: AbortSignal.timeout(10_000) });
    } catch (err) {
        log(`healthcheck ping failed: ${err}`);
    }
}

// --- entry ------------------------------------------------------------------

async function main(): Promise<void> {
    const mode = process.argv[2] ?? 'check';

    if (mode === '--status') {
        console.log(JSON.stringify(loadState(Date.now()), null, 2));
        return;
    }

    if (mode === '--test-alert') {
        const ok = await sendWhatsApp('✅ [watchdog] test alert — delivery path works.');
        log(`test alert: ${ok ? 'delivered' : 'FAILED'}`);
        process.exit(ok ? 0 : 1);
    }

    const nowMs = Date.now();
    const results = [await checkIbkr(), await checkGatewayProcess()];
    const { state, alerts } = evaluate(loadState(nowMs), results, nowMs, {
        failsBeforeAlert: CONFIG.failsBeforeAlert,
        realertMinutes: CONFIG.realertMinutes,
    });
    saveState(state);

    const summary = results.map((r) => `${r.id}=${r.ok ? 'up' : `DOWN(${r.detail})`}`).join(' ');
    log(`${summary} alerts=${alerts.length}`);

    for (const alert of alerts) {
        const delivered = await sendWhatsApp(formatAlert(alert));
        log(`alert ${alert.kind}/${alert.component}: ${delivered ? 'delivered' : 'NOT delivered'}`);
    }

    await pingHealthcheck(results.every((r) => r.ok));
}

main().catch((err) => {
    log(`watchdog fatal: ${err}`);
    process.exit(1);
});
