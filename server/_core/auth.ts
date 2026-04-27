/**
 * Internal-API auth middleware (B1).
 *
 * Closes the "anyone-on-the-box-can-call-our-API" gap. Mounted on /api/*
 * so a single chokepoint covers both Express REST handlers and the tRPC
 * mount at /api/trpc.
 *
 * Auth model: shared secret via `X-Internal-Token` header. This is a
 * single-tenant system — there's exactly one authorised caller surface
 * (the dashboard browser + the Python pipeline + ops scripts), and they
 * all run in environments where INTERNAL_API_SECRET is reachable. Per-user
 * JWTs would be over-engineering.
 *
 * Two enforcement modes (env-controlled, see .env.example):
 *   REQUIRE_INTERNAL_AUTH=false (default during rollout)
 *     Missing/wrong tokens → LOG WARNING + request proceeds. Lets us
 *     ship the middleware before every Python caller is updated.
 *   REQUIRE_INTERNAL_AUTH=true
 *     Missing/wrong tokens → 401. Flip the flag once Python is updated.
 *
 * Exemptions: /health and /ready (kube/launcher probes — must stay open).
 */

import type { Request, Response, NextFunction } from "express";
import { createLogger } from "../broker/logger";

const log = createLogger("BOOT", "Auth");

const HEADER = "x-internal-token";

const EXEMPT_PATHS = new Set(["/health", "/ready"]);

let warnedNoSecret = false;

function isEnforced(): boolean {
  return (process.env.REQUIRE_INTERNAL_AUTH ?? "").toLowerCase() === "true";
}

export function getInternalApiSecret(): string {
  return process.env.INTERNAL_API_SECRET ?? "";
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // /health and /ready bypass auth — probes need to work without secrets.
  if (EXEMPT_PATHS.has(req.path)) return next();

  const expected = getInternalApiSecret();
  if (!expected) {
    if (!warnedNoSecret) {
      warnedNoSecret = true;
      log.warn(
        "INTERNAL_API_SECRET is empty — auth check is disabled until set. " +
          "Generate one and add to .env (see .env.example).",
      );
    }
    return next();
  }

  const provided = req.header(HEADER) ?? "";
  if (provided && constantTimeEqual(provided, expected)) {
    return next();
  }

  // Token missing or wrong.
  if (isEnforced()) {
    log.warn(
      `401 ${req.method} ${req.path} — missing/invalid X-Internal-Token from ${req.ip ?? "?"}`,
    );
    res.status(401).json({ error: "missing or invalid X-Internal-Token" });
    return;
  }

  // Warn-only mode: surface the gap without breaking callers.
  log.warn(
    `[warn-only] ${req.method} ${req.path} — missing/invalid X-Internal-Token from ${req.ip ?? "?"} ` +
      "— flip REQUIRE_INTERNAL_AUTH=true to enforce.",
  );
  return next();
}

/**
 * Length-stable string comparison. Avoids leaking secret length via
 * timing on the fast/slow no-match paths.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Test-only — reset the one-shot warning flag. */
export function _resetAuthForTesting(): void {
  warnedNoSecret = false;
}
