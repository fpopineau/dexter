/**
 * Backtest trade simulator — models order fills, slippage, and commissions.
 *
 * Simulates realistic execution of trades during bar-by-bar replay.
 * Tracks open positions, applies stop-loss/take-profit logic, and
 * manages the equity curve.
 */

import type { Bar } from './data-loader.js';
import type { EquityPoint, Trade } from './metrics.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SimulatorConfig {
    /** Starting capital in USD. */
    startingCapital: number;

    /** Commission per share (default $0.005, IBKR tiered). */
    commissionPerShare: number;

    /** Minimum commission per order (default $1.00). */
    minCommission: number;

    /** Maximum commission per order (default $10.00). */
    maxCommission: number;

    /**
     * Slippage model: 'fixed' or 'proportional'.
     *   fixed: slippageBps ignored, uses slippageFixed cents per share.
     *   proportional: slippage = price * slippageBps / 10000.
     */
    slippageModel: 'fixed' | 'proportional';

    /** Fixed slippage in cents per share (default 1 cent). */
    slippageFixed: number;

    /** Proportional slippage in basis points (default 5 bps). */
    slippageBps: number;

    /** Maximum position size as fraction of equity (default 0.05 = 5%). */
    maxPositionPct: number;

    /** Maximum number of concurrent open positions (default 10). */
    maxOpenPositions: number;

    /** Maximum daily loss as fraction of starting capital (default 0.02 = 2%). */
    maxDailyLossPct: number;
}

export interface OrderRequest {
    symbol: string;
    direction: 'long' | 'short';
    /** Number of shares. If 0, auto-size from equity and maxPositionPct. */
    quantity: number;
    /** Limit price. If undefined, filled at market (next bar open). */
    limitPrice?: number;
    /** Stop-loss price. */
    stopLoss: number;
    /** Take-profit price. */
    takeProfit: number;
    /** Maximum bars to hold before forced exit (0 = unlimited). */
    maxBarsHeld?: number;
    /** Signal score at entry (for record-keeping). */
    signalScore?: number;
}

export interface OpenPosition {
    id: number;
    symbol: string;
    direction: 'long' | 'short';
    entryTime: string;
    entryPrice: number;
    quantity: number;
    stopLoss: number;
    takeProfit: number;
    maxBarsHeld: number;
    barsHeld: number;
    entryCost: number;
    signalScore?: number;
}

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

export const DEFAULT_SIM_CONFIG: SimulatorConfig = {
    startingCapital: 100_000,
    commissionPerShare: 0.005,
    minCommission: 1.0,
    maxCommission: 10.0,
    slippageModel: 'proportional',
    slippageFixed: 0.01,
    slippageBps: 5,
    maxPositionPct: 0.05,
    maxOpenPositions: 10,
    maxDailyLossPct: 0.02,
};

// ---------------------------------------------------------------------------
// Simulator
// ---------------------------------------------------------------------------

export class Simulator {
    readonly config: SimulatorConfig;
    private equity: number;
    private peak: number;
    private positions: Map<number, OpenPosition> = new Map();
    private nextTradeId = 1;
    private dailyPnl = 0;
    private currentDate = '';

    /** Completed trades. */
    readonly trades: Trade[] = [];
    /** Equity curve (one point per bar). */
    readonly equityCurve: EquityPoint[] = [];
    /** Pending orders waiting to be filled on the next bar. */
    private pendingOrders: OrderRequest[] = [];
    /** Whether trading is halted for the day due to daily loss limit. */
    private dailyHalted = false;

    constructor(config: Partial<SimulatorConfig> = {}) {
        this.config = { ...DEFAULT_SIM_CONFIG, ...config };
        this.equity = this.config.startingCapital;
        this.peak = this.equity;
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    /** Submit an order to be filled on the next bar. */
    submitOrder(order: OrderRequest): void {
        if (this.dailyHalted) return;
        if (this.positions.size >= this.config.maxOpenPositions) return;
        this.pendingOrders.push(order);
    }

    /**
     * Process one bar of data. Called by the engine for each bar in sequence.
     *
     * Order of operations:
     * 1. Reset daily state if new day
     * 2. Fill pending orders at this bar's open
     * 3. Check stops/targets against this bar's high/low
     * 4. Increment bars-held counters
     * 5. Record equity point
     */
    processBar(bar: Bar): void {
        const date = bar.time.substring(0, 10);

        // New trading day — reset daily counters
        if (date !== this.currentDate) {
            this.currentDate = date;
            this.dailyPnl = 0;
            this.dailyHalted = false;
        }

        // Fill pending orders
        this.fillPendingOrders(bar);

        // Check stops and targets on open positions
        this.checkExits(bar);

        // Increment bars held
        for (const pos of this.positions.values()) {
            pos.barsHeld++;
        }

        // Record equity (mark-to-market)
        const mtm = this.markToMarket(bar);
        const totalEquity = this.equity + mtm;
        if (totalEquity > this.peak) this.peak = totalEquity;
        const dd = this.peak - totalEquity;
        const ddPct = this.peak > 0 ? dd / this.peak : 0;

        this.equityCurve.push({
            time: bar.time,
            equity: totalEquity,
            drawdown: dd,
            drawdownPct: ddPct,
        });
    }

    /** Force-close all open positions at the given bar's close. */
    closeAll(bar: Bar, reason = 'end_of_backtest'): void {
        for (const pos of [...this.positions.values()]) {
            this.closePosition(pos, bar.close, bar.time, reason);
        }
    }

    /** Get current equity (cash only, no unrealized). */
    getEquity(): number {
        return this.equity;
    }

    /** Get number of open positions. */
    getOpenPositionCount(): number {
        return this.positions.size;
    }

    /** Get open positions for a given symbol. */
    getPositionsForSymbol(symbol: string): OpenPosition[] {
        return [...this.positions.values()].filter((p) => p.symbol === symbol);
    }

    /** Check if daily loss limit has been hit. */
    isDailyHalted(): boolean {
        return this.dailyHalted;
    }

    // -----------------------------------------------------------------------
    // Internal — order filling
    // -----------------------------------------------------------------------

    private fillPendingOrders(bar: Bar): void {
        const orders = this.pendingOrders;
        this.pendingOrders = [];

        for (const order of orders) {
            if (this.dailyHalted) break;
            if (this.positions.size >= this.config.maxOpenPositions) break;

            // Check if we already have a position in this symbol
            const existing = this.getPositionsForSymbol(order.symbol);
            if (existing.length > 0) continue; // no doubling down

            // Determine fill price (at bar open + slippage)
            let fillPrice = bar.open;
            if (order.limitPrice != null) {
                // Limit order: only fill if open is at or better than limit
                if (order.direction === 'long' && bar.open > order.limitPrice) continue;
                if (order.direction === 'short' && bar.open < order.limitPrice) continue;
                fillPrice = Math.min(bar.open, order.limitPrice);
                if (order.direction === 'short') {
                    fillPrice = Math.max(bar.open, order.limitPrice);
                }
            }

            // Apply slippage (adverse direction)
            const slip = this.computeSlippage(fillPrice);
            if (order.direction === 'long') {
                fillPrice += slip;
            } else {
                fillPrice -= slip;
            }

            // Auto-size if quantity is 0
            let qty = order.quantity;
            if (qty <= 0) {
                const maxNotional = this.equity * this.config.maxPositionPct;
                qty = Math.floor(maxNotional / fillPrice);
                if (qty <= 0) continue;
            }

            // Commission
            const commission = this.computeCommission(qty);

            // Deduct from equity
            const cost = fillPrice * qty + commission;

            const pos: OpenPosition = {
                id: this.nextTradeId++,
                symbol: order.symbol,
                direction: order.direction,
                entryTime: bar.time,
                entryPrice: fillPrice,
                quantity: qty,
                stopLoss: order.stopLoss,
                takeProfit: order.takeProfit,
                maxBarsHeld: order.maxBarsHeld ?? 0,
                barsHeld: 0,
                entryCost: commission,
                signalScore: order.signalScore,
            };

            this.equity -= cost;
            this.positions.set(pos.id, pos);
        }
    }

    // -----------------------------------------------------------------------
    // Internal — exit checks
    // -----------------------------------------------------------------------

    private checkExits(bar: Bar): void {
        for (const pos of [...this.positions.values()]) {
            let exitPrice: number | null = null;
            let exitReason = '';

            if (pos.direction === 'long') {
                // Stop loss hit?
                if (bar.low <= pos.stopLoss) {
                    exitPrice = pos.stopLoss;
                    exitReason = 'stop_loss';
                }
                // Take profit hit?
                else if (bar.high >= pos.takeProfit) {
                    exitPrice = pos.takeProfit;
                    exitReason = 'take_profit';
                }
            } else {
                // Short stop loss (price rises)
                if (bar.high >= pos.stopLoss) {
                    exitPrice = pos.stopLoss;
                    exitReason = 'stop_loss';
                }
                // Short take profit (price drops)
                else if (bar.low <= pos.takeProfit) {
                    exitPrice = pos.takeProfit;
                    exitReason = 'take_profit';
                }
            }

            // Time-based exit
            if (
                !exitPrice &&
                pos.maxBarsHeld > 0 &&
                pos.barsHeld >= pos.maxBarsHeld
            ) {
                exitPrice = bar.close;
                exitReason = 'time_exit';
            }

            if (exitPrice != null) {
                this.closePosition(pos, exitPrice, bar.time, exitReason);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Internal — position closing
    // -----------------------------------------------------------------------

    private closePosition(
        pos: OpenPosition,
        exitPrice: number,
        exitTime: string,
        exitReason: string,
    ): void {
        // Apply exit slippage (adverse direction)
        const slip = this.computeSlippage(exitPrice);
        let adjustedExit = exitPrice;
        if (pos.direction === 'long') {
            adjustedExit -= slip;
        } else {
            adjustedExit += slip;
        }

        const commission = this.computeCommission(pos.quantity);
        const grossPnl =
            pos.direction === 'long'
                ? (adjustedExit - pos.entryPrice) * pos.quantity
                : (pos.entryPrice - adjustedExit) * pos.quantity;
        const netPnl = grossPnl - commission - pos.entryCost;
        const pnlPct = pos.entryPrice !== 0
            ? (adjustedExit - pos.entryPrice) / pos.entryPrice * (pos.direction === 'long' ? 1 : -1)
            : 0;

        // Return capital + P&L
        this.equity += pos.entryPrice * pos.quantity + grossPnl - commission;

        const trade: Trade = {
            id: pos.id,
            symbol: pos.symbol,
            direction: pos.direction,
            entryTime: pos.entryTime,
            exitTime,
            entryPrice: pos.entryPrice,
            exitPrice: adjustedExit,
            quantity: pos.quantity,
            pnl: netPnl,
            pnlPct,
            commission: commission + pos.entryCost,
            slippage: slip * pos.quantity * 2, // entry + exit
            exitReason,
            barsHeld: pos.barsHeld,
        };

        this.trades.push(trade);
        this.positions.delete(pos.id);

        // Daily P&L tracking
        this.dailyPnl += netPnl;
        const dailyLossLimit = this.config.startingCapital * this.config.maxDailyLossPct;
        if (this.dailyPnl <= -dailyLossLimit) {
            this.dailyHalted = true;
        }
    }

    // -----------------------------------------------------------------------
    // Internal — cost models
    // -----------------------------------------------------------------------

    private computeSlippage(price: number): number {
        if (this.config.slippageModel === 'fixed') {
            return this.config.slippageFixed;
        }
        return price * this.config.slippageBps / 10_000;
    }

    private computeCommission(shares: number): number {
        const raw = shares * this.config.commissionPerShare;
        return Math.max(this.config.minCommission, Math.min(raw, this.config.maxCommission));
    }

    // -----------------------------------------------------------------------
    // Internal — mark-to-market
    // -----------------------------------------------------------------------

    /** Unrealized P&L across all open positions at the given bar's close. */
    private markToMarket(bar: Bar): number {
        let unrealized = 0;
        for (const pos of this.positions.values()) {
            // In single-symbol backtests, bar.close is the current price.
            // For multi-symbol, we'd need a price lookup — the engine handles this.
            if (pos.direction === 'long') {
                unrealized += (bar.close - pos.entryPrice) * pos.quantity;
            } else {
                unrealized += (pos.entryPrice - bar.close) * pos.quantity;
            }
        }
        return unrealized;
    }
}
