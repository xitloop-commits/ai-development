/**
 * AlertModel + purge integration tests.
 *
 * Hits the actual Mongo schema (via mongodb-memory-server from the global
 * setup) — no router-context mocking. Covers the four operations the
 * client will need (push / list / markAllRead / purge) plus the boundary
 * conditions of the 30-day retention window.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { AlertModel } from "./alertModel";

const DAY_MS = 86_400_000;

async function insert(timestamp: number, overrides: Partial<{ readAt: number | null }> = {}) {
  return AlertModel.create({
    type: "go_signal",
    priority: "medium",
    title: "test",
    message: "test message",
    timestamp,
    readAt: overrides.readAt ?? null,
  });
}

describe("AlertModel — CRUD + retention", () => {
  beforeEach(async () => {
    await AlertModel.deleteMany({});
  });

  it("inserts and reads back in descending timestamp order", async () => {
    await insert(1000);
    await insert(3000);
    await insert(2000);
    const docs = await AlertModel.find({}).sort({ timestamp: -1 }).lean();
    expect(docs.map((d) => d.timestamp)).toEqual([3000, 2000, 1000]);
  });

  it("list `since` filter only returns alerts strictly newer than the cutoff", async () => {
    await insert(1000);
    await insert(2000);
    await insert(3000);
    const docs = await AlertModel.find({ timestamp: { $gt: 2000 } })
      .sort({ timestamp: -1 })
      .lean();
    expect(docs.map((d) => d.timestamp)).toEqual([3000]);
  });

  it("markAllRead stamps only previously-unread rows", async () => {
    const now = Date.now();
    await insert(now, { readAt: now - 1000 }); // already read
    await insert(now); // unread
    await insert(now); // unread

    const result = await AlertModel.updateMany({ readAt: null }, { $set: { readAt: now } });
    expect(result.modifiedCount).toBe(2);

    const stillUnread = await AlertModel.countDocuments({ readAt: null });
    expect(stillUnread).toBe(0);
  });

  it("purge cutoff deletes alerts older than 30 days, keeps the rest", async () => {
    const now = Date.now();
    await insert(now - 31 * DAY_MS);  // old — should purge
    await insert(now - 60 * DAY_MS);  // very old — should purge
    await insert(now - 29 * DAY_MS);  // boundary — keep
    await insert(now - DAY_MS);       // recent — keep
    await insert(now);                // now — keep

    const cutoff = now - 30 * DAY_MS;
    const result = await AlertModel.deleteMany({ timestamp: { $lt: cutoff } });
    expect(result.deletedCount).toBe(2);

    const remaining = await AlertModel.find({}).sort({ timestamp: 1 }).lean();
    expect(remaining).toHaveLength(3);
    expect(remaining[0].timestamp).toBeGreaterThanOrEqual(cutoff);
  });

  it("purge on an empty collection is a no-op (deletedCount = 0)", async () => {
    const cutoff = Date.now() - 30 * DAY_MS;
    const result = await AlertModel.deleteMany({ timestamp: { $lt: cutoff } });
    expect(result.deletedCount).toBe(0);
  });
});
