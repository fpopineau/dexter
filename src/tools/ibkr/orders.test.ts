import { describe, expect, test } from 'bun:test';
import { checkReduceOnly } from './orders.js';

describe('checkReduceOnly — ibkr_orders place may only shrink a position', () => {
    test('no position → refused (opening exposure)', () => {
        const r = checkReduceOnly('BUY', 10, 0);
        expect(r.ok).toBe(false);
        expect(r.reason).toContain('trade proposal');
        expect(checkReduceOnly('SELL', 10, 0).ok).toBe(false);
    });

    test('long position: SELL up to the held size passes, BUY refused', () => {
        expect(checkReduceOnly('SELL', 10, 25).ok).toBe(true);
        expect(checkReduceOnly('SELL', 25, 25).ok).toBe(true);
        const add = checkReduceOnly('BUY', 5, 25);
        expect(add.ok).toBe(false);
        expect(add.reason).toContain('adds exposure');
    });

    test('short position: BUY up to |size| passes, SELL refused', () => {
        expect(checkReduceOnly('BUY', 10, -25).ok).toBe(true);
        expect(checkReduceOnly('SELL', 5, -25).ok).toBe(false);
    });

    test('overshoot that would reverse the position is refused', () => {
        const r = checkReduceOnly('SELL', 30, 25);
        expect(r.ok).toBe(false);
        expect(r.reason).toContain('reverse');
        expect(checkReduceOnly('BUY', 26, -25).ok).toBe(false);
    });
});
