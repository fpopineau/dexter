import { describe, expect, test } from 'bun:test';
import { decideGuardianStep } from './kill-switch-guardian.js';

describe('kill-switch guardian (review 2026-08-23 — continuous observation IS enforcement)', () => {
    test('a LATCHED halt is handled exactly once per ET day', () => {
        expect(decideGuardianStep({ halted: true, latched: true }, null, '2026-08-24')).toBe('handle');
        expect(decideGuardianStep({ halted: true, latched: true }, '2026-08-24', '2026-08-24')).toBe('none');
        // A new day with a new latch handles again.
        expect(decideGuardianStep({ halted: true, latched: true }, '2026-08-24', '2026-08-25')).toBe('handle');
    });

    test('halted-but-NOT-latched (unverifiable P&L, missing FX) never cancels working orders', () => {
        // The gates already refuse new risk on this status; stripping working
        // entries on a broker hiccup would turn an outage into forced churn.
        expect(decideGuardianStep({ halted: true, latched: false }, null, '2026-08-24')).toBe('none');
        expect(decideGuardianStep({ halted: true }, null, '2026-08-24')).toBe('none');
    });

    test('healthy status does nothing', () => {
        expect(decideGuardianStep({ halted: false }, null, '2026-08-24')).toBe('none');
    });
});
