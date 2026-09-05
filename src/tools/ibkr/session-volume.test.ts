import { describe, expect, test } from 'bun:test';
import { sessionVolumeFromBars } from './signal-scorer.js';

describe('sessionVolumeFromBars (REQ-SCAN-004 — dollar volume needs the session cumulative volume)', () => {
    test('sums the volume of bars sharing the newest bar\'s date; earlier days are excluded', () => {
        const times = ['20260904  15:55:00', '20260905  09:35:00', '20260905  09:40:00', '20260905  09:45:00'];
        const volumes = [1_000_000, 200, 300, 500];
        expect(sessionVolumeFromBars(times, volumes)).toBe(1000);
    });

    test('empty input → null; bars without a parseable date are skipped', () => {
        expect(sessionVolumeFromBars([], [])).toBeNull();
        expect(sessionVolumeFromBars(['garbage', '20260905  09:35:00'], [5, 7])).toBe(7);
    });
});
