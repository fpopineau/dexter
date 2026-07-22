/**
 * Scanner-health state machine.
 *
 * On 2026-07-21 the engine ran 49 consecutive market-hours cycles that
 * scanned ZERO symbols (degraded IB Gateway API) and nobody knew until
 * after the close — three catchable movers were missed. This monitor turns
 * that silence into a signal: after `threshold` consecutive empty cycles
 * while the market is open it emits `degraded` (once per episode), and
 * `recovered` when scans return data again.
 *
 * Pure state, no I/O — the engine feeds it cycle results; the gateway
 * bridges events to WhatsApp.
 */

export interface HealthTransition {
    kind: 'degraded' | 'recovered';
    /** Consecutive empty cycles observed in this episode. */
    emptyCycles: number;
    /** Timestamp of the first empty cycle of the episode. */
    sinceMs: number;
}

export class ScanHealthMonitor {
    private empty = 0;
    private since = 0;
    private notified = false;

    constructor(private readonly threshold = 3) {}

    /** Feed one cycle result; returns a transition when one occurs. */
    observe(scanned: number, marketOpen: boolean, now: number = Date.now()): HealthTransition | null {
        // Closed-market cycles carry no signal either way: an empty pre-open
        // scan at 04:00 is normal, and must not clear a live episode.
        if (!marketOpen) return null;

        if (scanned === 0) {
            if (this.empty === 0) this.since = now;
            this.empty++;
            if (!this.notified && this.empty >= this.threshold) {
                this.notified = true;
                return { kind: 'degraded', emptyCycles: this.empty, sinceMs: this.since };
            }
            return null;
        }

        const transition: HealthTransition | null = this.notified
            ? { kind: 'recovered', emptyCycles: this.empty, sinceMs: this.since }
            : null;
        this.empty = 0;
        this.since = 0;
        this.notified = false;
        return transition;
    }
}
