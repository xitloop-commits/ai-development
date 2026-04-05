/**
 * Dhan API v2 — Request/Response Types
 *
 * These types map directly to Dhan's API contracts.
 * They are converted to/from our internal BrokerAdapter types in the adapter.
 */

// ─── Fund Limit (used for token validation) ────────────────────

export interface DhanFundLimitResponse {
  dhanClientId: string;
  availabelBalance: number; // Note: Dhan has a typo in their API ("availabel")
  sodLimit: number;
  collateralAmount: number;
  receiveableAmount: number;
  utilizedAmount: number;
  blockedPayoutAmount: number;
  withdrawableBalance: number;
}

// ─── Orders ────────────────────────────────────────────────────

export interface DhanOrderRequest {
  dhanClientId: string;
  correlationId?: string;
  transactionType: "BUY" | "SELL";
  exchangeSegment: string;
  productType: string;
  orderType: string;
  validity: "DAY" | "IOC";
  securityId: string;
  quantity: number;
  price: number;
  triggerPrice?: number;
  afterMarketOrder?: boolean;
  boProfitValue?: number;
  boStopLossValue?: number;
}

export interface DhanOrderResponse {
  orderId: string;
  orderStatus: string;
  dhanClientId?: string;
}

export interface DhanOrderBookEntry {
  dhanClientId: string;
  orderId: string;
  correlationId?: string;
  orderStatus: string;
  transactionType: string;
  exchangeSegment: string;
  productType: string;
  orderType: string;
  validity: string;
  tradingSymbol: string;
  securityId: string;
  quantity: number;
  disclosedQuantity?: number;
  price: number;
  triggerPrice?: number;
  afterMarketOrder?: boolean;
  boProfitValue?: number;
  boStopLossValue?: number;
  remainingQuantity?: number;
  filledQty?: number;
  averageTradedPrice?: number;
  exchangeTime?: string;
  createTime?: string;
  updateTime?: string;
  exchangeOrderId?: string;
  omsErrorCode?: string;
  omsErrorDescription?: string;
}

export interface DhanTradeBookEntry {
  dhanClientId: string;
  orderId: string;
  exchangeOrderId?: string;
  transactionType: string;
  exchangeSegment: string;
  productType: string;
  orderType: string;
  tradingSymbol: string;
  securityId: string;
  tradedQuantity: number;
  tradedPrice: number;
  exchangeTime?: string;
  createTime?: string;
}

// ─── Positions ─────────────────────────────────────────────────

export interface DhanPositionEntry {
  dhanClientId: string;
  tradingSymbol: string;
  securityId: string;
  positionType?: string;
  exchangeSegment: string;
  productType: string;
  buyAvg: number;
  buyQty: number;
  sellAvg: number;
  sellQty: number;
  netQty: number;
  realizedProfit: number;
  unrealizedProfit: number;
  dayBuyQty?: number;
  dayBuyAvg?: number;
  daySellQty?: number;
  daySellAvg?: number;
  multiplier?: number;
}

// ─── Kill Switch ───────────────────────────────────────────────

export interface DhanKillSwitchResponse {
  dhanClientId: string;
  killSwitchStatus: string;
}

// ─── Option Chain ──────────────────────────────────────────────

export interface DhanExpiryListRequest {
  UnderlyingScrip: string;
  UnderlyingSeg: string;
}

export interface DhanExpiryListResponse {
  data: string[]; // array of expiry date strings
}

export interface DhanOptionChainRequest {
  UnderlyingScrip: string;
  UnderlyingSeg: string;
  Expiry: string;
}

export interface DhanOptionChainEntry {
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
}

export interface DhanOptionChainResponse {
  data: DhanOptionChainEntry[];
  spotPrice?: number;
}

// ─── Charts / Historical Data ─────────────────────────────────

export interface DhanHistoricalDataRequest {
  securityId: string;
  exchangeSegment: string;
  instrument: string;
  expiryCode?: number;
  oi?: boolean;
  fromDate: string; // "YYYY-MM-DD"
  toDate: string;   // "YYYY-MM-DD" (non-inclusive)
}

export interface DhanIntradayDataRequest {
  securityId: string;
  exchangeSegment: string;
  instrument: string;
  interval: string; // "1", "5", "15", "25", "60"
  oi?: boolean;
  fromDate: string; // "YYYY-MM-DD HH:mm:ss"
  toDate: string;   // "YYYY-MM-DD HH:mm:ss"
}

export interface DhanCandleDataResponse {
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
  timestamp: number[];
  open_interest?: number[];
}

// ─── Error Response ────────────────────────────────────────────

export interface DhanErrorResponse {
  errorType?: string;
  errorCode?: string;
  errorMessage?: string;
}

// ─── Scrip Master CSV Row ──────────────────────────────────────

export interface DhanScripMasterRow {
  SEM_EXM_EXCH_ID: string; // Exchange (NSE, BSE, MCX)
  SEM_SEGMENT: string; // Segment (E, D, C)
  SEM_SMST_SECURITY_ID: string; // Security ID
  SEM_INSTRUMENT_NAME: string; // OPTIDX, FUTIDX, OPTSTK, etc.
  SEM_TRADING_SYMBOL: string; // Trading symbol
  SEM_CUSTOM_SYMBOL: string; // Custom symbol
  SEM_EXPIRY_DATE: string; // Expiry date
  SEM_STRIKE_PRICE: string; // Strike price
  SEM_OPTION_TYPE: string; // CE, PE, XX
  SEM_LOT_UNITS: string; // Lot size
  SEM_TICK_SIZE: string; // Tick size
  SEM_EXPIRY_FLAG: string; // Expiry flag
}
