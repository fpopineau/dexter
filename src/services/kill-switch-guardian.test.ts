import { describe, expect, test } from 'bun:test';
import { decideGuardianStep, FAILSAFE_PERSIST_TICKS } from './kill-switch-guardian.js';

describe('kill-switch guardian (review 2026-08-23 — cleanup repeats until the book is clean)', () => {
    const D = '2026-08-24';

    test('a LATCHED halt alerts once per ET day but cleans up EVERY tick', () => {
        const latched = { halted: true, latched: true };
        expect(decideGuardianStep(latched, null, D, 0)).toEqual({ alert: true, cleanup: true });
        // Same day, already alerted: no second alert — cleanup continues
        // (the old one-shot marked the day handled before cancels landed).
        expect(decideGuardianStep(latched, D, D, 0)).toEqual({ alert: false, cleanup: true });
        // A new day's latch alerts again.
        expect(decideGuardianStep(latched, D, '2026-08-25', 0)).toEqual({ alert: true, cleanup: true });
    });

    test('a TRANSIENT unverifiable account never cancels; a PERSISTENT one does', () => {
        const failsafe = { halted: true, latched: false };
        // One hiccup — the gates already refuse new risk; stripping working
        // orders on a 60-second outage would turn a hiccup into churn.
        expect(decideGuardianStep(failsafe, null, D, 1)).toEqual({ alert: false, cleanup: false });
        expect(decideGuardianStep(failsafe, null, D, FAILSAFE_PERSIST_TICKS - 1)).toEqual({ alert: false, cleanup: false });
        // Persistently unverifiable: pending entries are FUTURE RISK on an
        // account whose losses cannot be observed — clean them up.
        expect(decideGuardianStep(failsafe, null, D, FAILSAFE_PERSIST_TICKS)).toEqual({ alert: true, cleanup: true });
        expect(decideGuardianStep(failsafe, D, D, FAILSAFE_PERSIST_TICKS + 3)).toEqual({ alert: false, cleanup: true });
    });

    test('healthy status does nothing', () => {
        expect(decideGuardianStep({ halted: false }, null, D, 0)).toEqual({ alert: false, cleanup: false });
        expect(decideGuardianStep({ halted: false }, D, D, 99)).toEqual({ alert: false, cleanup: false });
    });
});

describe('selectEntryParents (omission 7 — broker-truth halt cleanup)', () => {
    test('only bracket ENTRY parents are candidates; exits, protects, closes and foreign refs never are', async () => {
        const { selectEntryParents } = await import('./kill-switch-guardian.js');
        const picked = selectEntryParents([
            { orderId: 1, orderRef: 'P-1A2B:entry' },   // ✓ bracket parent
            { orderId: 2, orderRef: 'P-1A2B:tp' },      // exit — never
            { orderId: 3, orderRef: 'P-1A2B:stop' },    // protection — never
            { orderId: 4, orderRef: 'protect-XYZ:stop' }, // protection — never
            { orderId: 5, orderRef: 'close-XYZ' },      // risk-reducing — never
            { orderId: 6, orderRef: 'reduce-XYZ' },     // risk-reducing — never
            { orderId: 7, orderRef: null },             // foreign — never
            { orderId: 8, orderRef: 'P-9F00:entry' },   // ✓ another parent (orphaned/executing rows included)
        ]);
        expect(picked.map((o) => o.orderId)).toEqual([1, 8]);
    });
});
