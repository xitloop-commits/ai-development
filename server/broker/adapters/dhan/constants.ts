/**
 * Dhan API v2 — Constants
 *
 * Base URLs, exchange segment mappings, error codes, and rate limits.
 */

// ─── Base URLs ─────────────────────────────────────────────────

export const DHAN_API_BASE = "https://api.dhan.co/v2";
export const DHAN_WS_FEED_URL = "wss://api-feed.dhan.co";

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
  IDX_I: "IDX_I",
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

// ─── WebSocket Feed Constants ─────────────────────────────────

/** Feed Request Codes (JSON messages sent to server) */
export const DHAN_FEED_REQUEST = {
  CONNECT: 11,
  DISCONNECT: 12,
  SUBSCRIBE_TICKER: 15,
  UNSUBSCRIBE_TICKER: 16,
  SUBSCRIBE_QUOTE: 17,
  UNSUBSCRIBE_QUOTE: 18,
  SUBSCRIBE_FULL: 21,
  UNSUBSCRIBE_FULL: 22,
  SUBSCRIBE_DEPTH: 23,
  UNSUBSCRIBE_DEPTH: 25,
} as const;

/** Feed Response Codes (binary header byte 0) */
export const DHAN_FEED_RESPONSE = {
  INDEX: 1,
  TICKER: 2,
  QUOTE: 4,
  OI: 5,
  PREV_CLOSE: 6,
  MARKET_STATUS: 7,
  FULL: 8,
  DISCONNECT: 50,
} as const;

/** Exchange Segment numeric codes for WS binary header byte 3 */
export const DHAN_WS_EXCHANGE_SEGMENT: Record<number, string> = {
  0: "IDX_I",
  1: "NSE_EQ",
  2: "NSE_FNO",
  3: "NSE_CURRENCY",
  4: "BSE_EQ",
  5: "MCX_COMM",
  7: "BSE_CURRENCY",
  8: "BSE_FNO",
};

/** Reverse: exchange segment string → numeric code for subscribe messages */
export const DHAN_WS_EXCHANGE_SEGMENT_CODE: Record<string, number> = {
  IDX_I: 0,
  NSE_EQ: 1,
  NSE_FNO: 2,
  NSE_CURRENCY: 3,
  BSE_EQ: 4,
  MCX_COMM: 5,
  BSE_CURRENCY: 7,
  BSE_FNO: 8,
};

/** WS Disconnect reason codes */
export const DHAN_WS_DISCONNECT_CODES: Record<number, string> = {
  804: "Instruments exceed limit",
  805: "Too many connections",
  806: "Data APIs not subscribed",
  807: "Access token expired",
  808: "Authentication failed",
  809: "Access token invalid",
  810: "Client ID invalid",
};

/** Max instruments per subscribe message */
export const DHAN_WS_MAX_INSTRUMENTS_PER_MSG = 100;

/** Max instruments per connection */
export const DHAN_WS_MAX_INSTRUMENTS_PER_CONN = 5000;

/** Ping interval from server (ms) */
export const DHAN_WS_PING_INTERVAL_MS = 10_000;

/** Connection timeout (ms) — server disconnects after 40s no pong */
export const DHAN_WS_TIMEOUT_MS = 40_000;
