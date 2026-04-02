/**
 * Broker Service — Type Definitions & Adapter Interface
 *
 * This file defines the unified contract that all broker adapters must implement.
 * The interface is designed to be broker-agnostic: Dhan, Mock, and future brokers
 * (Zerodha, Angel One, Upstox) all implement the same BrokerAdapter interface.
 */

// ─── Enums & Constants ──────────────────────────────────────────

export type OrderType = "LIMIT" | "MARKET" | "SL" | "SL-M";
export type ProductType = "INTRADAY" | "CNC" | "MARGIN";
export type TransactionType = "BUY" | "SELL";
export type ExchangeSegment = "IDX_I" | "NSE_EQ" | "NSE_FNO" | "BSE_FNO" | "MCX_COMM";
export type OptionType = "CE" | "PE" | "FUT";

export type OrderStatus =
  | "PENDING"
  | "OPEN"
  | "FILLED"
  | "PARTIALLY_FILLED"
  | "CANCELLED"
  | "REJECTED"
  | "EXPIRED";

export type PositionStatus = "OPEN" | "CLOSED";

export type TokenStatus = "valid" | "expired" | "unknown";
export type ConnectionStatus = "connected" | "disconnected" | "error";

// ─── Order Types ────────────────────────────────────────────────

export interface OrderParams {
  instrument: string; // e.g. "NIFTY_50"
  exchange: ExchangeSegment;
  transactionType: TransactionType;
  optionType: OptionType;
  strike: number;
  expiry: string; // ISO date string
  quantity: number;
  price: number; // limit price
  orderType: OrderType;
  productType: ProductType;
  triggerPrice?: number; // for SL orders
  stopLoss?: number; // bracket SL
  target?: number; // bracket TP
  tag?: string; // user tag for identification
}

export interface ModifyParams {
  price?: number;
  quantity?: number;
  triggerPrice?: number;
  orderType?: OrderType;
}

export interface OrderResult {
  orderId: string;
  status: OrderStatus;
  message?: string;
  timestamp: number; // UTC ms
}

export interface Order {
  orderId: string;
  instrument: string;
  exchange: ExchangeSegment;
  transactionType: TransactionType;
  optionType: OptionType;
  strike: number;
  expiry: string;
  quantity: number;
  filledQuantity: number;
  price: number;
  averagePrice: number;
  triggerPrice?: number;
  orderType: OrderType;
  productType: ProductType;
  status: OrderStatus;
  tag?: string;
  createdAt: number; // UTC ms
  updatedAt: number; // UTC ms
}

export interface Trade {
  tradeId: string;
  orderId: string;
  instrument: string;
  exchange: ExchangeSegment;
  transactionType: TransactionType;
  optionType: OptionType;
  strike: number;
  expiry: string;
  quantity: number;
  price: number;
  timestamp: number; // UTC ms
}

// ─── Position Types ─────────────────────────────────────────────

export interface Position {
  positionId: string;
  instrument: string;
  exchange: ExchangeSegment;
  transactionType: TransactionType;
  optionType: OptionType;
  strike: number;
  expiry: string;
  quantity: number;
  averagePrice: number;
  ltp: number;
  pnl: number;
  pnlPercent: number;
  status: PositionStatus;
  createdAt: number; // UTC ms
  updatedAt: number; // UTC ms
}

// ─── Margin / Funds ─────────────────────────────────────────────

export interface MarginInfo {
  available: number;
  used: number;
  total: number;
}

// ─── Market Data Types ──────────────────────────────────────────

export interface Instrument {
  securityId: string;
  tradingSymbol: string;
  underlying: string;
  exchange: string;
  segment: string;
  optionType?: string;
  strike?: number;
  expiry?: string;
  lotSize: number;
  tickSize: number;
}

export interface OptionChainRow {
  strike: number;
  callOI: number;
  callOIChange: number;
  callLTP: number;
  callVolume: number;
  callIV: number;
  putOI: number;
  putOIChange: number;
  putLTP: number;
  putVolume: number;
  putIV: number;
}

export interface OptionChainData {
  underlying: string;
  expiry: string;
  spotPrice: number;
  rows: OptionChainRow[];
  timestamp: number; // UTC ms
}

// ─── Real-time Types ────────────────────────────────────────────

export type FeedMode = "ticker" | "quote" | "full";

export interface SubscribeParams {
  securityId: string;
  exchange: ExchangeSegment;
  mode?: FeedMode; // default "full"
}

export interface MarketDepthLevel {
  bidQty: number;
  askQty: number;
  bidOrders: number;
  askOrders: number;
  bidPrice: number;
  askPrice: number;
}

export interface TickData {
  securityId: string;
  exchange: ExchangeSegment;
  ltp: number;
  ltq: number; // last traded quantity
  ltt: number; // last trade time (epoch seconds)
  atp: number; // average trade price
  volume: number;
  totalSellQty: number;
  totalBuyQty: number;
  oi: number;
  highOI: number; // highest OI for the day (NSE_FNO)
  lowOI: number; // lowest OI for the day (NSE_FNO)
  dayOpen: number;
  dayClose: number; // only post-market
  dayHigh: number;
  dayLow: number;
  prevClose: number;
  prevOI: number;
  depth: MarketDepthLevel[]; // 5 levels
  bidPrice: number; // best bid (depth[0].bidPrice shortcut)
  askPrice: number; // best ask (depth[0].askPrice shortcut)
  timestamp: number; // UTC ms (local receive time)
}

export type TickCallback = (data: TickData) => void;

export interface OrderUpdate {
  orderId: string;
  status: OrderStatus;
  filledQuantity: number;
  averagePrice: number;
  timestamp: number; // UTC ms
}

export type OrderUpdateCallback = (update: OrderUpdate) => void;

// ─── Subscription Manager Types ────────────────────────────────

export interface SubscriptionState {
  totalSubscriptions: number;
  maxSubscriptions: number;
  instruments: Map<string, { exchange: ExchangeSegment; mode: FeedMode }>;
  wsConnected: boolean;
}

export interface ATMWindowConfig {
  strikeWindow: number; // +/- strikes from ATM (default 10)
  underlying: string; // e.g. "NIFTY", "BANKNIFTY"
  expiry: string; // ISO date
  exchange: ExchangeSegment;
}

// ─── Broker Config (MongoDB document shape) ─────────────────────

export interface BrokerCredentials {
  accessToken: string;
  clientId: string;
  updatedAt: number; // UTC ms
  expiresIn: number; // ms (default 86400000 = 24h)
  status: TokenStatus;
}

export interface BrokerSettings {
  orderEntryOffset: number; // % below LTP for limit orders (default 1.0)
  defaultSL: number; // default stop loss % (default 2.0)
  defaultTP: number; // default target profit % (default 5.0)
  orderType: OrderType; // default order type (default "LIMIT")
  productType: ProductType; // default product type (default "INTRADAY")
}

export interface BrokerConnection {
  apiStatus: ConnectionStatus;
  wsStatus: ConnectionStatus;
  lastApiCall: number | null; // UTC ms
  lastWsTick: number | null; // UTC ms
  latencyMs: number | null;
}

export interface BrokerCapabilities {
  bracketOrder: boolean;
  coverOrder: boolean;
  websocket: boolean;
  optionChain: boolean;
  gtt: boolean; // Good Till Triggered
  amo: boolean; // After Market Order
}

export interface BrokerConfigDoc {
  brokerId: string;
  displayName: string;
  isActive: boolean;
  isPaperBroker: boolean;
  credentials: BrokerCredentials;
  settings: BrokerSettings;
  connection: BrokerConnection;
  capabilities: BrokerCapabilities;
}

// ─── Broker Adapter Interface ───────────────────────────────────

export interface BrokerAdapter {
  /** Unique broker identifier (e.g. "dhan", "mock") */
  readonly brokerId: string;

  /** Human-readable name (e.g. "Dhan", "Paper Trading") */
  readonly displayName: string;

  // ── Auth ──────────────────────────────────────────────────────
  /** Validate the stored access token. Returns validity and optional expiry. */
  validateToken(): Promise<{ valid: boolean; expiresAt?: number }>;

  /** Update the access token (and optionally client ID). */
  updateToken(token: string, clientId?: string): Promise<void>;

  // ── Orders ────────────────────────────────────────────────────
  /** Place a new order. Returns orderId and status. */
  placeOrder(params: OrderParams): Promise<OrderResult>;

  /** Modify a pending order. */
  modifyOrder(orderId: string, params: ModifyParams): Promise<OrderResult>;

  /** Cancel a pending order. */
  cancelOrder(orderId: string): Promise<OrderResult>;

  /** Exit all open positions and cancel all pending orders. */
  exitAll(): Promise<OrderResult[]>;

  /** Get all orders for the current session. */
  getOrderBook(): Promise<Order[]>;

  /** Get status of a specific order. */
  getOrderStatus(orderId: string): Promise<Order>;

  /** Get all executed trades for the current session. */
  getTradeBook(): Promise<Trade[]>;

  // ── Positions & Funds ─────────────────────────────────────────
  /** Get all current positions. */
  getPositions(): Promise<Position[]>;

  /** Get margin/fund information. */
  getMargin(): Promise<MarginInfo>;

  // ── Market Data ───────────────────────────────────────────────
  /** Get scrip master (instrument list) for an exchange. */
  getScripMaster(exchange: string): Promise<Instrument[]>;

  /** Get available expiry dates for an underlying. */
  getExpiryList(underlying: string): Promise<string[]>;

  /** Get option chain data for an underlying + expiry. */
  getOptionChain(underlying: string, expiry: string): Promise<OptionChainData>;

  // ── Scrip Master Helpers (optional — implemented by adapters with local cache) ──
  /** Get scrip master cache status. */
  getScripMasterStatus?(): ScripMasterStatusResult;

  /** Force refresh the scrip master cache. */
  refreshScripMaster?(): Promise<ScripMasterStatusResult>;

  /** Lookup a single security from the scrip master cache. */
  lookupSecurity?(params: SecurityLookupParams): SecurityLookupResult | null;

  /** Get expiry dates from the scrip master cache (not Dhan API). */
  getScripExpiryDates?(symbol: string, exchange?: string, instrumentName?: string): string[];

  /** Resolve nearest-month MCX FUTCOM security ID. */
  resolveMCXFutcom?(symbol: string): SecurityLookupResult | null;

  // ── Real-time (WebSocket) ─────────────────────────────────────
  /** Subscribe to live tick data for instruments. Mode: ticker (LTP only), quote (OHLCV+OI), full (+ depth). */
  subscribeLTP(instruments: SubscribeParams[], callback: TickCallback): void;

  /** Unsubscribe from tick data updates. */
  unsubscribeLTP(instruments: SubscribeParams[]): void;

  /** Subscribe to real-time order status updates. */
  onOrderUpdate(callback: OrderUpdateCallback): void;

  /** Get current subscription state (count, instruments, ws status). */
  getSubscriptionState?(): SubscriptionState;

  /** Connect the WebSocket feed (called automatically by connect(), or manually for reconnect). */
  connectFeed?(): Promise<void>;

  /** Disconnect the WebSocket feed without disconnecting the adapter. */
  disconnectFeed?(): Promise<void>;

  // ── Lifecycle ─────────────────────────────────────────────────
  /** Initialize the adapter (validate token, connect WebSocket, etc.). */
  connect(): Promise<void>;

  /** Gracefully shut down the adapter. */
  disconnect(): Promise<void>;

  // ── Emergency ─────────────────────────────────────────────────
  /** Kill switch: cancel all orders, close all positions, block trading. */
  killSwitch(
    action: "ACTIVATE" | "DEACTIVATE"
  ): Promise<{ status: string; message?: string }>;
}

// ─── Scrip Master Helper Types ─────────────────────────────────

export interface ScripMasterStatusResult {
  isLoaded: boolean;
  recordCount: number;
  lastDownload: number; // UTC ms
  downloadTimeMs: number;
  derivativeCount?: number;
  exchanges?: string[];
  message?: string;
}

export interface SecurityLookupParams {
  symbol: string;
  expiry?: string;
  strike?: number;
  optionType?: string;
  exchange?: string;
  instrumentName?: string;
}

export interface SecurityLookupResult {
  securityId: string;
  tradingSymbol: string;
  customSymbol: string;
  lotSize: number;
  exchange: string;
  instrumentName: string;
  expiryDate: string;
  strikePrice: number;
  optionType: string;
}

// ─── Broker Service Status ──────────────────────────────────────

export interface BrokerServiceStatus {
  activeBrokerId: string | null;
  activeBrokerName: string | null;
  tokenStatus: TokenStatus;
  apiStatus: ConnectionStatus;
  wsStatus: ConnectionStatus;
  killSwitchActive: boolean;
  registeredAdapters: string[];
}
