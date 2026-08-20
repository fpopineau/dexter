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

    /** Max loss-if-stopped per auto-sized trade, as fraction of equity
     *  (default 0.0025 = 0.25%, matching the live sizer). WP9: the old
     *  auto-size was the live sizer's notional-cap branch with the risk
     *  branch deleted — always max size, ATR-floating risk. */
    maxRiskPerTradePct: number;

    /** Maximum number of concurrent open positions (default 10). */
    maxOpenPositions: number;

    /** Maximum daily loss as fraction of the DAY-START equity (default
     *  0.02 = 2%). WP9: was anchored to starting capital forever. */
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
    maxRiskPerTradePct: 0.0025,
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
    /** Equity curve (one point per timestamp). */
    readonly equityCurve: EquityPoint[] = [];
    /** Pending orders waiting for their symbol's next bar. */
    private pendingOrders: Array<OrderRequest & { age: number }> = [];
    /** Whether trading is halted for the day due to daily loss limit. */
    private dailyHalted = false;
    /** Last seen close per symbol — marks positions whose symbol has no
     *  bar this timestamp, and prices terminal closes (WP9). */
    private lastCloseBySymbol = new Map<string, number>();
    private lastTime = '';
    /** Marked (cash + positions) equity as of the last processed tick —
     *  the sizing base (cash alone shrinks with every open position). */
    private lastMarkedEquity: number;
    /** Equity at the start of the current ET day — the daily-loss anchor. */
    private dayStartEquity: number;

    /** Ticks a pending order survives without its symbol printing a bar
     *  before it is dropped (data gap ≠ resting forever). */
    private static readonly MAX_PENDING_AGE = 3;

    constructor(config: Partial<SimulatorConfig> = {}) {
        this.config = { ...DEFAULT_SIM_CONFIG, ...config };
        this.equity = this.config.startingCapital;
        this.peak = this.equity;
        this.lastMarkedEquity = this.equity;
        this.dayStartEquity = this.equity;
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    /** Submit an order to be filled on its symbol's NEXT bar. */
    submitOrder(order: OrderRequest): void {
        if (this.dailyHalted) return;
        if (this.positions.size >= this.config.maxOpenPositions) return;
        this.pendingOrders.push({ ...order, age: 0 });
    }

    /**
     * Advance one timestamp with every symbol's bar for that instant (WP9
     * — the single-bar advance priced every symbol off the first ticker).
     *
     * Order of operations:
     * 1. Day rollover (daily-loss anchor re-bases to current equity)
     * 2. Fill pending orders, each at ITS OWN symbol's open
     * 3. Check stops/targets, each against ITS OWN symbol's bar
     * 4. Increment bars-held; record marked equity
     */
    processBars(time: string, barsBySymbol: Map<string, Bar>): void {
        const date = time.substring(0, 10);
        if (date !== this.currentDate) {
            this.currentDate = date;
            this.dailyPnl = 0;
            this.dailyHalted = false;
            this.dayStartEquity = this.lastMarkedEquity;
        }

        this.fillPendingOrders(time, barsBySymbol);
        this.checkExits(time, barsBySymbol);

        for (const [symbol, bar] of barsBySymbol) {
            this.lastCloseBySymbol.set(symbol, bar.close);
        }
        for (const pos of this.positions.values()) {
            if (barsBySymbol.has(pos.symbol)) pos.barsHeld++;
        }

        const totalEquity = this.equity + this.markToMarket();
        this.lastMarkedEquity = totalEquity;
        this.lastTime = time;
        if (totalEquity > this.peak) this.peak = totalEquity;
        const dd = this.peak - totalEquity;
        this.equityCurve.push({
            time,
            equity: totalEquity,
            drawdown: dd,
            drawdownPct: this.peak > 0 ? dd / this.peak : 0,
        });
    }

    /** Force-close every open position at its own symbol's last close, and
     *  land the result on the equity curve (WP9 — the old closeAll priced
     *  everything off one symbol and bypassed the curve, so the headline
     *  return and the trade sum disagreed by construction). */
    closeAll(reason = 'end_of_backtest'): void {
        for (const pos of [...this.positions.values()]) {
            const px = this.lastCloseBySymbol.get(pos.symbol) ?? pos.entryPrice;
            this.closePosition(pos, px, this.lastTime || pos.entryTime, reason);
        }
        const totalEquity = this.equity;
        this.lastMarkedEquity = totalEquity;
        if (totalEquity > this.peak) this.peak = totalEquity;
        const dd = this.peak - totalEquity;
        this.equityCurve.push({
            time: this.lastTime || 'end',
            equity: totalEquity,
            drawdown: dd,
            drawdownPct: this.peak > 0 ? dd / this.peak : 0,
        });
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

    private fillPendingOrders(time: string, barsBySymbol: Map<string, Bar>): void {
        const orders = this.pendingOrders;
        this.pendingOrders = [];

        for (const order of orders) {
            if (this.dailyHalted) continue;
            if (this.positions.size >= this.config.maxOpenPositions) continue;

            const bar = barsBySymbol.get(order.symbol);
            if (!bar) {
                // The symbol did not print this timestamp — the order waits
                // for its own bar, bounded so a data gap cannot rest forever.
                if (order.age < Simulator.MAX_PENDING_AGE) {
                    this.pendingOrders.push({ ...order, age: order.age + 1 });
                }
                continue;
            }

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

            // Auto-size (WP9): min(risk budget / stop distance, notional
            // cap) on MARKED equity — the live sizer's shape. The old code
            // was the cap branch alone on post-debit cash: always max size,
            // shrinking with each open position.
            let qty = order.quantity;
            if (qty <= 0) {
                const base = this.lastMarkedEquity;
                const stopDist = Math.abs(fillPrice - order.stopLoss);
                const byCap = Math.floor((base * this.config.maxPositionPct) / fillPrice);
                const byRisk = stopDist > 0
                    ? Math.floor((base * this.config.maxRiskPerTradePct) / stopDist)
                    : 0;
                qty = Math.min(byCap, byRisk);
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
        void time;
    }

    // -----------------------------------------------------------------------
    // Internal — exit checks
    // -----------------------------------------------------------------------

    private checkExits(time: string, barsBySymbol: Map<string, Bar>): void {
        for (const pos of [...this.positions.values()]) {
            const bar = barsBySymbol.get(pos.symbol);
            if (!bar) continue; // no print for this symbol this timestamp

            let exitPrice: number | null = null;
            let exitReason = '';

            // Gap-aware fills (WP9): a bar that OPENS through the level
            // fills at the open — the honest gap loss (or the better price
            // a resting limit actually gets), never the level itself.
            // Same-bar stop+target still resolves stop-first (conservative).
            if (pos.direction === 'long') {
                if (bar.open <= pos.stopLoss) {
                    exitPrice = bar.open;
                    exitReason = 'stop_loss';
                } else if (bar.low <= pos.stopLoss) {
                    exitPrice = pos.stopLoss;
                    exitReason = 'stop_loss';
                } else if (bar.open >= pos.takeProfit) {
                    exitPrice = bar.open;
                    exitReason = 'take_profit';
                } else if (bar.high >= pos.takeProfit) {
                    exitPrice = pos.takeProfit;
                    exitReason = 'take_profit';
                }
            } else {
                if (bar.open >= pos.stopLoss) {
                    exitPrice = bar.open;
                    exitReason = 'stop_loss';
                } else if (bar.high >= pos.stopLoss) {
                    exitPrice = pos.stopLoss;
                    exitReason = 'stop_loss';
                } else if (bar.open <= pos.takeProfit) {
                    exitPrice = bar.open;
                    exitReason = 'take_profit';
                } else if (bar.low <= pos.takeProfit) {
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
                this.closePosition(pos, exitPrice, time, exitReason);
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

        // Daily P&L tracking — anchored to the DAY-START equity (WP9): the
        // old starting-capital anchor made the halt looser as equity grew
        // and tighter as it shrank, in the wrong direction both times.
        this.dailyPnl += netPnl;
        const dailyLossLimit = this.dayStartEquity * this.config.maxDailyLossPct;
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

    /**
     * Current VALUE of open positions (not just unrealized P&L): entry
     * debits cash by the full notional, so the equity curve needs the
     * notional back plus the unrealized move — otherwise every open
     * position punches a hole of one position size into the curve.
     * WP9: each position marks at ITS OWN symbol's last close.
     */
    private markToMarket(): number {
        let value = 0;
        for (const pos of this.positions.values()) {
            const close = this.lastCloseBySymbol.get(pos.symbol) ?? pos.entryPrice;
            if (pos.direction === 'long') {
                value += close * pos.quantity;
            } else {
                // Shorts also debit entry×qty at entry (as margin):
                // value = margin + unrealized = (2×entry − close) × qty.
                value += (2 * pos.entryPrice - close) * pos.quantity;
            }
        }
        return value;
    }
}
