import { describe, expect, test } from 'bun:test';
import type { Bar } from './data-loader.js';
import { Simulator } from './simulator.js';

// WP9 (REMEDIATION-2026-08-20): the first tests src/backtest/ has ever
// had. The anchor: an order submitted on bar i fills at bar i+1's OPEN —
// the old engine advanced the simulator with the signal bar, harvesting
// each bar's own body on entry (the plausible origin of the rejected
// 7.96 OOS Sharpe).

const bar = (time: string, open: number, high: number, low: number, close: number): Bar =>
    ({ time, open, high, low, close, volume: 10_000 });

const tick = (sim: Simulator, time: string, bars: Record<string, Bar>) =>
    sim.processBars(time, new Map(Object.entries(bars)));

// Slippage off for arithmetic-exact assertions unless a test wants it.
const noSlip = { slippageModel: 'proportional' as const, slippageBps: 0, minCommission: 0, commissionPerShare: 0 };

describe('ANCHOR: next-bar fill contract', () => {
    test('an order submitted on bar i fills at bar i+1 open, never bar i', () => {
        const sim = new Simulator({ ...noSlip });
        tick(sim, 't1', { AAA: bar('t1', 100, 101, 99, 101) });
        // Signal fires AFTER t1 was processed (engine order) — submit now.
        sim.submitOrder({ symbol: 'AAA', direction: 'long', quantity: 10, stopLoss: 90, takeProfit: 120 });
        expect(sim.getOpenPositionCount()).toBe(0); // nothing fills on the signal bar
        tick(sim, 't2', { AAA: bar('t2', 103, 104, 102, 104) });
        expect(sim.getOpenPositionCount()).toBe(1);
        expect(sim.getPositionsForSymbol('AAA')[0].entryPrice).toBe(103); // t2's OPEN
        expect(sim.getPositionsForSymbol('AAA')[0].entryTime).toBe('t2');
    });

    test('an order whose symbol has no bar this tick stays pending for its next bar', () => {
        const sim = new Simulator({ ...noSlip });
        sim.submitOrder({ symbol: 'BBB', direction: 'long', quantity: 5, stopLoss: 90, takeProfit: 120 });
        tick(sim, 't1', { AAA: bar('t1', 50, 51, 49, 50) }); // BBB absent
        expect(sim.getOpenPositionCount()).toBe(0);
        tick(sim, 't2', { BBB: bar('t2', 100, 101, 99, 100) });
        expect(sim.getPositionsForSymbol('BBB')[0]?.entryPrice).toBe(100);
    });
});

describe('gap-aware exits', () => {
    test('a long stop gapped through fills at the OPEN, not the stop level', () => {
        const sim = new Simulator({ ...noSlip });
        sim.submitOrder({ symbol: 'AAA', direction: 'long', quantity: 10, stopLoss: 95, takeProfit: 120 });
        tick(sim, 't1', { AAA: bar('t1', 100, 101, 99, 100) }); // entry @ 100
        tick(sim, 't2', { AAA: bar('t2', 90, 92, 88, 91) }); // gaps 10 through the stop
        expect(sim.trades.length).toBe(1);
        expect(sim.trades[0].exitPrice).toBe(90); // the open, the honest loss
        expect(sim.trades[0].exitReason).toBe('stop_loss');
    });

    test('a short stop gapped through fills at the open (mirror)', () => {
        const sim = new Simulator({ ...noSlip });
        sim.submitOrder({ symbol: 'AAA', direction: 'short', quantity: 10, stopLoss: 105, takeProfit: 80 });
        tick(sim, 't1', { AAA: bar('t1', 100, 101, 99, 100) });
        tick(sim, 't2', { AAA: bar('t2', 112, 113, 111, 112) });
        expect(sim.trades[0].exitPrice).toBe(112);
        expect(sim.trades[0].exitReason).toBe('stop_loss');
    });

    test('a target gapped through fills at the open (the better price a resting limit gets)', () => {
        const sim = new Simulator({ ...noSlip });
        sim.submitOrder({ symbol: 'AAA', direction: 'long', quantity: 10, stopLoss: 90, takeProfit: 110 });
        tick(sim, 't1', { AAA: bar('t1', 100, 101, 99, 100) });
        tick(sim, 't2', { AAA: bar('t2', 115, 116, 114, 115) });
        expect(sim.trades[0].exitPrice).toBe(115);
        expect(sim.trades[0].exitReason).toBe('take_profit');
    });

    test('an intrabar stop (no gap) still fills at the stop level', () => {
        const sim = new Simulator({ ...noSlip });
        sim.submitOrder({ symbol: 'AAA', direction: 'long', quantity: 10, stopLoss: 95, takeProfit: 120 });
        tick(sim, 't1', { AAA: bar('t1', 100, 101, 99, 100) });
        tick(sim, 't2', { AAA: bar('t2', 98, 99, 94, 96) }); // trades through 95
        expect(sim.trades[0].exitPrice).toBe(95);
    });
});

describe('per-symbol advance (the first-ticker bug is dead)', () => {
    test("each position exits on ITS OWN symbol's bar, marks on its own close", () => {
        const sim = new Simulator({ ...noSlip });
        sim.submitOrder({ symbol: 'AAA', direction: 'long', quantity: 10, stopLoss: 95, takeProfit: 200 });
        sim.submitOrder({ symbol: 'BBB', direction: 'long', quantity: 10, stopLoss: 45, takeProfit: 200 });
        tick(sim, 't1', { AAA: bar('t1', 100, 101, 99, 100), BBB: bar('t1', 50, 51, 49, 50) });
        expect(sim.getOpenPositionCount()).toBe(2);
        // BBB crashes through ITS stop; AAA is fine. Under the old code
        // whichever bar came first priced BOTH.
        tick(sim, 't2', { AAA: bar('t2', 101, 102, 100, 101), BBB: bar('t2', 44, 45, 43, 44) });
        expect(sim.trades.length).toBe(1);
        expect(sim.trades[0].symbol).toBe('BBB');
        expect(sim.trades[0].exitPrice).toBe(44); // BBB's open (gap through 45)
        expect(sim.getPositionsForSymbol('AAA').length).toBe(1);
        // Equity marks AAA at AAA's close, not BBB's.
        const lastPoint = sim.equityCurve[sim.equityCurve.length - 1];
        // cash after: 100k -1000(AAA) -500(BBB) +440(BBB exit) = 98940; AAA marked 10×101.
        expect(lastPoint.equity).toBeCloseTo(98_940 + 1_010, 2);
    });
});

describe('risk-based auto-sizing (matches the live sizer shape)', () => {
    test('tight stop: the notional cap binds', () => {
        // byRisk = 0.25% × 100k / $1 = 250 shares; byCap = 5% × 100k / 100 = 50.
        const sim = new Simulator({ ...noSlip, maxRiskPerTradePct: 0.0025, maxPositionPct: 0.05 });
        sim.submitOrder({ symbol: 'AAA', direction: 'long', quantity: 0, stopLoss: 99, takeProfit: 110 });
        tick(sim, 't1', { AAA: bar('t1', 100, 101, 99.5, 100) });
        expect(sim.getPositionsForSymbol('AAA')[0].quantity).toBe(50);
    });

    test('wide stop: the risk budget binds — the old sizer always took the cap', () => {
        // byRisk = 250 / $10 = 25 shares; byCap = 50.
        const sim = new Simulator({ ...noSlip, maxRiskPerTradePct: 0.0025, maxPositionPct: 0.05 });
        sim.submitOrder({ symbol: 'AAA', direction: 'long', quantity: 0, stopLoss: 90, takeProfit: 130 });
        tick(sim, 't1', { AAA: bar('t1', 100, 101, 99, 100) });
        expect(sim.getPositionsForSymbol('AAA')[0].quantity).toBe(25);
    });
});

describe('closeAll uses each symbol last close and lands on the equity curve', () => {
    test('final equity point reflects the terminal closes', () => {
        const sim = new Simulator({ ...noSlip });
        sim.submitOrder({ symbol: 'AAA', direction: 'long', quantity: 10, stopLoss: 50, takeProfit: 500 });
        sim.submitOrder({ symbol: 'BBB', direction: 'long', quantity: 10, stopLoss: 10, takeProfit: 500 });
        tick(sim, 't1', { AAA: bar('t1', 100, 101, 99, 100), BBB: bar('t1', 50, 51, 49, 50) });
        tick(sim, 't2', { AAA: bar('t2', 102, 103, 101, 102), BBB: bar('t2', 52, 53, 51, 52) });
        sim.closeAll('end_of_backtest');
        expect(sim.trades.length).toBe(2);
        const bySym = Object.fromEntries(sim.trades.map((t) => [t.symbol, t.exitPrice]));
        expect(bySym.AAA).toBe(102); // its own last close
        expect(bySym.BBB).toBe(52);
        // The curve's final point includes the realized result (the old
        // closeAll mutated cash without a curve point — headline return
        // and trade sum disagreed by construction).
        const last = sim.equityCurve[sim.equityCurve.length - 1];
        expect(last.equity).toBeCloseTo(100_000 + 20 + 20, 2);
    });
});
