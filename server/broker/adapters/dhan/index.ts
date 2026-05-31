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
  DHAN_SANDBOX_API_BASE,
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
} from "./scripMaster";

import {
  parseTradingSymbol,
  RateLimiter,
  withRetry,
  isRetryableError,
} from "./utils";

import { DhanWebSocket } from "./websocket";
import { SubscriptionManager } from "./subscriptionManager";
import { DhanOrderUpdateWs } from "./orderUpdateWs";
import { generateDhanToken } from "./tokenManager";
import type { SubscriptionState, TickData } from "../../types";
import { createLogger, type Logger } from "../../logger";
import { notifyBrokerDisconnect } from "../../../_core/tradeEventNotifier";
import { dhanApiLatencyMs } from "../../../_core/metrics";

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

  // Option chain cache + global throttle. Dhan rate-limits the option chain
  // endpoint to ~1 request per 3s across ALL underlyings on a single API key.
  // Per-key cache (chainCache) coalesces duplicate fetches for the same
  // (underlying,expiry); the global serializer (chainFetchGate) staggers
  // fetches across underlyings so concurrent TFA processes for NIFTY +
  // BANKNIFTY + CRUDEOIL don't burst-trip 429s at market open.
  private chainCache = new Map<string, { data: OptionChainData; fetchedAt: number }>();
  private chainInflight = new Map<string, Promise<OptionChainData>>();
  private readonly CHAIN_CACHE_TTL_MS = 5100; // > CHAIN_MIN_INTERVAL_MS so cache always has data when next fetch is allowed
  private readonly CHAIN_MIN_INTERVAL_MS = 5000; // global gap between fetches (widened from 3100 → 5000 to add headroom over Dhan's 3s window)
  private chainLastFetchAt = 0;
  private chainFetchGate: Promise<void> = Promise.resolve();

  // WebSocket and Subscription Manager
  private ws: DhanWebSocket | null = null;
  private subManager: SubscriptionManager | null = null;
  private tickCallback: TickCallback | null = null;

  // Per-instance logger so logs carry the brokerId, distinguishing the
  // primary "dhan-primary-ac" from "dhan-secondary-ac" / "dhan-sandbox" in shared output.
  private readonly log: Logger;

  constructor(brokerId = "dhan-primary-ac", sandboxMode = false) {
    this.brokerId = brokerId;
    this.sandboxMode = sandboxMode;
    this.displayName = sandboxMode ? "Dhan Sandbox" : "Dhan";
    // Friendly log tag: "dhan-primary-ac" → "primary-ac",
    // "dhan-secondary-ac" → "secondary-ac", "dhan-sandbox" → "sandbox".
    // Falls back to raw brokerId for any other.
    const logTag = brokerId.replace(/^dhan-/, "");
    this.log = createLogger("BSA", `Dhan/${logTag}`);
  }

  // ── REST plumbing ─────────────────────────────────────────────
  //
  // Sandbox mode routes every REST call to Dhan's sandbox host (same path +
  // payload shape as live). The two private wrappers (_dhanRequest /
  // _validateToken) auto-inject this.accessToken + this._baseUrl so callers
  // don't need to think about which host they're hitting.

  /** Read-only metadata adapter (option chain, scrip master, WS feed) used
   *  ONLY when this adapter is in sandboxMode — Dhan sandbox doesn't expose
   *  market-data endpoints, so we route those reads to the primary live
   *  adapter. Wired by brokerService.initBrokerService after both adapters
   *  are constructed. */
  private metadataSource: BrokerAdapter | null = null;
  setMetadataSource(adapter: BrokerAdapter | null): void {
    this.metadataSource = adapter;
  }

  private get _baseUrl(): string {
    return this.sandboxMode ? DHAN_SANDBOX_API_BASE : DHAN_API_BASE;
  }

  private _dhanRequest<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    endpoint: string,
    body?: Record<string, unknown>,
    options?: { timeout?: number; clientId?: string },
  ) {
    return dhanRequest<T>(method, endpoint, this.accessToken, body, {
      ...options,
      baseUrl: this._baseUrl,
    });
  }

  private _validateToken() {
    return validateDhanToken(this.accessToken, { baseUrl: this._baseUrl });
  }

  // ── Token Auto-Refresh ────────────────────────────────────────

  /**
   * Generate a fresh token via TOTP and apply it in-memory + MongoDB.
   * Returns true on success, false on any failure.
   *
   * Only invoked from startup paths (first-launch mint, startup refresh
   * decision, startup post-validation recovery). Never called mid-session
   * after the May 6 2026 refresh-on-startup-only policy change.
   */
  private async _tryAutoRefresh(): Promise<boolean> {
    try {
      this.log.info("Refreshing Dhan token via TOTP...");
      const newToken = await generateDhanToken(this.brokerId);
      await this.updateToken(newToken);
      this.log.info("Token refreshed successfully.");
      return true;
    } catch (err: any) {
      this.log.error(`Token refresh failed: ${err.message}`);
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
    const result = await this._validateToken();

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
    // Validate against this adapter's own URL — sandbox tokens are issued by
    // developer.dhanhq.co and are rejected by the live host (DH-906), so we
    // must route the validate call to the right base URL.
    const result = await updateDhanToken(this.brokerId, token, clientId, { baseUrl: this._baseUrl });

    if (result.success) {
      this.accessToken = token;
      this.clientId = result.clientId ?? clientId ?? this.clientId;
      this.tokenUpdatedAt = Date.now();
      // Propagate to WebSocket + order update WS
      if (this.ws) this.ws.updateToken(token);
      if (this.orderUpdateWs) this.orderUpdateWs.updateCredentials(this.clientId, token);
      this.log.info(`Token updated. Client: ${this.clientId}`);
    } else {
      throw new Error(result.message);
    }
  }

  // ── Orders ────────────────────────────────────────────────────

  async placeOrder(params: OrderParams): Promise<OrderResult> {
    const _t0 = Date.now();
    let _status: "success" | "error" = "success";
    try {
      return await this._placeOrderImpl(params);
    } catch (err) {
      _status = "error";
      throw err;
    } finally {
      dhanApiLatencyMs.labels({ endpoint: "placeOrder", status: _status }).observe(Date.now() - _t0);
    }
  }

  private async _placeOrderImpl(params: OrderParams): Promise<OrderResult> {
    this._ensureToken();
    this._ensureNotKilled();

    // Load broker settings for configurable defaults
    const config = await getBrokerConfig(this.brokerId);
    const settings = config?.settings;

    // Resolve security ID from scrip master
    const securityId = this._resolveSecurityId(params);

    // Calculate limit price with offset if order type is LIMIT and price is 0 (auto-calculate)
    const price = params.price;
    if (params.orderType === "LIMIT" && price === 0 && settings) {
      // Price of 0 means "use LTP with offset" — caller should provide actual LTP as price
      // For now, keep price as-is; the frontend will calculate using LTP
      this.log.warn("LIMIT order with price=0. Frontend should provide LTP-based price.");
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
      () => this._dhanRequest<DhanOrderResponse>(
        "POST",
        DHAN_ENDPOINTS.PLACE_ORDER,
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
      throw new Error("Token expired. Restart BSA to refresh (refresh-on-startup policy).");
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

    const result = await this._dhanRequest<DhanOrderResponse>(
      "PUT",
      DHAN_ENDPOINTS.MODIFY_ORDER(orderId),
      body
    );

    if (result.isAuthError) {
      await handleDhan401(this.brokerId);
      throw new Error("Token expired. Restart BSA to refresh (refresh-on-startup policy).");
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

    const result = await this._dhanRequest<DhanOrderResponse>(
      "DELETE",
      DHAN_ENDPOINTS.CANCEL_ORDER(orderId),
    );

    if (result.isAuthError) {
      await handleDhan401(this.brokerId);
      throw new Error("Token expired. Restart BSA to refresh (refresh-on-startup policy).");
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

    const result = await this._dhanRequest<DhanOrderBookEntry[]>(
      "GET",
      DHAN_ENDPOINTS.ORDER_BOOK,
    );

    if (result.isAuthError) {
      await handleDhan401(this.brokerId);
      throw new Error("Token expired. Restart BSA to refresh.");
    }

    if (!result.ok || !result.data) {
      return [];
    }

    return result.data.map((entry) => this._mapDhanOrder(entry));
  }

  async getOrderStatus(orderId: string): Promise<Order> {
    this._ensureToken();
    await this.rateLimiter.acquire();

    const result = await this._dhanRequest<DhanOrderBookEntry>(
      "GET",
      DHAN_ENDPOINTS.ORDER_STATUS(orderId),
    );

    if (result.isAuthError) {
      await handleDhan401(this.brokerId);
      throw new Error("Token expired. Restart BSA to refresh.");
    }

    if (!result.ok || !result.data) {
      throw new Error(`Order ${orderId} not found.`);
    }

    return this._mapDhanOrder(result.data);
  }

  async getTradeBook(): Promise<Trade[]> {
    this._ensureToken();
    await this.rateLimiter.acquire();

    const result = await this._dhanRequest<DhanTradeBookEntry[]>(
      "GET",
      DHAN_ENDPOINTS.TRADE_BOOK,
    );

    if (result.isAuthError) {
      await handleDhan401(this.brokerId);
      throw new Error("Token expired. Restart BSA to refresh.");
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

    const result = await this._dhanRequest<DhanPositionEntry[]>(
      "GET",
      DHAN_ENDPOINTS.POSITIONS,
    );

    if (result.isAuthError) {
      await handleDhan401(this.brokerId);
      throw new Error("Token expired. Restart BSA to refresh.");
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

    const result = await this._dhanRequest<DhanFundLimitResponse>(
      "GET",
      DHAN_ENDPOINTS.FUND_LIMIT,
    );

    if (result.isAuthError) {
      await handleDhan401(this.brokerId);
      throw new Error("Token expired. Restart BSA to refresh.");
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
    // Sandbox doesn't expose scrip master — delegate to the live primary adapter.
    if (this.sandboxMode && this.metadataSource) {
      return this.metadataSource.getScripMaster(exchange);
    }
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
    if (this.sandboxMode && this.metadataSource?.getLotSize) {
      return this.metadataSource.getLotSize(symbol);
    }
    return getLotSizeBySymbol(symbol);
  }

  async getExpiryList(underlying: string, exchangeSegment?: string): Promise<string[]> {
    // Sandbox doesn't expose expiry-list — delegate to live primary adapter.
    if (this.sandboxMode && this.metadataSource?.getExpiryList) {
      return this.metadataSource.getExpiryList(underlying, exchangeSegment);
    }
    this._ensureToken();

    const result = await this._dhanRequest<{ data: string[] }>(
      "POST",
      DHAN_ENDPOINTS.EXPIRY_LIST,
      {
        UnderlyingScrip: Number(underlying),
        UnderlyingSeg: exchangeSegment || "IDX_I",
      },
      { clientId: this.clientId }
    );

    this.log.debug(`getExpiryList(${underlying}, ${exchangeSegment}) → status=${result.status}, ok=${result.ok}, data=${JSON.stringify(result.data)?.slice(0, 200)}`);

    if (result.isAuthError) {
      await handleDhan401(this.brokerId);
      throw new Error("Token expired. Restart BSA to refresh.");
    }

    if (!result.ok || !result.data) {
      return [];
    }

    return result.data.data ?? [];
  }

   async getOptionChain(underlying: string, expiry: string, exchangeSegment?: string): Promise<OptionChainData> {
    // Sandbox doesn't expose option chain — delegate to live primary adapter.
    // Read-only metadata, no money risk; sandbox just borrows the chain shape
    // so option trades can be placed against the sandbox order API.
    if (this.sandboxMode && this.metadataSource?.getOptionChain) {
      return this.metadataSource.getOptionChain(underlying, expiry, exchangeSegment);
    }
    // Cache key: underlying + expiry + segment
    const cacheKey = `${underlying}|${expiry}|${exchangeSegment || "IDX_I"}`;
    const now = Date.now();

    // Return cached result if fresh
    const cached = this.chainCache.get(cacheKey);
    if (cached && now - cached.fetchedAt < this.CHAIN_CACHE_TTL_MS) {
      return cached.data;
    }

    // Coalesce in-flight requests
    const inflight = this.chainInflight.get(cacheKey);
    if (inflight) return inflight;

    const promise = this._fetchOptionChain(underlying, expiry, exchangeSegment);
    this.chainInflight.set(cacheKey, promise);
    try {
      const data = await promise;
      this.chainCache.set(cacheKey, { data, fetchedAt: Date.now() });
      // Fan out to browsers via tickBus → /ws/ticks (text frame).
      // TFA and UI both trigger this path; every cache write pushes the latest
      // chain to all connected clients so their optionChainStore stays current
      // without additional Dhan traffic.
      try {
        const { tickBus } = await import("../../tickBus");
        tickBus.emitChainUpdate(underlying, expiry, exchangeSegment || "IDX_I", data);
      } catch {
        /* non-fatal: emit path isn't required for cache correctness */
      }
      return data;
    } finally {
      this.chainInflight.delete(cacheKey);
    }
  }

  private async _acquireChainFetchSlot(): Promise<void> {
    // Serialize callers via a promise chain; each call waits for the prior
    // slot to release, then sleeps until CHAIN_MIN_INTERVAL_MS has elapsed
    // since the last fetch start. Gap is measured from request-issue time
    // (not response time) so a slow upstream call doesn't compound delay.
    const prev = this.chainFetchGate;
    let release!: () => void;
    this.chainFetchGate = new Promise<void>((res) => {
      release = res;
    });
    try {
      await prev;
      const waitMs = this.CHAIN_MIN_INTERVAL_MS - (Date.now() - this.chainLastFetchAt);
      if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
      this.chainLastFetchAt = Date.now();
    } finally {
      release();
    }
  }

  private async _fetchOptionChain(underlying: string, expiry: string, exchangeSegment?: string): Promise<OptionChainData> {
    this._ensureToken();
    await this._acquireChainFetchSlot();

    const requestBody = {
      UnderlyingScrip: Number(underlying),
      UnderlyingSeg: exchangeSegment || "IDX_I",
      Expiry: expiry,
    };

    const result = await this._dhanRequest<{
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
      requestBody,
      { clientId: this.clientId }
    );

    if (result.isAuthError) {
      this.log.warn(`Token expired for underlying=${underlying}`);
      await handleDhan401(this.brokerId);
      throw new Error("Token expired. Restart BSA to refresh.");
    }

    if (!result.ok || !result.data) {
      // Dhan sometimes returns {status:"failed", data:{<code>:"<message>"}}
      // instead of the typed {errorMessage, errorType} shape — unwrap the
      // first message from `data` so the real reason reaches the caller.
      const errAny = result.error as any;
      const dataMsg = errAny && typeof errAny.data === "object" && errAny.data
        ? String(Object.values(errAny.data)[0] ?? "")
        : "";
      const errorMsg =
        errAny?.errorMessage ||
        errAny?.errorType ||
        dataMsg ||
        (result.status === 429 ? "Rate limited by Dhan" : "Unknown error");
      this.log.warn(`Option chain fetch failed: underlying=${underlying}, expiry=${expiry}, status=${result.status}, error=${errorMsg}`);
      this.log.debug(`Full error response: ${JSON.stringify(result.error)}`);
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
      () => this._dhanRequest<DhanCandleDataResponse>(
        "POST",
        DHAN_ENDPOINTS.CHARTS_INTRADAY,
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
      throw new Error("Token expired. Restart BSA to refresh (refresh-on-startup policy).");
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
      () => this._dhanRequest<DhanCandleDataResponse>(
        "POST",
        DHAN_ENDPOINTS.CHARTS_HISTORICAL,
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
      throw new Error("Token expired. Restart BSA to refresh (refresh-on-startup policy).");
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

    // Sandbox has no WebSocket — delegate the subscription to the live primary
    // adapter so sandbox trades read the same live tick stream as everyone else.
    if (this.sandboxMode && this.metadataSource?.subscribeLTP) {
      this.metadataSource.subscribeLTP(instruments, callback);
      return;
    }

    if (!this.subManager) {
      this.log.warn("SubscriptionManager not initialized. Call connect() first.");
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
    if (this.sandboxMode && this.metadataSource?.unsubscribeLTP) {
      this.metadataSource.unsubscribeLTP(instruments);
      return;
    }

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
    this.log.info("onOrderUpdate: Callback registered");
  }

  private connectOrderUpdateWs(): void {
    if (!this.clientId || !this.accessToken) return;
    if (this.orderUpdateWs) {
      this.orderUpdateWs.disconnect();
    }
    this.orderUpdateWs = new DhanOrderUpdateWs(this.clientId, this.accessToken, this.brokerId);
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
        brokerId: this.brokerId,
        orderId: update.orderId,
        status: (statusMap[update.status] || "PENDING") as import("../../types").OrderStatus,
        filledQuantity: update.tradedQty,
        averagePrice: update.avgTradedPrice,
        timestamp: Date.now(),
      });
    });
    this.orderUpdateWs.connect();
    this.log.important("Order update WS connected");
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
      this.log.warn("Cannot connect feed — no credentials.");
      return;
    }

    // Initialize WebSocket
    // Lazy import to avoid circular dependency
    const { tickBus } = await import("../../tickBus");

    this.ws = new DhanWebSocket({
      accessToken: this.accessToken,
      clientId: this.clientId,
      brokerTag: this.brokerId,
      onTick: (tick: TickData) => {
        if (this.tickCallback) this.tickCallback(tick);
      },
      onRawMessage: (data: Buffer) => {
        tickBus.emitRawBinary(data);
      },
      onPrevClose: () => {},
      onDisconnect: (code, reason) => {
        this.log.warn(`WS disconnected: ${reason} (${code})`);
        void updateBrokerConnection(this.brokerId, { wsStatus: "disconnected" });
      },
      onError: (err) => {
        // Suppress repeated "max reconnect" spam — it's already logged once by WS
        if (!err.message.includes("max reconnect attempts")) {
          this.log.error(`WS error: ${err.message}`);
        }
        void updateBrokerConnection(this.brokerId, { wsStatus: "error" });
        // T52: push to Telegram when the WS reconnect loop has exhausted
        // its attempts. Routine single drops auto-recover and are too
        // noisy to push (5-min per-broker cooldown protects against
        // burst-storms if the give-up condition fires repeatedly).
        if (err.message.includes("max reconnect attempts")) {
          notifyBrokerDisconnect({
            brokerId: this.brokerId,
            kind: "ws_gave_up",
            reason: err.message,
          });
        }
      },
      onConnected: () => {
        void updateBrokerConnection(this.brokerId, {
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
      this.log.important("Feed connected (WS)");
    } catch (err) {
      this.log.error("Feed connection failed:", err);
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
    this.log.info("Feed disconnected.");
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  async connect(): Promise<void> {
    // ── Sandbox path ───────────────────────────────────────────
    // Dhan sandbox uses a separate API host with its own access token (issued
    // by developer.dhanhq.co — no TOTP refresh flow). Load creds from Mongo,
    // validate against the sandbox API, skip TOTP refresh + WebSocket.
    if (this.sandboxMode) {
      const config = await getBrokerConfig(this.brokerId);
      if (!config || !config.credentials.accessToken) {
        this.log.warn(
          "Sandbox access token missing. Paste your sandbox token via Settings or: " +
          `node scripts/dhan-update-credentials.mjs --brokerId ${this.brokerId} --accessToken <SANDBOX_TOKEN>`
        );
        await updateBrokerConnection(this.brokerId, { apiStatus: "disconnected" });
        return;
      }
      this.accessToken = config.credentials.accessToken;
      this.clientId = config.credentials.clientId;
      this.tokenUpdatedAt = config.credentials.updatedAt;

      const validation = await this._validateToken();
      if (!validation.valid) {
        this.log.error(`Sandbox token invalid: ${validation.error}. Refresh token at developer.dhanhq.co and re-paste.`);
        await updateBrokerCredentials(this.brokerId, { status: "expired" });
        await updateBrokerConnection(this.brokerId, { apiStatus: "error" });
        return;
      }
      this.clientId = validation.clientId ?? this.clientId;
      await updateBrokerCredentials(this.brokerId, { clientId: this.clientId, status: "valid" });
      await updateBrokerConnection(this.brokerId, {
        apiStatus: "connected",
        lastApiCall: Date.now(),
      });
      this.log.important(
        `Sandbox connected. Client: ${this.clientId}. Balance: ₹${validation.fundData?.availabelBalance ?? "N/A"}. ` +
        `Note: every order fills at ₹100, capital resets to ₹10,00,000 daily. WebSocket + option chain are NOT available; ` +
        `metadata reads will delegate to the primary live adapter.`
      );
      return;
    }

    // Load credentials from MongoDB
    const config = await getBrokerConfig(this.brokerId);

    if (!config) {
      this.log.warn("No config found in MongoDB. Waiting for token setup.");
      throw new Error(`No broker_config found for ${this.brokerId}`);
    }

    this.accessToken = config.credentials.accessToken;
    this.clientId = config.credentials.clientId;
    this.tokenUpdatedAt = config.credentials.updatedAt;

    // First-launch path: no access token yet, but TOTP inputs are stored →
    // mint the initial token now via TOTP, then continue.
    const auth = (config as any).auth ?? {};
    const hasAuthCreds = !!auth.clientId && !!auth.pin && !!auth.totpSecret;

    if (!this.accessToken) {
      if (!hasAuthCreds) {
        this.log.warn(
          "No access token and no TOTP auth credentials. " +
          `Set them with: node scripts/dhan-update-credentials.mjs --brokerId ${this.brokerId} --clientId <ID> --pin <PIN> --totp <SECRET>`
        );
        await updateBrokerConnection(this.brokerId, { apiStatus: "disconnected" });
        throw new Error(`Missing TOTP auth credentials for ${this.brokerId}`);
      }
      this.log.info("No access token yet — running first-time TOTP refresh to mint one...");
      const minted = await this._tryAutoRefresh();
      if (!minted || !this.accessToken) {
        this.log.error("First-time TOTP refresh failed. Adapter will not be ready until next restart.");
        await updateBrokerConnection(this.brokerId, { apiStatus: "disconnected" });
        throw new Error(`First-time TOTP refresh failed for ${this.brokerId}`);
      }
      // Fall through into the validation path below — already have a fresh token.
    } else {
      // Existing-token path: mint a fresh token if any of the following holds:
      //   1. token expired or ≤12h remaining (TTL gate)
      //   2. calendar date rolled over since the token was issued (Dhan invalidates
      //      tokens at the day boundary even when the 24h TTL still has hours left —
      //      e.g. a token minted 11 PM Sun is "valid for 22h" but Dhan rejects it
      //      for Mon's market session).
      // Server runs in IST and Dhan operates in IST, so local-date comparison is correct.
      // Refresh policy (May 6 2026): refresh ONLY at startup, and even at
      // startup skip if the token is < 2h old. Rapid server restarts shouldn't
      // burn TOTP refreshes (Dhan's 1-token-per-2-min rate limit), and a
      // recently-minted token is trusted as-is.
      const TWO_HOURS_MS = 2 * 3_600_000;
      const ageMs = Date.now() - this.tokenUpdatedAt;
      const expiry = calculateTokenExpiry(this.tokenUpdatedAt);
      const issuedDate = new Date(this.tokenUpdatedAt).toDateString();
      const todayDate = new Date().toDateString();
      const dateChanged = issuedDate !== todayDate;

      if (ageMs < TWO_HOURS_MS) {
        this.log.info(
          `Token is ${Math.round(ageMs / 60_000)} min old (< 2h) — skipping startup refresh.`,
        );
      } else if (expiry.isExpired || dateChanged) {
        const reason = expiry.isExpired
          ? "expired"
          : `date rolled over (issued ${issuedDate}, today ${todayDate})`;
        this.log.info(`Refreshing token on startup (${reason})...`);
        const refreshed = await this._tryAutoRefresh();
        if (!refreshed) {
          if (expiry.isExpired) {
            this.log.error("Token refresh failed and existing token expired. BSA will start without a valid token.");
            await updateBrokerCredentials(this.brokerId, { status: "expired" });
            await updateBrokerConnection(this.brokerId, { apiStatus: "error" });
            return;
          }
          this.log.warn(
            `Token refresh failed but existing token still valid (${Math.round(expiry.remainingMs / 60_000)} min remaining). Continuing with it.`,
          );
        }
      } else {
        const hoursLeft = (expiry.remainingMs / 3_600_000).toFixed(1);
        this.log.info(`Token has ${hoursLeft}h remaining, same day — skipping startup refresh.`);
      }
    }

    // Validate token against Dhan API
    let validation = await this._validateToken();

    if (!validation.valid) {
      this.log.warn(`Token validation failed (${validation.error}) — auto-refreshing...`);
      const refreshed = await this._tryAutoRefresh();
      if (!refreshed) {
        this.log.error("Auto-refresh failed. BSA will start without a valid token.");
        await handleDhan401(this.brokerId);
        return;
      }
      validation = await this._validateToken();
      if (!validation.valid) {
        this.log.error(`Token invalid after refresh: ${validation.error}`);
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
    this.log.important(`Connected. Client: ${this.clientId}, Balance: ₹${validation.fundData?.availabelBalance ?? "N/A"}`);

    // Live path always opens WebSocket feeds. Sandbox path returned early
    // above — it has no WebSocket support on Dhan's side.
    await this.connectFeed();
    this.connectOrderUpdateWs();
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

    this.log.info("Disconnected.");
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
        this.log.error("exitAll during kill switch failed:", err);
      }

      // Then activate Dhan's kill switch
      const result = await this._dhanRequest<DhanKillSwitchResponse>(
        "POST",
        `${DHAN_ENDPOINTS.KILL_SWITCH}?killSwitchStatus=ACTIVATE`,
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
      const result = await this._dhanRequest<DhanKillSwitchResponse>(
        "POST",
        `${DHAN_ENDPOINTS.KILL_SWITCH}?killSwitchStatus=DEACTIVATE`,
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
    this.log.warn(`Could not resolve securityId for ${params.instrument}. Using as-is.`);
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
        this.log.error("Scrip master download failed:", err);
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
