import { describe, expect, test } from 'bun:test';
import { ScanHealthMonitor } from './scan-health.js';

describe('ScanHealthMonitor', () => {
    test('emits degraded once at the threshold, recovered on first good scan', () => {
        const m = new ScanHealthMonitor(3);
        expect(m.observe(0, true, 1000)).toBeNull();
        expect(m.observe(0, true, 2000)).toBeNull();
        const degraded = m.observe(0, true, 3000);
        expect(degraded).toEqual({ kind: 'degraded', emptyCycles: 3, sinceMs: 1000 });
        // stays silent while the episode continues — no alert spam
        expect(m.observe(0, true, 4000)).toBeNull();
        expect(m.observe(0, true, 5000)).toBeNull();
        const recovered = m.observe(65, true, 6000);
        expect(recovered?.kind).toBe('recovered');
        expect(recovered?.sinceMs).toBe(1000);
        // a new episode alerts again
        expect(m.observe(0, true, 7000)).toBeNull();
        expect(m.observe(0, true, 8000)).toBeNull();
        expect(m.observe(0, true, 9000)?.kind).toBe('degraded');
    });

    test('healthy scans below threshold never alert', () => {
        const m = new ScanHealthMonitor(3);
        expect(m.observe(0, true)).toBeNull();
        expect(m.observe(0, true)).toBeNull();
        expect(m.observe(40, true)).toBeNull(); // reset before threshold, no recovery msg
        expect(m.observe(0, true)).toBeNull();
        expect(m.observe(0, true)).toBeNull();
    });

    test('closed-market cycles are ignored entirely', () => {
        const m = new ScanHealthMonitor(2);
        expect(m.observe(0, false)).toBeNull();
        expect(m.observe(0, false)).toBeNull();
        expect(m.observe(0, false)).toBeNull();
        // market opens: episode starts fresh
        expect(m.observe(0, true, 100)).toBeNull();
        expect(m.observe(0, true, 200)?.kind).toBe('degraded');
        // an overnight (closed) cycle must not clear a live episode
        expect(m.observe(50, false)).toBeNull();
        expect(m.observe(30, true)?.kind).toBe('recovered');
    });
});
