/**
 * Correlation context — request / trade / signal IDs that flow through
 * every log line emitted while a request, trade submission, or signal
 * evaluation is in-flight.
 *
 * Currently logs only show what each agent did; you can't grep a single
 * trade through Express → tRPC → executor → broker → portfolio → discipline.
 * This module gives every async operation a stable correlation ID via
 * Node's `AsyncLocalStorage`, and the pino logger reads those fields on
 * every emit through its `mixin` hook (see `broker/logger.ts`).
 *
 * Usage:
 *   - Express: `app.use(requestIdMiddleware)` once at boot.
 *   - TEA: `await withTrade(req.tradeId, () => submitTrade(...))` so every
 *     log line emitted during the call carries `tradeId`.
 *   - SEA inbound: `await withSignal(signalId, () => evaluateSignal(...))`.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export interface CorrelationFields {
  requestId?: string;
  tradeId?: string;
  signalId?: string;
}

const als = new AsyncLocalStorage<CorrelationFields>();

/**
 * Returns the active correlation fields, or `{}` if no context is set
 * (e.g. a background timer firing outside a request). Used by the pino
 * `mixin` hook so structured log lines always include the IDs that exist.
 */
export function getCorrelationFields(): CorrelationFields {
  return als.getStore() ?? {};
}

/**
 * Run `fn` inside a fresh correlation scope. Returns whatever `fn`
 * returns; preserves the parent scope on exit.
 */
export function runWithCorrelation<T>(
  fields: CorrelationFields,
  fn: () => T,
): T {
  const merged = { ...(als.getStore() ?? {}), ...fields };
  return als.run(merged, fn);
}

/**
 * Express middleware — assigns one `requestId` per HTTP request and
 * propagates it through the request's async tree. Reads the upstream
 * `x-request-id` header if a load balancer / gateway already set one,
 * otherwise mints a short (8-char) UUID prefix.
 */
export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const upstream = req.headers["x-request-id"];
  const requestId = typeof upstream === "string" && upstream.length > 0
    ? upstream
    : randomUUID().slice(0, 8);
  // Echo back so clients can tie failures to a specific server log line.
  res.setHeader("x-request-id", requestId);
  als.run({ requestId }, () => next());
}

/**
 * Wrap a chunk of async work so its logs carry `tradeId`. Inherits the
 * surrounding requestId (if any) so a trade placed via tRPC keeps the
 * caller's request-id context.
 */
export function withTrade<T>(tradeId: string, fn: () => Promise<T>): Promise<T> {
  return runWithCorrelation({ tradeId }, fn);
}

/**
 * Same as `withTrade` for inbound SEA signal evaluation. SEA is Python
 * upstream of TS; signals enter the TS surface via `risk-control/routes`,
 * which calls `withSignal(signalId, …)` to scope the downstream logs.
 */
export function withSignal<T>(signalId: string, fn: () => Promise<T>): Promise<T> {
  return runWithCorrelation({ signalId }, fn);
}