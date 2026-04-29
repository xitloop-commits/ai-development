/**
 * Mock Adapter — Paper Trading Implementation
 *
 * Full BrokerAdapter implementation for paper trading.
 * Everything runs in-memory — no external dependencies.
 *
 * Behavior:
 * - Orders fill instantly at the requested price
 * - Positions track P&L (unrealized = 0 without real LTP feed)
 * - Virtual margin starts at ₹5,00,000 (configurable)
 * - Kill switch blocks new orders and exits all positions
 * - Token validation always returns valid
 * - WebSocket/LTP methods are no-ops
 */

import { createLogger } from "../../logger";

const log = createLogger("BSA", "Mock");

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
  TickData,
  OrderUpdateCallback,
  SubscriptionState,
  ScripMasterStatusResult,
  SecurityLookupParams,
  SecurityLookupResult,
} from "../../types";
import { MockOrderBook } from "./mockOrderBook";

// ─── Default Config ─────────────────────────────────────────────

const DEFAULT_INITIAL_MARGIN = 500000; // ₹5,00,000

// ─── MockAdapter Class ──────────────────────────────────────────

export class MockAdapter implements BrokerAdapter {
  readonly brokerId: string;
  readonly displayName: string;

  private orderBook: MockOrderBook;
  private connected = false;
  private killSwitchActive = false;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private tickCallback: TickCallback | null = null;
  private subscribedInstruments = new Map<string, SubscribeParams>();

  constructor(
    brokerId = "mock",
    displayName = "Paper Trading",
    initialMargin: number = DEFAULT_INITIAL_MARGIN
  ) {
    this.brokerId = brokerId;
    this.displayName = displayName;
    this.orderBook = new MockOrderBook(brokerId, initialMargin);
  }

  // ── Auth ──────────────────────────────────────────────────────

  async validateToken(): Promise<{ valid: boolean; expiresAt?: number }> {
    // Mock adapter always has a valid token
    return { valid: true };
  }

  async updateToken(_token: string, _clientId?: string): Promise<void> {
    // No-op for mock adapter
  }

  // ── Orders ────────────────────────────────────────────────────

  async placeOrder(params: OrderParams): Promise<OrderResult> {
    if (this.killSwitchActive) {
      return {
        orderId: "",
        status: "REJECTED",
        message: "Kill switch is active. All trading is halted.",
        timestamp: Date.now(),
      };
    }

    return this.orderBook.placeOrder(params);
  }

  async modifyOrder(
    orderId: string,
    params: ModifyParams
  ): Promise<OrderResult> {
    if (this.killSwitchActive) {
      return {
        orderId,
        status: "REJECTED",
        message: "Kill switch is active. Cannot modify orders.",
        timestamp: Date.now(),
      };
    }

    return this.orderBook.modifyOrder(orderId, params);
  }

  async cancelOrder(orderId: string): Promise<OrderResult> {
    return this.orderBook.cancelOrder(orderId);
  }

  async exitAll(): Promise<OrderResult[]> {
    return this.orderBook.exitAll();
  }

  async getOrderBook(): Promise<Order[]> {
    return this.orderBook.getOrderBook();
  }

  async getOrderStatus(orderId: string): Promise<Order> {
    const order = this.orderBook.getOrderStatus(orderId);
    if (!order) {
      throw new Error(`Order ${orderId} not found`);
    }
    return order;
  }

  async getTradeBook(): Promise<Trade[]> {
    return this.orderBook.getTradeBook();
  }

  // ── Positions & Funds ─────────────────────────────────────────

  async getPositions(): Promise<Position[]> {
    return this.orderBook.getPositions();
  }

  async getMargin(): Promise<MarginInfo> {
    return this.orderBook.getMargin();
  }

  // ── Market Data ───────────────────────────────────────────────

  async getScripMaster(_exchange: string): Promise<Instrument[]> {
    // Mock adapter returns a small set of sample instruments
    return [
      {
        securityId: "MOCK-NIFTY-26000-CE",
        tradingSymbol: "NIFTY 03APR 26000 CE",
        underlying: "NIFTY_50",
        exchange: "NSE",
        segment: "NSE_FNO",
        optionType: "CE",
        strike: 26000,
        expiry: "2026-04-03",
        lotSize: 50,
        tickSize: 0.05,
      },
      {
        securityId: "MOCK-NIFTY-26000-PE",
        tradingSymbol: "NIFTY 03APR 26000 PE",
        underlying: "NIFTY_50",
        exchange: "NSE",
        segment: "NSE_FNO",
        optionType: "PE",
        strike: 26000,
        expiry: "2026-04-03",
        lotSize: 50,
        tickSize: 0.05,
      },
      {
        securityId: "MOCK-BANKNIFTY-55000-CE",
        tradingSymbol: "BANKNIFTY 03APR 55000 CE",
        underlying: "BANK_NIFTY",
        exchange: "NSE",
        segment: "NSE_FNO",
        optionType: "CE",
        strike: 55000,
        expiry: "2026-04-03",
        lotSize: 30,
        tickSize: 0.05,
      },
      {
        securityId: "MOCK-CRUDEOIL-6000-CE",
        tradingSymbol: "CRUDEOIL 20APR 6000 CE",
        underlying: "CRUDE_OIL",
        exchange: "MCX",
        segment: "MCX_COMM",
        optionType: "CE",
        strike: 6000,
        expiry: "2026-04-20",
        lotSize: 100,
        tickSize: 1,
      },
    ];
  }

  async getExpiryList(_underlying: string, _exchangeSegment?: string): Promise<string[]> {
    // Mock adapter returns sample expiry dates
    return ["2026-04-03", "2026-04-10", "2026-04-17", "2026-04-24"];
  }

  async getLotSize(symbol: string): Promise<number> {
    const MOCK_LOT_SIZES: Record<string, number> = {
      NIFTY: 25, BANKNIFTY: 15, FINNIFTY: 25, MIDCPNIFTY: 50,
      SENSEX: 10, BANKEX: 15,
      CRUDEOIL: 100, NATURALGAS: 1250, GOLD: 1, SILVER: 30,
    };
    return MOCK_LOT_SIZES[symbol.toUpperCase()] ?? 1;
  }

  async getOptionChain(
    underlying: string,
    expiry: string,
    _exchangeSegment?: string
  ): Promise<OptionChainData> {
    // Mock adapter returns a sample option chain
    const sym = underlying.toUpperCase();
    const isNifty = sym.includes("NIFTY");
    const baseStrike = isNifty ? 26000 : 6000;
    const step = isNifty ? 100 : 50;

    // Static lot sizes matching NSE/MCX exchange norms
    const MOCK_LOT_SIZES: Record<string, number> = {
      NIFTY: 25, BANKNIFTY: 15, FINNIFTY: 25, MIDCPNIFTY: 50,
      SENSEX: 10, BANKEX: 15,
      CRUDEOIL: 100, NATURALGAS: 1250, GOLD: 1, SILVER: 30,
    };
    const lotSize = MOCK_LOT_SIZES[sym] ?? (isNifty ? 25 : 1);

    const rows = [];
    for (let i = -5; i <= 5; i++) {
      const strike = baseStrike + i * step;
      rows.push({
        strike,
        callOI: Math.floor(Math.random() * 100000),
        callOIChange: Math.floor(Math.random() * 10000) - 5000,
        callLTP: Math.max(0.05, (5 - i) * 20 + Math.random() * 10),
        callVolume: Math.floor(Math.random() * 50000),
        callIV: 15 + Math.random() * 10,
        callSecurityId: `MOCK-${sym}-${strike}-CE`,
        putOI: Math.floor(Math.random() * 100000),
        putOIChange: Math.floor(Math.random() * 10000) - 5000,
        putLTP: Math.max(0.05, (i + 5) * 20 + Math.random() * 10),
        putVolume: Math.floor(Math.random() * 50000),
        putIV: 15 + Math.random() * 10,
        putSecurityId: `MOCK-${sym}-${strike}-PE`,
      });
    }

    return {
      underlying,
      expiry,
      spotPrice: baseStrike,
      lotSize,
      rows,
      timestamp: Date.now(),
    };
  }

  // ── Charts / Historical Data (Mock) ────────────────────────────

  async getIntradayData(params: IntradayDataParams): Promise<CandleData> {
    // Generate mock intraday candle data
    const count = 30; // 30 candles
    const basePrice = 3750;
    const baseTime = Math.floor(Date.now() / 1000) - count * 60;

    const open: number[] = [];
    const high: number[] = [];
    const low: number[] = [];
    const close: number[] = [];
    const volume: number[] = [];
    const timestamp: number[] = [];

    let price = basePrice;
    for (let i = 0; i < count; i++) {
      const jitter = (Math.random() - 0.5) * 20;
      const o = Math.round((price + jitter) * 100) / 100;
      const h = Math.round((o + Math.random() * 10) * 100) / 100;
      const l = Math.round((o - Math.random() * 10) * 100) / 100;
      const c = Math.round((l + Math.random() * (h - l)) * 100) / 100;
      price = c;

      open.push(o);
      high.push(h);
      low.push(l);
      close.push(c);
      volume.push(Math.floor(Math.random() * 10000) + 1000);
      timestamp.push(baseTime + i * 60);
    }

    const result: CandleData = { open, high, low, close, volume, timestamp };
    if (params.oi) {
      result.openInterest = Array(count).fill(0);
    }
    return result;
  }

  async getHistoricalData(params: HistoricalDataParams): Promise<CandleData> {
    // Generate mock daily historical candle data
    const count = 20; // 20 trading days
    const basePrice = 3800;
    const baseTime = Math.floor(Date.now() / 1000) - count * 86400;

    const open: number[] = [];
    const high: number[] = [];
    const low: number[] = [];
    const close: number[] = [];
    const volume: number[] = [];
    const timestamp: number[] = [];

    let price = basePrice;
    for (let i = 0; i < count; i++) {
      const jitter = (Math.random() - 0.5) * 100;
      const o = Math.round((price + jitter) * 100) / 100;
      const h = Math.round((o + Math.random() * 50) * 100) / 100;
      const l = Math.round((o - Math.random() * 50) * 100) / 100;
      const c = Math.round((l + Math.random() * (h - l)) * 100) / 100;
      price = c;

      open.push(o);
      high.push(h);
      low.push(l);
      close.push(c);
      volume.push(Math.floor(Math.random() * 5000000) + 500000);
      timestamp.push(baseTime + i * 86400);
    }

    const result: CandleData = { open, high, low, close, volume, timestamp };
    if (params.oi) {
      result.openInterest = Array(count).fill(0);
    }
    return result;
  }

  // ── Scrip Master Helpers ──────────────────────────────────────

  getScripMasterStatus(): ScripMasterStatusResult {
    return {
      isLoaded: true,
      recordCount: 4,
      lastDownload: Date.now(),
      downloadTimeMs: 0,
      derivativeCount: 4,
      exchanges: ["NSE", "MCX"],
      message: "Mock scrip master (static data)",
    };
  }

  async refreshScripMaster(): Promise<ScripMasterStatusResult> {
    return this.getScripMasterStatus();
  }

  lookupSecurity(params: SecurityLookupParams): SecurityLookupResult | null {
    // Simple mock lookup — matches against the static sample instruments
    const instruments = [
      { securityId: "MOCK-NIFTY-26000-CE", tradingSymbol: "NIFTY 03APR 26000 CE", customSymbol: "NIFTY 26 APR 26000 CALL", lotSize: 50, exchange: "NSE", instrumentName: "OPTIDX", expiryDate: "2026-04-03", strikePrice: 26000, optionType: "CE" },
      { securityId: "MOCK-NIFTY-26000-PE", tradingSymbol: "NIFTY 03APR 26000 PE", customSymbol: "NIFTY 26 APR 26000 PUT", lotSize: 50, exchange: "NSE", instrumentName: "OPTIDX", expiryDate: "2026-04-03", strikePrice: 26000, optionType: "PE" },
      { securityId: "MOCK-BANKNIFTY-55000-CE", tradingSymbol: "BANKNIFTY 03APR 55000 CE", customSymbol: "BANKNIFTY 26 APR 55000 CALL", lotSize: 30, exchange: "NSE", instrumentName: "OPTIDX", expiryDate: "2026-04-03", strikePrice: 55000, optionType: "CE" },
      { securityId: "MOCK-CRUDEOIL-6000-CE", tradingSymbol: "CRUDEOIL 20APR 6000 CE", customSymbol: "CRUDEOIL 26 APR 6000 CALL", lotSize: 100, exchange: "MCX", instrumentName: "OPTCOM", expiryDate: "2026-04-20", strikePrice: 6000, optionType: "CE" },
    ];

    return instruments.find((inst) => {
      const symbolMatch = inst.tradingSymbol.toUpperCase().includes(params.symbol.toUpperCase());
      const expiryMatch = !params.expiry || inst.expiryDate === params.expiry;
      const strikeMatch = !params.strike || inst.strikePrice === params.strike;
      const optionMatch = !params.optionType || inst.optionType === params.optionType;
      const exchangeMatch = !params.exchange || inst.exchange === params.exchange;
      return symbolMatch && expiryMatch && strikeMatch && optionMatch && exchangeMatch;
    }) ?? null;
  }

  getScripExpiryDates(_symbol: string, _exchange?: string, _instrumentName?: string): string[] {
    return ["2026-04-03", "2026-04-10", "2026-04-17", "2026-04-24"];
  }

  resolveMCXFutcom(symbol: string): SecurityLookupResult | null {
    const sym = symbol.toUpperCase();
    if (sym === "CRUDEOIL") {
      return {
        securityId: "MOCK-CRUDEOIL-FUT",
        tradingSymbol: "CRUDEOIL 20APR FUT",
        customSymbol: "CRUDEOIL 26 APR FUTURE",
        lotSize: 100,
        exchange: "MCX",
        instrumentName: "FUTCOM",
        expiryDate: "2026-04-20",
        strikePrice: 0,
        optionType: "XX",
      };
    }
    if (sym === "NATURALGAS") {
      return {
        securityId: "MOCK-NATURALGAS-FUT",
        tradingSymbol: "NATURALGAS 28APR FUT",
        customSymbol: "NATURALGAS 26 APR FUTURE",
        lotSize: 1250,
        exchange: "MCX",
        instrumentName: "FUTCOM",
        expiryDate: "2026-04-28",
        strikePrice: 0,
        optionType: "XX",
      };
    }
    return null;
  }

  // ── Real-time (WebSocket) ─────────────────────────────────────

  subscribeLTP(instruments: SubscribeParams[], callback: TickCallback): void {
    this.tickCallback = callback;
    for (const inst of instruments) {
      this.subscribedInstruments.set(`${inst.exchange}:${inst.securityId}`, inst);
    }
    if (!this.tickTimer && this.subscribedInstruments.size > 0) {
      this.startTickSimulation();
    }
    log.info(`subscribeLTP: ${instruments.length} instruments`);
  }

  unsubscribeLTP(instruments: SubscribeParams[]): void {
    for (const inst of instruments) {
      this.subscribedInstruments.delete(`${inst.exchange}:${inst.securityId}`);
    }
    if (this.subscribedInstruments.size === 0 && this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  getSubscriptionState(): SubscriptionState {
    return {
      totalSubscriptions: this.subscribedInstruments.size,
      maxSubscriptions: 200,
      instruments: new Map(),
      wsConnected: this.connected,
    };
  }

  private startTickSimulation(): void {
    const basePrices = new Map<string, number>();
    this.tickTimer = setInterval(() => {
      if (!this.tickCallback) return;
      for (const [key, inst] of Array.from(this.subscribedInstruments)) {
        if (!basePrices.has(key)) basePrices.set(key, 100 + Math.random() * 400);
        const base = basePrices.get(key)!;
        const jitter = (Math.random() - 0.5) * base * 0.005;
        const ltp = Math.round((base + jitter) * 100) / 100;
        basePrices.set(key, ltp);
        const tick: TickData = {
          securityId: inst.securityId,
          exchange: inst.exchange,
          ltp,
          ltq: Math.floor(Math.random() * 100) + 1,
          ltt: Math.floor(Date.now() / 1000),
          atp: ltp,
          volume: Math.floor(Math.random() * 100000),
          totalSellQty: Math.floor(Math.random() * 50000),
          totalBuyQty: Math.floor(Math.random() * 50000),
          oi: Math.floor(Math.random() * 500000),
          highOI: Math.floor(Math.random() * 600000),
          lowOI: Math.floor(Math.random() * 400000),
          dayOpen: ltp * 0.99,
          dayClose: 0,
          dayHigh: ltp * 1.01,
          dayLow: ltp * 0.98,
          prevClose: ltp * 0.995,
          prevOI: Math.floor(Math.random() * 500000),
          depth: [],
          bidPrice: ltp - 0.05,
          askPrice: ltp + 0.05,
          timestamp: Date.now(),
        };
        this.tickCallback(tick);
      }
    }, 2000);
  }

  onOrderUpdate(callback: OrderUpdateCallback): void {
    this.orderBook.onOrderUpdate(callback);
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  async connect(): Promise<void> {
    this.connected = true;
    log.info("Connected (paper trading mode)");
  }

  async disconnect(): Promise<void> {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.tickCallback = null;
    this.subscribedInstruments.clear();
    this.connected = false;
    log.info("Disconnected");
  }

  // ── Emergency ─────────────────────────────────────────────────

  async killSwitch(
    action: "ACTIVATE" | "DEACTIVATE"
  ): Promise<{ status: string; message?: string }> {
    if (action === "ACTIVATE") {
      this.killSwitchActive = true;

      // Exit all open positions
      const exitResults = this.orderBook.exitAll();
      const exitCount = exitResults.length;

      return {
        status: "activated",
        message: `Kill switch activated. ${exitCount} position(s) closed. All new orders blocked.`,
      };
    }

    // DEACTIVATE
    this.killSwitchActive = false;
    return {
      status: "deactivated",
      message: "Kill switch deactivated. Trading resumed.",
    };
  }

  // ── Mock-specific Methods ─────────────────────────────────────

  /**
   * Check if the mock adapter is connected.
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Check if the kill switch is active.
   */
  isKillSwitchActive(): boolean {
    return this.killSwitchActive;
  }

  /**
   * Reset the mock adapter state (orders, positions, margin).
   */
  reset(initialMargin?: number): void {
    this.orderBook.reset(initialMargin);
    this.killSwitchActive = false;
  }

  /**
   * Simulate an LTP update for testing P&L calculation.
   */
  simulateLTPUpdate(positionId: string, ltp: number): void {
    this.orderBook.simulateLTPUpdate(positionId, ltp);
  }

  /**
   * Get only open positions (convenience method).
   */
  async getOpenPositions(): Promise<Position[]> {
    return this.orderBook.getOpenPositions();
  }
}
