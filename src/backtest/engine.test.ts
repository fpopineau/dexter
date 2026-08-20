import { describe, expect, test } from 'bun:test';
import type { Bar } from './data-loader.js';
import { ENGINE_VERSION, runSimulation, type EngineConfig } from './engine.js';
import { Simulator } from './simulator.js';

// WP9: the engine's ordering contract — advance the simulator with bar i
// BEFORE generating signals from bar i, so a signal's order fills at bar
// i+1's open. signalOverride injects a deterministic strategy (the real
// scorer is not the thing under test here).

function mkBars(n: number, startPrice: number, step: number, day = '2026-05-04'): Bar[] {
    return Array.from({ length: n }, (_, i) => {
        const price = startPrice + i * step;
        const hh = String(9 + Math.floor(i / 12)).padStart(2, '0');
        const mm = String((i % 12) * 5).padStart(2, '0');
        return { time: `${day} ${hh}:${mm}:00`, open: price, high: price + 1, low: price - 1, close: price + 0.5, volume: 10_000 };
    });
}

function cfg(overrides: Partial<EngineConfig> = {}): EngineConfig {
    return {
        tickers: ['AAA'],
        dataSource: 'archive',
        startDate: '2026-05-04',
        endDate: '2026-05-05',
        lookbackBars: 3,
        ...overrides,
    };
}

const NO_SENTIMENT = new Map<string, never[]>();
const SIM = { slippageModel: 'proportional' as const, slippageBps: 0, minCommission: 0, commissionPerShare: 0 };

describe('engine ordering (advance BEFORE signal)', () => {
    test('a signal on bar i produces an entry at bar i+1 open', () => {
        const bars = mkBars(10, 100, 1);
        let fired: string | null = null;
        const config = cfg({
            simulator: SIM,
            signalOverride: (ticker, _window, bar) => {
                if (fired) return null; // one shot
                fired = bar.time;
                return { symbol: ticker, direction: 'long', quantity: 10, stopLoss: 50, takeProfit: 500 };
            },
        });
        const sim = new Simulator(SIM);
        runSimulation(config, new Map([['AAA', bars]]), NO_SENTIMENT, sim);
        expect(fired).not.toBeNull();
        const firedIdx = bars.findIndex((b) => b.time === fired);
        // The entry is the NEXT bar's open — never the signal bar's.
        expect(sim.trades.length + sim.getOpenPositionCount()).toBeGreaterThan(0);
        const entryTime = sim.trades[0]?.entryTime ?? sim.getPositionsForSymbol('AAA')[0].entryTime;
        const entryPrice = sim.trades[0]?.entryPrice ?? sim.getPositionsForSymbol('AAA')[0].entryPrice;
        expect(entryTime).toBe(bars[firedIdx + 1].time);
        expect(entryPrice).toBe(bars[firedIdx + 1].open);
    });

    test('warm-up bars (before startDate) feed indicators but never signal or land on the curve', () => {
        const warm = mkBars(6, 90, 1, '2026-05-01');
        const live = mkBars(6, 100, 1, '2026-05-04');
        const seen: string[] = [];
        const config = cfg({
            simulator: SIM,
            signalOverride: (_t, _w, bar) => {
                seen.push(bar.time);
                return null;
            },
        });
        const sim = new Simulator(SIM);
        runSimulation(config, new Map([['AAA', [...warm, ...live]]]), NO_SENTIMENT, sim);
        // Signals only from startDate on…
        expect(seen.every((t) => t >= '2026-05-04')).toBe(true);
        expect(seen.length).toBeGreaterThan(0);
        // …and the equity curve starts at startDate too (no flat warm-up
        // padding diluting Sharpe).
        expect(sim.equityCurve.every((p) => p.time >= '2026-05-04')).toBe(true);
    });

    test('multi-symbol: signals price off their own symbol (the first-ticker bug)', () => {
        const aaa = mkBars(8, 100, 1);
        const bbb = mkBars(8, 50, -2); // crashing
        let submitted = 0;
        const config = cfg({
            tickers: ['AAA', 'BBB'],
            simulator: SIM,
            signalOverride: (ticker, _w, bar) => {
                if (ticker !== 'BBB' || submitted++) return null;
                return { symbol: 'BBB', direction: 'long', quantity: 10, stopLoss: bar.close - 3, takeProfit: 500 };
            },
        });
        const sim = new Simulator(SIM);
        runSimulation(config, new Map([['AAA', aaa], ['BBB', bbb]]), NO_SENTIMENT, sim);
        // BBB entered on a BBB open and stopped on a BBB bar — every price
        // in its trade belongs to BBB's tape (≤ 50), never AAA's (≥ 100).
        expect(sim.trades.length).toBe(1);
        const t = sim.trades[0];
        expect(t.symbol).toBe('BBB');
        expect(t.entryPrice).toBeLessThan(60);
        expect(t.exitPrice).toBeLessThan(60);
    });
});

describe('engine version stamp', () => {
    test('the honest-replay version is exported (calibrate-scorer refuses older engines)', () => {
        expect(ENGINE_VERSION).toContain('wp9');
    });
});
