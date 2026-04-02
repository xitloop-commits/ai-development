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
import { tickBus } from "./tickBus";

const LOG = "[TickWS]";

export function setupTickWebSocket(server: Server): void {
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

  // Forward raw binary from Dhan WS directly to all browser clients
  const onRawBinary = (data: Buffer) => {
    if (wss.clients.size === 0) return;
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    });
  };

  tickBus.on("rawBinary", onRawBinary);

  wss.on("connection", (ws, request) => {
    console.log(`${LOG} Client connected (total: ${wss.clients.size})`);

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

    ws.on("close", () => {
      console.log(`${LOG} Client disconnected (total: ${wss.clients.size})`);
    });

    ws.on("error", (err) => {
      console.warn(`${LOG} Client error:`, err.message);
    });
  });

  console.log(`${LOG} Tick WebSocket ready on /ws/ticks`);
}
