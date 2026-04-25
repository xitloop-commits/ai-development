/**
 * TEA Phase 1 commits 1-2 smoke test.
 * Run: pnpm tsx scripts/test-tea-paper.ts
 * Requires `pnpm dev` running on http://localhost:3000.
 */

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

async function main() {
  const now = Date.now();
  const execId = `smoke-${now}`;
  const tradeInput = {
    executionId: execId,
    channel: "my-paper" as const,
    origin: "USER" as const,
    instrument: "NIFTY_50",
    direction: "BUY" as const,
    quantity: 75,
    entryPrice: 100,
    stopLoss: 90,
    takeProfit: 120,
    orderType: "MARKET" as const,
    productType: "INTRADAY" as const,
    timestamp: now,
  };

  console.log("\n=== 1. Submit a paper trade (channel=my-paper) ===");
  const submit = await callTrpc<any>("executor.submitTrade", tradeInput);
  console.log(submit);

  console.log("\n=== 2. Snapshot — should show 1 open position ===");
  const snap = await callTrpc<any>("portfolio.snapshot", { channel: "my-paper" }, "GET");
  console.log({
    openPositionCount: snap.openPositionCount,
    openExposure: snap.openExposure,
    unrealizedPnl: snap.unrealizedPnl,
  });

  console.log("\n=== 3. Resubmit SAME executionId — idempotency replay ===");
  const dup = await callTrpc<any>("executor.submitTrade", tradeInput);
  console.log({
    firstTradeId: submit.tradeId,
    secondTradeId: dup.tradeId,
    match: submit.tradeId === dup.tradeId,
  });

  console.log("\n=== 4. Snapshot again — should STILL be 1 open position ===");
  const snap2 = await callTrpc<any>("portfolio.snapshot", { channel: "my-paper" }, "GET");
  console.log({ openPositionCount: snap2.openPositionCount });

  console.log("\n=== 5. Live submit on my-live — should be REJECTED (commit 3 not landed) ===");
  const live = await callTrpc<any>("executor.submitTrade", { ...tradeInput, executionId: `live-${now}`, channel: "my-live" });
  console.log({ success: live.success, status: live.status, error: live.error });

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
