/**
 * tradeEventNotifier — pure formatter tests.
 *
 * Only exercises the format* functions. The notifyTradeFill / notifyTradeExit /
 * notifyGateRejection wrappers are thin try/catch shims around notifyPartha;
 * they don't need their own tests because failure is logged and discarded.
 */
import { describe, it, expect } from "vitest";
import {
  formatExit,
  formatGateRejection,
  formatBrokerDisconnect,
} from "./tradeEventNotifier";

describe("formatExit", () => {
  const base = {
    channel: "live",
    instrument: "NATURALGAS",
    type: "CALL_BUY",
    strike: 24500,
    qty: 1250,
    entryPrice: 150,
    exitPrice: 195,
    triggeredBy: "USER",
    durationSeconds: 22 * 60,
  };

  it("profit → 'profit Rs.{amount} from {instrument} - {pct}%'", () => {
    const msg = formatExit({
      ...base,
      realizedPnl: 3375,
      realizedPnlPercent: 30.0,
      reason: "TP_HIT",
    });
    expect(msg).toBe("profit Rs.3,375 from NATURALGAS - 30.00%");
  });

  it("loss → 'lost Rs.{amount} from {instrument} - {pct}%'", () => {
    const msg = formatExit({
      ...base,
      realizedPnl: -750,
      realizedPnlPercent: -12.5,
      reason: "SL_HIT",
      triggeredBy: "PA",
    });
    expect(msg).toBe("lost Rs.750 from NATURALGAS - 12.50%");
  });

  it("reason no longer changes the wording — a profitable SL_HIT still reads 'profit'", () => {
    const msg = formatExit({
      ...base,
      realizedPnl: 900,
      realizedPnlPercent: 15.0,
      reason: "SL_HIT",
      triggeredBy: "PA",
    });
    expect(msg).toBe("profit Rs.900 from NATURALGAS - 15.00%");
  });

  it("a discipline exit in loss still reads 'lost'", () => {
    const msg = formatExit({
      ...base,
      realizedPnl: -900,
      realizedPnlPercent: -10,
      reason: "DISCIPLINE_EXIT",
      triggeredBy: "DA",
    });
    expect(msg).toBe("lost Rs.900 from NATURALGAS - 10.00%");
  });

  it("zero P&L reads as 'profit Rs.0 0.00%'", () => {
    const msg = formatExit({
      ...base,
      realizedPnl: 0,
      realizedPnlPercent: 0,
      reason: "MANUAL",
    });
    expect(msg).toBe("profit Rs.0 from NATURALGAS - 0.00%");
  });

  it("appends '[cohort · Strategy]' when both are known (the T84 race twins)", () => {
    const msg = formatExit({
      ...base,
      realizedPnl: 4500,
      realizedPnlPercent: 8,
      reason: "TP_HIT",
      cohort: "scalp",
      exitStrategy: "runway",
    });
    expect(msg).toBe("profit Rs.4,500 from NATURALGAS [scalp · Runway] - 8.00%");
  });

  it("shows only the strategy when cohort is null (bare manual trade)", () => {
    const msg = formatExit({
      ...base,
      realizedPnl: -750,
      realizedPnlPercent: -12.5,
      reason: "SL_HIT",
      cohort: null,
      exitStrategy: "sprint",
    });
    expect(msg).toBe("lost Rs.750 from NATURALGAS [Sprint] - 12.50%");
  });
});

describe("formatGateRejection", () => {
  it("'blocked {qty} {instrument} — {reason}' when qty is known", () => {
    const msg = formatGateRejection({
      channel: "live",
      instrument: "NIFTY 50",
      qty: 150,
      reason: "Discipline blocked: AI Live 1-lot cap exceeded",
    });
    expect(msg).toBe("blocked 150 NIFTY 50 — Discipline blocked: AI Live 1-lot cap exceeded");
  });

  it("omits the qty when not supplied", () => {
    const msg = formatGateRejection({
      channel: "live",
      instrument: "CRUDE OIL",
      reason: "Circuit breaker active",
    });
    expect(msg).toBe("blocked CRUDE OIL — Circuit breaker active");
  });
});

describe("formatBrokerDisconnect", () => {
  it("WS gave-up → plain feed-dropped line + retry hint", () => {
    const msg = formatBrokerDisconnect({
      brokerId: "dhan-primary-ac",
      kind: "ws_gave_up",
      reason: "WebSocket max reconnect attempts exceeded",
    });
    expect(msg).toBe(
      "dhan-primary-ac feed gave up — WebSocket max reconnect attempts exceeded. Server will keep retrying; restart BSA to reset.",
    );
  });

  it("token-expired → token line + fresh-token restart hint", () => {
    const msg = formatBrokerDisconnect({
      brokerId: "dhan-secondary-ac",
      kind: "token_expired",
      reason: "401 returned by /fundlimit",
    });
    expect(msg).toBe(
      "dhan-secondary-ac token expired — 401 returned by /fundlimit. Restart BSA to mint a fresh token.",
    );
  });

  it("ws_error → feed-error line, no token hint", () => {
    const msg = formatBrokerDisconnect({
      brokerId: "dhan-primary-ac",
      kind: "ws_error",
      reason: "network timeout",
    });
    expect(msg).toBe(
      "dhan-primary-ac feed error — network timeout. Server will keep retrying; restart BSA to reset.",
    );
    expect(msg).not.toContain("mint a fresh token");
  });
});
