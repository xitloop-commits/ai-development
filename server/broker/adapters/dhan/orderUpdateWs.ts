/**
 * Dhan Live Order Update WebSocket Client
 *
 * Connects to wss://api-order-update.dhan.co
 * Receives real-time JSON order updates for all orders in the account.
 * Parses updates and emits normalized OrderUpdate events.
 *
 * Key fields from Dhan:
 *   - LegNo: 1=Entry, 2=StopLoss, 3=Target
 *   - Status: TRANSIT, PENDING, REJECTED, CANCELLED, TRADED, EXPIRED
 *   - AvgTradedPrice, TradedQty, OrderNo, SecurityId
 */
import WebSocket from "ws";
import { EventEmitter } from "events";

import { createLogger, type Logger } from "../../logger";

const ORDER_UPDATE_URL = "wss://api-order-update.dhan.co";
const RECONNECT_DELAY_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 30000;
// A close this soon after open, with no parsed frame in between, counts as the
// server rejecting us (bad/expired token → 5-byte binary refusal + close 1006).
const RAPID_CLOSE_MS = 10_000;
// After this many consecutive rapid closes, stop reconnecting until new
// credentials arrive via updateCredentials(). ~1 min at 5s reconnect delay.
const MAX_RAPID_CLOSES = 10;

/**
 * Raw order-update frame. `Data` is intentionally untyped — Dhan's real wire
 * format is camelCase (orderNo/status/legNo/reasonDescription/…), NOT the
 * PascalCase the docs show, so `normalize()` reads it case-insensitively by
 * lowercasing every key rather than accessing named fields. A typed field
 * list here would be both unused and misleading about the casing.
 */
export interface DhanOrderUpdateRaw {
  Data: Record<string, unknown>;
  Type: string; // "order_alert"
}

export interface NormalizedOrderUpdate {
  orderId: string;         // Dhan OrderNo
  exchOrderId: string;     // Exchange order number
  securityId: string;
  exchange: string;
  symbol: string;
  txnType: "BUY" | "SELL";
  status: "TRANSIT" | "PENDING" | "REJECTED" | "CANCELLED" | "TRADED" | "EXPIRED" | "PART-TRADED" | "MODIFIED";
  product: string;         // Dhan code: I=intraday, C=CNC, F=MTF, M=margin
  productName: string;     // INTRADAY | CNC | MTF | ...
  legNo: number;           // 1=Entry, 2=SL, 3=Target
  entryOrderId: string;    // AlgoOrdNo — links SL/Target legs to entry
  quantity: number;
  tradedQty: number;
  remainingQty: number;
  price: number;
  triggerPrice: number;
  tradedPrice: number;
  avgTradedPrice: number;
  strikePrice: number;
  expiryDate: string;
  optionType: string;
  lotSize: number;
  correlationId: string;
  remarks: string;
  reason: string;          // ReasonDescription — reject/cancel text, "" if none
  timestamp: string;
}

export class DhanOrderUpdateWs extends EventEmitter {
  private ws: WebSocket | null = null;
  private clientId: string;
  private accessToken: string;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private shouldReconnect = true;
  private connectedAt = 0;
  private rapidCloses = 0;
  private halted = false;
  private readonly log: Logger;

  /**
   * @param brokerTag — module-name suffix for the logger so multi-broker
   *   setups disambiguate `[BSA:Dhan/ai-data-OrderWS]` vs the legacy
   *   `[BSA:DhanOrderWS]`. Optional; defaults to `"default"`.
   */
  constructor(clientId: string, accessToken: string, brokerTag: string = "default") {
    super();
    this.clientId = clientId;
    this.accessToken = accessToken;
    this.log = createLogger("BSA", `Dhan/${brokerTag}-OrderWS`);
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
    }

    this.log.info(`Connecting to ${ORDER_UPDATE_URL}`);
    this.halted = false;
    this.ws = new WebSocket(ORDER_UPDATE_URL);

    this.ws.on("open", () => {
      this.connectedAt = Date.now();
      this.log.info("Connected, sending auth...");
      this.sendAuth();
      this.startHeartbeat();
      // Signal (re)connect so listeners can run a one-shot reconcile of any
      // order events missed while we were down/disconnected (Dhan does not
      // replay them). Fires on first connect AND every reconnect.
      this.emit("connected");
    });

    this.ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      const text = data.toString();
      // Dhan occasionally sends binary frames whose bytes hold no readable
      // JSON (observed 2026-07-12). Nothing to parse — note them and move on.
      if (isBinary || !/^[[{]/.test(text.trimStart())) {
        const hex = Buffer.isBuffer(data) ? data.toString("hex") : Buffer.from(text).toString("hex");
        this.log.info(`Received unknown values (non-JSON frame, ${text.length} chars, hex=${hex.slice(0, 64)})`);
        return;
      }
      try {
        const msg = JSON.parse(text);
        // Any parseable frame means the server accepted us — this is not a
        // credentials-rejected connection, so clear the rapid-close streak.
        this.rapidCloses = 0;
        if (msg.Type === "order_alert" && msg.Data) {
          // Lifecycle event. normalize() reads the real wire format, which is
          // camelCase (orderNo/status/legNo/…) with a Title-case status value
          // ("Rejected") — NOT the PascalCase shape Dhan's docs show. We log
          // from the normalized result so the field stream is always visible.
          const normalized = this.normalize(msg as DhanOrderUpdateRaw);
          // Debug capture (DHAN_ORDER_WS_RAW=1): dump the FULL raw Data + the
          // normalized event so every field Dhan sends (tradedQty, avgTradedPrice,
          // all timestamps, per-leg fields) is visible for wiring the order
          // lifecycle. Off by default — noisy; enable only while capturing.
          if (process.env.DHAN_ORDER_WS_RAW) {
            this.log.important(`[order_alert RAW] ${JSON.stringify(msg.Data)}`);
            this.log.important(`[order_alert NORMALIZED] ${JSON.stringify(normalized)}`);
          }
          this.log.important(
            `order_alert order=${normalized.orderId} status=${normalized.status} legNo=${normalized.legNo} ` +
              `symbol=${normalized.symbol}${normalized.reason ? ` reason="${normalized.reason}"` : ""}`,
          );
          this.emit("orderUpdate", normalized);
        } else {
          // Non-order_alert frame — auth acknowledgement or error. Log it raw
          // so a silent auth failure (which yields zero order events) shows up.
          this.log.info(`frame ${JSON.stringify(msg).slice(0, 400)}`);
        }
      } catch (err) {
        // Text frame that looked like JSON but failed to parse — log the raw
        // frame so we can see exactly what Dhan sent.
        this.log.error(`Parse error on raw frame: ${JSON.stringify(text.slice(0, 800))}`, err);
      }
    });

    this.ws.on("close", (code, reason) => {
      this.log.info(`Closed: ${code} ${reason}`);
      this.stopHeartbeat();
      if (!this.shouldReconnect) return;
      if (Date.now() - this.connectedAt < RAPID_CLOSE_MS) {
        this.rapidCloses++;
        if (this.rapidCloses >= MAX_RAPID_CLOSES) {
          this.halted = true;
          this.log.error(
            `Halting reconnects: server dropped the socket ${this.rapidCloses} times in a row right after auth — ` +
              `credentials are likely rejected. Update the token to resume.`,
          );
          return;
        }
      } else {
        this.rapidCloses = 0;
      }
      this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      this.log.error(`Error: ${err.message}`);
    });
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this.log.info("Disconnected");
  }

  updateCredentials(clientId: string, accessToken: string): void {
    this.clientId = clientId;
    this.accessToken = accessToken;
    this.rapidCloses = 0;
    if (this.connected) {
      // Reconnect with new credentials
      this.disconnect();
      this.shouldReconnect = true;
      this.connect();
    } else if (this.halted) {
      // Reconnects were halted after repeated rejections — new credentials
      // are the cure, so resume connecting.
      this.connect();
    }
  }

  private sendAuth(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const authMsg = {
      LoginReq: {
        MsgCode: 42,
        ClientId: this.clientId,
        Token: this.accessToken,
      },
      UserType: "SELF",
    };
    this.ws.send(JSON.stringify(authMsg));
    this.log.info("Auth sent");
  }

  private normalize(raw: DhanOrderUpdateRaw): NormalizedOrderUpdate {
    // Dhan's real order-update wire format is camelCase (orderNo/status/legNo/
    // reasonDescription/…) with a Title-case status value ("Rejected"), even
    // though the official docs show PascalCase. To be robust to either, index
    // every Data key by its lowercased name and read case-insensitively.
    const lc: Record<string, unknown> = {};
    for (const k of Object.keys(raw.Data)) {
      lc[k.toLowerCase()] = (raw.Data as Record<string, unknown>)[k];
    }
    const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
    const num = (v: unknown): number => (typeof v === "number" ? v : parseFloat(str(v)) || 0);
    return {
      orderId: str(lc["orderno"]),
      exchOrderId: str(lc["exchorderno"]),
      securityId: str(lc["securityid"]),
      exchange: str(lc["exchange"]),
      symbol: str(lc["symbol"]),
      txnType: lc["txntype"] === "B" ? "BUY" : "SELL",
      product: str(lc["product"]),         // I=intraday, C=CNC, F=MTF, M=margin
      productName: str(lc["productname"]), // INTRADAY | CNC | MTF | ...
      // Uppercase the status value so downstream maps (TRANSIT/PENDING/REJECTED/
      // TRADED/…) match regardless of the Title-case Dhan sends ("Rejected").
      status: str(lc["status"]).toUpperCase() as NormalizedOrderUpdate["status"],
      legNo: num(lc["legno"]),
      entryOrderId: str(lc["algoordno"]),
      quantity: num(lc["quantity"]),
      tradedQty: num(lc["tradedqty"]),
      remainingQty: num(lc["remainingquantity"]),
      price: num(lc["price"]),
      triggerPrice: num(lc["triggerprice"]),
      tradedPrice: num(lc["tradedprice"]),
      avgTradedPrice: num(lc["avgtradedprice"]),
      strikePrice: num(lc["strikeprice"]),
      expiryDate: str(lc["expirydate"]),
      optionType: str(lc["opttype"]),
      lotSize: num(lc["lotsize"]),
      correlationId: str(lc["correlationid"]),
      remarks: str(lc["remarks"]),
      reason: str(lc["reasondescription"]),
      timestamp: str(lc["lastupdatedtime"]),
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.log.info("Reconnecting...");
      this.connect();
    }, RECONNECT_DELAY_MS);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
