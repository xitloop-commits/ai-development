// @vitest-environment jsdom
/**
 * Copying was silently dead on the origin the desk is actually opened at.
 *
 * `navigator.clipboard` exists only in a SECURE CONTEXT — https, localhost or
 * 127.0.0.1. The desk is normally reached at `http://lubas`, a plain-http
 * origin, where the API is `undefined`. The call sites wrote
 * `navigator.clipboard?.writeText(...)`, so that undefined became a no-op with
 * no toast and no console error: the button looked alive and did nothing.
 *
 * These tests pin the two behaviours that matter — it must still work when the
 * API is missing, and it must never report success when the copy did not
 * happen.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { copyText } from "./clipboard";

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, "clipboard", { value, configurable: true, writable: true });
}

beforeEach(() => {
  // jsdom implements neither; declare them per-test.
  setClipboard(undefined);
  (document as unknown as { execCommand?: unknown }).execCommand = vi.fn(() => true);
});

afterEach(() => {
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  vi.restoreAllMocks();
});

describe("copyText", () => {
  it("uses the clipboard API when the origin is secure", async () => {
    const writeText = vi.fn(async () => {});
    setClipboard({ writeText });

    await expect(copyText("NIFTY 24 Jul 23850 CALL")).resolves.toBe(true);

    expect(writeText).toHaveBeenCalledWith("NIFTY 24 Jul 23850 CALL");
    expect(document.execCommand).not.toHaveBeenCalled();
  });

  it("still copies when navigator.clipboard does not exist (plain-http origin)", async () => {
    // THE bug: this is the http://lubas case, where the whole feature was dead.
    await expect(copyText("NIFTY 24 Jul 23850 CALL")).resolves.toBe(true);
    expect(document.execCommand).toHaveBeenCalledWith("copy");
  });

  it("falls back to execCommand when the clipboard API rejects", async () => {
    // Permission denied, or the document wasn't focused — giving up here would
    // fail a copy that the legacy path would have completed.
    setClipboard({ writeText: vi.fn(async () => { throw new Error("NotAllowedError"); }) });

    await expect(copyText("PUT")).resolves.toBe(true);
    expect(document.execCommand).toHaveBeenCalledWith("copy");
  });

  it("reports FALSE when neither path works — never a false success", async () => {
    (document as unknown as { execCommand: unknown }).execCommand = vi.fn(() => false);
    await expect(copyText("PUT")).resolves.toBe(false);
  });

  it("reports false for an empty string rather than 'copying' nothing", async () => {
    await expect(copyText("")).resolves.toBe(false);
    expect(document.execCommand).not.toHaveBeenCalled();
  });

  it("leaves no textarea behind in the DOM", async () => {
    await copyText("NIFTY 24 Jul 23850 CALL");
    expect(document.querySelectorAll("textarea")).toHaveLength(0);
  });
});
