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
import type { TickData } from "./types";
import { isReplayActive } from "../replay/tickReplay";
import { getSeaStatus } from "../seaHeartbeat";
import { getInstrumentLiveState } from "../instrumentLiveState";
import { WATCHED_INSTRUMENTS } from "../instrumentStateWatcher";

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

  // ── Replay LTP bridge ──────────────────────────────────────────────────────
  // A tick replay injects STRUCTURED ticks at the tickBus (the "tick" event) but
  // never the raw Dhan binary frames the browser decodes for live LTP — so the
  // UI's prices would sit frozen through a replay. Bridge them: coalesce the
  // replayed ticks per security and flush ~5x/s as the JSON "snapshot" the client
  // already applies (tickStore.set), so watchlist + trade-row LTP move like live.
  // Coalescing caps volume at one row per security per flush regardless of replay
  // speed, so a 60x replay can't flood the browser. Idle in live mode: the guard
  // returns before touching the map, and rawBinary already carries live LTP.
  const replayPending = new Map<string, TickData>();
  const onTick = (tick: TickData) => {
    if (!isReplayActive()) return;
    replayPending.set(`${tick.exchange}:${tick.securityId}`, tick);
  };
  tickBus.on("tick", onTick);
  const replayFlushTimer = setInterval(() => {
    if (replayPending.size === 0 || wss.clients.size === 0) return;
    const ticks = Array.from(replayPending.values());
    replayPending.clear();
    sendToAllClients(wss, JSON.stringify({ type: "snapshot", ticks }));
  }, 200);
  replayFlushTimer.unref?.();

  // Forward option-chain updates as JSON text frames. Skip the stringify +
  // strip work entirely when no client is connected.
  const onChainUpdate = (update: ChainUpdate) => {
    if (wss.clients.size === 0) return;
    const msg = JSON.stringify({ type: "chainUpdate", chain: stripChainMeta(update) });
    sendToAllClients(wss, msg);
  };

  tickBus.on("chainUpdate", onChainUpdate);

  // Forward SEA signals as JSON text frames so the signal tray updates live
  // (history is loaded separately from Mongo). Skip when no client connected.
  const onSeaSignal = (signal: unknown) => {
    if (wss.clients.size === 0) return;
    sendToAllClients(wss, JSON.stringify({ type: "sea_signal", signal }));
  };
  tickBus.on("seaSignal", onSeaSignal);

  // Forward SEA engine liveness over the same socket (replaces UI polling).
  // Pushed on every heartbeat; a timer also re-pushes so the light greys out
  // when an engine dies (heartbeats stop → no push without the timer).
  const onSeaStatus = (status: unknown) => {
    if (wss.clients.size === 0) return;
    sendToAllClients(wss, JSON.stringify({ type: "sea_status", status }));
  };
  tickBus.on("seaStatus", onSeaStatus);
  const seaStatusTimer = setInterval(() => {
    if (wss.clients.size === 0) return;
    sendToAllClients(wss, JSON.stringify({ type: "sea_status", status: getSeaStatus() }));
  }, 10_000);
  seaStatusTimer.unref?.();

  // Forward the global SEA cohort on/off state so open control panels update
  // live when anyone toggles a cohort (the SEA processes get it over the
  // dedicated /ws/sea-control channel).
  const onSeaControl = (state: unknown) => {
    if (wss.clients.size === 0) return;
    sendToAllClients(wss, JSON.stringify({ type: "sea_control", state }));
  };
  tickBus.on("seaControl", onSeaControl);

  // Forward per-mode AI config updates so every open AI menu syncs after Apply.
  const onAiConfig = (config: unknown) => {
    if (wss.clients.size === 0) return;
    sendToAllClients(wss, JSON.stringify({ type: "ai_config", config }));
  };
  tickBus.on("aiConfig", onAiConfig);

  // Forward portfolio day-record updates so the trade list stays live without
  // polling allDays. The client swaps the pushed day in by (channel, dayIndex).
  const onPortfolio = (payload: unknown) => {
    if (wss.clients.size === 0) return;
    sendToAllClients(wss, JSON.stringify({ type: "portfolio", ...(payload as object) }));
  };
  tickBus.on("portfolio", onPortfolio);

  // Capital-state changed (pools/projections) → client refetches state once.
  const onCapitalChanged = (payload: unknown) => {
    if (wss.clients.size === 0) return;
    sendToAllClients(wss, JSON.stringify({ type: "capital_changed", ...(payload as object) }));
  };
  tickBus.on("capitalChanged", onCapitalChanged);

  // Forward TFA live instrument state (replaces the 2s instrumentLiveState poll).
  const onInstrumentState = (payload: unknown) => {
    if (wss.clients.size === 0) return;
    sendToAllClients(wss, JSON.stringify({ type: "instrument_state", ...(payload as object) }));
  };
  tickBus.on("instrumentState", onInstrumentState);

  // Status-change signals → client refetches the matching query once (replaces
  // the broker.status / broker.feed.state / discipline polls).
  const onBrokerChanged = () => {
    if (wss.clients.size === 0) return;
    sendToAllClients(wss, JSON.stringify({ type: "broker_changed" }));
  };
  tickBus.on("brokerChanged", onBrokerChanged);
  const onDisciplineChanged = () => {
    if (wss.clients.size === 0) return;
    sendToAllClients(wss, JSON.stringify({ type: "discipline_changed" }));
  };
  tickBus.on("disciplineChanged", onDisciplineChanged);

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

    // Send the current SEA liveness snapshot so the light is correct on connect
    // without waiting for the next heartbeat/timer push.
    ws.send(JSON.stringify({ type: "sea_status", status: getSeaStatus() }));

    // Seed the current TFA state for each instrument so cards/bars/lights have
    // data immediately (cheap: getInstrumentLiveState is mtime-cached).
    for (const inst of WATCHED_INSTRUMENTS) {
      try {
        ws.send(JSON.stringify({ type: "instrument_state", instrument: inst, state: getInstrumentLiveState(inst) }));
      } catch { /* skip on read race */ }
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
        tickBus.off("tick", onTick);
        clearInterval(replayFlushTimer);
        tickBus.off("chainUpdate", onChainUpdate);
        tickBus.off("seaSignal", onSeaSignal);
        tickBus.off("seaStatus", onSeaStatus);
        tickBus.off("seaControl", onSeaControl);
        tickBus.off("aiConfig", onAiConfig);
        tickBus.off("portfolio", onPortfolio);
        tickBus.off("capitalChanged", onCapitalChanged);
        tickBus.off("instrumentState", onInstrumentState);
        tickBus.off("brokerChanged", onBrokerChanged);
        tickBus.off("disciplineChanged", onDisciplineChanged);
        clearInterval(seaStatusTimer);
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
