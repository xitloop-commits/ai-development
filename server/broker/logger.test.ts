/**
 * F6 — pino logger smoke test.
 *
 * Confirms the createLogger shim still emits one structured record per
 * call with `agent` / `module` fields populated, and that correlation
 * fields (requestId / tradeId) injected via AsyncLocalStorage land on
 * the same record via the pino `mixin`.
 */
import { describe, it, expect } from "vitest";
import { Writable } from "node:stream";
import pino from "pino";
import {
  runWithCorrelation,
  withTrade,
  getCorrelationFields,
} from "../_core/correlationContext";
import { sanitizeForConsole } from "./logger";

/**
 * Build a fresh pino root + capture stream so each test sees a clean log
 * tape. Mirrors the prod factory in `broker/logger.ts` minus the
 * pino-pretty transport (we want raw JSON for assertions).
 */
function makeCapture() {
  const lines: any[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      const text = chunk.toString("utf-8").trim();
      for (const line of text.split("\n")) {
        if (line) lines.push(JSON.parse(line));
      }
      cb();
    },
  });
  const root = pino(
    {
      level: "debug",
      base: undefined,
      mixin: () => getCorrelationFields(),
    },
    stream,
  );
  return { lines, root };
}

describe("logger / pino integration", () => {
  it("emits structured JSON with agent + module fields", () => {
    const { lines, root } = makeCapture();
    const child = root.child({ agent: "PA", module: "TickHandler" });
    child.info("Started");

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 30, // pino numeric for "info"
      msg: "Started",
      agent: "PA",
      module: "TickHandler",
    });
  });

  it("merges correlation fields onto every record via the mixin", async () => {
    const { lines, root } = makeCapture();
    const child = root.child({ agent: "TEA", module: "Executor" });

    await runWithCorrelation({ requestId: "r-100" }, async () => {
      child.info("submitTrade start");
      await withTrade("t-9", async () => {
        child.info("submitTrade inside trade scope");
      });
      child.info("submitTrade end");
    });

    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ requestId: "r-100", msg: "submitTrade start" });
    expect(lines[0].tradeId).toBeUndefined();

    expect(lines[1]).toMatchObject({
      requestId: "r-100",
      tradeId: "t-9",
      msg: "submitTrade inside trade scope",
    });

    expect(lines[2]).toMatchObject({ requestId: "r-100", msg: "submitTrade end" });
    expect(lines[2].tradeId).toBeUndefined();
  });

  it("serializes Error objects under the err field for stack-trace shipping", () => {
    const { lines, root } = makeCapture();
    const child = root.child({ agent: "BSA", module: "Mongo" });
    const e = new Error("boom");
    child.error({ err: e }, "connection failed");
    expect(lines[0]).toMatchObject({ level: 50, msg: "connection failed" });
    expect(lines[0].err).toMatchObject({ message: "boom", type: "Error" });
    expect(typeof lines[0].err.stack).toBe("string");
  });
});

// Log lines must be ASCII so the Windows console (cp437/cp1252) renders them
// cleanly instead of mojibake ("Rs." -> "Γé╣", emoji -> "≡ƒÜÇ").
describe("sanitizeForConsole", () => {
  it("transliterates the rupee sign", () => {
    expect(sanitizeForConsole("Balance: ₹1000000")).toBe("Balance: Rs.1000000");
  });

  it("replaces em/en dashes with a hyphen", () => {
    expect(sanitizeForConsole("Started — listening")).toBe("Started - listening");
    expect(sanitizeForConsole("a – b")).toBe("a - b");
  });

  it("normalizes smart quotes and ellipsis", () => {
    expect(sanitizeForConsole("“hi” ‘x’ wait…")).toBe('"hi" \'x\' wait...');
  });

  it("strips emoji and trims the trailing space they leave", () => {
    expect(sanitizeForConsole("Feed connected 🚀")).toBe("Feed connected");
    expect(sanitizeForConsole("DhanAdapter (live) connected 🚀")).toBe("DhanAdapter (live) connected");
  });

  it("leaves plain ASCII untouched", () => {
    expect(sanitizeForConsole("submitTrade ok channel=my-paper")).toBe("submitTrade ok channel=my-paper");
  });
});
