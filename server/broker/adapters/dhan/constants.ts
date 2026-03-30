/**
 * Dhan API v2 — Constants
 *
 * Base URLs, exchange segment mappings, error codes, and rate limits.
 */

// ─── Base URLs ─────────────────────────────────────────────────

export const DHAN_API_BASE = "https://api.dhan.co/v2";

// ─── Endpoints ─────────────────────────────────────────────────

export const DHAN_ENDPOINTS = {
  // Auth / Profile (use fundlimit as token validation)
  FUND_LIMIT: "/fundlimit",

  // Orders
  PLACE_ORDER: "/orders",
  MODIFY_ORDER: (orderId: string) => `/orders/${orderId}`,
  CANCEL_ORDER: (orderId: string) => `/orders/${orderId}`,
  ORDER_BOOK: "/orders",
  ORDER_STATUS: (orderId: string) => `/orders/${orderId}`,
  TRADE_BOOK: "/trades",
  TRADES_BY_ORDER: (orderId: string) => `/trades/${orderId}`,

  // Positions & Portfolio
  POSITIONS: "/positions",
  HOLDINGS: "/holdings",

  // Kill Switch
  KILL_SWITCH: "/killswitch",

  // P&L Based Exit
  PNL_EXIT: "/pnlExit",

  // Market Data
  OPTION_CHAIN: "/optionchain",
  EXPIRY_LIST: "/optionchain/expirylist",
  MARKET_QUOTE: "/marketfeed/ltp",

  // Scrip Master (CSV download — not under /v2)
  SCRIP_MASTER: "https://images.dhan.co/api-data/api-scrip-master.csv",
} as const;

// ─── Exchange Segment Mapping ──────────────────────────────────

/** Maps our internal exchange segment to Dhan's enum values */
export const DHAN_EXCHANGE_SEGMENTS: Record<string, string> = {
  NSE_EQ: "NSE_EQ",
  NSE_FNO: "NSE_FNO",
  BSE_EQ: "BSE_EQ",
  BSE_FNO: "BSE_FNO",
  MCX_COMM: "MCX_COMM",
};

// ─── Order Type Mapping ────────────────────────────────────────

/** Maps our internal order types to Dhan's enum values */
export const DHAN_ORDER_TYPES: Record<string, string> = {
  LIMIT: "LIMIT",
  MARKET: "MARKET",
  SL: "STOP_LOSS",
  "SL-M": "STOP_LOSS_MARKET",
};

// ─── Product Type Mapping ──────────────────────────────────────

export const DHAN_PRODUCT_TYPES: Record<string, string> = {
  INTRADAY: "INTRADAY",
  CNC: "CNC",
  MARGIN: "MARGIN",
};

// ─── Dhan Order Status → Our Status ───────────────────────────

export const DHAN_ORDER_STATUS_MAP: Record<string, string> = {
  TRANSIT: "PENDING",
  PENDING: "PENDING",
  REJECTED: "REJECTED",
  CANCELLED: "CANCELLED",
  TRADED: "FILLED",
  EXPIRED: "EXPIRED",
};

// ─── Token Defaults ────────────────────────────────────────────

/** Dhan access tokens expire after 24 hours */
export const DHAN_TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000; // 86,400,000 ms

/** Buffer before expiry to warn (1 hour) */
export const DHAN_TOKEN_EXPIRY_BUFFER_MS = 60 * 60 * 1000; // 3,600,000 ms

// ─── Rate Limits ───────────────────────────────────────────────

export const DHAN_RATE_LIMITS = {
  orders: { perSecond: 10, perMinute: 250, perHour: 1000, perDay: 7000 },
  data: { perSecond: 5, perDay: 100000 },
  quote: { perSecond: 1 },
  nonTrading: { perSecond: 20 },
  modifyPerOrder: 25,
} as const;

// ─── Error Codes ───────────────────────────────────────────────

/** HTTP status codes that indicate token issues */
export const DHAN_AUTH_ERROR_CODES = [401, 403];

/** Common Dhan error types */
export const DHAN_ERROR_TYPES = {
  UNAUTHORIZED: "DH-901",
  TOKEN_EXPIRED: "DH-902",
  INVALID_TOKEN: "DH-903",
  RATE_LIMITED: "DH-904",
  ORDER_REJECTED: "DH-905",
} as const;
