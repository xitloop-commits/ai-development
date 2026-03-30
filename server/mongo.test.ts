import { describe, expect, it, afterAll } from "vitest";
import mongoose from "mongoose";

/**
 * MongoDB Feature 1 Tests
 *
 * These tests validate:
 * 1. MONGODB_URI env var is set
 * 2. Connection to MongoDB Atlas succeeds
 * 3. Ping (admin command) works
 * 4. Basic CRUD operations work
 * 5. Health check returns correct shape
 */

// ─── Test 1: Environment Variable ────────────────────────────────
describe("MongoDB Environment", () => {
  it("MONGODB_URI is set", () => {
    const uri = process.env.MONGODB_URI;
    expect(uri).toBeDefined();
    expect(uri).not.toBe("");
    expect(uri).toContain("mongodb");
  });
});

// ─── Test 2-5: Connection, Ping, CRUD, Health ────────────────────
describe("MongoDB Connection & Operations", () => {
  afterAll(async () => {
    // Clean up test collection and disconnect
    try {
      if (mongoose.connection.readyState === 1) {
        await mongoose.connection.db!.collection("_test_feature1").drop();
      }
    } catch {
      // collection may not exist, that's fine
    }
    await mongoose.disconnect();
  });

  it("connects to MongoDB Atlas", async () => {
    const uri = process.env.MONGODB_URI!;
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
    });
    expect(mongoose.connection.readyState).toBe(1);
  }, 15000);

  it("pings the database", async () => {
    const result = await mongoose.connection.db!.admin().ping();
    expect(result).toBeDefined();
    expect(result.ok).toBe(1);
  }, 10000);

  it("performs basic CRUD operations", async () => {
    const collection = mongoose.connection.db!.collection("_test_feature1");

    // Create
    const insertResult = await collection.insertOne({
      key: "test_key",
      value: "hello_mongodb",
      timestamp: new Date(),
    });
    expect(insertResult.acknowledged).toBe(true);
    expect(insertResult.insertedId).toBeDefined();

    // Read
    const doc = await collection.findOne({ key: "test_key" });
    expect(doc).not.toBeNull();
    expect(doc!.value).toBe("hello_mongodb");

    // Update
    const updateResult = await collection.updateOne(
      { key: "test_key" },
      { $set: { value: "updated_value" } }
    );
    expect(updateResult.modifiedCount).toBe(1);

    const updatedDoc = await collection.findOne({ key: "test_key" });
    expect(updatedDoc!.value).toBe("updated_value");

    // Delete
    const deleteResult = await collection.deleteOne({ key: "test_key" });
    expect(deleteResult.deletedCount).toBe(1);

    const deletedDoc = await collection.findOne({ key: "test_key" });
    expect(deletedDoc).toBeNull();
  }, 15000);

  it("getMongoHealth returns correct shape when connected", async () => {
    // Import after connection is established
    const { getMongoHealth } = await import("./mongo");
    const health = getMongoHealth();

    expect(health).toHaveProperty("status");
    expect(health).toHaveProperty("database");
    expect(health).toHaveProperty("host");
    expect(health).toHaveProperty("readyState");
    expect(health).toHaveProperty("error");
    expect(health.status).toBe("connected");
    expect(health.readyState).toBe(1);
    expect(health.database).toBeTruthy();
  });

  it("pingMongo returns latency > 0 when connected", async () => {
    const { pingMongo } = await import("./mongo");
    const latency = await pingMongo();
    expect(latency).toBeGreaterThan(0);
    expect(latency).toBeLessThan(5000); // should be well under 5s
  }, 10000);
});
