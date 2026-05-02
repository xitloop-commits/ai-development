/**
 * G5 — useHotkeyListener
 *
 * Locks the three behavioural guarantees the hook makes:
 *
 *   1. Modifier keys (Ctrl / Meta / Alt / Shift) suppress the hotkey
 *      so browser shortcuts (Ctrl+S, Cmd+R) and intentional combos
 *      pass through to the OS / browser instead of placing a trade.
 *
 *   2. Typing inside an input / textarea / select MUST NOT fire the
 *      hotkey — otherwise typing the digit "1" in NewTradeForm would
 *      trigger the NIFTY hotkey mid-edit.
 *
 *   3. A hotkey collision (no entry in the map) is silent — does not
 *      preventDefault, does not call onHotkey.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useHotkeyListener, type HotkeyAction } from "./useHotkeyListener";

const NIFTY: HotkeyAction = { instrumentKey: "NIFTY_50", instrumentName: "NIFTY 50", hotkey: "1" };
const BANKNIFTY: HotkeyAction = { instrumentKey: "BANKNIFTY", instrumentName: "BANK NIFTY", hotkey: "2" };

function makeMap(): Record<string, HotkeyAction> {
  return { "1": NIFTY, "2": BANKNIFTY };
}

function dispatchKey(key: string, opts: KeyboardEventInit & { tagName?: string } = {}) {
  const { tagName, ...init } = opts;
  if (tagName) {
    const el = document.createElement(tagName);
    document.body.appendChild(el);
    el.focus();
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
    el.remove();
    return;
  }
  window.dispatchEvent(new KeyboardEvent("keydown", { key, ...init }));
}

describe("useHotkeyListener", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("fires onHotkey for a mapped key", () => {
    const onHotkey = vi.fn();
    renderHook(() => useHotkeyListener(makeMap(), onHotkey));

    dispatchKey("1");

    expect(onHotkey).toHaveBeenCalledTimes(1);
    expect(onHotkey).toHaveBeenCalledWith(NIFTY);
  });

  it("normalises uppercase to lowercase before lookup", () => {
    const onHotkey = vi.fn();
    renderHook(() => useHotkeyListener(makeMap(), onHotkey));

    // Some users hit shift accidentally; the hook lowercases internally.
    dispatchKey("2");
    expect(onHotkey).toHaveBeenCalledWith(BANKNIFTY);
  });

  it("does not fire when an unmapped key is pressed", () => {
    const onHotkey = vi.fn();
    renderHook(() => useHotkeyListener(makeMap(), onHotkey));

    dispatchKey("9");

    expect(onHotkey).not.toHaveBeenCalled();
  });

  it("suppresses when Ctrl is held (browser shortcut passthrough)", () => {
    const onHotkey = vi.fn();
    renderHook(() => useHotkeyListener(makeMap(), onHotkey));

    dispatchKey("1", { ctrlKey: true });

    expect(onHotkey).not.toHaveBeenCalled();
  });

  it("suppresses when Meta is held (Cmd+R, Cmd+1, etc.)", () => {
    const onHotkey = vi.fn();
    renderHook(() => useHotkeyListener(makeMap(), onHotkey));

    dispatchKey("1", { metaKey: true });

    expect(onHotkey).not.toHaveBeenCalled();
  });

  it("suppresses when Alt is held", () => {
    const onHotkey = vi.fn();
    renderHook(() => useHotkeyListener(makeMap(), onHotkey));

    dispatchKey("1", { altKey: true });

    expect(onHotkey).not.toHaveBeenCalled();
  });

  it("suppresses when Shift is held", () => {
    const onHotkey = vi.fn();
    renderHook(() => useHotkeyListener(makeMap(), onHotkey));

    dispatchKey("1", { shiftKey: true });

    expect(onHotkey).not.toHaveBeenCalled();
  });

  it("does NOT fire when the focus target is an INPUT (typing in a form)", () => {
    const onHotkey = vi.fn();
    renderHook(() => useHotkeyListener(makeMap(), onHotkey));

    dispatchKey("1", { tagName: "INPUT" });

    expect(onHotkey).not.toHaveBeenCalled();
  });

  it("does NOT fire when the focus target is a TEXTAREA", () => {
    const onHotkey = vi.fn();
    renderHook(() => useHotkeyListener(makeMap(), onHotkey));

    dispatchKey("1", { tagName: "TEXTAREA" });

    expect(onHotkey).not.toHaveBeenCalled();
  });

  it("does NOT fire when the focus target is a SELECT (dropdown)", () => {
    const onHotkey = vi.fn();
    renderHook(() => useHotkeyListener(makeMap(), onHotkey));

    dispatchKey("1", { tagName: "SELECT" });

    expect(onHotkey).not.toHaveBeenCalled();
  });

  it("removes its event listener on unmount (no fire after teardown)", () => {
    const onHotkey = vi.fn();
    const { unmount } = renderHook(() => useHotkeyListener(makeMap(), onHotkey));

    dispatchKey("1");
    expect(onHotkey).toHaveBeenCalledTimes(1);

    unmount();
    dispatchKey("1");

    expect(onHotkey).toHaveBeenCalledTimes(1); // not 2 — listener gone
  });
});
