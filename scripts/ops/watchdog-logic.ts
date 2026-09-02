/**
 * Pure decision core of the ops watchdog (scripts/ops/watchdog.ts).
 *
 * Kept side-effect free so the alerting state machine is testable without
 * an IB Gateway or a process table: the runner feeds it check results and
 * executes the alert actions it returns.
 *
 * Alert policy — why these rules:
 * - A single failed check is NOT an outage: the IB Gateway daily
 *   auto-restart (handbook §3.1) and brief network blips would spam
 *   otherwise. Alert only after `failsBeforeAlert` consecutive failures.
 * - While a component stays down, re-alert every `realertMinutes` — one
 *   missed WhatsApp message must not mean silence for the whole outage.
 * - Recovery is announced only if a down-alert was actually sent;
 *   absorbed blips stay silent.
 */

export const COMPONENT_IDS = ['ibkr', 'gateway'] as const;
export type ComponentId = (typeof COMPONENT_IDS)[number];

export interface CheckResult {
    id: ComponentId;
    ok: boolean;
    /** Human-readable diagnosis, forwarded into the alert text. */
    detail: string;
}

export interface ComponentState {
    status: 'up' | 'down';
    /** Consecutive failed checks (0 when up). */
    failCount: number;
    /** First failure of the current down streak, null when up. */
    downSinceMs: number | null;
    /** Last down/still-down alert actually sent, null when up or never alerted. */
    lastAlertMs: number | null;
}

export interface WatchdogState {
    version: 1;
    components: Record<ComponentId, ComponentState>;
    updatedMs: number;
}

export interface AlertAction {
    kind: 'down' | 'still-down' | 'recovered';
    component: ComponentId;
    detail: string;
    /** Minutes since the down streak began (0 for a fresh 'down'). */
    downMinutes: number;
}

export interface EvaluateConfig {
    /** Consecutive failures before the first alert (>= 1). */
    failsBeforeAlert: number;
    /** Minutes between repeated alerts while a component stays down. */
    realertMinutes: number;
}

const UP: ComponentState = { status: 'up', failCount: 0, downSinceMs: null, lastAlertMs: null };

export function initialState(nowMs: number): WatchdogState {
    return {
        version: 1,
        components: { ibkr: { ...UP }, gateway: { ...UP } },
        updatedMs: nowMs,
    };
}

function minutesSince(fromMs: number, nowMs: number): number {
    return Math.max(0, Math.round((nowMs - fromMs) / 60_000));
}

function evaluateComponent(
    prev: ComponentState,
    result: CheckResult,
    nowMs: number,
    cfg: EvaluateConfig,
): { state: ComponentState; alert: AlertAction | null } {
    if (result.ok) {
        // Announce recovery only for outages the operator was told about.
        const alert: AlertAction | null = prev.lastAlertMs !== null && prev.downSinceMs !== null
            ? {
                kind: 'recovered',
                component: result.id,
                detail: result.detail,
                downMinutes: minutesSince(prev.downSinceMs, nowMs),
            }
            : null;
        return { state: { ...UP }, alert };
    }

    const failCount = prev.failCount + 1;
    const downSinceMs = prev.downSinceMs ?? nowMs;
    const confirmedDown = failCount >= cfg.failsBeforeAlert;
    const state: ComponentState = {
        status: confirmedDown ? 'down' : prev.status,
        failCount,
        downSinceMs,
        lastAlertMs: prev.lastAlertMs,
    };

    if (!confirmedDown) return { state, alert: null };

    if (prev.lastAlertMs === null) {
        state.lastAlertMs = nowMs;
        return {
            state,
            alert: { kind: 'down', component: result.id, detail: result.detail, downMinutes: minutesSince(downSinceMs, nowMs) },
        };
    }

    if (nowMs - prev.lastAlertMs >= cfg.realertMinutes * 60_000) {
        state.lastAlertMs = nowMs;
        return {
            state,
            alert: { kind: 'still-down', component: result.id, detail: result.detail, downMinutes: minutesSince(downSinceMs, nowMs) },
        };
    }

    return { state, alert: null };
}

/** Fold one round of check results into the state; returns alerts to send. */
export function evaluate(
    prev: WatchdogState,
    results: readonly CheckResult[],
    nowMs: number,
    cfg: EvaluateConfig,
): { state: WatchdogState; alerts: AlertAction[] } {
    const components = { ...prev.components };
    const alerts: AlertAction[] = [];
    for (const result of results) {
        const { state, alert } = evaluateComponent(components[result.id] ?? { ...UP }, result, nowMs, cfg);
        components[result.id] = state;
        if (alert) alerts.push(alert);
    }
    return { state: { version: 1, components, updatedMs: nowMs }, alerts };
}
