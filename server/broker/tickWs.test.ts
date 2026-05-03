/**
 * F1 — slow-client cutoff.
 *
 * `sendToAllClients` must close any OPEN client whose outbound buffer is
 * over 1 MB with code 1011 ("server error / try again"). Healthy clients
 * keep receiving the message, so a single backed-up tab doesn't stall the
 * whole tick fanout.
 */
import { describe, it, expect, vi } from "vitest";
import { WebSocket } from "ws";
import { sendToAllClients } from "./tickWs";

function fakeClient(opts: { bufferedAmount: number; readyState?: number }) {
  return {
    readyState: opts.readyState ?? WebSocket.OPEN,
    bufferedAmount: opts.bufferedAmount,
    send: vi.fn(),
    close: vi.fn(),
  };
}

describe("tickWs / sendToAllClients", () => {
  it("closes a slow client (bufferedAmount > 1MB) with code 1011 and skips its send", () => {
    const slow = fakeClient({ bufferedAmount: 2_000_000 });
    const wss = { clients: new Set([slow]) } as any;

    const dropped = sendToAllClients(wss, "ping");

    expect(dropped).toBe(1);
    expect(slow.close).toHaveBeenCalledWith(1011, "slow-client");
    expect(slow.send).not.toHaveBeenCalled();
  });

  it("does not close a healthy client (bufferedAmount under 1MB)", () => {
    const fast = fakeClient({ bufferedAmount: 500_000 });
    const wss = { clients: new Set([fast]) } as any;

    const dropped = sendToAllClients(wss, "ping");

    expect(dropped).toBe(0);
    expect(fast.close).not.toHaveBeenCalled();
    expect(fast.send).toHaveBeenCalledWith("ping");
  });

  it("drops only the slow client when fast and slow are mixed", () => {
    const slow = fakeClient({ bufferedAmount: 5_000_000 });
    const fast1 = fakeClient({ bufferedAmount: 0 });
    const fast2 = fakeClient({ bufferedAmount: 100 });
    const wss = { clients: new Set([slow, fast1, fast2]) } as any;

    const dropped = sendToAllClients(wss, "ping");

    expect(dropped).toBe(1);
    expect(slow.close).toHaveBeenCalledWith(1011, "slow-client");
    expect(fast1.send).toHaveBeenCalledWith("ping");
    expect(fast2.send).toHaveBeenCalledWith("ping");
  });

  it("returns early without iterating when there are no clients", () => {
    const wss = { clients: new Set() } as any;
    expect(sendToAllClients(wss, "ping")).toBe(0);
  });

  it("ignores clients that are not OPEN", () => {
    const closing = fakeClient({ bufferedAmount: 0, readyState: WebSocket.CLOSING });
    const wss = { clients: new Set([closing]) } as any;

    sendToAllClients(wss, "ping");

    expect(closing.send).not.toHaveBeenCalled();
    expect(closing.close).not.toHaveBeenCalled();
  });
});
