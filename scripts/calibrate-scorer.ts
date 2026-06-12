/**
 * Scorer calibration — walk-forward grid search over the signal scorer's
 * factor weights (momentum / mean-reversion / volume / trend).
 *
 * For each candidate weight set, runs a walk-forward backtest and ranks by
 * AVERAGE OUT-OF-SAMPLE SHARPE (the honest number), with a penalty for
 * fold sets that barely trade. Read-only by default; --apply writes the
 * winner to .dexter/data/scorer-weights.json, which the LIVE scorer and
 * future backtests then pick up automatically.
 *
 * Run (requires FirstRate data, FIRSTRATE_DATA_DIR in .env):
 *   bun run scripts/calibrate-scorer.ts AAPL NVDA MSFT 2024-01-02 2024-12-30
 *   bun run scripts/calibrate-scorer.ts AAPL --fine          # denser grid
 *   bun run scripts/calibrate-scorer.ts AAPL --apply         # write winner
 */

import 'dotenv/config';

import { runBacktest } from '@/backtest/engine';
import {
    DEFAULT_WEIGHTS,
    setActiveWeights,
    type FactorWeights,
} from '@/tools/ibkr/signal-scorer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const fine = args.includes('--fine');
const tickers = args.filter((a) => /^[A-Za-z.]+$/.test(a) && !a.startsWith('--')).map((t) => t.toUpperCase());
const dates = args.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));

const TICKERS = tickers.length ? tickers : ['AAPL'];
const START = dates[0] ?? '2024-01-02';
const END = dates[1] ?? '2024-12-30';
const MIN_OOS_TRADES = 10; // below this across all folds, the result is noise

// ---------------------------------------------------------------------------
// Candidate grid
// ---------------------------------------------------------------------------

function simplex(step: number): FactorWeights[] {
    const out: FactorWeights[] = [];
    const n = Math.round(1 / step);
    for (let m = 0; m <= n; m++) {
        for (let r = 0; r + m <= n; r++) {
            for (let v = 0; v + r + m <= n; v++) {
                const t = n - m - r - v;
                out.push({ momentum: m * step, meanReversion: r * step, volume: v * step, trend: t * step });
            }
        }
    }
    return out;
}

const grid = fine ? simplex(0.1) : simplex(0.25);
// Always evaluate the current defaults explicitly (baseline).
if (!grid.some((w) => JSON.stringify(w) === JSON.stringify(DEFAULT_WEIGHTS))) {
    grid.unshift(DEFAULT_WEIGHTS);
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

interface Row {
    weights: FactorWeights;
    oosSharpe: number;
    oosReturnPct: number;
    oosTrades: number;
    folds: number;
    penalized: boolean;
}

function fmtW(w: FactorWeights): string {
    return `M${w.momentum.toFixed(2)} R${w.meanReversion.toFixed(2)} V${w.volume.toFixed(2)} T${w.trend.toFixed(2)}`;
}

console.log(`\n=== Scorer calibration (walk-forward grid search) ===`);
console.log(`Tickers : ${TICKERS.join(', ')}   period ${START} → ${END}`);
console.log(`Grid    : ${grid.length} weight sets (${fine ? 'fine 0.10' : 'coarse 0.25'})`);
console.log(`Metric  : average out-of-sample Sharpe across folds (min ${MIN_OOS_TRADES} OOS trades)\n`);

const rows: Row[] = [];
const t0 = Date.now();

for (let i = 0; i < grid.length; i++) {
    const w = grid[i];
    setActiveWeights(w);
    try {
        const result = await runBacktest({
            tickers: TICKERS,
            dataSource: 'firstrate',
            startDate: START,
            endDate: END,
            timeframe: '5m',
            minSignalScore: 60,
            direction: 'long',
            walkForward: true,
        });
        const folds = result.folds ?? [];
        const oosSharpe = folds.length
            ? folds.reduce((a, f) => a + f.testMetrics.sharpeRatio, 0) / folds.length
            : NaN;
        const oosTrades = result.metrics.totalTrades;
        rows.push({
            weights: w,
            oosSharpe,
            oosReturnPct: result.metrics.totalReturnPct,
            oosTrades,
            folds: folds.length,
            penalized: oosTrades < MIN_OOS_TRADES,
        });
        console.log(
            `[${String(i + 1).padStart(3)}/${grid.length}] ${fmtW(w)}  ` +
            `OOS Sharpe ${Number.isFinite(oosSharpe) ? oosSharpe.toFixed(2).padStart(6) : '   n/a'}  ` +
            `trades ${String(oosTrades).padStart(4)}${oosTrades < MIN_OOS_TRADES ? '  (too few — penalized)' : ''}`,
        );
    } catch (err) {
        console.log(`[${String(i + 1).padStart(3)}/${grid.length}] ${fmtW(w)}  FAILED: ${err}`);
    } finally {
        setActiveWeights(null);
    }
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

const ranked = rows
    .filter((r) => Number.isFinite(r.oosSharpe))
    .sort((a, b) => {
        if (a.penalized !== b.penalized) return a.penalized ? 1 : -1;
        return b.oosSharpe - a.oosSharpe;
    });

console.log(`\n=== Top 10 (of ${ranked.length} valid, ${((Date.now() - t0) / 60000).toFixed(1)} min) ===`);
console.log('rank  weights                          OOS-Sharpe  OOS-return  trades');
ranked.slice(0, 10).forEach((r, i) => {
    console.log(
        String(i + 1).padStart(4) + '  ' +
        fmtW(r.weights).padEnd(32) + ' ' +
        r.oosSharpe.toFixed(2).padStart(9) + '  ' +
        `${(r.oosReturnPct * 100).toFixed(1)}%`.padStart(9) + '  ' +
        String(r.oosTrades).padStart(5) +
        (r.penalized ? '  ⚠ few trades' : ''),
    );
});

const baseline = rows.find((r) => JSON.stringify(r.weights) === JSON.stringify(DEFAULT_WEIGHTS));
if (baseline) {
    console.log(`\nBaseline (equal weights): OOS Sharpe ${baseline.oosSharpe.toFixed(2)}, ${baseline.oosTrades} trades`);
}

const best = ranked[0];
if (!best) {
    console.log('\nNo valid result — check data availability.');
    process.exit(1);
}

if (apply) {
    if (best.penalized) {
        console.log('\nRefusing --apply: best candidate traded too little to be trusted.');
        process.exit(1);
    }
    if (baseline && best.oosSharpe <= baseline.oosSharpe + 0.05) {
        console.log('\nRefusing --apply: best candidate does not meaningfully beat the equal-weight baseline (Δ ≤ 0.05 Sharpe). Keeping defaults.');
        process.exit(0);
    }
    const dir = process.env.DEXTER_DATA_DIR ?? join(process.cwd(), '.dexter', 'data');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'scorer-weights.json');
    writeFileSync(path, JSON.stringify({
        ...best.weights,
        _meta: {
            calibratedAt: new Date().toISOString(),
            tickers: TICKERS,
            period: `${START}..${END}`,
            oosSharpe: best.oosSharpe,
            oosTrades: best.oosTrades,
            baselineSharpe: baseline?.oosSharpe ?? null,
        },
    }, null, 2));
    console.log(`\nApplied: ${fmtW(best.weights)} written to ${path}`);
    console.log('The live scorer and future backtests will use these weights (restart required for running processes).');
} else {
    console.log(`\nDry run — best candidate: ${fmtW(best.weights)} (OOS Sharpe ${best.oosSharpe.toFixed(2)}).`);
    console.log('Re-run with --apply to write it to .dexter/data/scorer-weights.json.');
}
