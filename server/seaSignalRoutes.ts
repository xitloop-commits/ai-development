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
import { insertSeaLine, type SeaLineKind } from "./seaLineStore";
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
    recordSeaHeartbeat(inst, req.body?.ribbon);
    res.json({ success: true });
  });

  // Locked-contract premium feed (T163 premium-ribbon detectors, 2026-08-13).
  // SEA polls this every few seconds per instrument: returns the session-locked
  // CE/PE contracts (T161 lock — computed on first demand) plus each leg's
  // premium ticks from the option-day index, incrementally (`sinceCe`/`sincePe`
  // = epoch seconds of the last tick the caller already has; omit for the full
  // session so a freshly-started engine warms its ribbons instantly).
  app.get("/api/sea/locked-premiums", async (req: Request, res: Response) => {
    const instrument = String(req.query.instrument ?? "");
    if (!instrument) {
      res.status(400).json({ success: false, error: "missing instrument" });
      return;
    }
    try {
      const { getLock } = await import("./portfolio/strikeLock");
      const { readOptionContractTicks } = await import("./chartData");
      const { getReplayStatus, replayCutoffTs } = await import("./replay/tickReplay");
      const { getReplayLock } = await import("./replay/replayLock");
      const { logFolderFor } = await import("./seaSignals");

      // Live-simulation transparency (T165): while a replay is streaming THIS
      // instrument, serve the REPLAYED day's lock (from the recorded chain at
      // open) and its premium ticks capped at the sim clock — so SEA tests the
      // ribbon signals against the simulation without knowing the difference.
      const rp = getReplayStatus();
      const isSim = rp.running && !!rp.date && rp.instruments.includes(logFolderFor(instrument));
      let date: string;
      let cutoff = Infinity;
      let lock: { date: string; expiry: string; lockedAt: number; ce: { strike: number; securityId: string }; pe: { strike: number; securityId: string } } | null;
      if (isSim) {
        date = rp.date!;
        cutoff = replayCutoffTs() ?? Infinity;
        lock = await getReplayLock(instrument, date);
      } else {
        date = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
        lock = await getLock(instrument);
      }
      if (!lock) {
        res.json({ success: true, lock: null });
        return;
      }
      const leg = async (l: { strike: number; securityId: string }, since: number) => {
        const ticks = await readOptionContractTicks(instrument, date, l.securityId);
        // Incremental slice — arrays are chronological, binary-search the cut.
        let lo = 0;
        if (since > 0) {
          let hi = ticks.t.length;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (ticks.t[mid] <= since) lo = mid + 1; else hi = mid;
          }
        }
        // Sim: never serve past the replay clock — the future hasn't happened.
        let hiEnd = ticks.t.length;
        if (cutoff !== Infinity) {
          while (hiEnd > lo && ticks.t[hiEnd - 1] > cutoff) hiEnd--;
        }
        return {
          strike: l.strike,
          securityId: l.securityId,
          t: ticks.t.slice(lo, hiEnd),
          ltp: ticks.ltp.slice(lo, hiEnd),
        };
      };
      const sinceCe = Number(req.query.sinceCe ?? 0) || 0;
      const sincePe = Number(req.query.sincePe ?? 0) || 0;
      res.json({
        success: true,
        lock: { date: lock.date, expiry: lock.expiry, lockedAt: lock.lockedAt },
        replay: isSim || undefined,
        ce: await leg(lock.ce, sinceCe),
        pe: await leg(lock.pe, sincePe),
      });
    } catch (err: any) {
      log.warn(`sea/locked-premiums failed: ${err?.message ?? err}`);
      res.status(500).json({ success: false, error: err?.message ?? String(err) });
    }
  });

  // T169-B — SEA pushes one closed-candle ribbon sample per contract+kind here,
  // so the chart draws the exact line the signal decision used (no re-calc). The
  // server just stores it (seaLineStore) + fans it out live; fire-and-forget on
  // SEA's side, so a hiccup never stalls the engine.
  app.post("/api/sea/line", (req: Request, res: Response) => {
    const b = req.body;
    if (!b || typeof b !== "object" || !b.instrument || !b.securityId || !b.date) {
      res.status(400).json({ success: false, error: "missing line body" });
      return;
    }
    const kind: SeaLineKind = b.kind === "ma" ? "ma" : "sma5";
    const t = Number(b.t);
    const line = Number(b.line);
    const close = Number(b.close);
    if (!Number.isFinite(t) || !Number.isFinite(line) || !Number.isFinite(close)) {
      res.status(400).json({ success: false, error: "t/line/close must be finite" });
      return;
    }
    const state: -1 | 0 | 1 = b.state === 1 ? 1 : b.state === -1 ? -1 : 0;
    try {
      insertSeaLine(String(b.instrument), String(b.date), String(b.securityId), kind, { t, line, state, close });
      tickBus.emitSeaLine({ instrument: String(b.instrument), date: String(b.date), securityId: String(b.securityId), kind, t, line, state, close });
      res.json({ success: true });
    } catch (err: any) {
      log.warn(`sea/line ingest failed: ${err?.message ?? err}`);
      res.status(500).json({ success: false, error: err?.message ?? String(err) });
    }
  });

  app.post("/api/sea/signal", async (req: Request, res: Response) => {
    const body = req.body;
    if (!body || typeof body !== "object" || !body.instrument) {
      res.status(400).json({ success: false, error: "missing signal body" });
      return;
    }
    // T161 — per-instrument master switch (watchlist tick icon). OFF drops the
    // signal at the door: nothing enters the tray, nothing broadcasts. 200 so
    // SEA doesn't treat the drop as a delivery failure worth retrying/logging.
    try {
      const { getCommonConfig } = await import("./portfolio/aiModeConfig");
      const { logFolderFor } = await import("./seaSignals");
      if (getCommonConfig().instrumentEnabled[logFolderFor(String(body.instrument))] === false) {
        res.json({ success: true, dropped: "instrument switched off" });
        return;
      }
    } catch { /* config unreadable — let the signal through */ }
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
