/**
 * Tick WebSocket Server
 *
 * Native WebSocket endpoint that relays tickBus ticks to browser clients
 * with zero serialization overhead.
 *
 * Uses noServer mode so we can handle the HTTP upgrade event manually,
 * preventing Vite HMR from intercepting /ws/ticks connections.
 *
 * Path: /ws/ticks
 */

import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import { tickBus } from "./tickBus";

const LOG = "[TickWS]";

export function setupTickWebSocket(server: Server): void {
  // noServer mode — we handle the upgrade event ourselves
  const wss = new WebSocketServer({ noServer: true });

  // Intercept HTTP upgrade before Vite HMR can grab it
  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = request.url || "";
    if (url.startsWith("/ws/ticks")) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    }
    // If not /ws/ticks, let other handlers (Vite HMR) handle it
  });

  // Relay every tick from tickBus to all connected WS clients
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

  wss.on("connection", (ws) => {
    console.log(`${LOG} Client connected (total: ${wss.clients.size})`);

    // Send all cached ticks on connect so UI has data immediately
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
