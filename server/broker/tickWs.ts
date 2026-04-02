/**
 * Tick WebSocket Server
 *
 * Native WebSocket endpoint that relays tickBus ticks to browser clients.
 * Optimized for minimal latency:
 *  - noServer mode to coexist with Vite HMR
 *  - Nagle disabled (TCP_NODELAY) on each client socket
 *  - JSON.stringify called once per tick, shared across all clients
 *  - perMessageDeflate disabled to avoid compression latency
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
    perMessageDeflate: false, // no compression overhead
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

  // Relay ticks — stringify once, send to all
  const onTick = (tick: unknown) => {
    if (wss.clients.size === 0) return;
    const msg = JSON.stringify(tick);
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    });
  };

  tickBus.on("tick", onTick);

  wss.on("connection", (ws, request) => {
    console.log(`${LOG} Client connected (total: ${wss.clients.size})`);

    // Disable Nagle's algorithm for minimal TCP latency
    const rawSocket = (request.socket || (ws as any)._socket) as Socket;
    if (rawSocket && typeof rawSocket.setNoDelay === "function") {
      rawSocket.setNoDelay(true);
    }

    // Send cached ticks immediately so UI has data on connect
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
