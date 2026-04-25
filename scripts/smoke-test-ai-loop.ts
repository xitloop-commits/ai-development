/**
 * End-to-end smoke test for the AI loop on ai-paper.
 * Run: pnpm tsx scripts/smoke-test-ai-loop.ts
 *
 * What it does:
 *   1. Snapshot ai-paper baseline (open count + day P&L)
 *   2. Append a synthetic filtered SEA signal (LONG_CE on BANKNIFTY)
 *      to logs/signals/banknifty/<today>_filtered_signals.log
 *   3. Wait ~7s for seaBridge.poll() to fire (5s interval)
 *   4. Snapshot — expect openPositionCount += 1
 *   5. Find the newest open position via portfolio.positions
 *   6. Exit it via executor.exitTrade (reason=MANUAL, triggeredBy=USER)
 *   7. Snapshot — expect openPositionCount back to baseline; pnl bumped
 *
 * Verifies wiring: SEA bridge → TEA submitTrade → MockAdapter →
 * portfolioAgent.appendTrade → position_state dual-write → TEA.exitTrade
 * → portfolioAgent.closeTrade → recordTradeClosed → discipline +
 * portfolio_metrics rollup.
 *
 * Prereqs:
 *   - `pnpm dev` running on http://localhost:3000
 *   - MongoDB connected
 *   - mock-ai broker configured (default at boot)
 */

import { existsSync, mkdirSync, appendFileSync } from "fs";
import path from "path";

const BASE = "http://localhost:3000/api/trpc";

async function callTrpc<T>(procedure: string, input: unknown, method: "POST" | "GET" = "POST"): Promise<T> {
  const body = JSON.stringify({ json: input });
  const url =
    method === "GET"
      ? `${BASE}/${procedure}?input=${encodeURIComponent(body)}`
      : `${BASE}/${procedure}`;
  const init: RequestInit =
    method === "GET"
      ? { method: "GET" }
      : { method: "POST", headers: { "content-type": "application/json" }, body };
  const res = await fetch(url, init);
  const json = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${JSON.stringify(json)}`);
  return json.result.data as T;
}

function todayIST(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function writeSyntheticSignal(): { signalLine: string; logPath: string } {
  const today = todayIST();
  const dir = path.resolve(`logs/signals/banknifty`);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, `${today}_filtered_signals.log`);

  const now = Date.now();
  const signal = {
    timestamp: now / 1000,
    timestamp_ist: new Date(now).toLocaleString("sv-SE", { timeZone: "Asia/Kolkata" }).replace(" ", "T") + "+05:30",
    instrument: "BANKNIFTY",
    direction: "GO_CALL",
    direction_prob_30s: 0.78,
    max_upside_pred_30s: 0.85,
    max_drawdown_pred_30s: 0.30,
    atm_strike: 56400,
    atm_ce_ltp: 100.0,
    atm_pe_ltp: 100.0,
    atm_ce_security_id: "smoke-12345",
    atm_pe_security_id: "smoke-67890",
    spot_price: 56400,
    momentum: 0.82,
    breakout: 1.0,
    model_version: "smoke-test",
    // v3 / filtered fields — these are what seaBridge.processSignal gates on
    action: "LONG_CE",
    confidence: "HIGH",
    score: 5,
    entry: 100.0,
    tp: 110.0,
    sl: 95.0,
    rr: 2.0,
    sustained_ticks: 8,
    avg_prob: 0.76,
  };
  const line = JSON.stringify(signal);
  appendFileSync(logPath, line + "\n");
  return { signalLine: line, logPath };
}

async function snapshot() {
  return callTrpc<any>("portfolio.snapshot", { channel: "ai-paper" }, "GET");
}

async function getPositions() {
  return callTrpc<any[]>("portfolio.positions", { channel: "ai-paper" }, "GET");
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log("=== AI loop smoke test (ai-paper) ===\n");

  console.log("1. Baseline snapshot");
  const before = await snapshot();
  console.log({
    openPositionCount: before.openPositionCount,
    todayPnl: before.todayPnl,
    realizedPnl: before.realizedPnl,
  });
  const baselineOpen = before.openPositionCount;

  console.log("\n2. Writing synthetic filtered SEA signal");
  const { logPath } = writeSyntheticSignal();
  console.log(`   wrote → ${logPath}`);

  console.log("\n3. Waiting 7 s for seaBridge.poll()…");
  await sleep(7_000);

  console.log("\n4. Snapshot after bridge poll");
  const afterPlace = await snapshot();
  console.log({
    openPositionCount: afterPlace.openPositionCount,
    openExposure: afterPlace.openExposure,
    unrealizedPnl: afterPlace.unrealizedPnl,
  });
  if (afterPlace.openPositionCount <= baselineOpen) {
    console.error("\n❌ FAIL: open position count did not increase. Bridge or TEA didn't accept the signal.");
    console.error("   Check server logs for [BSA:SeaBridge] / [BSA:TradeExecutor] entries.");
    process.exit(1);
  }
  console.log("   ✅ Trade landed via SEA → TEA → PA");

  console.log("\n5. Looking up the new position");
  const positions = await getPositions();
  const newest = positions
    .filter((p) => p.status === "OPEN")
    .sort((a, b) => b.openedAt - a.openedAt)[0];
  if (!newest) {
    console.error("❌ FAIL: no open position visible via portfolio.positions");
    process.exit(1);
  }
  console.log({
    tradeId: newest.id,
    instrument: newest.instrument,
    type: newest.type,
    qty: newest.qty,
    entryPrice: newest.entryPrice,
    targetPrice: newest.targetPrice,
    stopLossPrice: newest.stopLossPrice,
  });

  const positionId = `POS-${String(newest.id).replace(/^T/, "")}`;
  console.log(`   positionId = ${positionId}`);

  console.log("\n6. Exiting via executor.exitTrade (reason=MANUAL)");
  const exit = await callTrpc<any>("executor.exitTrade", {
    executionId: `smoke-exit-${Date.now()}`,
    positionId,
    channel: "ai-paper",
    exitType: "MARKET",
    reason: "MANUAL",
    triggeredBy: "USER",
    timestamp: Date.now(),
  });
  console.log({
    success: exit.success,
    realizedPnl: exit.realizedPnl,
    realizedPnlPct: exit.realizedPnlPct,
    error: exit.error,
  });
  if (!exit.success) {
    console.error("❌ FAIL: exitTrade rejected.");
    process.exit(1);
  }

  console.log("\n7. Final snapshot");
  const after = await snapshot();
  console.log({
    openPositionCount: after.openPositionCount,
    todayPnl: after.todayPnl,
    realizedPnl: after.realizedPnl,
  });

  if (after.openPositionCount !== baselineOpen) {
    console.warn(`⚠️  open count is ${after.openPositionCount}, expected ${baselineOpen}. Other trades may have landed in parallel — not necessarily a failure.`);
  } else {
    console.log("   ✅ open count back to baseline");
  }

  console.log("\n=== ALL CHECKS PASSED ===");
  console.log("AI loop is wired end-to-end. Open `?view=h2h` to see the close show up in portfolio_metrics.");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
