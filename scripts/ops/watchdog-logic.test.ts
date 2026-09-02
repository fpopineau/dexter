import { describe, expect, test } from 'bun:test';
import {
    evaluate,
    initialState,
    type CheckResult,
    type EvaluateConfig,
    type WatchdogState,
} from './watchdog-logic';

const CFG: EvaluateConfig = { failsBeforeAlert: 2, realertMinutes: 60 };
const T0 = 1_756_800_000_000;
const MIN = 60_000;

const ok = (id: 'ibkr' | 'gateway'): CheckResult => ({ id, ok: true, detail: 'ok' });
const down = (id: 'ibkr' | 'gateway', detail = 'unreachable'): CheckResult => ({ id, ok: false, detail });

function run(state: WatchdogState, results: CheckResult[], nowMs: number) {
    return evaluate(state, results, nowMs, CFG);
}

describe('watchdog evaluate', () => {
    test('all up stays silent', () => {
        const { state, alerts } = run(initialState(T0), [ok('ibkr'), ok('gateway')], T0);
        expect(alerts).toEqual([]);
        expect(state.components.ibkr.status).toBe('up');
        expect(state.components.gateway.status).toBe('up');
    });

    test('single blip is absorbed — no alert, silent recovery', () => {
        const r1 = run(initialState(T0), [down('ibkr'), ok('gateway')], T0);
        expect(r1.alerts).toEqual([]);
        expect(r1.state.components.ibkr.status).toBe('up');
        expect(r1.state.components.ibkr.failCount).toBe(1);

        const r2 = run(r1.state, [ok('ibkr'), ok('gateway')], T0 + 5 * MIN);
        expect(r2.alerts).toEqual([]);
        expect(r2.state.components.ibkr.failCount).toBe(0);
    });

    test('second consecutive failure alerts down, once', () => {
        const r1 = run(initialState(T0), [down('ibkr')], T0);
        const r2 = run(r1.state, [down('ibkr', 'api-silent')], T0 + 5 * MIN);
        expect(r2.alerts).toHaveLength(1);
        expect(r2.alerts[0]).toMatchObject({ kind: 'down', component: 'ibkr', detail: 'api-silent', downMinutes: 5 });
        expect(r2.state.components.ibkr.status).toBe('down');

        // Third failure inside the re-alert window stays silent.
        const r3 = run(r2.state, [down('ibkr')], T0 + 10 * MIN);
        expect(r3.alerts).toEqual([]);
    });

    test('re-alerts after the realert window while still down', () => {
        const r1 = run(initialState(T0), [down('ibkr')], T0);
        const r2 = run(r1.state, [down('ibkr')], T0 + 5 * MIN);
        const r3 = run(r2.state, [down('ibkr')], T0 + 5 * MIN + 61 * MIN);
        expect(r3.alerts).toHaveLength(1);
        expect(r3.alerts[0]).toMatchObject({ kind: 'still-down', component: 'ibkr', downMinutes: 66 });
    });

    test('recovery after an alerted outage announces itself with duration', () => {
        const r1 = run(initialState(T0), [down('gateway')], T0);
        const r2 = run(r1.state, [down('gateway')], T0 + 5 * MIN);
        expect(r2.alerts[0]?.kind).toBe('down');

        const r3 = run(r2.state, [ok('gateway')], T0 + 47 * MIN);
        expect(r3.alerts).toHaveLength(1);
        expect(r3.alerts[0]).toMatchObject({ kind: 'recovered', component: 'gateway', downMinutes: 47 });
        expect(r3.state.components.gateway.status).toBe('up');
        expect(r3.state.components.gateway.lastAlertMs).toBeNull();
    });

    test('components are independent', () => {
        const r1 = run(initialState(T0), [down('ibkr'), down('gateway')], T0);
        const r2 = run(r1.state, [down('ibkr'), ok('gateway')], T0 + 5 * MIN);
        expect(r2.alerts).toHaveLength(1);
        expect(r2.alerts[0]).toMatchObject({ kind: 'down', component: 'ibkr' });
        expect(r2.state.components.gateway.status).toBe('up');
    });
});
