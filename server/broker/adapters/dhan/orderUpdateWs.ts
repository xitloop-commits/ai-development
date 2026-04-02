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

const ORDER_UPDATE_URL = "wss://api-order-update.dhan.co";
const RECONNECT_DELAY_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 30000;

export interface DhanOrderUpdateRaw {
  Data: {
    Exchange: string;
    Segment: string;
    SecurityId: string;
    ClientId: string;
    ExchOrderNo: string;
    OrderNo: string;
    Product: string;       // C, I, M, F
    TxnType: string;       // B, S
    OrderType: string;     // LMT, MKT, SL, SLM
    Quantity: number;
    TradedQty: number;
    RemainingQuantity: number;
    Price: number;
    TriggerPrice: number;
    TradedPrice: number;
    AvgTradedPrice: number;
    Status: string;        // TRANSIT, PENDING, REJECTED, CANCELLED, TRADED, EXPIRED
    LegNo: number;         // 1=Entry, 2=SL, 3=Target
    Symbol: string;
    StrikePrice: number | string;
    ExpiryDate: string;
    OptType: string;       // CE, PE, XX
    LotSize: number;
    CorrelationId: string;
    Remarks: string;
    LastUpdatedTime: string;
    AlgoOrdNo: string;     // Entry leg order number for tracking related legs
    [key: string]: unknown;
  };
  Type: string;            // "order_alert"
}

export interface NormalizedOrderUpdate {
  orderId: string;         // Dhan OrderNo
  exchOrderId: string;     // Exchange order number
  securityId: string;
  exchange: string;
  symbol: string;
  txnType: "BUY" | "SELL";
  status: "TRANSIT" | "PENDING" | "REJECTED" | "CANCELLED" | "TRADED" | "EXPIRED";
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
  timestamp: string;
}

export class DhanOrderUpdateWs extends EventEmitter {
  private ws: WebSocket | null = null;
  private clientId: string;
  private accessToken: string;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private shouldReconnect = true;

  constructor(clientId: string, accessToken: string) {
    super();
    this.clientId = clientId;
    this.accessToken = accessToken;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
    }

    console.log("[DhanOrderWS] Connecting to", ORDER_UPDATE_URL);
    this.ws = new WebSocket(ORDER_UPDATE_URL);

    this.ws.on("open", () => {
      console.log("[DhanOrderWS] Connected, sending auth...");
      this.sendAuth();
      this.startHeartbeat();
    });

    this.ws.on("message", (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.Type === "order_alert" && msg.Data) {
          const normalized = this.normalize(msg as DhanOrderUpdateRaw);
          this.emit("orderUpdate", normalized);
        }
      } catch (err) {
        console.error("[DhanOrderWS] Parse error:", err);
      }
    });

    this.ws.on("close", (code, reason) => {
      console.log(`[DhanOrderWS] Closed: ${code} ${reason}`);
      this.stopHeartbeat();
      if (this.shouldReconnect) this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      console.error("[DhanOrderWS] Error:", err.message);
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
    console.log("[DhanOrderWS] Disconnected");
  }

  updateCredentials(clientId: string, accessToken: string): void {
    this.clientId = clientId;
    this.accessToken = accessToken;
    if (this.connected) {
      // Reconnect with new credentials
      this.disconnect();
      this.shouldReconnect = true;
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
    console.log("[DhanOrderWS] Auth sent");
  }

  private normalize(raw: DhanOrderUpdateRaw): NormalizedOrderUpdate {
    const d = raw.Data;
    return {
      orderId: d.OrderNo,
      exchOrderId: d.ExchOrderNo,
      securityId: d.SecurityId,
      exchange: d.Exchange,
      symbol: d.Symbol,
      txnType: d.TxnType === "B" ? "BUY" : "SELL",
      status: d.Status as NormalizedOrderUpdate["status"],
      legNo: d.LegNo,
      entryOrderId: d.AlgoOrdNo || "",
      quantity: d.Quantity,
      tradedQty: d.TradedQty,
      remainingQty: d.RemainingQuantity,
      price: d.Price,
      triggerPrice: d.TriggerPrice,
      tradedPrice: d.TradedPrice,
      avgTradedPrice: d.AvgTradedPrice,
      strikePrice: typeof d.StrikePrice === "number" ? d.StrikePrice : parseFloat(d.StrikePrice as string) || 0,
      expiryDate: d.ExpiryDate,
      optionType: d.OptType,
      lotSize: d.LotSize,
      correlationId: d.CorrelationId || "",
      remarks: d.Remarks || "",
      timestamp: d.LastUpdatedTime,
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      console.log("[DhanOrderWS] Reconnecting...");
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
