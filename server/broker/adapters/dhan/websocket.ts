/**
 * Dhan WebSocket Client — Live Market Feed v2
 *
 * Handles:
 * - WS connection lifecycle (connect, reconnect, disconnect)
 * - Binary packet parsing (Ticker, Quote, OI, PrevClose, Full Packet)
 * - Subscribe/Unsubscribe with batching (max 100 per message)
 * - Ping/pong keep-alive
 * - Exponential backoff reconnection
 *
 * Binary format: Little Endian
 * Full Packet (Code 8): 162 bytes = 8 header + 54 data + 100 depth (5 x 20)
 */

import WebSocket from "ws";
import { EventEmitter } from "events";
import type {
  ExchangeSegment,
  FeedMode,
  MarketDepthLevel,
  TickData,
} from "../../types.js";
import {
  DHAN_WS_FEED_URL,
  DHAN_FEED_REQUEST,
  DHAN_FEED_RESPONSE,
  DHAN_WS_EXCHANGE_SEGMENT,
  DHAN_WS_MAX_INSTRUMENTS_PER_MSG,
  DHAN_WS_DISCONNECT_CODES,
} from "./constants.js";

import { createLogger, type Logger } from "../../logger.js";

// ─── Types ─────────────────────────────────────────────────────

interface DhanWSConfig {
  accessToken: string;
  clientId: string;
  /**
   * Per-broker tag used in the logger module name so multi-broker setups
   * (`dhan` for trading, `dhan-ai-data` for AI tick feed, etc.) emit
   * disambiguated lines: `[BSA:Dhan/ai-data-WS]` instead of generic
   * `[BSA:DhanWS]`. Optional — defaults to `"default"`.
   */
  brokerTag?: string;
  onTick: (tick: TickData) => void;
  onRawMessage?: (data: Buffer) => void;
  onPrevClose: (data: {
    securityId: string;
    exchange: ExchangeSegment;
    prevClose: number;
    prevOI: number;
  }) => void;
  onDisconnect: (code: number, reason: string) => void;
  onError: (error: Error) => void;
  onConnected: () => void;
}

interface SubscriptionEntry {
  exchange: string; // "NSE_FNO", "NSE_EQ", etc.
  securityId: string;
  mode: FeedMode;
}

// ─── Binary Parsing Helpers ────────────────────────────────────

function parseHeader(buf: Buffer): {
  responseCode: number;
  messageLength: number;
  exchangeSegment: number;
  securityId: number;
} {
  return {
    responseCode: buf.readUInt8(0),
    messageLength: buf.readInt16LE(1),
    exchangeSegment: buf.readUInt8(3),
    securityId: buf.readInt32LE(4),
  };
}

function parseTickerPacket(
  buf: Buffer,
  securityId: string,
  exchange: ExchangeSegment
): Partial<TickData> {
  return {
    securityId,
    exchange,
    ltp: buf.readFloatLE(8),
    ltt: buf.readInt32LE(12),
    timestamp: Date.now(),
  };
}

function parseQuotePacket(
  buf: Buffer,
  securityId: string,
  exchange: ExchangeSegment
): Partial<TickData> {
  return {
    securityId,
    exchange,
    ltp: buf.readFloatLE(8),
    ltq: buf.readInt16LE(12),
    ltt: buf.readInt32LE(14),
    atp: buf.readFloatLE(18),
    volume: buf.readInt32LE(22),
    totalSellQty: buf.readInt32LE(26),
    totalBuyQty: buf.readInt32LE(30),
    dayOpen: buf.readFloatLE(34),
    dayClose: buf.readFloatLE(38),
    dayHigh: buf.readFloatLE(42),
    dayLow: buf.readFloatLE(46),
    timestamp: Date.now(),
  };
}

function parseOIPacket(
  buf: Buffer,
  securityId: string,
  exchange: ExchangeSegment
): { securityId: string; exchange: ExchangeSegment; oi: number } {
  return {
    securityId,
    exchange,
    oi: buf.readInt32LE(8),
  };
}

function parseDepthLevels(buf: Buffer, offset: number): MarketDepthLevel[] {
  const levels: MarketDepthLevel[] = [];
  for (let i = 0; i < 5; i++) {
    const base = offset + i * 20;
    levels.push({
      bidQty: buf.readInt32LE(base),
      askQty: buf.readInt32LE(base + 4),
      bidOrders: buf.readInt16LE(base + 8),
      askOrders: buf.readInt16LE(base + 10),
      bidPrice: buf.readFloatLE(base + 12),
      askPrice: buf.readFloatLE(base + 16),
    });
  }
  return levels;
}

function parseFullPacket(
  buf: Buffer,
  securityId: string,
  exchange: ExchangeSegment
): TickData {
  const depth = parseDepthLevels(buf, 62);
  return {
    securityId,
    exchange,
    ltp: buf.readFloatLE(8),
    ltq: buf.readInt16LE(12),
    ltt: buf.readInt32LE(14),
    atp: buf.readFloatLE(18),
    volume: buf.readInt32LE(22),
    totalSellQty: buf.readInt32LE(26),
    totalBuyQty: buf.readInt32LE(30),
    oi: buf.readInt32LE(34),
    highOI: buf.readInt32LE(38),
    lowOI: buf.readInt32LE(42),
    dayOpen: buf.readFloatLE(46),
    dayClose: buf.readFloatLE(50),
    dayHigh: buf.readFloatLE(54),
    dayLow: buf.readFloatLE(58),
    prevClose: 0, // filled from PrevClose packet
    prevOI: 0, // filled from PrevClose packet
    depth,
    bidPrice: depth[0]?.bidPrice ?? 0,
    askPrice: depth[0]?.askPrice ?? 0,
    timestamp: Date.now(),
  };
}

// ─── DhanWebSocket Class ───────────────────────────────────────

export class DhanWebSocket extends EventEmitter {
  private ws: WebSocket | null = null;
  private config: DhanWSConfig;
  private subscriptions = new Map<string, SubscriptionEntry>(); // key: "exchange:securityId"
  private tickCache = new Map<string, TickData>(); // accumulated tick data per instrument
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isConnecting = false;
  private isDisconnecting = false;
  private _connected = false;
  private _cooldownUntil = 0;   // 429/auth cooldown — reject connects until this time
  private healthyTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly log: Logger;

  constructor(config: DhanWSConfig) {
    super();
    this.config = config;
    const tag = config.brokerTag ?? "default";
    this.log = createLogger("BSA", `Dhan/${tag}-WS`);
  }

  /** Update the access token used for future (re)connects. Does not reconnect. */
  updateToken(newToken: string): void {
    this.config.accessToken = newToken;
    this._cooldownUntil = 0;       // clear cooldown so next reconnect can try
    this.reconnectAttempts = 0;    // reset attempt counter with fresh token
    this.log.info("WS token updated — next reconnect will use new token");
  }

  // ── Public API ─────────────────────────────────────────────────

  get connected(): boolean {
    return this._connected;
  }

  get subscriptionCount(): number {
    return this.subscriptions.size;
  }

  async connect(): Promise<void> {
    if (this._connected || this.isConnecting) return;
    const now = Date.now();
    if (now < this._cooldownUntil) {
      const waitSec = Math.ceil((this._cooldownUntil - now) / 1000);
      this.log.debug(`Skip connect — cooldown active, retry in ${waitSec}s`);
      return;
    }
    this.isConnecting = true;
    this.isDisconnecting = false;

    return new Promise((resolve, reject) => {
      const url = `${DHAN_WS_FEED_URL}?version=2&token=${this.config.accessToken}&clientId=${this.config.clientId}&authType=2`;

      this.log.info("Connecting to Dhan Live Market Feed...");

      this.ws = new WebSocket(url);

      const timeout = setTimeout(() => {
        this.isConnecting = false;
        reject(new Error("WebSocket connection timeout (15s)"));
        this.ws?.close();
      }, 15_000);

      this.ws.on("open", () => {
        clearTimeout(timeout);
        this._connected = true;
        this.isConnecting = false;
        // Don't reset reconnectAttempts here. The Dhan feed sometimes accepts the WS
        // upgrade and then closes the TCP within ~10ms (e.g. nightly maintenance, stale
        // token, account WS-cap exceeded — all surface as code 1006). Resetting on `open`
        // lets that pattern loop forever, hammering Dhan into a 429 + 5-min cooldown.
        // Only credit the connection as healthy after it has stayed open for 10s.
        if (this.healthyTimer) clearTimeout(this.healthyTimer);
        this.healthyTimer = setTimeout(() => {
          this.reconnectAttempts = 0;
          this.healthyTimer = null;
        }, 10_000);
        // Disable Nagle for minimal latency on incoming ticks
        const sock = (this.ws as any)?._socket;
        if (sock && typeof sock.setNoDelay === "function") sock.setNoDelay(true);
        this.log.info("Connected successfully");
        this.config.onConnected();

        // Re-subscribe existing instruments after reconnect
        if (this.subscriptions.size > 0) {
          this.resubscribeAll();
        }

        resolve();
      });

      this.ws.on("message", (data: Buffer) => {
        if (this.config.onRawMessage) this.config.onRawMessage(data);
        this.handleBinaryMessage(data);
      });

      this.ws.on("close", (code: number, reason: Buffer) => {
        clearTimeout(timeout);
        if (this.healthyTimer) {
          clearTimeout(this.healthyTimer);
          this.healthyTimer = null;
        }
        this._connected = false;
        this.isConnecting = false;
        const reasonStr = reason.toString() || `code ${code}`;
        this.log.info(`Disconnected: ${reasonStr}`);

        if (!this.isDisconnecting) {
          this.scheduleReconnect();
        }
      });

      this.ws.on("error", (err: Error) => {
        clearTimeout(timeout);
        this.log.error(`Error: ${err.message}`);
        this.config.onError(err);

        // Set cooldown on rate limit or auth errors to avoid hammering Dhan
        if (err.message.includes("429")) {
          this._cooldownUntil = Date.now() + 5 * 60 * 1000;  // 5 min cooldown for 429
          this.reconnectAttempts = this.maxReconnectAttempts;  // stop further retries
          this.log.warn("WS 429 — 5 min cooldown active, reconnects suspended");
        } else if (err.message.includes("401") || err.message.includes("403")) {
          this._cooldownUntil = Date.now() + 2 * 60 * 1000;  // 2 min for auth errors
          this.reconnectAttempts = this.maxReconnectAttempts;
          this.log.warn("WS auth error — 2 min cooldown active");
        }

        if (this.isConnecting) {
          this.isConnecting = false;
          reject(err);
        }
      });

      this.ws.on("ping", () => {
        // ws library auto-sends pong, but log for debugging
      });
    });
  }

  async disconnect(): Promise<void> {
    this.isDisconnecting = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.healthyTimer) {
      clearTimeout(this.healthyTimer);
      this.healthyTimer = null;
    }

    if (this.ws) {
      // Send disconnect request
      try {
        this.sendJSON({ RequestCode: DHAN_FEED_REQUEST.DISCONNECT });
      } catch {
        // ignore
      }
      this.ws.close();
      this.ws = null;
    }

    this._connected = false;
    this.isConnecting = false;
    this.log.info("Disconnected gracefully");
  }

  subscribe(instruments: SubscriptionEntry[]): void {
    if (!this._connected || !this.ws) {
      // Queue subscriptions — they'll be sent on reconnect
      for (const inst of instruments) {
        const key = `${inst.exchange}:${inst.securityId}`;
        this.subscriptions.set(key, inst);
      }
      return;
    }

    const newInstruments: SubscriptionEntry[] = [];
    for (const inst of instruments) {
      const key = `${inst.exchange}:${inst.securityId}`;
      if (!this.subscriptions.has(key)) {
        this.subscriptions.set(key, inst);
        newInstruments.push(inst);
      }
    }

    if (newInstruments.length === 0) return;

    // Batch into groups of 100
    this.sendSubscribeBatched(newInstruments, "subscribe");
  }

  unsubscribe(instruments: { exchange: string; securityId: string }[]): void {
    const toRemove: SubscriptionEntry[] = [];
    for (const inst of instruments) {
      const key = `${inst.exchange}:${inst.securityId}`;
      const entry = this.subscriptions.get(key);
      if (entry) {
        toRemove.push(entry);
        this.subscriptions.delete(key);
        this.tickCache.delete(key);
      }
    }

    if (toRemove.length === 0 || !this._connected || !this.ws) return;

    this.sendSubscribeBatched(toRemove, "unsubscribe");
  }

  /** Get the latest cached tick for an instrument */
  getLatestTick(exchange: string, securityId: string): TickData | undefined {
    return this.tickCache.get(`${exchange}:${securityId}`);
  }

  /** Get all cached ticks */
  getAllTicks(): Map<string, TickData> {
    return new Map(this.tickCache);
  }

  // ── Private Methods ────────────────────────────────────────────

  private handleBinaryMessage(data: Buffer): void {
    if (data.length < 8) return; // too short for header

    const header = parseHeader(data);
    const exchangeStr =
      DHAN_WS_EXCHANGE_SEGMENT[header.exchangeSegment] || "UNKNOWN";
    const securityId = String(header.securityId);
    const exchange = exchangeStr as ExchangeSegment;
    const key = `${exchangeStr}:${securityId}`;


    switch (header.responseCode) {
      case DHAN_FEED_RESPONSE.TICKER: {
        const partial = parseTickerPacket(data, securityId, exchange);
        this.mergeTick(key, partial);
        break;
      }

      case DHAN_FEED_RESPONSE.QUOTE: {
        const partial = parseQuotePacket(data, securityId, exchange);
        this.mergeTick(key, partial);
        break;
      }

      case DHAN_FEED_RESPONSE.OI: {
        const oiData = parseOIPacket(data, securityId, exchange);
        this.mergeTick(key, { oi: oiData.oi });
        break;
      }

      case DHAN_FEED_RESPONSE.PREV_CLOSE: {
        const prevClose = data.readFloatLE(8);
        const prevOI = data.readInt32LE(12);
        this.mergeTick(key, { prevClose, prevOI });
        this.config.onPrevClose({ securityId, exchange, prevClose, prevOI });
        break;
      }

      case DHAN_FEED_RESPONSE.FULL: {
        const fullTick = parseFullPacket(data, securityId, exchange);
        // Preserve prevClose/prevOI from earlier PrevClose packet
        const existing = this.tickCache.get(key);
        if (existing) {
          fullTick.prevClose = existing.prevClose || fullTick.prevClose;
          fullTick.prevOI = existing.prevOI || fullTick.prevOI;
        }
        this.tickCache.set(key, fullTick);
        this.config.onTick(fullTick);
        break;
      }

      case DHAN_FEED_RESPONSE.DISCONNECT: {
        const disconnectCode = data.length >= 10 ? data.readInt16LE(8) : 0;
        const reason =
          DHAN_WS_DISCONNECT_CODES[disconnectCode] || `Unknown (${disconnectCode})`;
        this.log.warn(`Server disconnect: ${reason}`);
        this.config.onDisconnect(disconnectCode, reason);
        break;
      }

      case DHAN_FEED_RESPONSE.INDEX: {
        // Index packet — treat like ticker for index instruments
        if (data.length >= 12) {
          const partial = parseTickerPacket(data, securityId, exchange);
          this.mergeTick(key, partial);
        }
        break;
      }

      case DHAN_FEED_RESPONSE.MARKET_STATUS: {
        // Market status packet — log but don't process
        this.log.info("Market status update received");
        break;
      }

      default:
        this.log.warn(`Unknown response code: ${header.responseCode}`);
    }
  }

  private mergeTick(key: string, partial: Partial<TickData>): void {
    const existing = this.tickCache.get(key) || this.createEmptyTick(key);
    const merged = { ...existing, ...partial, timestamp: Date.now() };
    this.tickCache.set(key, merged);
    this.config.onTick(merged);
  }

  private createEmptyTick(key: string): TickData {
    const [exchange, securityId] = key.split(":");
    return {
      securityId: securityId || "",
      exchange: (exchange || "NSE_FNO") as ExchangeSegment,
      ltp: 0,
      ltq: 0,
      ltt: 0,
      atp: 0,
      volume: 0,
      totalSellQty: 0,
      totalBuyQty: 0,
      oi: 0,
      highOI: 0,
      lowOI: 0,
      dayOpen: 0,
      dayClose: 0,
      dayHigh: 0,
      dayLow: 0,
      prevClose: 0,
      prevOI: 0,
      depth: [],
      bidPrice: 0,
      askPrice: 0,
      timestamp: Date.now(),
    };
  }

  private sendSubscribeBatched(
    instruments: SubscriptionEntry[],
    action: "subscribe" | "unsubscribe"
  ): void {
    // Group by mode
    const byMode = new Map<FeedMode, SubscriptionEntry[]>();
    for (const inst of instruments) {
      const mode = inst.mode || "full";
      if (!byMode.has(mode)) byMode.set(mode, []);
      byMode.get(mode)!.push(inst);
    }

    for (const [mode, insts] of Array.from(byMode)) {
      const requestCode = this.getRequestCode(mode, action);

      // Batch into groups of 100
      for (
        let i = 0;
        i < insts.length;
        i += DHAN_WS_MAX_INSTRUMENTS_PER_MSG
      ) {
        const batch = insts.slice(i, i + DHAN_WS_MAX_INSTRUMENTS_PER_MSG);
        const msg = {
          RequestCode: requestCode,
          InstrumentCount: batch.length,
          InstrumentList: batch.map((inst: SubscriptionEntry) => ({
            ExchangeSegment: inst.exchange,
            SecurityId: inst.securityId,
          })),
        };
        this.sendJSON(msg);
      }

      const actionLabel = action === "subscribe" ? "Subscribed" : "Unsubscribed";
      this.log.info(`${actionLabel} ${insts.length} instruments (${mode})`);
    }
  }

  private getRequestCode(
    mode: FeedMode,
    action: "subscribe" | "unsubscribe"
  ): number {
    if (action === "subscribe") {
      switch (mode) {
        case "ticker":
          return DHAN_FEED_REQUEST.SUBSCRIBE_TICKER;
        case "quote":
          return DHAN_FEED_REQUEST.SUBSCRIBE_QUOTE;
        case "full":
          return DHAN_FEED_REQUEST.SUBSCRIBE_FULL;
      }
    } else {
      switch (mode) {
        case "ticker":
          return DHAN_FEED_REQUEST.UNSUBSCRIBE_TICKER;
        case "quote":
          return DHAN_FEED_REQUEST.UNSUBSCRIBE_QUOTE;
        case "full":
          return DHAN_FEED_REQUEST.UNSUBSCRIBE_FULL;
      }
    }
  }

  private resubscribeAll(): void {
    const entries = Array.from(this.subscriptions.values());
    if (entries.length === 0) return;
    this.log.info(`Re-subscribing ${entries.length} instruments after reconnect`);
    this.sendSubscribeBatched(entries, "subscribe");
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.log.error(`Max reconnect attempts (${this.maxReconnectAttempts}) reached. Giving up.`);
      this.config.onError(
        new Error("WebSocket max reconnect attempts exceeded")
      );
      return;
    }

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s (capped at 30s)
    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts),
      30_000
    );
    this.reconnectAttempts++;

    this.log.info(`Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch (err) {
        this.log.error("Reconnect failed:", err);
        this.scheduleReconnect();
      }
    }, delay);
  }

  private sendJSON(msg: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}

// ─── Exported Parsing Functions (for testing) ──────────────────

export {
  parseHeader,
  parseTickerPacket,
  parseQuotePacket,
  parseOIPacket,
  parseFullPacket,
  parseDepthLevels,
};
