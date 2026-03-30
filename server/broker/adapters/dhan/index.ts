/**
 * Dhan Adapter — Full BrokerAdapter implementation for Dhan API v2
 *
 * Handles:
 * - Token validation and expiry detection
 * - 401 auto-detection → marks token expired
 * - Order placement, modification, cancellation
 * - Position and margin retrieval
 * - Kill switch (via Dhan's /killswitch endpoint)
 * - Market data (scrip master, expiry list, option chain)
 * - WebSocket stubs (implemented in Step 0.5+)
 */

import type {
  BrokerAdapter,
  OrderParams,
  ModifyParams,
  OrderResult,
  Order,
  Trade,
  Position,
  MarginInfo,
  Instrument,
  OptionChainData,
  SubscribeParams,
  TickCallback,
  OrderUpdateCallback,
} from "../../types";

import {
  DHAN_API_BASE,
  DHAN_ENDPOINTS,
  DHAN_TOKEN_EXPIRY_MS,
  DHAN_ORDER_STATUS_MAP,
  DHAN_ORDER_TYPES,
  DHAN_PRODUCT_TYPES,
} from "./constants";

import {
  dhanRequest,
  validateDhanToken,
  updateDhanToken,
  calculateTokenExpiry,
  handleDhan401,
} from "./auth";

import type {
  DhanOrderRequest,
  DhanOrderResponse,
  DhanOrderBookEntry,
  DhanTradeBookEntry,
  DhanPositionEntry,
  DhanFundLimitResponse,
  DhanKillSwitchResponse,
} from "./types";

import { getBrokerConfig, updateBrokerConnection } from "../../brokerConfig";

// ─── DhanAdapter ───────────────────────────────────────────────

export class DhanAdapter implements BrokerAdapter {
  readonly brokerId = "dhan";
  readonly displayName = "Dhan";

  private accessToken: string = "";
  private clientId: string = "";
  private tokenUpdatedAt: number = 0;
  private killSwitchActive: boolean = false;

  // Order update callback (for real-time order updates)
  private orderUpdateCb: OrderUpdateCallback | null = null;

  // ── Auth ──────────────────────────────────────────────────────

  async validateToken(): Promise<{ valid: boolean; expiresAt?: number }> {
    // First check local expiry
    if (this.tokenUpdatedAt > 0) {
      const expiry = calculateTokenExpiry(this.tokenUpdatedAt);
      if (expiry.isExpired) {
        await handleDhan401(this.brokerId);
        return { valid: false };
      }
    }

    // If no token stored, invalid
    if (!this.accessToken) {
      return { valid: false };
    }

    // Validate against Dhan API
    const result = await validateDhanToken(this.accessToken);

    if (result.valid) {
      const expiresAt = this.tokenUpdatedAt + DHAN_TOKEN_EXPIRY_MS;
      await updateBrokerConnection(this.brokerId, {
        apiStatus: "connected",
        lastApiCall: Date.now(),
      });
      return { valid: true, expiresAt };
    }

    // Token is invalid
    await handleDhan401(this.brokerId);
    return { valid: false };
  }

  async updateToken(token: string, clientId?: string): Promise<void> {
    const result = await updateDhanToken(this.brokerId, token, clientId);

    if (result.success) {
      this.accessToken = token;
      this.clientId = result.clientId ?? clientId ?? this.clientId;
      this.tokenUpdatedAt = Date.now();
      console.log(`[DhanAdapter] Token updated successfully. Client: ${this.clientId}`);
    } else {
      throw new Error(result.message);
    }
  }

  // ── Orders ────────────────────────────────────────────────────

  async placeOrder(params: OrderParams): Promise<OrderResult> {
    this._ensureToken();
    this._ensureNotKilled();

    const body: DhanOrderRequest = {
      dhanClientId: this.clientId,
      transactionType: params.transactionType,
      exchangeSegment: params.exchange,
      productType: DHAN_PRODUCT_TYPES[params.productType] ?? params.productType,
      orderType: DHAN_ORDER_TYPES[params.orderType] ?? params.orderType,
      validity: "DAY",
      securityId: this._resolveSecurityId(params),
      quantity: params.quantity,
      price: params.price,
    };

    if (params.triggerPrice) {
      body.triggerPrice = params.triggerPrice;
    }
    if (params.stopLoss) {
      body.boStopLossValue = params.stopLoss;
    }
    if (params.target) {
      body.boProfitValue = params.target;
    }
    if (params.tag) {
      body.correlationId = params.tag;
    }

    const result = await dhanRequest<DhanOrderResponse>(
      "POST",
      DHAN_ENDPOINTS.PLACE_ORDER,
      this.accessToken,
      body as unknown as Record<string, unknown>
    );

    if (result.isAuthError) {
      await handleDhan401(this.brokerId);
      throw new Error("Token expired. Please update your Dhan access token.");
    }

    if (!result.ok || !result.data) {
      throw new Error(
        result.error?.errorMessage ?? `Order placement failed (HTTP ${result.status})`
      );
    }

    return {
      orderId: result.data.orderId,
      status: (DHAN_ORDER_STATUS_MAP[result.data.orderStatus] ?? "PENDING") as OrderResult["status"],
      message: `Order placed: ${result.data.orderId}`,
      timestamp: Date.now(),
    };
  }

  async modifyOrder(orderId: string, params: ModifyParams): Promise<OrderResult> {
    this._ensureToken();

    const body: Record<string, unknown> = {
      dhanClientId: this.clientId,
      orderId,
    };

    if (params.price !== undefined) body.price = params.price;
    if (params.quantity !== undefined) body.quantity = params.quantity;
    if (params.triggerPrice !== undefined) body.triggerPrice = params.triggerPrice;
    if (params.orderType !== undefined) {
      body.orderType = DHAN_ORDER_TYPES[params.orderType] ?? params.orderType;
    }

    const result = await dhanRequest<DhanOrderResponse>(
      "PUT",
      DHAN_ENDPOINTS.MODIFY_ORDER(orderId),
      this.accessToken,
      body
    );

    if (result.isAuthError) {
      await handleDhan401(this.brokerId);
      throw new Error("Token expired. Please update your Dhan access token.");
    }

    if (!result.ok || !result.data) {
      throw new Error(
        result.error?.errorMessage ?? `Order modification failed (HTTP ${result.status})`
      );
    }

    return {
      orderId: result.data.orderId,
      status: (DHAN_ORDER_STATUS_MAP[result.data.orderStatus] ?? "PENDING") as OrderResult["status"],
      message: `Order modified: ${orderId}`,
      timestamp: Date.now(),
    };
  }

  async cancelOrder(orderId: string): Promise<OrderResult> {
    this._ensureToken();

    const result = await dhanRequest<DhanOrderResponse>(
      "DELETE",
      DHAN_ENDPOINTS.CANCEL_ORDER(orderId),
      this.accessToken
    );

    if (result.isAuthError) {
      await handleDhan401(this.brokerId);
      throw new Error("Token expired. Please update your Dhan access token.");
    }

    if (!result.ok || !result.data) {
      throw new Error(
        result.error?.errorMessage ?? `Order cancellation failed (HTTP ${result.status})`
      );
    }

    return {
      orderId: result.data.orderId,
      status: "CANCELLED",
      message: `Order cancelled: ${orderId}`,
      timestamp: Date.now(),
    };
  }

  async exitAll(): Promise<OrderResult[]> {
    this._ensureToken();

    const results: OrderResult[] = [];

    // 1. Cancel all pending orders
    const orders = await this.getOrderBook();
    const pendingOrders = orders.filter(
      (o) => o.status === "PENDING" || o.status === "OPEN"
    );

    for (const order of pendingOrders) {
      try {
        const cancelResult = await this.cancelOrder(order.orderId);
        results.push(cancelResult);
      } catch (err) {
        results.push({
          orderId: order.orderId,
          status: "REJECTED",
          message: `Cancel failed: ${err instanceof Error ? err.message : String(err)}`,
          timestamp: Date.now(),
        });
      }
    }

    // 2. Close all open positions with market orders
    const positions = await this.getPositions();
    const openPositions = positions.filter((p) => p.status === "OPEN" && p.quantity !== 0);

    for (const pos of openPositions) {
      try {
        const exitResult = await this.placeOrder({
          instrument: pos.instrument,
          exchange: pos.exchange,
          transactionType: pos.quantity > 0 ? "SELL" : "BUY",
          optionType: pos.optionType,
          strike: pos.strike,
          expiry: pos.expiry,
          quantity: Math.abs(pos.quantity),
          price: 0,
          orderType: "MARKET",
          productType: "INTRADAY",
        });
        results.push(exitResult);
      } catch (err) {
        results.push({
          orderId: `exit-${pos.positionId}`,
          status: "REJECTED",
          message: `Exit failed: ${err instanceof Error ? err.message : String(err)}`,
          timestamp: Date.now(),
        });
      }
    }

    return results;
  }

  async getOrderBook(): Promise<Order[]> {
    this._ensureToken();

    const result = await dhanRequest<DhanOrderBookEntry[]>(
      "GET",
      DHAN_ENDPOINTS.ORDER_BOOK,
      this.accessToken
    );

    if (result.isAuthError) {
      await handleDhan401(this.brokerId);
      throw new Error("Token expired.");
    }

    if (!result.ok || !result.data) {
      return [];
    }

    return result.data.map((entry) => this._mapDhanOrder(entry));
  }

  async getOrderStatus(orderId: string): Promise<Order> {
    this._ensureToken();

    const result = await dhanRequest<DhanOrderBookEntry>(
      "GET",
      DHAN_ENDPOINTS.ORDER_STATUS(orderId),
      this.accessToken
    );

    if (result.isAuthError) {
      await handleDhan401(this.brokerId);
      throw new Error("Token expired.");
    }

    if (!result.ok || !result.data) {
      throw new Error(`Order ${orderId} not found.`);
    }

    return this._mapDhanOrder(result.data);
  }

  async getTradeBook(): Promise<Trade[]> {
    this._ensureToken();

    const result = await dhanRequest<DhanTradeBookEntry[]>(
      "GET",
      DHAN_ENDPOINTS.TRADE_BOOK,
      this.accessToken
    );

    if (result.isAuthError) {
      await handleDhan401(this.brokerId);
      throw new Error("Token expired.");
    }

    if (!result.ok || !result.data) {
      return [];
    }

    return result.data.map((entry, i) => ({
      tradeId: `${entry.orderId}-${i}`,
      orderId: entry.orderId,
      instrument: entry.tradingSymbol,
      exchange: entry.exchangeSegment as Order["exchange"],
      transactionType: entry.transactionType as Order["transactionType"],
      optionType: "CE" as const, // Will be resolved from tradingSymbol in future
      strike: 0,
      expiry: "",
      quantity: entry.tradedQuantity,
      price: entry.tradedPrice,
      timestamp: entry.createTime ? new Date(entry.createTime).getTime() : Date.now(),
    }));
  }

  // ── Positions & Funds ─────────────────────────────────────────

  async getPositions(): Promise<Position[]> {
    this._ensureToken();

    const result = await dhanRequest<DhanPositionEntry[]>(
      "GET",
      DHAN_ENDPOINTS.POSITIONS,
      this.accessToken
    );

    if (result.isAuthError) {
      await handleDhan401(this.brokerId);
      throw new Error("Token expired.");
    }

    if (!result.ok || !result.data) {
      return [];
    }

    return result.data.map((entry) => ({
      positionId: `${entry.securityId}-${entry.productType}`,
      instrument: entry.tradingSymbol,
      exchange: entry.exchangeSegment as Position["exchange"],
      transactionType: (entry.netQty >= 0 ? "BUY" : "SELL") as Position["transactionType"],
      optionType: "CE" as const, // Will be resolved from tradingSymbol
      strike: 0,
      expiry: "",
      quantity: entry.netQty,
      averagePrice: entry.netQty >= 0 ? entry.buyAvg : entry.sellAvg,
      ltp: 0, // Will be updated via WebSocket
      pnl: entry.realizedProfit + entry.unrealizedProfit,
      pnlPercent: 0,
      status: entry.netQty === 0 ? "CLOSED" as const : "OPEN" as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));
  }

  async getMargin(): Promise<MarginInfo> {
    this._ensureToken();

    const result = await dhanRequest<DhanFundLimitResponse>(
      "GET",
      DHAN_ENDPOINTS.FUND_LIMIT,
      this.accessToken
    );

    if (result.isAuthError) {
      await handleDhan401(this.brokerId);
      throw new Error("Token expired.");
    }

    if (!result.ok || !result.data) {
      throw new Error("Failed to fetch margin info.");
    }

    return {
      available: result.data.availabelBalance,
      used: result.data.utilizedAmount,
      total: result.data.sodLimit,
    };
  }

  // ── Market Data ───────────────────────────────────────────────

  async getScripMaster(_exchange: string): Promise<Instrument[]> {
    // Scrip master is a large CSV download — will be implemented in Step 0.5
    console.log("[DhanAdapter] getScripMaster: Will be implemented in Step 0.5");
    return [];
  }

  async getExpiryList(underlying: string): Promise<string[]> {
    this._ensureToken();

    const result = await dhanRequest<{ data: string[] }>(
      "POST",
      DHAN_ENDPOINTS.EXPIRY_LIST,
      this.accessToken,
      {
        UnderlyingScrip: underlying,
        UnderlyingSeg: "IDX_I",
      }
    );

    if (result.isAuthError) {
      await handleDhan401(this.brokerId);
      throw new Error("Token expired.");
    }

    if (!result.ok || !result.data) {
      return [];
    }

    return result.data.data ?? [];
  }

  async getOptionChain(underlying: string, expiry: string): Promise<OptionChainData> {
    this._ensureToken();

    const result = await dhanRequest<{
      data: Array<{
        strike_price: number;
        ce_oi: number;
        ce_oi_change: number;
        ce_ltp: number;
        ce_volume: number;
        ce_iv: number;
        pe_oi: number;
        pe_oi_change: number;
        pe_ltp: number;
        pe_volume: number;
        pe_iv: number;
      }>;
      spotPrice?: number;
    }>(
      "POST",
      DHAN_ENDPOINTS.OPTION_CHAIN,
      this.accessToken,
      {
        UnderlyingScrip: underlying,
        UnderlyingSeg: "IDX_I",
        Expiry: expiry,
      }
    );

    if (result.isAuthError) {
      await handleDhan401(this.brokerId);
      throw new Error("Token expired.");
    }

    if (!result.ok || !result.data) {
      throw new Error("Failed to fetch option chain.");
    }

    return {
      underlying,
      expiry,
      spotPrice: result.data.spotPrice ?? 0,
      rows: (result.data.data ?? []).map((row) => ({
        strike: row.strike_price,
        callOI: row.ce_oi,
        callOIChange: row.ce_oi_change,
        callLTP: row.ce_ltp,
        callVolume: row.ce_volume,
        callIV: row.ce_iv,
        putOI: row.pe_oi,
        putOIChange: row.pe_oi_change,
        putLTP: row.pe_ltp,
        putVolume: row.pe_volume,
        putIV: row.pe_iv,
      })),
      timestamp: Date.now(),
    };
  }

  // ── Real-time (WebSocket) ─────────────────────────────────────

  subscribeLTP(_instruments: SubscribeParams[], _callback: TickCallback): void {
    console.log("[DhanAdapter] subscribeLTP: Will be implemented in WebSocket step");
  }

  unsubscribeLTP(_instruments: SubscribeParams[]): void {
    console.log("[DhanAdapter] unsubscribeLTP: Will be implemented in WebSocket step");
  }

  onOrderUpdate(callback: OrderUpdateCallback): void {
    this.orderUpdateCb = callback;
    console.log("[DhanAdapter] onOrderUpdate: Callback registered (WebSocket step)");
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  async connect(): Promise<void> {
    // Load credentials from MongoDB
    const config = await getBrokerConfig(this.brokerId);

    if (!config) {
      console.warn("[DhanAdapter] No config found in MongoDB. Waiting for token setup.");
      return;
    }

    this.accessToken = config.credentials.accessToken;
    this.clientId = config.credentials.clientId;
    this.tokenUpdatedAt = config.credentials.updatedAt;

    if (!this.accessToken) {
      console.warn("[DhanAdapter] No access token configured. Waiting for token setup.");
      await updateBrokerConnection(this.brokerId, {
        apiStatus: "disconnected",
      });
      return;
    }

    // Check token expiry
    const expiry = calculateTokenExpiry(this.tokenUpdatedAt);

    if (expiry.isExpired) {
      console.warn("[DhanAdapter] Token has expired. Please update your access token.");
      await handleDhan401(this.brokerId);
      return;
    }

    if (expiry.isExpiringSoon) {
      const remainingMin = Math.round(expiry.remainingMs / 60000);
      console.warn(
        `[DhanAdapter] Token expires in ${remainingMin} minutes. Consider updating.`
      );
    }

    // Validate token against Dhan API
    const validation = await validateDhanToken(this.accessToken);

    if (validation.valid) {
      this.clientId = validation.clientId ?? this.clientId;
      await updateBrokerConnection(this.brokerId, {
        apiStatus: "connected",
        lastApiCall: Date.now(),
      });
      console.log(
        `[DhanAdapter] Connected. Client: ${this.clientId}, Balance: ₹${validation.fundData?.availabelBalance ?? "N/A"}`
      );
    } else {
      console.error(`[DhanAdapter] Token validation failed: ${validation.error}`);
      await handleDhan401(this.brokerId);
    }
  }

  async disconnect(): Promise<void> {
    this.accessToken = "";
    this.clientId = "";
    this.tokenUpdatedAt = 0;
    this.killSwitchActive = false;
    this.orderUpdateCb = null;

    await updateBrokerConnection(this.brokerId, {
      apiStatus: "disconnected",
      wsStatus: "disconnected",
    });

    console.log("[DhanAdapter] Disconnected.");
  }

  // ── Emergency ─────────────────────────────────────────────────

  async killSwitch(
    action: "ACTIVATE" | "DEACTIVATE"
  ): Promise<{ status: string; message?: string }> {
    this._ensureToken();

    if (action === "ACTIVATE") {
      // First exit all positions and cancel orders
      try {
        await this.exitAll();
      } catch (err) {
        console.error("[DhanAdapter] exitAll during kill switch failed:", err);
      }

      // Then activate Dhan's kill switch
      const result = await dhanRequest<DhanKillSwitchResponse>(
        "POST",
        `${DHAN_ENDPOINTS.KILL_SWITCH}?killSwitchStatus=ACTIVATE`,
        this.accessToken
      );

      if (result.isAuthError) {
        await handleDhan401(this.brokerId);
        throw new Error("Token expired.");
      }

      this.killSwitchActive = true;

      return {
        status: "ACTIVATED",
        message: result.data?.killSwitchStatus ?? "Kill switch activated",
      };
    } else {
      // Deactivate
      const result = await dhanRequest<DhanKillSwitchResponse>(
        "POST",
        `${DHAN_ENDPOINTS.KILL_SWITCH}?killSwitchStatus=DEACTIVATE`,
        this.accessToken
      );

      if (result.isAuthError) {
        await handleDhan401(this.brokerId);
        throw new Error("Token expired.");
      }

      this.killSwitchActive = false;

      return {
        status: "DEACTIVATED",
        message: result.data?.killSwitchStatus ?? "Kill switch deactivated",
      };
    }
  }

  // ── Private Helpers ───────────────────────────────────────────

  private _ensureToken(): void {
    if (!this.accessToken) {
      throw new Error("No Dhan access token configured. Please update your token in Settings.");
    }
  }

  private _ensureNotKilled(): void {
    if (this.killSwitchActive) {
      throw new Error("Kill switch is active. Deactivate it before placing orders.");
    }
  }

  /**
   * Resolve the Dhan securityId from order params.
   * For now, uses the instrument string directly.
   * Will be enhanced with scrip master lookup in Step 0.5.
   */
  private _resolveSecurityId(params: OrderParams): string {
    // If instrument looks like a securityId (numeric), use it directly
    if (/^\d+$/.test(params.instrument)) {
      return params.instrument;
    }
    // Otherwise, return as-is (will be resolved via scrip master later)
    return params.instrument;
  }

  /**
   * Map a Dhan order book entry to our internal Order type.
   */
  private _mapDhanOrder(entry: DhanOrderBookEntry): Order {
    return {
      orderId: entry.orderId,
      instrument: entry.tradingSymbol ?? entry.securityId,
      exchange: entry.exchangeSegment as Order["exchange"],
      transactionType: entry.transactionType as Order["transactionType"],
      optionType: "CE" as const, // Will be resolved from tradingSymbol
      strike: 0,
      expiry: "",
      quantity: entry.quantity,
      filledQuantity: entry.filledQty ?? 0,
      price: entry.price,
      averagePrice: entry.averageTradedPrice ?? 0,
      triggerPrice: entry.triggerPrice,
      orderType: entry.orderType as Order["orderType"],
      productType: entry.productType as Order["productType"],
      status: (DHAN_ORDER_STATUS_MAP[entry.orderStatus] ?? entry.orderStatus) as Order["status"],
      tag: entry.correlationId,
      createdAt: entry.createTime ? new Date(entry.createTime).getTime() : Date.now(),
      updatedAt: entry.updateTime ? new Date(entry.updateTime).getTime() : Date.now(),
    };
  }

  // ── Testing Helpers ───────────────────────────────────────────

  /** For testing: get internal state */
  _getInternalState() {
    return {
      accessToken: this.accessToken,
      clientId: this.clientId,
      tokenUpdatedAt: this.tokenUpdatedAt,
      killSwitchActive: this.killSwitchActive,
    };
  }

  /** For testing: set internal state directly */
  _setInternalState(state: {
    accessToken?: string;
    clientId?: string;
    tokenUpdatedAt?: number;
    killSwitchActive?: boolean;
  }) {
    if (state.accessToken !== undefined) this.accessToken = state.accessToken;
    if (state.clientId !== undefined) this.clientId = state.clientId;
    if (state.tokenUpdatedAt !== undefined) this.tokenUpdatedAt = state.tokenUpdatedAt;
    if (state.killSwitchActive !== undefined) this.killSwitchActive = state.killSwitchActive;
  }
}
