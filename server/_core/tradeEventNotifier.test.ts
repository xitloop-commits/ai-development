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
  it("buy entry → 'bought {qty} {instrument} at Rs.{price}', no contract/strike noise", () => {
    const msg = formatFill({
      channel: "my-live",
      instrument: "NIFTY 50",
      type: "CALL_BUY",
      strike: 24500,
      expiry: "2026-06-26",
      qty: 75,
      entryPrice: 150,
    });
    expect(msg).toBe("bought 75 NIFTY 50 at Rs.150");
  });

  it("sell (short) entry → 'sold …'", () => {
    const msg = formatFill({
      channel: "ai-live",
      instrument: "BANK NIFTY",
      type: "PUT_SELL",
      strike: 52000,
      qty: 25,
      entryPrice: 200,
    });
    expect(msg).toBe("sold 25 BANK NIFTY at Rs.200");
  });

  it("non-option buy reads the same plain way", () => {
    const msg = formatFill({
      channel: "testing-live",
      instrument: "NATURALGAS",
      type: "BUY",
      strike: null,
      qty: 1250,
      entryPrice: 45,
    });
    expect(msg).toBe("bought 1250 NATURALGAS at Rs.45");
  });
});

describe("formatExit", () => {
  const base = {
    channel: "my-live",
    instrument: "NATURALGAS",
    type: "CALL_BUY",
    strike: 24500,
    qty: 1250,
    entryPrice: 150,
    exitPrice: 195,
    triggeredBy: "USER",
    durationSeconds: 22 * 60,
  };

  it("TP_HIT → 'target achieved {pct} {rs} from {instrument}'", () => {
    const msg = formatExit({
      ...base,
      realizedPnl: 3375,
      realizedPnlPercent: 30.0,
      reason: "TP_HIT",
    });
    expect(msg).toBe("target achieved 30.00% Rs.3,375 from NATURALGAS");
  });

  it("SL_HIT in loss → 'stop-loss hit, lost {pct} {rs} from {instrument}'", () => {
    const msg = formatExit({
      ...base,
      realizedPnl: -750,
      realizedPnlPercent: -12.5,
      reason: "SL_HIT",
      triggeredBy: "PA",
    });
    expect(msg).toBe("stop-loss hit, lost 12.50% Rs.750 from NATURALGAS");
  });

  it("SL_HIT in profit (trailing stop locked a gain) → 'trailing stop hit, gained ...'", () => {
    const msg = formatExit({
      ...base,
      realizedPnl: 900,
      realizedPnlPercent: 15.0,
      reason: "SL_HIT",
      triggeredBy: "PA",
    });
    expect(msg).toBe("trailing stop hit, gained 15.00% Rs.900 from NATURALGAS");
  });

  it("DISCIPLINE_EXIT → 'closed by risk rule, …' regardless of P&L sign", () => {
    const msg = formatExit({
      ...base,
      realizedPnl: -900,
      realizedPnlPercent: -10,
      reason: "DISCIPLINE_EXIT",
      triggeredBy: "DA",
    });
    expect(msg).toBe("closed by risk rule, 10.00% Rs.900 from NATURALGAS");
  });

  it("normal sell winner → 'gained …'", () => {
    const msg = formatExit({
      ...base,
      realizedPnl: 750,
      realizedPnlPercent: 6.67,
      reason: "MANUAL",
    });
    expect(msg).toBe("gained 6.67% Rs.750 from NATURALGAS");
  });

  it("normal sell loser → 'lost …'", () => {
    const msg = formatExit({
      ...base,
      realizedPnl: -1200,
      realizedPnlPercent: -3,
      reason: "MANUAL",
    });
    expect(msg).toBe("lost 3.00% Rs.1,200 from NATURALGAS");
  });
});

describe("formatGateRejection", () => {
  it("'blocked {qty} {instrument} — {reason}' when qty is known", () => {
    const msg = formatGateRejection({
      channel: "ai-live",
      instrument: "NIFTY 50",
      qty: 150,
      reason: "Discipline blocked: AI Live 1-lot cap exceeded",
    });
    expect(msg).toBe("blocked 150 NIFTY 50 — Discipline blocked: AI Live 1-lot cap exceeded");
  });

  it("omits the qty when not supplied", () => {
    const msg = formatGateRejection({
      channel: "my-live",
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
