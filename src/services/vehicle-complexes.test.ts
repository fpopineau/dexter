import { describe, expect, test } from 'bun:test';
import {
    complexAdmission,
    complexesOf,
    isVehicle,
    loadVehicleComplexes,
    oppositeDirectionConflict,
    parseVehicleComplexes,
} from './vehicle-complexes.js';

const YAML = `
# comment
semis:
  vehicles: SOXL, SOXS, SMH
  constituents: NVDA, AMD, MU
crypto:
  vehicles: IBIT
  constituents: MSTR, COIN, NVDA
`;

describe('vehicle complexes (REQ-SCAN-007/008 — a 3x ETF and its underlyings are ONE information source)', () => {
    test('parseVehicleComplexes reads the two-level yaml into named complexes (tickers upper-cased, trimmed)', () => {
        const cx = parseVehicleComplexes(YAML);
        expect(cx.map((c) => c.name)).toEqual(['semis', 'crypto']);
        expect(cx[0].vehicles).toEqual(['SOXL', 'SOXS', 'SMH']);
        expect(cx[0].constituents).toEqual(['NVDA', 'AMD', 'MU']);
    });

    test('validation fails LOUD: empty lists, a vehicle in two complexes, a symbol both vehicle and constituent', () => {
        expect(() => parseVehicleComplexes('semis:\n  vehicles: SOXL\n')).toThrow(/constituents/);
        expect(() => parseVehicleComplexes('a:\n  vehicles: SOXL\n  constituents: NVDA\nb:\n  vehicles: SOXL\n  constituents: AMD\n')).toThrow(/SOXL/);
        expect(() => parseVehicleComplexes('a:\n  vehicles: SOXL\n  constituents: SOXL\n')).toThrow(/SOXL/);
        expect(() => parseVehicleComplexes('a:\n  vehicles: soxl!\n  constituents: NVDA\n')).toThrow(/ticker/);
    });

    test('lookups: complexesOf lists every complex a symbol belongs to; isVehicle only for vehicles', () => {
        const cx = parseVehicleComplexes(YAML);
        expect(complexesOf('NVDA', cx).map((c) => c.name)).toEqual(['semis', 'crypto']);
        expect(complexesOf('soxl', cx).map((c) => c.name)).toEqual(['semis']);
        expect(complexesOf('AAPL', cx)).toEqual([]);
        expect(isVehicle('SOXS', cx)).toBe(true);
        expect(isVehicle('NVDA', cx)).toBe(false);
    });

    test('complexAdmission: a constituent joins when its move is at least one daily ATR (1% floor); misses admit nothing', () => {
        expect(complexAdmission(4.1, 3.5)).toBe('long');       // +4.1% on a 3.5% ATR name — the MU case
        expect(complexAdmission(-3.0, 2.0)).toBe('short');
        expect(complexAdmission(2.0, 3.5)).toBeNull();         // under one ATR
        expect(complexAdmission(0.8, 0.5)).toBeNull();         // over one ATR but under the 1% floor
        expect(complexAdmission(null, 3.5)).toBeNull();
        expect(complexAdmission(4.1, null)).toBeNull();        // no ATR → no admission (never guesses)
        expect(complexAdmission(4.1, 0)).toBeNull();
    });

    test('oppositeDirectionConflict: a working row on the same complex in the OPPOSITE direction names the rival; same direction or other complex is free', () => {
        const cx = parseVehicleComplexes(YAML);
        const working = [
            { id: 'P-SOXL', symbol: 'SOXL', direction: 'short' as const },
            { id: 'P-COIN', symbol: 'COIN', direction: 'long' as const },
        ];
        const hit = oppositeDirectionConflict('MU', 'long', working, cx);
        expect(hit?.rivalId).toBe('P-SOXL');
        expect(hit?.complex).toBe('semis');
        expect(oppositeDirectionConflict('MU', 'short', working, cx)).toBeNull();   // same side as the vehicle
        expect(oppositeDirectionConflict('MSTR', 'short', working, cx)?.rivalId).toBe('P-COIN');
        expect(oppositeDirectionConflict('AAPL', 'long', working, cx)).toBeNull();  // no complex
        expect(oppositeDirectionConflict('NVDA', 'long', [], cx)).toBeNull();
        // the row itself is never its own rival
        expect(oppositeDirectionConflict('SOXL', 'long', working, cx, 'P-SOXL')).toBeNull();
    });

    test('the shipped config loads and validates', () => {
        const cx = loadVehicleComplexes();
        expect(cx.length).toBeGreaterThanOrEqual(2);
        expect(isVehicle('SOXL', cx)).toBe(true);
        expect(complexesOf('MU', cx).length).toBeGreaterThan(0);
    });
});
