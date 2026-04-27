/**
 * Readiness gate — `/ready` returns 200 only when every dependency
 * the app needs to serve traffic is up. `/health` (defined elsewhere)
 * is a process-liveness probe; `/ready` is the readiness probe used by
 * launchers (start-all.bat) and reverse proxies before declaring the
 * system live.
 *
 * Each long-lived module that has its own initialisation lifecycle marks
 * itself ready by calling `markReady("<key>")`; all configured keys must
 * be ready, AND Mongo must be connected, for `/ready` to return 200.
 */

import type { Express, Request, Response } from "express";
import { getMongoHealth } from "../mongo";

const requiredKeys = ["broker", "tickWs"] as const;
type ReadyKey = (typeof requiredKeys)[number];

const readyFlags: Record<ReadyKey, boolean> = {
  broker: false,
  tickWs: false,
};

/** Module marks itself ready. Idempotent. */
export function markReady(key: ReadyKey): void {
  readyFlags[key] = true;
}

/** Module marks itself NOT ready (e.g. broker connection lost). */
export function markNotReady(key: ReadyKey): void {
  readyFlags[key] = false;
}

export interface ReadyStatus {
  ready: boolean;
  checks: {
    mongo: { ok: boolean; status: string };
    broker: { ok: boolean };
    tickWs: { ok: boolean };
  };
}

export function getReadyStatus(): ReadyStatus {
  const mongo = getMongoHealth();
  const checks = {
    mongo: { ok: mongo.status === "connected", status: mongo.status },
    broker: { ok: readyFlags.broker },
    tickWs: { ok: readyFlags.tickWs },
  };
  const ready = checks.mongo.ok && checks.broker.ok && checks.tickWs.ok;
  return { ready, checks };
}

export function registerReadyEndpoint(app: Express): void {
  app.get("/ready", (_req: Request, res: Response) => {
    const status = getReadyStatus();
    res.status(status.ready ? 200 : 503).json(status);
  });
}

/**
 * Test-only — reset flags to the initial (unready) state. Production
 * code never calls this.
 */
export function _resetReadyForTesting(): void {
  for (const k of requiredKeys) readyFlags[k] = false;
}
