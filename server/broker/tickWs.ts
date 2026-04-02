/**
 * Tick WebSocket Server
 *
 * Native WebSocket endpoint that relays tickBus ticks to browser clients
 * with zero serialization overhead. Replaces tRPC SSE for LTP streaming.
 *
 * Path: /ws/ticks
 */

import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import { tickBus } from "./tickBus";

const LOG = "[TickWS]";

export function setupTickWebSocket(server: Server): void {
  const wss = new WebSocketServer({ server, path: "/ws/ticks" });

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
