/**
 * T118 — which real Dhan account backs the ai-live book.
 *
 * Dhan ties an API key to ONE whitelisted IP and refuses an IP already
 * registered on another account, so a household with one static IP can only
 * trade from one of the two accounts. `AI_LIVE_BROKER_ID` moves ai-live onto the
 * primary account; everything downstream (order routing, capital seeding,
 * reconciliation) reads that one resolver rather than repeating the mapping.
 */
import { describe, it, expect, afterEach } from "vitest";
import { brokerIdForChannel, liveBooksShareAccount } from "./brokerService";

const ORIGINAL = process.env.AI_LIVE_BROKER_ID;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.AI_LIVE_BROKER_ID;
  else process.env.AI_LIVE_BROKER_ID = ORIGINAL;
});

describe("brokerIdForChannel", () => {
  it("defaults ai-live to the secondary account and my-live to the primary", () => {
    delete process.env.AI_LIVE_BROKER_ID;
    expect(brokerIdForChannel("ai-live")).toBe("dhan-secondary-ac");
    expect(brokerIdForChannel("my-live")).toBe("dhan-primary-ac");
    expect(liveBooksShareAccount()).toBe(false);
  });

  it("moves ai-live onto the primary account when the env var says so", () => {
    process.env.AI_LIVE_BROKER_ID = "dhan-primary-ac";
    expect(brokerIdForChannel("ai-live")).toBe("dhan-primary-ac");
    expect(liveBooksShareAccount()).toBe(true);
  });

  it("my-live is never configurable — it is always the primary account", () => {
    // Guard against a future 'make it symmetric' refactor: my-live is where
    // hand-placed trades go, and moving those is not what this switch is for.
    process.env.AI_LIVE_BROKER_ID = "dhan-secondary-ac";
    expect(brokerIdForChannel("my-live")).toBe("dhan-primary-ac");
  });

  it("treats an empty or whitespace env var as unset, not as an empty brokerId", () => {
    // An empty value in .env is a common way to 'turn something off'; it must
    // not resolve to "" and silently fail every adapter lookup.
    process.env.AI_LIVE_BROKER_ID = "   ";
    expect(brokerIdForChannel("ai-live")).toBe("dhan-secondary-ac");
    expect(liveBooksShareAccount()).toBe(false);
  });

  it("returns null for paper — there is no real account behind it", () => {
    expect(brokerIdForChannel("paper")).toBeNull();
  });
});
