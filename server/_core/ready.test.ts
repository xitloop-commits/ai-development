/**
 * Tests for the /ready readiness gate (B7).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Stub mongo before importing ready.ts so the module picks up our mock.
vi.mock("../mongo", () => ({
  getMongoHealth: vi.fn(),
}));

// eslint-disable-next-line import/first
import { getMongoHealth } from "../mongo";
// eslint-disable-next-line import/first
import {
  getReadyStatus,
  markReady,
  markNotReady,
  _resetReadyForTesting,
} from "./ready";

const mockMongoHealth = getMongoHealth as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  _resetReadyForTesting();
  mockMongoHealth.mockReset();
});

describe("getReadyStatus (B7)", () => {
  it("returns ready=false when nothing is initialised", () => {
    mockMongoHealth.mockReturnValue({ status: "disconnected" });
    const s = getReadyStatus();
    expect(s.ready).toBe(false);
    expect(s.checks.mongo.ok).toBe(false);
    expect(s.checks.broker.ok).toBe(false);
    expect(s.checks.tickWs.ok).toBe(false);
  });

  it("returns ready=false when only Mongo is up", () => {
    mockMongoHealth.mockReturnValue({ status: "connected" });
    const s = getReadyStatus();
    expect(s.ready).toBe(false);
    expect(s.checks.mongo.ok).toBe(true);
    expect(s.checks.broker.ok).toBe(false);
    expect(s.checks.tickWs.ok).toBe(false);
  });

  it("returns ready=false when broker is up but Mongo is reconnecting", () => {
    mockMongoHealth.mockReturnValue({ status: "connecting" });
    markReady("broker");
    markReady("tickWs");
    const s = getReadyStatus();
    expect(s.ready).toBe(false);
    expect(s.checks.mongo.ok).toBe(false);
    expect(s.checks.mongo.status).toBe("connecting");
  });

  it("returns ready=true when every dependency is green", () => {
    mockMongoHealth.mockReturnValue({ status: "connected" });
    markReady("broker");
    markReady("tickWs");
    const s = getReadyStatus();
    expect(s.ready).toBe(true);
    expect(s.checks.mongo.ok).toBe(true);
    expect(s.checks.broker.ok).toBe(true);
    expect(s.checks.tickWs.ok).toBe(true);
  });

  it("flips back to not-ready when a module marks itself down", () => {
    mockMongoHealth.mockReturnValue({ status: "connected" });
    markReady("broker");
    markReady("tickWs");
    expect(getReadyStatus().ready).toBe(true);

    markNotReady("broker");
    const s = getReadyStatus();
    expect(s.ready).toBe(false);
    expect(s.checks.broker.ok).toBe(false);
  });

  it("response body shape matches what start-all.bat / kube probes consume", () => {
    mockMongoHealth.mockReturnValue({ status: "connected" });
    markReady("broker");
    markReady("tickWs");
    const s = getReadyStatus();
    expect(s).toMatchObject({
      ready: true,
      checks: {
        mongo: { ok: true, status: "connected" },
        broker: { ok: true },
        tickWs: { ok: true },
      },
    });
  });
});
