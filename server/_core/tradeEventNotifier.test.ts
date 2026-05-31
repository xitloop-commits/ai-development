/**
 * tradeEventNotifier — pure formatter tests.
 *
 * Only exercises the format* functions. The notifyTradeFill / notifyTradeExit /
 * notifyGateRejection wrappers are thin try/catch shims around notifyPartha;
 * they don't need their own tests because failure is logged and discarded.
 */
import { describe, it, expect } from "vitest";
import {
  formatFill,
  formatExit,
  formatGateRejection,
  formatBrokerDisconnect,
} from "./tradeEventNotifier";

describe("formatFill", () => {
  it("renders a CE option fill with contract + invested capital", () => {
    const msg = formatFill({
      channel: "my-live",
      instrument: "NIFTY 50",
      type: "CALL_BUY",
      strike: 24500,
      expiry: "2026-06-26",
      qty: 75,
      entryPrice: 150,
    });
    expect(msg).toContain("FILL · my-live");
    expect(msg).toContain("NIFTY 50 24500 CE");
    expect(msg).toContain("BUY");
    expect(msg).toContain("qty 75");
    expect(msg).toContain("@ ₹150");
    expect(msg).toContain("Invested: ₹11,250");
    expect(msg).toContain("Expiry: 2026-06-26");
  });

  it("renders a PE sell fill (no CALL label)", () => {
    const msg = formatFill({
      channel: "ai-live",
      instrument: "BANK NIFTY",
      type: "PUT_SELL",
      strike: 52000,
      qty: 25,
      entryPrice: 200,
    });
    expect(msg).toContain("BANK NIFTY 52000 PE");
    expect(msg).toContain("SELL");
    expect(msg).not.toContain("CE");
  });

  it("renders a non-option fill (futures direction) with no strike line", () => {
    const msg = formatFill({
      channel: "testing-live",
      instrument: "CRUDE OIL",
      type: "BUY",
      strike: null,
      qty: 100,
      entryPrice: 6500,
    });
    expect(msg).toContain("CRUDE OIL");
    expect(msg).not.toMatch(/CE|PE/);
    expect(msg).toContain("BUY");
  });
});

describe("formatExit", () => {
  it("uses green emoji + plus-sign P&L for a winner", () => {
    const msg = formatExit({
      channel: "my-live",
      instrument: "NIFTY 50",
      type: "CALL_BUY",
      strike: 24500,
      qty: 75,
      entryPrice: 150,
      exitPrice: 195,
      realizedPnl: 3375,
      realizedPnlPercent: 30.0,
      reason: "TP_HIT",
      triggeredBy: "USER",
      durationSeconds: 22 * 60,
    });
    expect(msg).toContain("🟢");
    expect(msg).toContain("EXIT · my-live");
    expect(msg).toContain("TP_HIT");
    expect(msg).toContain("₹150 → ₹195");
    expect(msg).toContain("+₹3,375");
    expect(msg).toContain("+30.00%");
    expect(msg).toContain("duration 22m");
  });

  it("uses red emoji + leading minus for a loser", () => {
    const msg = formatExit({
      channel: "ai-live",
      instrument: "CRUDE OIL",
      type: "CALL_BUY",
      strike: 6500,
      qty: 50,
      entryPrice: 120,
      exitPrice: 105,
      realizedPnl: -750,
      realizedPnlPercent: -12.5,
      reason: "SL_HIT",
      triggeredBy: "PA",
      durationSeconds: 8 * 60,
    });
    expect(msg).toContain("🔴");
    expect(msg).toContain("AUTO-EXIT");
    expect(msg).toContain("SL_HIT");
    expect(msg).toContain("-₹750");
    expect(msg).toContain("-12.50%");
  });

  it("uses ⛔ icon for DISCIPLINE_EXIT regardless of P&L sign", () => {
    const msg = formatExit({
      channel: "ai-live",
      instrument: "NIFTY 50",
      type: "PUT_BUY",
      strike: 24500,
      qty: 75,
      entryPrice: 100,
      exitPrice: 90,
      realizedPnl: -750,
      realizedPnlPercent: -10,
      reason: "DISCIPLINE_EXIT",
      triggeredBy: "DA",
      durationSeconds: 45 * 60,
    });
    expect(msg).toContain("⛔");
    expect(msg).toContain("DISCIPLINE_EXIT");
  });

  it("USER triggeredBy → EXIT header; non-USER → AUTO-EXIT header", () => {
    const base = {
      channel: "my-live",
      instrument: "NIFTY 50",
      type: "CALL_BUY",
      strike: 24500,
      qty: 75,
      entryPrice: 150,
      exitPrice: 160,
      realizedPnl: 750,
      realizedPnlPercent: 6.67,
      reason: "MANUAL",
      durationSeconds: 10 * 60,
    };
    expect(formatExit({ ...base, triggeredBy: "USER" })).toContain("EXIT · my-live");
    expect(formatExit({ ...base, triggeredBy: "USER" })).not.toContain("AUTO-EXIT");
    expect(formatExit({ ...base, triggeredBy: "PA" })).toContain("AUTO-EXIT · my-live");
  });

  it("duration formatter renders seconds / minutes / hours correctly", () => {
    const base = {
      channel: "x", instrument: "Y", type: "BUY", strike: null,
      qty: 1, entryPrice: 1, exitPrice: 1,
      realizedPnl: 0, realizedPnlPercent: 0,
      reason: "MANUAL", triggeredBy: "USER",
    };
    expect(formatExit({ ...base, durationSeconds: 45 })).toContain("duration 45s");
    expect(formatExit({ ...base, durationSeconds: 5 * 60 })).toContain("duration 5m");
    expect(formatExit({ ...base, durationSeconds: 2 * 3600 + 30 * 60 })).toContain("duration 2h30m");
  });
});

describe("formatGateRejection", () => {
  it("includes channel, instrument, qty (if known), and the reason", () => {
    const msg = formatGateRejection({
      channel: "ai-live",
      instrument: "NIFTY 50",
      qty: 150,
      reason: "Discipline blocked: AI Live 1-lot cap exceeded",
    });
    expect(msg).toContain("GATE REJECT · ai-live");
    expect(msg).toContain("NIFTY 50");
    expect(msg).toContain("qty 150");
    expect(msg).toContain("AI Live 1-lot cap exceeded");
  });

  it("omits the qty marker when qty is not supplied", () => {
    const msg = formatGateRejection({
      channel: "my-live",
      instrument: "CRUDE OIL",
      reason: "Circuit breaker active",
    });
    expect(msg).not.toContain("qty");
    expect(msg).toContain("Circuit breaker active");
  });
});

describe("formatBrokerDisconnect", () => {
  it("WS gave-up message uses 📡 icon + restart hint", () => {
    const msg = formatBrokerDisconnect({
      brokerId: "dhan-primary-ac",
      kind: "ws_gave_up",
      reason: "WebSocket max reconnect attempts exceeded",
    });
    expect(msg).toContain("📡");
    expect(msg).toContain("WS GAVE UP");
    expect(msg).toContain("dhan-primary-ac");
    expect(msg).toContain("max reconnect");
    expect(msg).toContain("restart BSA");
  });

  it("token-expired uses 🔑 icon + token-specific action hint", () => {
    const msg = formatBrokerDisconnect({
      brokerId: "dhan-secondary-ac",
      kind: "token_expired",
      reason: "401 returned by /fundlimit",
    });
    expect(msg).toContain("🔑");
    expect(msg).toContain("TOKEN EXPIRED");
    expect(msg).toContain("mint a fresh token");
  });

  it("ws_error kind uses 📡 icon + generic WS error label", () => {
    const msg = formatBrokerDisconnect({
      brokerId: "dhan-primary-ac",
      kind: "ws_error",
      reason: "network timeout",
    });
    expect(msg).toContain("📡");
    expect(msg).toContain("WS ERROR");
    expect(msg).not.toContain("mint a fresh token");
  });
});
