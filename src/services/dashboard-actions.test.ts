import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DASHBOARD_PORT = '8497';
process.env.DASHBOARD = 'true';
// CRITICAL: isolate the proposals DB BEFORE any import touches the store.
// This file sorts first alphabetically — without this line it binds the
// store to the PRODUCTION DB for the whole single-process test run (which
// is exactly what happened: 27 test fixtures leaked into the live book).
process.env.DEXTER_DATA_DIR = mkdtempSync(join(tmpdir(), 'dexter-dashboard-'));

import { startDashboard, stopDashboard } from './dashboard.js';

const BASE = 'http://127.0.0.1:8497';

startDashboard();
await new Promise((r) => setTimeout(r, 300));

afterAll(() => stopDashboard());

async function post(body: unknown, headers: Record<string, string> = {}) {
    return fetch(`${BASE}/api/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
    });
}

describe('dashboard action security', () => {
    test('mutations without the CSRF token are forbidden', async () => {
        const res = await post({ action: 'reject', id: 'P-ZZZZ' });
        expect(res.status).toBe(403);
    });

    test('wrong token is forbidden; foreign origin is forbidden even with a token', async () => {
        expect((await post({ action: 'reject', id: 'P-ZZZZ' }, { 'x-dexter-token': 'nope' })).status).toBe(403);

        const page = await fetch(`${BASE}/`).then((r) => r.text());
        const token = /DEXTER_TOKEN = '([0-9a-f]{32})'/.exec(page)?.[1];
        expect(token).toBeTruthy();
        const foreign = await post({ action: 'reject', id: 'P-ZZZZ' },
            { 'x-dexter-token': token!, origin: 'https://evil.example' });
        expect(foreign.status).toBe(403);
    });

    test('valid token routes to the real executor paths', async () => {
        const page = await fetch(`${BASE}/`).then((r) => r.text());
        const token = /DEXTER_TOKEN = '([0-9a-f]{32})'/.exec(page)?.[1]!;

        // Unknown proposal → the executor's own honest refusal, not a 500.
        const res = await post({ action: 'reject', id: 'P-ZZZZ' }, { 'x-dexter-token': token });
        expect(res.status).toBe(200);
        const out = await res.json() as { ok: boolean; message: string };
        expect(out.ok).toBe(false);
        expect(out.message).toContain('not found');

        // Malformed inputs are refused before touching anything.
        expect(((await (await post({ action: 'accept', id: 'DROP TABLE' }, { 'x-dexter-token': token })).json()) as { message: string }).message).toContain('bad proposal id');
        expect(((await (await post({ action: 'close', symbol: 'TOOLONGSYM' }, { 'x-dexter-token': token })).json()) as { message: string }).message).toContain('bad symbol');
        expect(((await (await post({ action: 'protect', symbol: 'AAPL' }, { 'x-dexter-token': token })).json()) as { message: string }).message).toContain('positive stop');
        expect(((await (await post({ action: 'explode' }, { 'x-dexter-token': token })).json()) as { message: string }).message).toContain('unknown action');
    });
});
