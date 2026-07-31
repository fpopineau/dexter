import { describe, expect, test } from 'bun:test';
import { decideEodAction } from './eod-triage.js';

describe('EOD triage decision', () => {
    test('losing AND fading → close (the operator rule)', () => {
        const d = decideEodAction({ direction: 'long', entryFill: 193.11, last: 191.2, hourAgo: 192.4 });
        expect(d.action).toBe('close');
        expect(d.reason).toContain('losing');
        expect(d.reason).toContain('fading');
    });

    test('losing but stabilizing/recovering → keep', () => {
        const d = decideEodAction({ direction: 'long', entryFill: 193.11, last: 191.2, hourAgo: 190.5 });
        expect(d.action).toBe('keep');
        expect(d.reason).toContain('stabilizing');
    });

    test('winning → keep, regardless of momentum', () => {
        expect(decideEodAction({ direction: 'long', entryFill: 193.11, last: 196, hourAgo: 197 }).action).toBe('keep');
        expect(decideEodAction({ direction: 'long', entryFill: 193.11, last: 196, hourAgo: 195 }).action).toBe('keep');
    });

    test('short positions mirror: losing = price above fill, fading = still rising', () => {
        expect(decideEodAction({ direction: 'short', entryFill: 100, last: 101.5, hourAgo: 100.8 }).action).toBe('close');
        expect(decideEodAction({ direction: 'short', entryFill: 100, last: 101.5, hourAgo: 102.2 }).action).toBe('keep');
        expect(decideEodAction({ direction: 'short', entryFill: 100, last: 98.5, hourAgo: 98 }).action).toBe('keep');
    });

    test('unknown momentum or bad prices never close — doubt favors holding', () => {
        expect(decideEodAction({ direction: 'long', entryFill: 100, last: 98, hourAgo: null }).action).toBe('keep');
        expect(decideEodAction({ direction: 'long', entryFill: 100, last: 0, hourAgo: 99 }).action).toBe('keep');
    });

    test('exactly breakeven counts as winning (kept)', () => {
        expect(decideEodAction({ direction: 'long', entryFill: 100, last: 100, hourAgo: 101 }).action).toBe('keep');
    });
});
