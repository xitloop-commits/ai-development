/**
 * SubscriptionManager — refcount semantics.
 *
 * Multiple subscribers can share one WS subscription; the actual WS
 * unsubscribe fires only when the last subscriber drops the entry. This
 * test pins that contract so future refactors don't quietly regress it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SubscriptionManager } from "./subscriptionManager";

describe("SubscriptionManager — refcount", () => {
  const onSubscribe = vi.fn();
  const onUnsubscribe = vi.fn();
  let mgr: SubscriptionManager;

  beforeEach(() => {
    onSubscribe.mockClear();
    onUnsubscribe.mockClear();
    mgr = new SubscriptionManager({ onSubscribe, onUnsubscribe });
  });

  const inst = (securityId: string) => ({
    exchange: "NSE_FNO",
    securityId,
    mode: "full" as const,
  });

  it("single subscribe → emits WS subscribe once", () => {
    mgr.subscribeManual([inst("12345")]);
    expect(onSubscribe).toHaveBeenCalledTimes(1);
    expect(onSubscribe.mock.calls[0][0]).toHaveLength(1);
    expect(mgr.getState().totalSubscriptions).toBe(1);
  });

  it("second subscribe on same key bumps refCount only — no second WS subscribe", () => {
    mgr.subscribeManual([inst("12345")]);
    mgr.subscribeManual([inst("12345")]);
    // Only the first call emitted to the WS
    expect(onSubscribe).toHaveBeenCalledTimes(1);
    expect(mgr.getState().totalSubscriptions).toBe(1);
  });

  it("first unsubscribe after two subscribes keeps the WS subscription alive", () => {
    mgr.subscribeManual([inst("12345")]);
    mgr.subscribeManual([inst("12345")]);
    mgr.unsubscribeManual([{ exchange: "NSE_FNO", securityId: "12345" }]);
    expect(onUnsubscribe).not.toHaveBeenCalled();
    expect(mgr.getState().totalSubscriptions).toBe(1);
  });

  it("second unsubscribe drops refCount to 0 and emits WS unsubscribe", () => {
    mgr.subscribeManual([inst("12345")]);
    mgr.subscribeManual([inst("12345")]);
    mgr.unsubscribeManual([{ exchange: "NSE_FNO", securityId: "12345" }]);
    mgr.unsubscribeManual([{ exchange: "NSE_FNO", securityId: "12345" }]);
    expect(onUnsubscribe).toHaveBeenCalledTimes(1);
    expect(mgr.getState().totalSubscriptions).toBe(0);
  });

  it("unsubscribing an unknown key is a silent no-op", () => {
    mgr.unsubscribeManual([{ exchange: "NSE_FNO", securityId: "nonexistent" }]);
    expect(onUnsubscribe).not.toHaveBeenCalled();
  });

  it("extra unsubscribes past refCount=0 stay silent (don't go negative)", () => {
    mgr.subscribeManual([inst("12345")]);
    mgr.unsubscribeManual([{ exchange: "NSE_FNO", securityId: "12345" }]);
    expect(onUnsubscribe).toHaveBeenCalledTimes(1);
    // Now refcount is 0 and entry is deleted; another unsubscribe must not crash or re-emit
    mgr.unsubscribeManual([{ exchange: "NSE_FNO", securityId: "12345" }]);
    expect(onUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it("independent keys each track their own refCount", () => {
    mgr.subscribeManual([inst("A"), inst("B")]);
    mgr.subscribeManual([inst("A")]);
    // A refCount=2, B refCount=1
    mgr.unsubscribeManual([{ exchange: "NSE_FNO", securityId: "A" }]);
    expect(onUnsubscribe).not.toHaveBeenCalled(); // A still has refCount=1
    mgr.unsubscribeManual([{ exchange: "NSE_FNO", securityId: "B" }]);
    expect(onUnsubscribe).toHaveBeenCalledTimes(1);
    expect(onUnsubscribe.mock.calls[0][0]).toEqual([
      { exchange: "NSE_FNO", securityId: "B" },
    ]);
  });

  it("max-instruments cap blocks new entries but lets refCount bumps through", () => {
    const tinyMgr = new SubscriptionManager({ onSubscribe, onUnsubscribe }, 1);
    tinyMgr.subscribeManual([inst("A")]);
    // 2nd subscribe on same key still works (refCount bump, no new entry)
    tinyMgr.subscribeManual([inst("A")]);
    expect(onSubscribe).toHaveBeenCalledTimes(1);
    // New key blocked by cap
    tinyMgr.subscribeManual([inst("B")]);
    expect(onSubscribe).toHaveBeenCalledTimes(1);
    expect(tinyMgr.getState().totalSubscriptions).toBe(1);
  });
});
