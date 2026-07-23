/**
 * Session summary — pure-function tests.
 *
 * computeSummary aggregates closed trades into a per-channel P&L digest;
 * formatSummary renders the Telegram message. Both pure, no Mongo, no
 * Telegram side effects.
 *
 * Rewritten 2026-07-01 for the new signature: computeSummary now takes
 * `Array<{channel, trades}>` (was `TradeRecord[]`) so the digest can
 * surface WHERE the P&L came from -- the operator's "final message
 * shows zero" complaint stemmed from not being able to see whether the
 * zero was "no trades on any AI channel" or "one stale zero-pnl trade
 * on live". formatSummary now emits a multi-line message with total
 * gain / total loss / net + a per-channel breakdown line.
 */
import { describe, it, expect } from "vitest";
import { computeSummary, formatSummary } from "./sessionSummaryScheduler";
import type { TradeRecord } from "../portfolio/state";

function trade(partial: Partial<TradeRecord>): TradeRecord {
  return {
    id: "T1",
    instrument: "NIFTY 50",
    type: "CALL_BUY",
    strike: 24000,
    expiry: null,
    contractSecurityId: null,
    entryPrice: 100,
    exitPrice: 110,
    ltp: 110,
    qty: 75,
    capitalPercent: 5,
    pnl: 750,
    unrealizedPnl: 0,
    charges: 50,
    chargesBreakdown: [],
    brokerOrderId: null,
    brokerId: null,
    status: "CLOSED",
    openedAt: 0,
    closedAt: 0,
    ...partial,
  } as TradeRecord;
}

/** Wrap a list of trades as a single-channel input for computeSummary. */
function oneChannel(channel: string, trades: TradeRecord[]) {
  return [{ channel, trades }];
}

describe("sessionSummaryScheduler — computeSummary", () => {
  it("returns zeros when no trades on any channel", () => {
    const s = computeSummary(
      [
        { channel: "live", trades: [] },
        { channel: "ai-paper", trades: [] },
      ],
      100_000,
      100_000,
    );
    expect(s.totalTrades).toBe(0);
    expect(s.totalGain).toBe(0);
    expect(s.totalLoss).toBe(0);
    expect(s.netPnl).toBe(0);
    expect(s.netPnlPercent).toBe(0);
    expect(s.bestTrade).toBeNull();
    expect(s.worstTrade).toBeNull();
    expect(s.currentCapital).toBe(100_000);
    // Per-channel breakdown reflects both empty buckets.
    expect(s.perChannel.map((c) => c.channel)).toEqual(["live", "ai-paper"]);
    expect(s.perChannel.every((c) => c.trades === 0 && c.net === 0)).toBe(true);
  });

  it("ignores OPEN / PENDING trades", () => {
    const trades = [
      trade({ id: "T1", pnl: 500, status: "CLOSED" }),
      trade({ id: "T2", pnl: 999, status: "OPEN" }),
      trade({ id: "T3", pnl: 999, status: "PENDING" }),
    ];
    const s = computeSummary(oneChannel("ai-paper", trades), 100_000, 100_500);
    expect(s.totalTrades).toBe(1);
    expect(s.netPnl).toBe(500);
  });

  it("splits gain vs loss: positive pnls contribute to totalGain, negative to totalLoss (magnitude)", () => {
    const trades = [
      trade({ id: "T1", pnl: 800 }),
      trade({ id: "T2", pnl: -300 }),
      trade({ id: "T3", pnl: 500 }),
      trade({ id: "T4", pnl: -100 }),
      trade({ id: "T5", pnl: 0 }),
    ];
    const s = computeSummary(oneChannel("ai-paper", trades), 100_000, 100_900);
    expect(s.totalGain).toBe(1300);   // 800 + 500
    expect(s.totalLoss).toBe(400);    // |-300| + |-100|
    expect(s.netPnl).toBe(900);       // 1300 - 400
  });

  it("computes wins / losses / breakevens by pnl sign", () => {
    const trades = [
      trade({ id: "T1", pnl: 500 }),
      trade({ id: "T2", pnl: -300 }),
      trade({ id: "T3", pnl: 0 }),
      trade({ id: "T4", pnl: 100 }),
    ];
    const s = computeSummary(oneChannel("live", trades), 100_000, 100_300);
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(1);
    expect(s.breakevens).toBe(1);
  });

  it("identifies best and worst trade across channels", () => {
    const s = computeSummary(
      [
        {
          channel: "live",
          trades: [trade({ id: "T1", pnl: 500, instrument: "NIFTY 50" })],
        },
        {
          channel: "ai-paper",
          trades: [
            trade({ id: "T2", pnl: -1200, instrument: "BANK NIFTY" }),
            trade({ id: "T3", pnl: 2500, instrument: "NIFTY 50" }),
          ],
        },
      ],
      100_000,
      101_800,
    );
    expect(s.bestTrade?.id).toBe("T3");
    expect(s.bestTrade?.pnl).toBe(2500);
    expect(s.worstTrade?.id).toBe("T2");
    expect(s.worstTrade?.pnl).toBe(-1200);
  });

  it("populates per-channel breakdown with gain / loss / net / trades", () => {
    const s = computeSummary(
      [
        {
          channel: "live",
          trades: [
            trade({ id: "T1", pnl: 300 }),
            trade({ id: "T2", pnl: -100 }),
          ],
        },
        {
          channel: "ai-paper",
          trades: [
            trade({ id: "T3", pnl: 800 }),
            trade({ id: "T4", pnl: 200 }),
          ],
        },
      ],
      100_000,
      101_200,
    );
    const live = s.perChannel.find((c) => c.channel === "live")!;
    const paper = s.perChannel.find((c) => c.channel === "ai-paper")!;
    expect(live).toEqual({ channel: "live", trades: 2, gain: 300, loss: 100, net: 200 });
    expect(paper).toEqual({ channel: "ai-paper", trades: 2, gain: 1000, loss: 0, net: 1000 });
    expect(s.netPnl).toBe(1200); // 200 + 1000
  });

  it("netPnlPercent guards against zero starting capital", () => {
    const s = computeSummary(oneChannel("ai-paper", [trade({ pnl: 500 })]), 0, 500);
    expect(s.netPnlPercent).toBe(0);
  });
});

describe("sessionSummaryScheduler — formatSummary", () => {
  it("profit close: multi-line with gain / loss / net profit + per-channel breakdown", () => {
    const summary = computeSummary(
      oneChannel("ai-paper", [trade({ pnl: 1500 })]),
      100_000,
      101_500,
    );
    const msg = formatSummary("NSE", summary);
    expect(msg.split("\n")).toEqual([
      "NSE closed",
      "gain Rs.1,500 · loss Rs.0 · net profit Rs.1,500 (1.50%)",
      "ai-paper: +Rs.1,500 (1 trades)",
      "1 trades · W 1 / L 0 / BE 0",
    ]);
  });

  it("loss close: 'net loss' phrasing, magnitude only", () => {
    const summary = computeSummary(
      oneChannel("live", [trade({ pnl: -800 })]),
      100_000,
      99_200,
    );
    const msg = formatSummary("MCX", summary);
    expect(msg.split("\n")).toEqual([
      "MCX closed",
      "gain Rs.0 · loss Rs.800 · net loss Rs.800 (0.80%)",
      "live: -Rs.800 (1 trades)",
      "1 trades · W 0 / L 1 / BE 0",
    ]);
  });

  it("net across mixed trades and channels shows aggregate + per-channel", () => {
    const summary = computeSummary(
      [
        {
          channel: "live",
          trades: [
            trade({ id: "A", pnl: 500, instrument: "NIFTY 50" }),
            trade({ id: "B", pnl: -300, instrument: "BANK NIFTY" }),
          ],
        },
        {
          channel: "ai-paper",
          trades: [trade({ id: "C", pnl: 2200, instrument: "NIFTY 50" })],
        },
      ],
      100_000,
      102_400,
    );
    const msg = formatSummary("NSE", summary);
    expect(msg).toBe(
      "NSE closed\n" +
        "gain Rs.2,700 · loss Rs.300 · net profit Rs.2,400 (2.40%)\n" +
        "live: +Rs.200 (2 trades)  ·  ai-paper: +Rs.2,200 (1 trades)\n" +
        "3 trades · W 2 / L 1 / BE 0",
    );
  });

  it("omits per-channel line when NO channels have trades (all-zero degenerate)", () => {
    // buildAndSend would early-return before formatSummary here, but the
    // formatter still has to render safely if called directly.
    const summary = computeSummary(
      [
        { channel: "live", trades: [] },
        { channel: "ai-paper", trades: [] },
      ],
      100_000,
      100_000,
    );
    const msg = formatSummary("NSE", summary);
    expect(msg.split("\n")).toEqual([
      "NSE closed",
      "gain Rs.0 · loss Rs.0 · net profit Rs.0 (0.00%)",
      "0 trades · W 0 / L 0 / BE 0",
    ]);
  });
});
