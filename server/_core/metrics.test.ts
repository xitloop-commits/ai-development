/**
 * F7 — prom-client metrics smoke test.
 *
 * Verifies the registry is wired correctly: counters increment, the
 * /metrics handler returns Prometheus-format text containing the
 * expected metric names, and gauge collect callbacks don't throw on
 * an early-boot environment (Mongo not connected, broker not init'd).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  registry,
  teaSubmitTradeTotal,
  teaExitTotal,
  disciplineValidateTotal,
  rcaEvalTotal,
  unhandledRejectionTotal,
  dhanApiLatencyMs,
  metricsHandler,
  _resetMetricsForTesting,
} from "./metrics";
import type { Request, Response } from "express";

describe("metrics — counters increment", () => {
  beforeEach(() => {
    _resetMetricsForTesting();
  });

  it("teaSubmitTradeTotal labels by channel + status", async () => {
    teaSubmitTradeTotal.labels({ channel: "ai-paper", status: "success" }).inc();
    teaSubmitTradeTotal.labels({ channel: "ai-paper", status: "success" }).inc();
    teaSubmitTradeTotal.labels({ channel: "ai-paper", status: "rejected" }).inc();
    teaSubmitTradeTotal.labels({ channel: "my-live", status: "success" }).inc();

    const text = await registry.metrics();
    expect(text).toContain('tea_submit_trade_total{channel="ai-paper",status="success"} 2');
    expect(text).toContain('tea_submit_trade_total{channel="ai-paper",status="rejected"} 1');
    expect(text).toContain('tea_submit_trade_total{channel="my-live",status="success"} 1');
  });

  it("teaExitTotal accepts the trigger label", async () => {
    teaExitTotal.labels({ channel: "ai-paper", trigger: "TP_HIT" }).inc();
    teaExitTotal.labels({ channel: "ai-paper", trigger: "SL_HIT" }).inc();
    const text = await registry.metrics();
    expect(text).toContain('tea_exit_total{channel="ai-paper",trigger="TP_HIT"} 1');
    expect(text).toContain('tea_exit_total{channel="ai-paper",trigger="SL_HIT"} 1');
  });

  it("disciplineValidateTotal records both allow and block decisions", async () => {
    disciplineValidateTotal.labels({ decision: "allow", reason: "ok" }).inc();
    disciplineValidateTotal.labels({ decision: "block", reason: "circuitBreaker" }).inc();
    disciplineValidateTotal.labels({ decision: "block", reason: "circuitBreaker" }).inc();
    const text = await registry.metrics();
    expect(text).toContain('discipline_validate_total{decision="allow",reason="ok"} 1');
    expect(text).toContain('discipline_validate_total{decision="block",reason="circuitBreaker"} 2');
  });

  it("rcaEvalTotal labels by decision", async () => {
    rcaEvalTotal.labels({ decision: "APPROVE" }).inc();
    rcaEvalTotal.labels({ decision: "REJECT" }).inc();
    const text = await registry.metrics();
    expect(text).toContain('rca_eval_total{decision="APPROVE"} 1');
    expect(text).toContain('rca_eval_total{decision="REJECT"} 1');
  });

  it("unhandledRejectionTotal increments without a label", async () => {
    unhandledRejectionTotal.inc();
    unhandledRejectionTotal.inc();
    unhandledRejectionTotal.inc();
    const text = await registry.metrics();
    expect(text).toContain("unhandled_rejection_total 3");
  });
});

describe("metrics — histogram", () => {
  beforeEach(() => {
    _resetMetricsForTesting();
  });

  it("dhanApiLatencyMs records observations into the right bucket", async () => {
    dhanApiLatencyMs.labels({ endpoint: "placeOrder", status: "success" }).observe(75);
    dhanApiLatencyMs.labels({ endpoint: "placeOrder", status: "success" }).observe(180);
    dhanApiLatencyMs.labels({ endpoint: "placeOrder", status: "error" }).observe(2500);

    const text = await registry.metrics();
    // prom-client emits buckets with `le` listed first. Both success
    // observations (75ms and 180ms) land in the le="250" bucket.
    expect(text).toContain('dhan_api_latency_ms_bucket{le="250",endpoint="placeOrder",status="success"} 2');
    // Error observation 2500ms lands in le="5000" (next bucket above 2000).
    expect(text).toContain('dhan_api_latency_ms_bucket{le="5000",endpoint="placeOrder",status="error"} 1');
  });
});

describe("metrics — /metrics handler", () => {
  beforeEach(() => {
    _resetMetricsForTesting();
  });

  it("returns Prometheus text format with the expected metric families", async () => {
    teaSubmitTradeTotal.labels({ channel: "ai-paper", status: "success" }).inc();

    let captured = "";
    let contentType = "";
    const req = {} as Request;
    const res = {
      setHeader: vi.fn((k: string, v: string) => {
        if (k === "Content-Type") contentType = v;
      }),
      send: vi.fn((body: string) => {
        captured = body;
      }),
    } as unknown as Response;

    await metricsHandler(req, res);

    expect(contentType).toContain("text/plain");
    expect(captured).toContain("# HELP tea_submit_trade_total");
    expect(captured).toContain("# TYPE tea_submit_trade_total counter");
    expect(captured).toContain('tea_submit_trade_total{channel="ai-paper",status="success"} 1');
    // Default Node.js metrics auto-included
    expect(captured).toContain("process_cpu_seconds_total");
    expect(captured).toContain("nodejs_heap_size_total_bytes");
  });
});
