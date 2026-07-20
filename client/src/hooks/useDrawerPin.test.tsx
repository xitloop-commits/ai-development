/**
 * Drawer pin persistence.
 *
 * The pin decides whether a drawer reopens on the next load, so it has to
 * survive a reload and must never throw — a browser with storage blocked should
 * fall back to "unpinned", not break the shell.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { readPinned, useDrawerPin } from "./useDrawerPin";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("readPinned", () => {
  it("defaults to false when nothing is stored", () => {
    expect(readPinned("left")).toBe(false);
    expect(readPinned("right")).toBe(false);
  });

  it("reads a stored pin", () => {
    localStorage.setItem("lubas.drawer.left.pinned", "1");
    expect(readPinned("left")).toBe(true);
    expect(readPinned("right")).toBe(false); // sides are independent
  });

  it("treats anything other than '1' as unpinned", () => {
    localStorage.setItem("lubas.drawer.left.pinned", "0");
    expect(readPinned("left")).toBe(false);
  });

  it("does not throw when storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError: storage disabled");
    });
    expect(() => readPinned("left")).not.toThrow();
    expect(readPinned("left")).toBe(false);
  });
});

describe("useDrawerPin", () => {
  it("starts from the persisted value", () => {
    localStorage.setItem("lubas.drawer.right.pinned", "1");
    const { result } = renderHook(() => useDrawerPin("right"));
    expect(result.current.pinned).toBe(true);
  });

  it("toggling persists, so the next load reopens the drawer", () => {
    const { result } = renderHook(() => useDrawerPin("left"));
    expect(result.current.pinned).toBe(false);

    act(() => result.current.togglePin());

    expect(result.current.pinned).toBe(true);
    expect(readPinned("left")).toBe(true); // what MainScreen reads on next load
  });

  it("toggling off persists too", () => {
    localStorage.setItem("lubas.drawer.left.pinned", "1");
    const { result } = renderHook(() => useDrawerPin("left"));

    act(() => result.current.togglePin());

    expect(result.current.pinned).toBe(false);
    expect(readPinned("left")).toBe(false);
  });

  it("left and right pins don't interfere", () => {
    const left = renderHook(() => useDrawerPin("left"));
    const right = renderHook(() => useDrawerPin("right"));

    act(() => left.result.current.togglePin());

    expect(readPinned("left")).toBe(true);
    expect(readPinned("right")).toBe(false);
    expect(right.result.current.pinned).toBe(false);
  });

  it("still toggles in-session when storage writes fail", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    const { result } = renderHook(() => useDrawerPin("left"));

    expect(() => act(() => result.current.togglePin())).not.toThrow();
    expect(result.current.pinned).toBe(true); // works now; just won't survive a reload
  });
});
