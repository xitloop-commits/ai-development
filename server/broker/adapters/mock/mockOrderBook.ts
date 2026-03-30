/**
 * Mock Order Book — In-Memory Order & Position Management
 *
 * Simulates a broker's order book for paper trading:
 * - Instant fill on MARKET orders
 * - Instant fill on LIMIT orders (assumes price always fills in paper mode)
 * - Position tracking with simulated P&L
 * - Virtual margin management
 * - Trade history
 */

import type {
  Order,
  OrderParams,
  ModifyParams,
  OrderResult,
  OrderStatus,
  Trade,
  Position,
  MarginInfo,
  OrderUpdate,
  OrderUpdateCallback,
} from "../../types";

// ─── Internal State ─────────────────────────────────────────────

interface InternalPosition {
  positionId: string;
  instrument: string;
  exchange: OrderParams["exchange"];
  transactionType: OrderParams["transactionType"];
  optionType: OrderParams["optionType"];
  strike: number;
  expiry: string;
  quantity: number;
  averagePrice: number;
  status: "OPEN" | "CLOSED";
  realizedPnl: number;
  createdAt: number;
  updatedAt: number;
}

// ─── Counter for unique IDs ─────────────────────────────────────

let orderCounter = 0;
let tradeCounter = 0;
let positionCounter = 0;

function nextOrderId(): string {
  return `MOCK-ORD-${++orderCounter}-${Date.now()}`;
}

function nextTradeId(): string {
  return `MOCK-TRD-${++tradeCounter}-${Date.now()}`;
}

function nextPositionId(): string {
  return `MOCK-POS-${++positionCounter}-${Date.now()}`;
}

// ─── MockOrderBook Class ────────────────────────────────────────

export class MockOrderBook {
  private orders: Map<string, Order> = new Map();
  private trades: Trade[] = [];
  private positions: Map<string, InternalPosition> = new Map();
  private orderUpdateCallbacks: OrderUpdateCallback[] = [];

  private totalMargin: number;
  private usedMargin: number = 0;

  constructor(initialMargin: number = 500000) {
    this.totalMargin = initialMargin;
  }

  // ── Orders ──────────────────────────────────────────────────────

  /**
   * Place an order. In paper mode, MARKET and LIMIT orders fill instantly.
   */
  placeOrder(params: OrderParams): OrderResult {
    const orderId = nextOrderId();
    const now = Date.now();

    const order: Order = {
      orderId,
      instrument: params.instrument,
      exchange: params.exchange,
      transactionType: params.transactionType,
      optionType: params.optionType,
      strike: params.strike,
      expiry: params.expiry,
      quantity: params.quantity,
      filledQuantity: params.quantity, // instant fill
      price: params.price,
      averagePrice: params.price, // fill at requested price
      triggerPrice: params.triggerPrice,
      orderType: params.orderType,
      productType: params.productType,
      status: "FILLED",
      tag: params.tag,
      createdAt: now,
      updatedAt: now,
    };

    this.orders.set(orderId, order);

    // Create trade record
    const trade: Trade = {
      tradeId: nextTradeId(),
      orderId,
      instrument: params.instrument,
      exchange: params.exchange,
      transactionType: params.transactionType,
      optionType: params.optionType,
      strike: params.strike,
      expiry: params.expiry,
      quantity: params.quantity,
      price: params.price,
      timestamp: now,
    };
    this.trades.push(trade);

    // Update positions
    this._updatePosition(params, params.price);

    // Update margin
    const marginRequired = params.price * params.quantity;
    if (params.transactionType === "BUY") {
      this.usedMargin += marginRequired;
    }

    // Notify callbacks
    this._notifyOrderUpdate({
      orderId,
      status: "FILLED",
      filledQuantity: params.quantity,
      averagePrice: params.price,
      timestamp: now,
    });

    return {
      orderId,
      status: "FILLED",
      message: "Order filled (paper trading)",
      timestamp: now,
    };
  }

  /**
   * Modify a pending order. In paper mode, only unfilled orders can be modified.
   * Since we instant-fill, this will typically return REJECTED.
   */
  modifyOrder(orderId: string, params: ModifyParams): OrderResult {
    const order = this.orders.get(orderId);
    const now = Date.now();

    if (!order) {
      return {
        orderId,
        status: "REJECTED",
        message: `Order ${orderId} not found`,
        timestamp: now,
      };
    }

    if (order.status === "FILLED" || order.status === "CANCELLED") {
      return {
        orderId,
        status: "REJECTED",
        message: `Cannot modify order with status ${order.status}`,
        timestamp: now,
      };
    }

    // Apply modifications
    if (params.price !== undefined) order.price = params.price;
    if (params.quantity !== undefined) order.quantity = params.quantity;
    if (params.triggerPrice !== undefined)
      order.triggerPrice = params.triggerPrice;
    if (params.orderType !== undefined) order.orderType = params.orderType;
    order.updatedAt = now;

    return {
      orderId,
      status: order.status,
      message: "Order modified (paper trading)",
      timestamp: now,
    };
  }

  /**
   * Cancel an order. Only pending/open orders can be cancelled.
   */
  cancelOrder(orderId: string): OrderResult {
    const order = this.orders.get(orderId);
    const now = Date.now();

    if (!order) {
      return {
        orderId,
        status: "REJECTED",
        message: `Order ${orderId} not found`,
        timestamp: now,
      };
    }

    if (order.status === "FILLED" || order.status === "CANCELLED") {
      return {
        orderId,
        status: "REJECTED",
        message: `Cannot cancel order with status ${order.status}`,
        timestamp: now,
      };
    }

    order.status = "CANCELLED";
    order.updatedAt = now;

    this._notifyOrderUpdate({
      orderId,
      status: "CANCELLED",
      filledQuantity: order.filledQuantity,
      averagePrice: order.averagePrice,
      timestamp: now,
    });

    return {
      orderId,
      status: "CANCELLED",
      message: "Order cancelled (paper trading)",
      timestamp: now,
    };
  }

  /**
   * Exit all open positions by placing opposite orders.
   */
  exitAll(): OrderResult[] {
    const results: OrderResult[] = [];
    const openPositions = Array.from(this.positions.values()).filter(
      (p) => p.status === "OPEN"
    );

    for (const pos of openPositions) {
      // Place an opposite order to close the position
      const exitParams: OrderParams = {
        instrument: pos.instrument,
        exchange: pos.exchange,
        transactionType: pos.transactionType === "BUY" ? "SELL" : "BUY",
        optionType: pos.optionType,
        strike: pos.strike,
        expiry: pos.expiry,
        quantity: pos.quantity,
        price: pos.averagePrice, // exit at entry price (no slippage in paper)
        orderType: "MARKET",
        productType: "INTRADAY",
        tag: "EXIT_ALL",
      };

      const result = this.placeOrder(exitParams);
      results.push(result);
    }

    return results;
  }

  // ── Queries ─────────────────────────────────────────────────────

  getOrderBook(): Order[] {
    return Array.from(this.orders.values()).sort(
      (a, b) => b.createdAt - a.createdAt
    );
  }

  getOrderStatus(orderId: string): Order | null {
    return this.orders.get(orderId) ?? null;
  }

  getTradeBook(): Trade[] {
    return [...this.trades].sort((a, b) => b.timestamp - a.timestamp);
  }

  getPositions(): Position[] {
    return Array.from(this.positions.values()).map((p) => {
      // For open positions, simulate P&L based on entry price
      // In real mode, LTP would come from WebSocket. In paper mode, use entry price (0 P&L).
      const ltp = p.averagePrice; // no real LTP in mock
      const pnl =
        p.status === "OPEN"
          ? 0 // no unrealized P&L without real LTP
          : p.realizedPnl;
      const pnlPercent =
        p.averagePrice > 0 ? (pnl / (p.averagePrice * p.quantity)) * 100 : 0;

      return {
        positionId: p.positionId,
        instrument: p.instrument,
        exchange: p.exchange,
        transactionType: p.transactionType,
        optionType: p.optionType,
        strike: p.strike,
        expiry: p.expiry,
        quantity: p.quantity,
        averagePrice: p.averagePrice,
        ltp,
        pnl,
        pnlPercent,
        status: p.status,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      };
    });
  }

  getOpenPositions(): Position[] {
    return this.getPositions().filter((p) => p.status === "OPEN");
  }

  getMargin(): MarginInfo {
    return {
      available: this.totalMargin - this.usedMargin,
      used: this.usedMargin,
      total: this.totalMargin,
    };
  }

  // ── Callbacks ─────────────────────────────────────────────────

  onOrderUpdate(callback: OrderUpdateCallback): void {
    this.orderUpdateCallbacks.push(callback);
  }

  // ── Reset ─────────────────────────────────────────────────────

  /**
   * Clear all orders, trades, and positions. Reset margin.
   */
  reset(initialMargin?: number): void {
    this.orders.clear();
    this.trades = [];
    this.positions.clear();
    this.orderUpdateCallbacks = [];
    this.usedMargin = 0;
    if (initialMargin !== undefined) {
      this.totalMargin = initialMargin;
    }
  }

  // ── Simulated LTP Update ──────────────────────────────────────

  /**
   * Simulate an LTP update for a position (used for P&L calculation).
   * In a real adapter, this comes from WebSocket.
   */
  simulateLTPUpdate(positionId: string, ltp: number): void {
    const pos = this.positions.get(positionId);
    if (!pos || pos.status !== "OPEN") return;
    pos.updatedAt = Date.now();
    // LTP is used in getPositions() to calculate unrealized P&L
    // We store it temporarily on the position for the next getPositions() call
    (pos as any)._simulatedLTP = ltp;
  }

  // ── Internal Helpers ──────────────────────────────────────────

  /**
   * Create or update a position based on a filled order.
   */
  private _updatePosition(params: OrderParams, fillPrice: number): void {
    // Position key does NOT include transactionType — so opposite orders match the same position
    const posKey = `${params.instrument}|${params.optionType}|${params.strike}|${params.expiry}`;

    // Find an existing OPEN position for this instrument/strike/expiry
    const existing = this.positions.get(posKey);

    if (existing && existing.status === "OPEN") {
      // Check if this is an exit order (opposite direction)
      const isExit = existing.transactionType !== params.transactionType;

      if (isExit) {
        // Close the position
        const pnl = this._calculatePnl(
          existing.transactionType,
          existing.averagePrice,
          fillPrice,
          existing.quantity
        );

        existing.status = "CLOSED";
        existing.realizedPnl = pnl;
        existing.updatedAt = Date.now();

        // Release margin
        this.usedMargin = Math.max(
          0,
          this.usedMargin - existing.averagePrice * existing.quantity
        );
      } else {
        // Add to position (average up/down)
        const totalQty = existing.quantity + params.quantity;
        existing.averagePrice =
          (existing.averagePrice * existing.quantity +
            fillPrice * params.quantity) /
          totalQty;
        existing.quantity = totalQty;
        existing.updatedAt = Date.now();
      }
    } else {
      // New position
      const positionId = nextPositionId();
      const now = Date.now();

      this.positions.set(posKey, {
        positionId,
        instrument: params.instrument,
        exchange: params.exchange,
        transactionType: params.transactionType,
        optionType: params.optionType,
        strike: params.strike,
        expiry: params.expiry,
        quantity: params.quantity,
        averagePrice: fillPrice,
        status: "OPEN",
        realizedPnl: 0,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  /**
   * Check if an order is closing an existing position.
   */
  private _isExitOrder(
    position: InternalPosition,
    params: OrderParams
  ): boolean {
    // An exit order has the opposite transaction type
    return (
      position.instrument === params.instrument &&
      position.optionType === params.optionType &&
      position.strike === params.strike &&
      position.expiry === params.expiry &&
      position.transactionType !== params.transactionType
    );
  }

  /**
   * Calculate P&L for a closed position.
   */
  private _calculatePnl(
    entryDirection: "BUY" | "SELL",
    entryPrice: number,
    exitPrice: number,
    quantity: number
  ): number {
    if (entryDirection === "BUY") {
      return (exitPrice - entryPrice) * quantity;
    } else {
      return (entryPrice - exitPrice) * quantity;
    }
  }

  /**
   * Notify all order update callbacks.
   */
  private _notifyOrderUpdate(update: OrderUpdate): void {
    for (const cb of this.orderUpdateCallbacks) {
      try {
        cb(update);
      } catch {
        // ignore callback errors
      }
    }
  }
}
