/**
 * Backtest performance metrics — pure math functions.
 *
 * Computes portfolio-level and trade-level statistics from a list
 * of completed trades and an equity curve.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Trade {
    /** Unique identifier for the trade. */
    id: number;
    symbol: string;
    direction: 'long' | 'short';
    entryTime: string;
    exitTime: string;
    entryPrice: number;
    exitPrice: number;
    quantity: number;
    pnl: number;
    pnlPct: number;
    commission: number;
    slippage: number;
    /** Exit reason: stop_loss, take_profit, time_exit, signal_exit. */
    exitReason: string;
    /** Bars held. */
    barsHeld: number;
}

export interface EquityPoint {
    time: string;
    equity: number;
    drawdown: number;
    drawdownPct: number;
}

export interface BacktestMetrics {
    // Summary
    startDate: string;
    endDate: string;
    totalBars: number;
    tradingDays: number;

    // Returns
    totalReturn: number;
    totalReturnPct: number;
    annualizedReturn: number;
    cagr: number;

    // Risk
    sharpeRatio: number;
    sortinoRatio: number;
    maxDrawdown: number;
    maxDrawdownPct: number;
    maxDrawdownDuration: number; // bars
    calmarRatio: number;
    volatility: number;

    // Trade statistics
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    winRate: number;
    avgWin: number;
    avgLoss: number;
    avgWinPct: number;
    avgLossPct: number;
    profitFactor: number;
    payoffRatio: number;
    expectancy: number;
    avgBarsHeld: number;

    // Costs
    totalCommissions: number;
    totalSlippage: number;

    // Streaks
    maxConsecutiveWins: number;
    maxConsecutiveLosses: number;

    // Monthly/daily
    bestDay: number;
    worstDay: number;
    bestMonth: number;
    worstMonth: number;
}

// ---------------------------------------------------------------------------
// Core computations
// ---------------------------------------------------------------------------

/**
 * Compute daily returns from an equity curve.
 * Assumes equity points are ordered chronologically.
 */
export function dailyReturns(equity: EquityPoint[]): number[] {
    if (equity.length < 2) return [];
    const returns: number[] = [];
    for (let i = 1; i < equity.length; i++) {
        const prev = equity[i - 1].equity;
        returns.push(prev !== 0 ? (equity[i].equity - prev) / prev : 0);
    }
    return returns;
}

/**
 * Annualized Sharpe ratio.
 * @param returns Array of periodic returns (daily).
 * @param riskFreeRate Annual risk-free rate (default 0.05 = 5%).
 * @param periodsPerYear Trading days per year (default 252).
 */
export function sharpe(
    returns: number[],
    riskFreeRate = 0.05,
    periodsPerYear = 252,
): number {
    if (returns.length < 2) return 0;
    const rfPerPeriod = riskFreeRate / periodsPerYear;
    const excess = returns.map((r) => r - rfPerPeriod);
    const mean = excess.reduce((a, b) => a + b, 0) / excess.length;
    const variance = excess.reduce((a, r) => a + (r - mean) ** 2, 0) / (excess.length - 1);
    const std = Math.sqrt(variance);
    return std === 0 ? 0 : (mean / std) * Math.sqrt(periodsPerYear);
}

/**
 * Annualized Sortino ratio (penalizes downside volatility only).
 */
export function sortino(
    returns: number[],
    riskFreeRate = 0.05,
    periodsPerYear = 252,
): number {
    if (returns.length < 2) return 0;
    const rfPerPeriod = riskFreeRate / periodsPerYear;
    const excess = returns.map((r) => r - rfPerPeriod);
    const mean = excess.reduce((a, b) => a + b, 0) / excess.length;
    const downside = excess.filter((r) => r < 0);
    if (downside.length === 0) return mean > 0 ? Infinity : 0;
    const downsideVariance = downside.reduce((a, r) => a + r ** 2, 0) / downside.length;
    const downsideStd = Math.sqrt(downsideVariance);
    return downsideStd === 0 ? 0 : (mean / downsideStd) * Math.sqrt(periodsPerYear);
}

/**
 * Maximum drawdown from equity curve.
 * Returns { maxDrawdown (absolute), maxDrawdownPct, maxDuration (bars) }.
 */
export function maxDrawdown(equity: EquityPoint[]): {
    maxDrawdown: number;
    maxDrawdownPct: number;
    maxDuration: number;
} {
    let peak = -Infinity;
    let md = 0;
    let mdPct = 0;
    let maxDur = 0;
    let currentDur = 0;

    for (const pt of equity) {
        if (pt.equity > peak) {
            peak = pt.equity;
            currentDur = 0;
        } else {
            currentDur++;
        }
        const dd = peak - pt.equity;
        const ddPct = peak !== 0 ? dd / peak : 0;
        if (dd > md) md = dd;
        if (ddPct > mdPct) mdPct = ddPct;
        if (currentDur > maxDur) maxDur = currentDur;
    }

    return { maxDrawdown: md, maxDrawdownPct: mdPct, maxDuration: maxDur };
}

/**
 * Annualized volatility from daily returns.
 */
export function annualizedVolatility(returns: number[], periodsPerYear = 252): number {
    if (returns.length < 2) return 0;
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1);
    return Math.sqrt(variance) * Math.sqrt(periodsPerYear);
}

/**
 * CAGR — Compound Annual Growth Rate.
 */
export function cagr(startEquity: number, endEquity: number, years: number): number {
    if (startEquity <= 0 || years <= 0) return 0;
    return (endEquity / startEquity) ** (1 / years) - 1;
}

// ---------------------------------------------------------------------------
// Trade statistics
// ---------------------------------------------------------------------------

export function computeTradeStats(trades: Trade[]) {
    const wins = trades.filter((t) => t.pnl > 0);
    const losses = trades.filter((t) => t.pnl <= 0);
    const totalPnl = trades.reduce((a, t) => a + t.pnl, 0);
    const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));

    // Streaks
    let maxConsWins = 0;
    let maxConsLosses = 0;
    let currentWins = 0;
    let currentLosses = 0;
    for (const t of trades) {
        if (t.pnl > 0) {
            currentWins++;
            currentLosses = 0;
            if (currentWins > maxConsWins) maxConsWins = currentWins;
        } else {
            currentLosses++;
            currentWins = 0;
            if (currentLosses > maxConsLosses) maxConsLosses = currentLosses;
        }
    }

    const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
    const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;
    const winRate = trades.length > 0 ? wins.length / trades.length : 0;

    return {
        totalTrades: trades.length,
        winningTrades: wins.length,
        losingTrades: losses.length,
        winRate,
        avgWin,
        avgLoss,
        avgWinPct: wins.length > 0 ? wins.reduce((a, t) => a + t.pnlPct, 0) / wins.length : 0,
        avgLossPct: losses.length > 0 ? losses.reduce((a, t) => a + t.pnlPct, 0) / losses.length : 0,
        profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
        payoffRatio: avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? Infinity : 0,
        expectancy: trades.length > 0 ? totalPnl / trades.length : 0,
        avgBarsHeld: trades.length > 0 ? trades.reduce((a, t) => a + t.barsHeld, 0) / trades.length : 0,
        totalCommissions: trades.reduce((a, t) => a + t.commission, 0),
        totalSlippage: trades.reduce((a, t) => a + t.slippage, 0),
        maxConsecutiveWins: maxConsWins,
        maxConsecutiveLosses: maxConsLosses,
    };
}

// ---------------------------------------------------------------------------
// Aggregate metrics
// ---------------------------------------------------------------------------

/**
 * Compute all backtest metrics from trades + equity curve.
 */
export function computeMetrics(
    trades: Trade[],
    equity: EquityPoint[],
    startingCapital: number,
): BacktestMetrics {
    const dr = dailyReturns(equity);
    const dd = maxDrawdown(equity);
    const tradeStats = computeTradeStats(trades);

    const startEq = startingCapital;
    const endEq = equity.length > 0 ? equity[equity.length - 1].equity : startingCapital;
    const totalReturn = endEq - startEq;
    const totalReturnPct = startEq !== 0 ? totalReturn / startEq : 0;

    // Estimate years from equity curve
    const startDate = equity.length > 0 ? equity[0].time : '';
    const endDate = equity.length > 0 ? equity[equity.length - 1].time : '';
    const tradingDays = equity.length;
    const years = tradingDays / 252;

    const vol = annualizedVolatility(dr);
    const cagrVal = cagr(startEq, endEq, years);
    const sharpeVal = sharpe(dr);
    const sortinoVal = sortino(dr);
    const calmar = dd.maxDrawdownPct > 0 ? cagrVal / dd.maxDrawdownPct : 0;

    // Daily P&L for best/worst day
    const dailyPnl = dr.map((r) => r * startEq); // approximate
    const bestDay = dailyPnl.length > 0 ? Math.max(...dailyPnl) : 0;
    const worstDay = dailyPnl.length > 0 ? Math.min(...dailyPnl) : 0;

    return {
        startDate,
        endDate,
        totalBars: equity.length,
        tradingDays,

        totalReturn,
        totalReturnPct,
        annualizedReturn: cagrVal,
        cagr: cagrVal,

        sharpeRatio: sharpeVal,
        sortinoRatio: sortinoVal,
        maxDrawdown: dd.maxDrawdown,
        maxDrawdownPct: dd.maxDrawdownPct,
        maxDrawdownDuration: dd.maxDuration,
        calmarRatio: calmar,
        volatility: vol,

        ...tradeStats,

        bestDay,
        worstDay,
        bestMonth: 0, // needs monthly grouping — placeholder
        worstMonth: 0,
    };
}
