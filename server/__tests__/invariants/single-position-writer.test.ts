/**
 * Invariant: only PortfolioAgent (server/portfolio/) writes to dayRecords
 * via upsertDayRecord. Position state has a single writer; everyone else
 * reads through PA's API or fires a PA event.
 *
 * Rationale: dual writers cause silent state divergence — exactly the
 * footgun B10 closed when it removed tradingStore.pushPosition. This
 * test prevents new writers creeping back in.
 *
 * If this test fails: route the write through PA. Only extend the
 * allowlist with explicit architectural approval + a tracker row.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SERVER_ROOT = join(__dirname, "..", "..");

const ALLOWED_PREFIXES = [
  "portfolio/", // PortfolioAgent — the canonical writer
];

const ALLOWED_FILES = new Set<string>([
  // Empty — every former violation has migrated to a PA event/API.
  // Do NOT extend without approval + tracker row.
]);

const FORBIDDEN_PATTERN = /\bupsertDayRecord\s*\(/;

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
    if (entry.endsWith(".test.ts")) continue;
    yield abs;
  }
}

function isAllowed(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/");
  if (ALLOWED_FILES.has(normalized)) return true;
  return ALLOWED_PREFIXES.some((p) => normalized.startsWith(p));
}

describe("invariant: single-position-writer", () => {
  it("only server/portfolio/ writes to dayRecords via upsertDayRecord (allowlist documented)", () => {
    const violations: { file: string; line: number; text: string }[] = [];

    for (const abs of walkTsFiles(SERVER_ROOT)) {
      const rel = relative(SERVER_ROOT, abs);
      if (isAllowed(rel)) continue;

      const text = readFileSync(abs, "utf8");
      const lines = text.split("\n");
      lines.forEach((line, idx) => {
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
        `Found ${violations.length} single-position-writer invariant violation(s) — only server/portfolio/ may call upsertDayRecord directly (allowlist: executor/orderSync.ts):\n${msg}`,
      );
    }

    expect(violations.length).toBe(0);
  });
});
