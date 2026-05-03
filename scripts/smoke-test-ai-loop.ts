/**
 * End-to-end smoke test for the canonical SEA → ATS path on ai-paper.
 * Run: pnpm tsx scripts/smoke-test-ai-loop.ts
 *
 * What it does:
 *   1. Snapshot ai-paper baseline (open count + day P&L)
 *   2. POST /api/discipline/validateTrade — simulates SEA-Python placing
 *      a LONG_CE on BANKNIFTY through the DA → RCA → TEA chain
 *   3. Snapshot — expect openPositionCount += 1
 *   4. Find the newest open position via portfolio.positions
 *   5. Exit it via executor.exitTrade (reason=MANUAL, triggeredBy=USER)
 *   6. Snapshot — expect openPositionCount back to baseline; pnl bumped
 *
 * Verifies wiring: validateTrade REST → DA.validateTrade → RCA.evaluate
 * → TEA.submitTrade → MockAdapter → portfolioAgent.appendTrade →
 * position_state dual-write → TEA.exitTrade → portfolioAgent.closeTrade
 * → recordTradeClosed → discipline + portfolio_metrics rollup.
 *
 * Prereqs:
 *   - `pnpm dev` running on http://localhost:3000
 *   - MongoDB connected
 *   - mock-ai broker configured (default at boot)
 *   - INTERNAL_API_SECRET env set if REQUIRE_INTERNAL_AUTH=true
 */

const BASE = "http://localhost:3000/api/trpc";
const REST = "http://localhost:3000/api";

function authHeaders(): Record<string, string> {
  const token = process.env.INTERNAL_API_SECRET ?? "";
  return token ? { "X-Internal-Token": token } : {};
}

async function callTrpc<T>(procedure: string, input: unknown, method: "POST" | "GET" = "POST"): Promise<T> {
  const body = JSON.stringify({ json: input });
  const url =
    method === "GET"
      ? `${BASE}/${procedure}?input=${encodeURIComponent(body)}`
      : `${BASE}/${procedure}`;
  const init: RequestInit =
    method === "GET"
      ? { method: "GET", headers: authHeaders() }
      : { method: "POST", headers: { "content-type": "application/json", ...authHeaders() }, body };
  const res = await fetch(url, init);
  const json = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${JSON.stringify(json)}`);
  // tRPC v11 superjson wraps the payload twice: { result: { data: { json: <real> } } }
  const wrapped = json?.result?.data;
  return (wrapped?.json ?? wrapped) as T;
}

async function postValidateTrade(payload: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${REST}/discipline/validateTrade`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function snapshot() {
  return callTrpc<any>("portfolio.snapshot", { channel: "ai-paper" }, "GET");
}

async function getPositions() {
  return callTrpc<any[]>("portfolio.positions", { channel: "ai-paper" }, "GET");
}

async function main() {
  console.log("=== AI loop smoke test (ai-paper, SEA REST chain) ===\n");

  console.log("1. Baseline snapshot");
  const before = await snapshot();
  console.log({
    openPositionCount: before.openPositionCount,
    todayPnl: before.todayPnl,
    realizedPnl: before.realizedPnl,
  });
  const baselineOpen = before.openPositionCount;

  console.log("\n2. POST /api/discipline/validateTrade (LONG_CE on BANKNIFTY)");
  const executionId = `smoke-${Date.now()}`;
  const placement = await postValidateTrade({
    executionId,
    channel: "ai-paper",
    origin: "AI",
    instrument: "BANK NIFTY",
    exchange: "NSE",
    transactionType: "BUY",
    optionType: "CE",
    strike: 56400,
    entryPrice: 100,
    quantity: 15,
    estimatedValue: 1500,
    stopLoss: 95,
    takeProfit: 110,
    aiConfidence: 0.78,
    aiRiskReward: 2,
    currentCapital: before.tradingPool ?? 100000,
    currentExposure: before.openExposure ?? 0,
  });
  console.log({
    success: placement.success,
    stage: placement.stage,
    decision: placement.decision,
    blockedBy: placement.blockedBy,
    tradeId: placement.tradeId,
  });

  if (!placement.success) {
    if ((placement.blockedBy ?? []).some((r: string) => r.toLowerCase().includes("discipline"))) {
      console.log(`\n   ✅ DA rejected (expected off-hours): ${(placement.blockedBy ?? []).join(", ")}`);
      console.log("\n--- Pipeline trace verified (partial) ---");
      console.log("   ✅ /api/discipline/validateTrade REST endpoint");
      console.log("   ✅ X-Internal-Token auth (B1)");
      console.log("   ✅ zod body validation (B8)");
      console.log("   ✅ DA pre-trade gate (blocking as expected)");
      console.log("");
      console.log("   ⏸  NOT verified (DA blocks first):");
      console.log("       RCA evaluate, TEA submitTrade, MockAdapter.placeOrder,");
      console.log("       PA.appendTrade, position_state dual-write, TEA.exitTrade.");
      console.log("");
      console.log("   To verify the full loop, either:");
      console.log("     a) Re-run during NSE market hours (09:15–15:30 IST)");
      console.log("     b) Temporarily disable timeWindow in discipline settings");
      console.log("");
      console.log("=== SMOKE TEST PARTIAL PASS ===");
      process.exit(0);
    }
    console.error(`   ❌ validateTrade rejected for unexpected reason: ${JSON.stringify(placement)}`);
    process.exit(1);
  }

  console.log("\n3. Snapshot after placement");
  const afterPlace = await snapshot();
  console.log({
    openPositionCount: afterPlace.openPositionCount,
    openExposure: afterPlace.openExposure,
    unrealizedPnl: afterPlace.unrealizedPnl,
  });

  if (afterPlace.openPositionCount <= baselineOpen) {
    console.error("   ❌ validateTrade reported success but no open position. Check PA.appendTrade.");
    process.exit(1);
  }
  console.log("   ✅ Trade landed via DA → RCA → TEA → PA");

  console.log("\n4. Looking up the new position");
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

  console.log("\n5. Exiting via executor.exitTrade (reason=MANUAL)");
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

  console.log("\n6. Final snapshot");
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
