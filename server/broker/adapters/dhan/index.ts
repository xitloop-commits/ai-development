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
  CandleData,
  IntradayDataParams,
  HistoricalDataParams,
  SubscribeParams,
  TickCallback,
  OrderUpdateCallback,
  ScripMasterStatusResult,
  SecurityLookupParams,
  SecurityLookupResult,
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
  DhanCandleDataResponse,
  DhanHistoricalDataRequest,
  DhanIntradayDataRequest,
} from "./types";

import { getBrokerConfig, updateBrokerConnection, updateBrokerCredentials } from "../../brokerConfig";

import {
  downloadScripMaster,
  lookupSecurityId as scripLookup,
  getExpiryDates as scripExpiryDates,
  resolveMCXFutcom,
  getScripMasterStatus,
  getRecordsByExchange,
  needsRefresh as scripNeedsRefresh,
  getLotSizeBySecurityId,
  getLotSizeBySymbol,
  type LookupResult,
} from "./scripMaster";

import {
  parseTradingSymbol,
  RateLimiter,
  withRetry,
  isRetryableError,
  calculateLimitPrice,
  calculateBracketPrices,
} from "./utils";

import { DhanWebSocket } from "./websocket";
import { SubscriptionManager } from "./subscriptionManager";
import { DhanOrderUpdateWs } from "./orderUpdateWs";
import { generateDhanToken } from "./tokenManager";
import type { SubscriptionState, TickData, FeedMode } from "../../types";
import { createLogger } from "../../logger";

const log = createLogger("Dhan");

// ─── DhanAdapter ───────────────────────────────────────────────

export class DhanAdapter implements BrokerAdapter {
  readonly brokerId: string;
  readonly displayName: string;
  private sandboxMode: boolean;

  private accessToken: string = "";
  private clientId: string = "";
  private tokenUpdatedAt: number = 0;
  private killSwitchActive: boolean = false;

  // Order update callback (for real-time order updates)
  private orderUpdateCb: OrderUpdateCallback | null = null;
  private orderUpdateWs: DhanOrderUpdateWs | null = null;

  // Rate limiter for Dhan API calls
  private rateLimiter = new RateLimiter(10, 250);

  // WebSocket and Subscription Manager
  private ws: DhanWebSocket | null = null;
  private subManager: SubscriptionManager | null = null;
  private tickCallback: TickCallback | null = null;

  constructor(brokerId = "dhan", sandboxMode = false) {
    this.brokerId = brokerId;
    this.sandboxMode = sandboxMode;
    this.displayName = sandboxMode ? "Dhan Sandbox" : "Dhan";
  }

  // ── Token Auto-Refresh ────────────────────────────────────────

  /**
   * Generate a fresh token via TOTP and apply it in-memory + MongoDB.
   * Returns true on success, false on any failure.
   */
  private async _tryAutoRefresh(): Promise<boolean> {
    try {
      // Coalesce with any refresh already in flight from the 401 handler.
      // handleDhan401() may have just generated a fresh token — reuse it
      // instead of doing a second TOTP call.
      const { _inflightRefresh } = await import("./auth");
      const existing = _inflightRefresh.get(this.brokerId);
      if (existing) {
        log.info("Refresh already in flight — awaiting existing result.");
        const newToken = await existing;
        if (newToken) {
          // handleDhan401 already wrote to Mongo — just sync in-memory token
          this.accessToken = newToken;
          this.tokenUpdatedAt = Date.now();
          // Propagate to WebSocket so next reconnect uses the new token
          if (this.ws) this.ws.updateToken(newToken);
          if (this.orderUpdateWs) this.orderUpdateWs.accessToken = newToken;
          log.info("Token synced from in-flight refresh.");
          return true;
        }
        return false;
      }

      log.info("Auto-refreshing Dhan token via TOTP...");
      const newToken = await generateDhanToken(this.brokerId);
      await this.updateToken(newToken);
      log.info("Token auto-refreshed successfully.");
      return true;
    } catch (err: any) {
      log.error(`Token auto-refresh failed: ${err.message}`);
      return false;
    }
  }

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
      // Propagate to WebSocket + order update WS
      if (this.ws) this.ws.updateToken(token);
      if (this.orderUpdateWs) this.orderUpdateWs.accessToken = token;
      log.info(`Token updated. Client: ${this.clientId}`);
    } else {
      throw new Error(result.message);
    }
  }

  // ── Orders ────────────────────────────────────────────────────

  async placeOrder(params: OrderParams): Promise<OrderResult> {
    this._ensureToken();
    this._ensureNotKilled();

    // Load broker settings for configurable defaults
    const config = await getBrokerConfig(this.brokerId);
    const settings = config?.settings;

    // Resolve security ID from scrip master
    const securityId = this._resolveSecurityId(params);

    // Calculate limit price with offset if order type is LIMIT and price is 0 (auto-calculate)
    let price = params.price;
    if (params.orderType === "LIMIT" && price === 0 && settings) {
      // Price of 0 means "use LTP with offset" — caller should provide actual LTP as price
      // For now, keep price as-is; the frontend will calculate using LTP
      log.warn("LIMIT order with price=0. Frontend should provide LTP-based price.");
    }

    // Build the Dhan order request
    const body: DhanOrderRequest = {
      dhanClientId: this.clientId,
      transactionType: params.transactionType,
      exchangeSegment: params.exchange,
      productType: DHAN_PRODUCT_TYPES[params.productType] ?? params.productType,
      orderType: DHAN_ORDER_TYPES[params.orderType] ?? params.orderType,
      validity: "DAY",
      securityId,
      quantity: params.quantity,
      price,
    };

    // Trigger price for SL orders
    if (params.triggerPrice) {
      body.triggerPrice = params.triggerPrice;
    }

    // Bracket order: SL and TP values
    if (params.stopLoss) {
      body.boStopLossValue = params.stopLoss;
    }
    if (params.target) {
      body.boProfitValue = params.target;
    }

    // Correlation ID for tracking
    if (params.tag) {
      body.correlationId = params.tag;
    }

    // Rate limit + retry
    await this.rateLimiter.acquire();

    const result = await withRetry(
      () => dhanRequest<DhanOrderResponse>(
        "POST",
        DHAN_ENDPOINTS.PLACE_ORDER,
        this.accessToken,
        body as unknown as Record<string, unknown>
      ),
      {
        maxRetries: 2,
        delayMs: 500,
        shouldRetry: isRetryableError,
      }
    );

    if (result.isAuthError) {
      await handleDhan401(this.brokerId);
      await this._tryAutoRefresh();
      throw new Error("Token expired. Please update your Dhan access token.");
    }

    if (!result.ok || !result.data) {
      throw new Error(
        result.error?.errorMessage ?? `Order placement failed (HTTP ${result.status})`
      );
    }

    // Update last API call timestamp
    await updateBrokerConnection(this.brokerId, { lastApiCall: Date.now() });

    return {
      orderId: result.data.orderId,
      status: (DHAN_ORDER_STATUS_MAP[result.data.orderStatus] ?? "PENDING") as OrderResult["status"],
      message: `Order placed: ${result.data.orderId}`,
      timestamp: Date.now(),
    };
  }

  async modifyOrder(orderId: string, params: ModifyParams): Promise<OrderResult> {
    this._ensureToken();
    await this.rateLimiter.acquire();

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
      await this._tryAutoRefresh();
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
    await this.rateLimiter.acquire();

    const result = await dhanRequest<DhanOrderResponse>(
      "DELETE",
      DHAN_ENDPOINTS.CANCEL_ORDER(orderId),
      this.accessToken
    );

    if (result.isAuthError) {
      await handleDhan401(this.brokerId);
      await this._tryAutoRefresh();
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
    await this.rateLimiter.acquire();

    const result = await dhanRequest<DhanOrderBookEntry[]>(
      "GET",
      DHAN_ENDPOINTS.ORDER_BOOK,
      this.accessToken
    );

    if (result.isAuthError) {
      await handleDhan401(this.brokerId);
      await this._tryAutoRefresh();
      throw new Error("Token expired.");
    }

    if (!result.ok || !result.data) {
      return [];
    }

    return result.data.map((entry) => this._mapDhanOrder(entry));
  }

  async getOrderStatus(orderId: string): Promise<Order> {
    this._ensureToken();
    await this.rateLimiter.acquire();

    const result = await dhanRequest<DhanOrderBookEntry>(
      "GET",
      DHAN_ENDPOINTS.ORDER_STATUS(orderId),
      this.accessToken
    );

    if (result.isAuthError) {
      await handleDhan401(this.brokerId);
      await this._tryAutoRefresh();
      throw new Error("Token expired.");
    }

    if (!result.ok || !result.data) {
      throw new Error(`Order ${orderId} not found.`);
    }

    return this._mapDhanOrder(result.data);
  }

  async getTradeBook(): Promise<Trade[]> {
    this._ensureToken();
    await this.rateLimiter.acquire();

    const result = await dhanRequest<DhanTradeBookEntry[]>(
      "GET",
      DHAN_ENDPOINTS.TRADE_BOOK,
      this.accessToken
    );

    if (result.isAuthError) {
      await handleDhan401(this.brokerId);
      await this._tryAutoRefresh();
      throw new Error("Token expired.");
    }

    if (!result.ok || !result.data) {
      return [];
    }

    return result.data.map((entry, i) => {
      const parsed = parseTradingSymbol(entry.tradingSymbol ?? "");
      return {
        tradeId: `${entry.orderId}-${i}`,
        orderId: entry.orderId,
        instrument: entry.tradingSymbol,
        exchange: entry.exchangeSegment as Order["exchange"],
        transactionType: entry.transactionType as Order["transactionType"],
        optionType: parsed?.optionType ?? ("CE" as const),
        strike: parsed?.strike ?? 0,
        expiry: parsed?.expiry ?? "",
        quantity: entry.tradedQuantity,
        price: entry.tradedPrice,
        timestamp: entry.createTime ? new Date(entry.createTime).getTime() : Date.now(),
      };
    });
  }

  // ── Positions & Funds ─────────────────────────────────────────

  async getPositions(): Promise<Position[]> {
    this._ensureToken();
    await this.rateLimiter.acquire();

    const result = await dhanRequest<DhanPositionEntry[]>(
      "GET",
      DHAN_ENDPOINTS.POSITIONS,
      this.accessToken
    );

    if (result.isAuthError) {
      await handleDhan401(this.brokerId);
      await this._tryAutoRefresh();
      throw new Error("Token expired.");
    }

    if (!result.ok || !result.data) {
      return [];
    }

    return result.data.map((entry) => {
      const parsed = parseTradingSymbol(entry.tradingSymbol ?? "");
      const avgPrice = entry.netQty >= 0 ? entry.buyAvg : entry.sellAvg;
      const totalPnl = entry.realizedProfit + entry.unrealizedProfit;
      const pnlPercent = avgPrice > 0 ? (totalPnl / (avgPrice * Math.abs(entry.netQty || 1))) * 100 : 0;

      return {
        positionId: `${entry.securityId}-${entry.productType}`,
        instrument: entry.tradingSymbol,
        exchange: entry.exchangeSegment as Position["exchange"],
        transactionType: (entry.netQty >= 0 ? "BUY" : "SELL") as Position["transactionType"],
        optionType: parsed?.optionType ?? ("CE" as const),
        strike: parsed?.strike ?? 0,
        expiry: parsed?.expiry ?? "",
        quantity: entry.netQty,
        averagePrice: avgPrice,
        ltp: 0, // Will be updated via WebSocket
        pnl: totalPnl,
        pnlPercent: Math.round(pnlPercent * 100) / 100,
        status: entry.netQty === 0 ? "CLOSED" as const : "OPEN" as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    });
  }

  async getMargin(): Promise<MarginInfo> {
    this._ensureToken();
    await this.rateLimiter.acquire();

    const result = await dhanRequest<DhanFundLimitResponse>(
      "GET",
      DHAN_ENDPOINTS.FUND_LIMIT,
      this.accessToken
    );

    if (result.isAuthError) {
      await handleDhan401(this.brokerId);
      await this._tryAutoRefresh();
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

  async getScripMaster(exchange: string): Promise<Instrument[]> {
    // Ensure scrip master is loaded
    await this._ensureScripMasterLoaded();

    const records = getRecordsByExchange(exchange);

    return records.map((r) => ({
      securityId: r.securityId,
      tradingSymbol: r.tradingSymbol,
      underlying: r.underlyingSymbol,
      exchange: r.exchange,
      segment: r.segment,
      optionType: r.optionType !== "XX" ? r.optionType : undefined,
      strike: r.strikePrice > 0 ? r.strikePrice : undefined,
      expiry: r.expiryDate || undefined,
      lotSize: r.lotSize,
      tickSize: r.tickSize,
    }));
  }

  async getLotSize(symbol: string): Promise<number> {
    return getLotSizeBySymbol(symbol);
  }

  async getExpiryList(underlying: string, exchangeSegment?: string): Promise<string[]> {
    this._ensureToken();

    const result = await dhanRequest<{ data: string[] }>(
      "POST",
      DHAN_ENDPOINTS.EXPIRY_LIST,
      this.accessToken,
      {
        UnderlyingScrip: Number(underlying),
        UnderlyingSeg: exchangeSegment || "IDX_I",
      },
      { clientId: this.clientId }
    );

    log.debug(`getExpiryList(${underlying}, ${exchangeSegment}) → status=${result.status}, ok=${result.ok}, data=${JSON.stringify(result.data)?.slice(0, 200)}`);

    if (result.isAuthError) {
      await handleDhan401(this.brokerId);
      await this._tryAutoRefresh();
      throw new Error("Token expired.");
    }

    if (!result.ok || !result.data) {
      return [];
    }

    return result.data.data ?? [];
  }

   async getOptionChain(underlying: string, expiry: string, exchangeSegment?: string): Promise<OptionChainData> {
    this._ensureToken();

    const requestBody = {
      UnderlyingScrip: Number(underlying),
      UnderlyingSeg: exchangeSegment || "IDX_I",
      Expiry: expiry,
    };

    const result = await dhanRequest<{
      data: {
        last_price: number;
        oc: Record<string, {
          ce?: {
            oi: number;
            previous_oi: number;
            last_price: number;
            volume: number;
            implied_volatility: number;
            security_id: number;
          };
          pe?: {
            oi: number;
            previous_oi: number;
            last_price: number;
            volume: number;
            implied_volatility: number;
            security_id: number;
          };
        }>;
      };
      status: string;
    }>(
      "POST",
      DHAN_ENDPOINTS.OPTION_CHAIN,
      this.accessToken,
      requestBody,
      { clientId: this.clientId }
    );

    if (result.isAuthError) {
      log.warn(`Token expired for underlying=${underlying}`);
      await handleDhan401(this.brokerId);
      await this._tryAutoRefresh();
      throw new Error("Token expired.");
    }

    if (!result.ok || !result.data) {
      const errorMsg = result.error?.errorMessage || result.error?.errorType || "Unknown error";
      log.warn(`Option chain fetch failed: underlying=${underlying}, expiry=${expiry}, status=${result.status}, error=${errorMsg}`);
      log.debug(`Full error response: ${JSON.stringify(result.error)}`);
      throw new Error(`Failed to fetch option chain: ${errorMsg}`);
    }

    const ocData = result.data.data;
    const rows = Object.entries(ocData.oc ?? {}).map(([strikeStr, strikes]) => ({
      strike: parseFloat(strikeStr),
      callOI: strikes.ce?.oi ?? 0,
      callOIChange: (strikes.ce?.oi ?? 0) - (strikes.ce?.previous_oi ?? 0),
      callLTP: strikes.ce?.last_price ?? 0,
      callVolume: strikes.ce?.volume ?? 0,
      callIV: strikes.ce?.implied_volatility ?? 0,
      callSecurityId: strikes.ce?.security_id ? String(strikes.ce.security_id) : undefined,
      putOI: strikes.pe?.oi ?? 0,
      putOIChange: (strikes.pe?.oi ?? 0) - (strikes.pe?.previous_oi ?? 0),
      putLTP: strikes.pe?.last_price ?? 0,
      putVolume: strikes.pe?.volume ?? 0,
      putIV: strikes.pe?.implied_volatility ?? 0,
      putSecurityId: strikes.pe?.security_id ? String(strikes.pe.security_id) : undefined,
    })).sort((a, b) => a.strike - b.strike);

    // Derive lot size from first available security ID in the option chain
    const firstEntry = Object.values(ocData.oc ?? {})[0];
    const firstSecId = firstEntry?.ce?.security_id ?? firstEntry?.pe?.security_id;
    const lotSize = firstSecId ? getLotSizeBySecurityId(String(firstSecId)) : 1;

    return {
      underlying,
      expiry,
      spotPrice: ocData.last_price ?? 0,
      lotSize,
      rows,
      timestamp: Date.now(),
    };
  }


  // ── Charts / Historical Data ──────────────────────────────────

  async getIntradayData(params: IntradayDataParams): Promise<CandleData> {
    this._ensureToken();
    await this.rateLimiter.acquire();

    const body: DhanIntradayDataRequest = {
      securityId: params.securityId,
      exchangeSegment: params.exchangeSegment,
      instrument: params.instrument,
      interval: params.interval,
      oi: params.oi ?? false,
      fromDate: params.fromDate,
      toDate: params.toDate,
    };

    const result = await withRetry(
      () => dhanRequest<DhanCandleDataResponse>(
        "POST",
        DHAN_ENDPOINTS.CHARTS_INTRADAY,
        this.accessToken,
        body as unknown as Record<string, unknown>
      ),
      {
        maxRetries: 2,
        delayMs: 500,
        shouldRetry: isRetryableError,
      }
    );

    if (result.isAuthError) {
      await handleDhan401(this.brokerId);
      await this._tryAutoRefresh();
      throw new Error("Token expired. Please update your Dhan access token.");
    }

    if (!result.ok || !result.data) {
      throw new Error(
        result.error?.errorMessage ?? `Intraday data fetch failed (HTTP ${result.status})`
      );
    }

    const data = result.data;
    return {
      open: data.open ?? [],
      high: data.high ?? [],
      low: data.low ?? [],
      close: data.close ?? [],
      volume: data.volume ?? [],
      timestamp: data.timestamp ?? [],
      ...(params.oi && data.open_interest ? { openInterest: data.open_interest } : {}),
    };
  }

  async getHistoricalData(params: HistoricalDataParams): Promise<CandleData> {
    this._ensureToken();
    await this.rateLimiter.acquire();

    const body: DhanHistoricalDataRequest = {
      securityId: params.securityId,
      exchangeSegment: params.exchangeSegment,
      instrument: params.instrument,
      expiryCode: params.expiryCode ?? 0,
      oi: params.oi ?? false,
      fromDate: params.fromDate,
      toDate: params.toDate,
    };

    const result = await withRetry(
      () => dhanRequest<DhanCandleDataResponse>(
        "POST",
        DHAN_ENDPOINTS.CHARTS_HISTORICAL,
        this.accessToken,
        body as unknown as Record<string, unknown>
      ),
      {
        maxRetries: 2,
        delayMs: 500,
        shouldRetry: isRetryableError,
      }
    );

    if (result.isAuthError) {
      await handleDhan401(this.brokerId);
      await this._tryAutoRefresh();
      throw new Error("Token expired. Please update your Dhan access token.");
    }

    if (!result.ok || !result.data) {
      throw new Error(
        result.error?.errorMessage ?? `Historical data fetch failed (HTTP ${result.status})`
      );
    }

    const data = result.data;
    return {
      open: data.open ?? [],
      high: data.high ?? [],
      low: data.low ?? [],
      close: data.close ?? [],
      volume: data.volume ?? [],
      timestamp: data.timestamp ?? [],
      ...(params.oi && data.open_interest ? { openInterest: data.open_interest } : {}),
    };
  }

  // ── Real-time (WebSocket) ─────────────────────────────────────

  subscribeLTP(instruments: SubscribeParams[], callback: TickCallback): void {
    this.tickCallback = callback;

    if (!this.subManager) {
      log.warn("SubscriptionManager not initialized. Call connect() first.");
      return;
    }

    this.subManager.subscribeManual(
      instruments.map((i) => ({
        exchange: i.exchange,
        securityId: i.securityId,
        mode: i.mode || "full",
      }))
    );
  }

  unsubscribeLTP(instruments: SubscribeParams[]): void {
    if (!this.subManager) return;

    this.subManager.unsubscribeManual(
      instruments.map((i) => ({
        exchange: i.exchange,
        securityId: i.securityId,
      }))
    );
  }

  onOrderUpdate(callback: OrderUpdateCallback): void {
    this.orderUpdateCb = callback;
    log.info("onOrderUpdate: Callback registered");
  }

  private connectOrderUpdateWs(): void {
    if (!this.clientId || !this.accessToken) return;
    if (this.orderUpdateWs) {
      this.orderUpdateWs.disconnect();
    }
    this.orderUpdateWs = new DhanOrderUpdateWs(this.clientId, this.accessToken);
    this.orderUpdateWs.on("orderUpdate", (update: import("./orderUpdateWs").NormalizedOrderUpdate) => {
      if (!this.orderUpdateCb) return;
      // Map to generic OrderUpdate for the broker interface
      const statusMap: Record<string, string> = {
        TRADED: "FILLED",
        CANCELLED: "CANCELLED",
        REJECTED: "REJECTED",
        PENDING: "PENDING",
        TRANSIT: "PENDING",
        EXPIRED: "CANCELLED",
      };
      this.orderUpdateCb({
        orderId: update.orderId,
        status: (statusMap[update.status] || "PENDING") as import("../../types").OrderStatus,
        filledQuantity: update.tradedQty,
        averagePrice: update.avgTradedPrice,
        timestamp: Date.now(),
      });
    });
    this.orderUpdateWs.connect();
    log.info("Order update WS connected");
  }

  getSubscriptionState(): SubscriptionState {
    return {
      totalSubscriptions: this.ws?.subscriptionCount ?? 0,
      maxSubscriptions: 200,
      instruments: new Map(),
      wsConnected: this.ws?.connected ?? false,
    };
  }

  async connectFeed(): Promise<void> {
    if (!this.accessToken || !this.clientId) {
      log.warn("Cannot connect feed — no credentials.");
      return;
    }

    // Initialize WebSocket
    // Lazy import to avoid circular dependency
    const { tickBus } = await import("../../tickBus");

    this.ws = new DhanWebSocket({
      accessToken: this.accessToken,
      clientId: this.clientId,
      onTick: (tick: TickData) => {
        if (this.tickCallback) this.tickCallback(tick);
      },
      onRawMessage: (data: Buffer) => {
        tickBus.emitRawBinary(data);
      },
      onPrevClose: () => {},
      onDisconnect: (code, reason) => {
        log.warn(`WS disconnected: ${reason} (${code})`);
        updateBrokerConnection(this.brokerId, { wsStatus: "disconnected" });
      },
      onError: (err) => {
        // Suppress repeated "max reconnect" spam — it's already logged once by WS
        if (!err.message.includes("max reconnect attempts")) {
          log.error(`WS error: ${err.message}`);
        }
        updateBrokerConnection(this.brokerId, { wsStatus: "error" });
      },
      onConnected: () => {
        updateBrokerConnection(this.brokerId, {
          wsStatus: "connected",
          lastWsTick: Date.now(),
        });
      },
    });

    // Initialize Subscription Manager
    this.subManager = new SubscriptionManager({
      onSubscribe: (instruments) => {
        if (this.ws) this.ws.subscribe(instruments);
      },
      onUnsubscribe: (instruments) => {
        if (this.ws) this.ws.unsubscribe(instruments);
      },
    });

    // Connect WebSocket
    try {
      await this.ws.connect();
      log.info("Feed connected (WS)");
    } catch (err) {
      log.error("Feed connection failed:", err);
      await updateBrokerConnection(this.brokerId, { wsStatus: "error" });
    }
  }

  async disconnectFeed(): Promise<void> {
    if (this.ws) {
      await this.ws.disconnect();
      this.ws = null;
    }
    this.subManager = null;
    await updateBrokerConnection(this.brokerId, { wsStatus: "disconnected" });
    log.info("Feed disconnected.");
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  async connect(): Promise<void> {
    // Load credentials from MongoDB
    const config = await getBrokerConfig(this.brokerId);

    if (!config) {
      log.warn("No config found in MongoDB. Waiting for token setup.");
      return;
    }

    this.accessToken = config.credentials.accessToken;
    this.clientId = config.credentials.clientId;
    this.tokenUpdatedAt = config.credentials.updatedAt;

    if (!this.accessToken) {
      log.warn("No access token configured. Waiting for token setup.");
      await updateBrokerConnection(this.brokerId, {
        apiStatus: "disconnected",
      });
      return;
    }

    // Always refresh on startup — ensures a fresh 24h token every morning.
    // Without this, yesterday's 13:30 token expires at 13:30 today (mid-session).
    // A fresh token at startup means it's valid for the entire trading day.
    log.info("Refreshing token on startup (fresh 24h TTL for today)...");
    const refreshed = await this._tryAutoRefresh();
    if (!refreshed) {
      // Fall back to existing token if refresh fails
      const expiry = calculateTokenExpiry(this.tokenUpdatedAt);
      if (expiry.isExpired) {
        log.error("Token refresh failed and existing token expired. BSA will start without a valid token.");
        return;
      }
      log.warn(`Token refresh failed but existing token still valid (${Math.round(expiry.remainingMs / 60000)} min remaining). Continuing with it.`);
    }

    // Validate token against Dhan API
    let validation = await validateDhanToken(this.accessToken);

    if (!validation.valid) {
      log.warn(`Token validation failed (${validation.error}) — auto-refreshing...`);
      const refreshed = await this._tryAutoRefresh();
      if (!refreshed) {
        log.error("Auto-refresh failed. BSA will start without a valid token.");
        await handleDhan401(this.brokerId);
        return;
      }
      validation = await validateDhanToken(this.accessToken);
      if (!validation.valid) {
        log.error(`Token invalid after refresh: ${validation.error}`);
        await handleDhan401(this.brokerId);
        return;
      }
    }

    this.clientId = validation.clientId ?? this.clientId;

    // Persist clientId to MongoDB so CredentialGate doesn't treat it as missing
    await updateBrokerCredentials(this.brokerId, {
      clientId: this.clientId,
    });

    await updateBrokerConnection(this.brokerId, {
      apiStatus: "connected",
      lastApiCall: Date.now(),
    });
    log.info(`Connected. Client: ${this.clientId}, Balance: ₹${validation.fundData?.availabelBalance ?? "N/A"}`);

    // Sandbox mode: token validation only — no WebSocket feed
    if (!this.sandboxMode) {
      await this.connectFeed();
      this.connectOrderUpdateWs();
    } else {
      log.info(`[${this.brokerId}] Sandbox mode — skipping WebSocket connections.`);
    }
  }

  async disconnect(): Promise<void> {
    // Disconnect order update WS
    if (this.orderUpdateWs) {
      this.orderUpdateWs.disconnect();
      this.orderUpdateWs = null;
    }
    // Disconnect feed
    await this.disconnectFeed();

    this.accessToken = "";
    this.clientId = "";
    this.tokenUpdatedAt = 0;
    this.killSwitchActive = false;
    this.orderUpdateCb = null;
    this.tickCallback = null;

    await updateBrokerConnection(this.brokerId, {
      apiStatus: "disconnected",
      wsStatus: "disconnected",
    });

    log.info("Disconnected.");
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
        log.error("exitAll during kill switch failed:", err);
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
   * First checks if it's already a numeric securityId, then tries scrip master lookup.
   */
  private _resolveSecurityId(params: OrderParams): string {
    // If instrument looks like a securityId (numeric), use it directly
    if (/^\d+$/.test(params.instrument)) {
      return params.instrument;
    }

    // Try scrip master lookup
    const result = scripLookup({
      symbol: params.instrument,
      expiry: params.expiry,
      strike: params.strike,
      optionType: params.optionType,
      exchange: params.exchange,
    });

    if (result) {
      return result.securityId;
    }

    // Fallback: return as-is
    log.warn(`Could not resolve securityId for ${params.instrument}. Using as-is.`);
    return params.instrument;
  }

  /**
   * Ensure scrip master is loaded and not stale (max age: 24 hours).
   */
  private async _ensureScripMasterLoaded(): Promise<void> {
    if (scripNeedsRefresh(24)) {
      try {
        await downloadScripMaster();
      } catch (err) {
        log.error("Scrip master download failed:", err);
      }
    }
  }

  /**
   * Get scrip master status (for REST/tRPC endpoints).
   */
  getScripMasterStatus(): ScripMasterStatusResult {
    const status = getScripMasterStatus();
    return {
      isLoaded: status.isLoaded,
      recordCount: status.recordCount,
      lastDownload: status.lastDownload,
      downloadTimeMs: status.downloadTimeMs,
      derivativeCount: status.derivativeCount,
      exchanges: status.exchanges,
    };
  }

  /**
   * Force refresh scrip master.
   */
  async refreshScripMaster(): Promise<ScripMasterStatusResult> {
    await downloadScripMaster();
    return this.getScripMasterStatus();
  }

  /**
   * Lookup a security ID from the scrip master.
   */
  lookupSecurity(params: SecurityLookupParams): SecurityLookupResult | null {
    const result = scripLookup(params);
    if (!result) return null;
    return {
      securityId: result.securityId,
      tradingSymbol: result.tradingSymbol,
      customSymbol: result.customSymbol,
      lotSize: result.lotSize,
      exchange: result.exchange,
      instrumentName: result.instrumentName,
      expiryDate: result.expiryDate,
      strikePrice: result.strikePrice,
      optionType: result.optionType,
    };
  }

  /**
   * Get expiry dates from the scrip master cache.
   */
  getScripExpiryDates(
    symbol: string,
    exchange?: string,
    instrumentName?: string
  ): string[] {
    return scripExpiryDates(symbol, exchange, instrumentName);
  }

  /**
   * Resolve nearest-month MCX FUTCOM.
   */
  async resolveMCXFutcom(symbol: string): Promise<SecurityLookupResult | null> {
    await this._ensureScripMasterLoaded();
    const result = resolveMCXFutcom(symbol);
    if (!result) return null;
    return {
      securityId: result.securityId,
      tradingSymbol: result.tradingSymbol,
      customSymbol: result.customSymbol,
      lotSize: result.lotSize,
      exchange: result.exchange,
      instrumentName: result.instrumentName,
      expiryDate: result.expiryDate,
      strikePrice: result.strikePrice,
      optionType: result.optionType,
    };
  }

  /**
   * Map a Dhan order book entry to our internal Order type.
   * Parses tradingSymbol to extract optionType, strike, and expiry.
   */
  private _mapDhanOrder(entry: DhanOrderBookEntry): Order {
    const parsed = parseTradingSymbol(entry.tradingSymbol ?? "");

    return {
      orderId: entry.orderId,
      instrument: entry.tradingSymbol ?? entry.securityId,
      exchange: entry.exchangeSegment as Order["exchange"],
      transactionType: entry.transactionType as Order["transactionType"],
      optionType: parsed?.optionType ?? ("CE" as const),
      strike: parsed?.strike ?? 0,
      expiry: parsed?.expiry ?? "",
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
