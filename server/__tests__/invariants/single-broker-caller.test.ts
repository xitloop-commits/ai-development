/**
 * Invariant: only TradeExecutorAgent and the broker adapters themselves
 * may call broker mutation methods (placeOrder / modifyOrder / cancelOrder).
 *
 * Rationale: these methods bypass TEA's idempotency, recovery, audit log,
 * and the BROKER_DESYNC safety net (B4). Any other module calling them
 * directly creates a hidden second-broker-caller that defeats the executor
 * invariant documented in TradeExecutorAgent_Spec_v1.3 §3.
 *
 * If this test fails: move the offending call into TEA, or wrap the new
 * caller in a TEA pass-through. Do NOT add the file to the allowlist
 * unless it is itself part of TEA or the adapter implementation.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SERVER_ROOT = join(__dirname, "..", "..");

// Files allowed to call broker mutation methods directly. These are the
// implementations of those methods OR TEA itself. Adding to this list
// requires architectural review.
const ALLOWED_PREFIXES = [
  "executor/",          // TradeExecutorAgent — the canonical caller
  "broker/adapters/",   // Adapters define placeOrder; calling within is fine
];

const FORBIDDEN_PATTERN = /\.(placeOrder|modifyOrder|cancelOrder)\s*\(/;

function* walkTsFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__") continue;
      yield* walkTsFiles(abs);
      continue;
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".d.ts")) continue;
    // Skip *.test.ts — tests legitimately drive adapters directly
    if (entry.endsWith(".test.ts")) continue;
    yield abs;
  }
}

function isAllowed(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/");
  return ALLOWED_PREFIXES.some((p) => normalized.startsWith(p));
}

describe("invariant: single-broker-caller", () => {
  it("only TEA + adapters call placeOrder/modifyOrder/cancelOrder directly", () => {
    const violations: { file: string; line: number; text: string }[] = [];

    for (const abs of walkTsFiles(SERVER_ROOT)) {
      const rel = relative(SERVER_ROOT, abs);
      if (isAllowed(rel)) continue;

      const text = readFileSync(abs, "utf8");
      const lines = text.split("\n");
      lines.forEach((line, idx) => {
        // Skip comment lines (best-effort — single-line // comments)
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
        if (FORBIDDEN_PATTERN.test(line)) {
          violations.push({
            file: rel.replace(/\\/g, "/"),
            line: idx + 1,
            text: trimmed.slice(0, 120),
          });
        }
      });
    }

    if (violations.length > 0) {
      const msg = violations
        .map((v) => `  ${v.file}:${v.line} → ${v.text}`)
        .join("\n");
      throw new Error(
        `Found ${violations.length} broker-caller invariant violation(s) — only server/executor/ and server/broker/adapters/ may call .placeOrder/.modifyOrder/.cancelOrder directly:\n${msg}`,
      );
    }

    expect(violations.length).toBe(0);
  });
});
