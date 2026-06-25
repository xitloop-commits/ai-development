/**
 * SEA signal ingest — POST /api/sea/signal
 *
 * The SEA POSTs each emitted signal here (push, not file-tail). The handler
 * persists it to Mongo (sea_signals) and broadcasts it live over /ws/ticks so
 * the UI tray updates in real time. Auth via the shared /api authMiddleware
 * (X-Internal-Token, B1).
 */

import type { Express, Request, Response } from "express";
import { insertSeaSignal } from "./seaSignalStore";
import { recordSeaHeartbeat } from "./seaHeartbeat";
import { tickBus } from "./broker/tickBus";
import { createLogger } from "./broker/logger";

const log = createLogger("SEA", "REST");

export function registerSeaSignalRoutes(app: Express): void {
  // Liveness heartbeat — SEA POSTs this every ~5s per engine, independent of
  // tick flow, so the UI can show whether SEA is running.
  app.post("/api/sea/heartbeat", (req: Request, res: Response) => {
    const inst = req.body?.instrument;
    if (!inst || typeof inst !== "string") {
      res.status(400).json({ success: false, error: "missing instrument" });
      return;
    }
    recordSeaHeartbeat(inst);
    res.json({ success: true });
  });

  app.post("/api/sea/signal", async (req: Request, res: Response) => {
    const body = req.body;
    if (!body || typeof body !== "object" || !body.instrument) {
      res.status(400).json({ success: false, error: "missing signal body" });
      return;
    }
    try {
      const doc = await insertSeaSignal(body);
      tickBus.emitSeaSignal(doc); // live fan-out to browser tray over /ws/ticks
      res.json({ success: true, id: doc.id });
    } catch (err: any) {
      log.warn(`sea/signal ingest failed: ${err?.message ?? err}`);
      res.status(500).json({ success: false, error: err?.message ?? String(err) });
    }
  });
}
