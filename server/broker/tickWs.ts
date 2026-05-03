/**
 * Tick WebSocket Server
 *
 * Forwards raw Dhan binary packets directly to browser clients for
 * client-side parsing — zero serialization overhead.
 * Also sends JSON snapshot on connect for initial data.
 *
 * Path: /ws/ticks
 */

import { WebSocketServer, WebSocket } from "ws";
import type { Server, IncomingMessage } from "http";
import type { Duplex } from "stream";
import type { Socket } from "net";
import { tickBus, type ChainUpdate } from "./tickBus";

import { createLogger } from "./logger";
const log = createLogger("BSA", "TickWS");

/**
 * Reduce a ChainUpdate to the fields the browser actually needs. Strips
 * LTP/OI/IV/volume (those change per-tick and already flow on the binary
 * tick stream). Keeps strike grid + security IDs + lot size + spot.
 */
function stripChainMeta(u: ChainUpdate) {
  return {
    underlying: u.underlying,
    expiry: u.expiry,
    exchangeSegment: u.exchangeSegment,
    spotPrice: u.data.spotPrice,
    lotSize: u.data.lotSize,
    timestamp: u.data.timestamp,
    strikes: (u.data.rows ?? []).map((r) => ({
      strike: r.strike,
      ceSecurityId: r.callSecurityId ?? null,
      peSecurityId: r.putSecurityId ?? null,
      // Include LTPs from the chain snapshot so NewTradeForm has a sensible
      // default entry for strikes outside the subscribed ATM±3 tick window.
      // Updates at chain-poll cadence (~5s); per-tick precision still comes
      // from the binary tick stream for subscribed strikes.
      ceLTP: r.callLTP ?? 0,
      peLTP: r.putLTP ?? 0,
    })),
  };
}

/**
 * Drop a client whose outbound buffer is over 1 MB — the browser is too
 * slow to drain ticks and is just adding RAM pressure to the server. The
 * client will reconnect and resync from the snapshot.
 */
const SLOW_CLIENT_BUFFER_LIMIT = 1_000_000;

/**
 * Send `data` to every OPEN client in `wss`, dropping any client whose
 * outbound buffer is over the slow-client limit. Exported for unit tests.
 * Returns the count of clients that were closed as slow.
 */
export function sendToAllClients(wss: WebSocketServer, data: string | Buffer): number {
  let droppedSlow = 0;
  if (wss.clients.size === 0) return 0;
  wss.clients.forEach((client) => {
    if (client.readyState !== WebSocket.OPEN) return;
    if (client.bufferedAmount > SLOW_CLIENT_BUFFER_LIMIT) {
      try { client.close(1011, "slow-client"); } catch { /* ignore */ }
      droppedSlow++;
      return;
    }
    client.send(data);
  });
  return droppedSlow;
}

export interface TickWsHandle {
  close: () => Promise<void>;
}

export function setupTickWebSocket(server: Server): TickWsHandle {
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
  });

  // Intercept HTTP upgrade for /ws/ticks only
  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = request.url || "";
    if (url.startsWith("/ws/ticks")) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    }
  });

  // Forward raw binary from Dhan WS directly to all browser clients.
  const onRawBinary = (data: Buffer) => {
    sendToAllClients(wss, data);
  };

  tickBus.on("rawBinary", onRawBinary);

  // Forward option-chain updates as JSON text frames. Skip the stringify +
  // strip work entirely when no client is connected.
  const onChainUpdate = (update: ChainUpdate) => {
    if (wss.clients.size === 0) return;
    const msg = JSON.stringify({ type: "chainUpdate", chain: stripChainMeta(update) });
    sendToAllClients(wss, msg);
  };

  tickBus.on("chainUpdate", onChainUpdate);

  wss.on("connection", (ws, request) => {
    log.info(`Client connected (total: ${wss.clients.size})`);

    // Disable Nagle for minimal TCP latency
    const rawSocket = (request.socket || (ws as any)._socket) as Socket;
    if (rawSocket && typeof rawSocket.setNoDelay === "function") {
      rawSocket.setNoDelay(true);
    }

    // Send cached ticks as JSON snapshot on connect (for initial data)
    const cached = tickBus.getAllTicks();
    if (cached.length > 0) {
      ws.send(JSON.stringify({ type: "snapshot", ticks: cached }));
    }

    // Send all cached option chains so the browser's optionChainStore hydrates
    // immediately without waiting for the next upstream fetch.
    const chains = tickBus.getAllChains();
    if (chains.length > 0) {
      ws.send(JSON.stringify({
        type: "chainSnapshot",
        chains: chains.map(stripChainMeta),
      }));
    }

    ws.on("close", () => {
      log.info(`Client disconnected (total: ${wss.clients.size})`);
    });

    ws.on("error", (err) => {
      log.warn(`Client error: ${err.message}`);
    });
  });

  log.important("Tick WebSocket ready on /ws/ticks");

  return {
    close: () =>
      new Promise<void>((resolve) => {
        // Detach tickBus listeners so no late-arriving packets try to
        // push into a closed wss (would log noisy errors).
        tickBus.off("rawBinary", onRawBinary);
        tickBus.off("chainUpdate", onChainUpdate);
        // Send a clean close frame to every connected browser, then
        // shut the server.
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            try { client.close(1001, "server shutdown"); } catch { /* ignore */ }
          }
        });
        wss.close(() => resolve());
      }),
  };
}
