/**
 * H5 — `instruments.setHotkey` zod input-schema regression.
 *
 * The procedure body wraps `assignHotkey()` (already covered by
 * instruments.test.ts via the swap-with-existing case). This file
 * locks the regex validator at the API boundary so the client can't
 * smuggle multi-character hotkeys, modifier sequences, or empty
 * strings past the boundary — those would then crash the tRPC handler.
 *
 * Mirrors the schema defined in `server/routers.ts:setHotkey`.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";

const setHotkeySchema = z.object({
  key: z.string().min(1),
  hotkey: z.string().regex(/^[a-z0-9]$/i, "single alphanumeric character").nullable(),
});

describe("setHotkey input schema", () => {
  it("accepts a single digit", () => {
    expect(setHotkeySchema.safeParse({ key: "NIFTY_50", hotkey: "1" }).success).toBe(true);
  });

  it("accepts a single lowercase letter", () => {
    expect(setHotkeySchema.safeParse({ key: "NIFTY_50", hotkey: "q" }).success).toBe(true);
  });

  it("accepts a single uppercase letter (case-insensitive regex)", () => {
    expect(setHotkeySchema.safeParse({ key: "NIFTY_50", hotkey: "A" }).success).toBe(true);
  });

  it("accepts null to clear an existing hotkey", () => {
    expect(setHotkeySchema.safeParse({ key: "NIFTY_50", hotkey: null }).success).toBe(true);
  });

  it("rejects multi-character strings", () => {
    expect(setHotkeySchema.safeParse({ key: "NIFTY_50", hotkey: "12" }).success).toBe(false);
    expect(setHotkeySchema.safeParse({ key: "NIFTY_50", hotkey: "Ctrl" }).success).toBe(false);
  });

  it("rejects empty string (caller should send null to clear)", () => {
    expect(setHotkeySchema.safeParse({ key: "NIFTY_50", hotkey: "" }).success).toBe(false);
  });

  it("rejects punctuation / special chars", () => {
    expect(setHotkeySchema.safeParse({ key: "NIFTY_50", hotkey: "!" }).success).toBe(false);
    expect(setHotkeySchema.safeParse({ key: "NIFTY_50", hotkey: " " }).success).toBe(false);
  });

  it("rejects empty instrument key", () => {
    expect(setHotkeySchema.safeParse({ key: "", hotkey: "1" }).success).toBe(false);
  });

  it("rejects missing fields (typo guard at the boundary)", () => {
    expect(setHotkeySchema.safeParse({ key: "NIFTY_50" }).success).toBe(false);
    expect(setHotkeySchema.safeParse({ hotkey: "1" }).success).toBe(false);
    expect(setHotkeySchema.safeParse({}).success).toBe(false);
  });
});
