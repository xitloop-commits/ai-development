/**
 * Prometheus metrics — single registry for the whole server.
 *
 * Exposes counters / gauges / histograms covering trade-flow, broker
 * latency, discipline & RCA decisions, and basic process health. The
 * `/metrics` endpoint (mounted in `_core/index.ts`) returns the full
 * registry in Prometheus text format on every scrape.
 *
 * Shape was specified in IMPLEMENTATION_PLAN_v2 §F7. Every metric
 * label set is intentionally low-cardinality (channel, status, decision,
 * trigger, brokerId) so the time-series count stays bounded.
 */
import {
  Registry,
  Counter,
  Gauge,
  Histogram,
  collectDefaultMetrics,
} from "prom-client";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import { getActiveBroker, getRegisteredAdaptersMeta } from "../broker/brokerService";

export const registry = new Registry();

// Default Node.js metrics — process_cpu_seconds_total, nodejs_heap_size_*,
// process_resident_memory_bytes, etc. Cheap and useful for capacity work.
collectDefaultMetrics({ register: registry });

// ─── Trade flow ─────────────────────────────────────────────────

export const teaSubmitTradeTotal = new Counter({
  name: "tea_submit_trade_total",
  help: "TEA.submitTrade calls, by channel and final status.",
  labelNames: ["channel", "status"] as const,
  registers: [registry],
});

export const teaModifyTotal = new Counter({
  name: "tea_modify_total",
  help: "TEA.modifyOrder calls, by channel and final status.",
  labelNames: ["channel", "status"] as const,
  registers: [registry],
});

export const teaExitTotal = new Counter({
  name: "tea_exit_total",
  help: "TEA.exitTrade / autoExit calls by trigger (manual, TP_HIT, SL_HIT, RCA, ...).",
  labelNames: ["channel", "trigger"] as const,
  registers: [registry],
});

// ─── Broker API ─────────────────────────────────────────────────

export const dhanApiLatencyMs = new Histogram({
  name: "dhan_api_latency_ms",
  help: "Dhan broker API call latency in milliseconds.",
  labelNames: ["endpoint", "status"] as const,
  // Buckets oriented around real-world expectations: <100ms is healthy,
  // >2s warrants alerting.
  buckets: [25, 50, 100, 250, 500, 1000, 2000, 5000, 10000],
  registers: [registry],
});

// ─── Discipline & RCA ───────────────────────────────────────────

export const disciplineValidateTotal = new Counter({
  name: "discipline_validate_total",
  help: "Discipline pre-trade gate decisions, by decision and reason.",
  labelNames: ["decision", "reason"] as const,
  registers: [registry],
});

export const rcaEvalTotal = new Counter({
  name: "rca_eval_total",
  help: "RCA evaluator decisions, by decision (hold, exit, ...).",
  labelNames: ["decision"] as const,
  registers: [registry],
});

export const module8SessionHaltedTotal = new Counter({
  name: "module8_session_halted_total",
  help: "Capital Protection (Module 8) session halts, by reason.",
  labelNames: ["reason"] as const,
  registers: [registry],
});

// ─── Process health ─────────────────────────────────────────────

export const unhandledRejectionTotal = new Counter({
  name: "unhandled_rejection_total",
  help: "Process-level unhandled promise rejections (B6 fatalHandlers).",
  registers: [registry],
});

// ─── Live gauges (collected on scrape) ─────────────────────────

export const mongoConnected = new Gauge({
  name: "mongo_connected",
  help: "1 when mongoose readyState === 1 (connected), 0 otherwise.",
  registers: [registry],
  collect() {
    this.set(mongoose.connection.readyState === 1 ? 1 : 0);
  },
});

export const brokerActive = new Gauge({
  name: "broker_active",
  help: "1 when an active broker adapter is registered, 0 when no broker is selected. Labelled by brokerId of the active adapter (set to 'none' when none).",
  labelNames: ["brokerId"] as const,
  registers: [registry],
  collect() {
    try {
      const active = getActiveBroker();
      // Reset all known brokerId labels to 0 each scrape so a previously-
      // active broker doesn't appear stuck-connected after a switch.
      for (const meta of getRegisteredAdaptersMeta()) {
        this.labels({ brokerId: meta.brokerId }).set(0);
      }
      if (active) {
        // The adapter exposes its brokerId via the meta lookup; fall back
        // to the constructor name if the meta isn't available.
        const meta = getRegisteredAdaptersMeta().find(
          (m) => (active as any).brokerId === m.brokerId,
        );
        const id = meta?.brokerId ?? (active as any).brokerId ?? "unknown";
        this.labels({ brokerId: id }).set(1);
      }
    } catch {
      // Broker service not initialised yet (early boot) — best-effort.
    }
  },
});

// ─── HTTP handler ──────────────────────────────────────────────

/**
 * Express handler for `GET /metrics`. Internal-auth-gated by virtue of
 * being mounted under `/api/_metrics` (the global `/api` authMiddleware
 * already covers it — no extra guard needed).
 */
export async function metricsHandler(_req: Request, res: Response): Promise<void> {
  res.setHeader("Content-Type", registry.contentType);
  res.send(await registry.metrics());
}

// ─── Test hook ─────────────────────────────────────────────────

/** Reset all counters / gauges / histograms. Tests only. */
export function _resetMetricsForTesting(): void {
  registry.resetMetrics();
}
