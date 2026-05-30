/**
 * F8 — per-broker WebSocket log tags.
 *
 * `DhanWebSocket` and `DhanOrderUpdateWs` constructors take a `brokerTag`
 * so multi-broker setups produce disambiguated log module names:
 *   `[BSA:Dhan/dhan-primary-ac-WS]`   (trading)
 *   `[BSA:Dhan/dhan-secondary-ac-WS]` (AI tick feed)
 * Without F8 every line read `[BSA:DhanWS]` regardless of which broker
 * fired it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const createLoggerMock = vi.fn();

vi.mock("../../logger.js", () => ({
  createLogger: (agent: string, mod: string) => {
    createLoggerMock(agent, mod);
    return {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      important: vi.fn(),
    };
  },
}));

// orderUpdateWs.ts uses "../../logger" (no .js); mock both specifiers.
vi.mock("../../logger", () => ({
  createLogger: (agent: string, mod: string) => {
    createLoggerMock(agent, mod);
    return {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      important: vi.fn(),
    };
  },
}));

import { DhanWebSocket } from "./websocket";
import { DhanOrderUpdateWs } from "./orderUpdateWs";

const baseConfig = {
  accessToken: "token-x",
  clientId: "client-x",
  onTick: vi.fn(),
  onPrevClose: vi.fn(),
  onDisconnect: vi.fn(),
  onError: vi.fn(),
  onConnected: vi.fn(),
};

describe("F8 — DhanWebSocket per-broker log tags", () => {
  beforeEach(() => {
    createLoggerMock.mockClear();
  });

  it("uses the supplied brokerTag in the module name", () => {
    new DhanWebSocket({ ...baseConfig, brokerTag: "dhan-primary-ac" } as any);
    new DhanWebSocket({ ...baseConfig, brokerTag: "dhan-secondary-ac" } as any);

    const tagsSeen = createLoggerMock.mock.calls.map((c) => c[1]);
    expect(tagsSeen).toContain("Dhan/dhan-primary-ac-WS");
    expect(tagsSeen).toContain("Dhan/dhan-secondary-ac-WS");
    // The two instances must produce distinct module names — that's
    // the whole point of F8.
    expect(new Set(tagsSeen).size).toBe(tagsSeen.length);
  });

  it("falls back to 'default' when brokerTag is omitted", () => {
    new DhanWebSocket({ ...baseConfig } as any);
    expect(createLoggerMock).toHaveBeenCalledWith("BSA", "Dhan/default-WS");
  });
});

describe("F8 — DhanOrderUpdateWs per-broker log tags", () => {
  beforeEach(() => {
    createLoggerMock.mockClear();
  });

  it("uses the supplied brokerTag in the module name", () => {
    new DhanOrderUpdateWs("client-1", "token-1", "dhan-primary-ac");
    new DhanOrderUpdateWs("client-2", "token-2", "dhan-secondary-ac");

    const tagsSeen = createLoggerMock.mock.calls.map((c) => c[1]);
    expect(tagsSeen).toContain("Dhan/dhan-primary-ac-OrderWS");
    expect(tagsSeen).toContain("Dhan/dhan-secondary-ac-OrderWS");
    expect(new Set(tagsSeen).size).toBe(tagsSeen.length);
  });

  it("falls back to 'default' when brokerTag is omitted", () => {
    new DhanOrderUpdateWs("client-x", "token-x");
    expect(createLoggerMock).toHaveBeenCalledWith("BSA", "Dhan/default-OrderWS");
  });
});
