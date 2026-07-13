/**
 * Day2Day backtest demo — runs the full pipeline (data loading, TA, signal
 * scoring, simulated execution, metrics) on historical data. Read-only:
 * no IBKR connection, no orders, no LLM keys required.
 *
 * Data: FirstRate 1-minute ZIPs (set FIRSTRATE_DATA_DIR in .env) or the
 * local SQLite archive (dataSource 'archive'). Optional GDELT sentiment
 * overlay via GDELT_DATA_DIR.
 *
 * Run:
 *   bun run scripts/demo-backtest.ts                       # AAPL, 6 months, walk-forward
 *   bun run scripts/demo-backtest.ts NVDA TSLA             # custom tickers
 *   bun run scripts/demo-backtest.ts AAPL 2024-01-02 2024-12-30
 */

import 'dotenv/config';

import { runBacktest } from '@/backtest/engine';

const args = process.argv.slice(2);
const tickers = args.filter((a) => /^[A-Za-z.]+$/.test(a)).map((t) => t.toUpperCase());
const dates = args.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));

const config = {
    tickers: tickers.length ? tickers : ['AAPL'],
    dataSource: 'firstrate' as const,
    startDate: dates[0] ?? '2024-01-02',
    endDate: dates[1] ?? '2024-12-30',
    timeframe: '5m' as const,
    minSignalScore: 60,
    direction: 'long' as const,
    stopAtrMultiple: 2.0,
    targetAtrMultiple: 3.0,
    walkForward: true,
    // Sentiment overlay activates only if GDELT_DATA_DIR points to parquet files
    useSentiment: Boolean(process.env.GDELT_DATA_DIR),
};

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
const usd = (x: number) => `$${x.toFixed(2)}`;

console.log(`\n=== Day2Day Backtest Demo ===`);
console.log(`Tickers   : ${config.tickers.join(', ')}`);
console.log(`Period    : ${config.startDate} → ${config.endDate} (${config.timeframe} bars)`);
console.log(`Signals   : ${config.direction}, score ≥ ${config.minSignalScore}, stop ${config.stopAtrMultiple}×ATR, target ${config.targetAtrMultiple}×ATR`);
console.log(`Sentiment : ${config.useSentiment ? 'GDELT overlay ON' : 'off (set GDELT_DATA_DIR to enable)'}\n`);

const t0 = Date.now();
const result = await runBacktest(config);
const m = result.metrics;

console.log(`Completed in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
console.log(`--- Performance -------------------------------`);
console.log(`Total return      ${pct(m.totalReturnPct)}   (CAGR ${pct(m.cagr)})`);
console.log(`Sharpe / Sortino  ${m.sharpeRatio.toFixed(2)} / ${m.sortinoRatio.toFixed(2)}`);
console.log(`Max drawdown      ${pct(m.maxDrawdownPct)} (${m.maxDrawdownDuration} bars)`);
console.log(`--- Trades ------------------------------------`);
console.log(`Trades            ${m.totalTrades}  (win rate ${pct(m.winRate)})`);
console.log(`Avg win / loss    ${usd(m.avgWin)} / ${usd(m.avgLoss)}   payoff ${m.payoffRatio.toFixed(2)}`);
console.log(`Profit factor     ${m.profitFactor.toFixed(2)}   expectancy ${usd(m.expectancy)}`);
console.log(`Costs             commissions ${usd(m.totalCommissions)}, slippage ${usd(m.totalSlippage)}`);

if (result.perSymbol) {
    console.log(`--- Per symbol --------------------------------`);
    for (const [sym, sm] of Object.entries(result.perSymbol)) {
        console.log(`${sym.padEnd(6)} return ${pct(sm.totalReturnPct).padStart(8)}  Sharpe ${sm.sharpeRatio.toFixed(2).padStart(6)}  trades ${String(sm.totalTrades).padStart(4)}  win ${pct(sm.winRate)}`);
    }
}

if (result.folds?.length) {
    console.log(`--- Walk-forward (${result.folds.length} folds: in-sample vs out-of-sample) ---`);
    for (const f of result.folds) {
        console.log(
            `#${f.foldIndex} test ${f.testStart}→${f.testEnd}  ` +
            `train Sharpe ${f.trainMetrics.sharpeRatio.toFixed(2)} / test Sharpe ${f.testMetrics.sharpeRatio.toFixed(2)}  ` +
            `test return ${pct(f.testMetrics.totalReturnPct)}`,
        );
    }
    const avgTest = result.folds.reduce((a, f) => a + f.testMetrics.sharpeRatio, 0) / result.folds.length;
    console.log(`Average out-of-sample Sharpe: ${avgTest.toFixed(2)} — c'est LE chiffre qui compte.`);
}

console.log('');
