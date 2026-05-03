/**
 * G3 — vitest setup: per-file in-memory MongoDB.
 *
 * Wired into `vitest.config.ts` via `setupFiles`. For every test file,
 * boots a `mongodb-memory-server` process, sets `process.env.MONGODB_URI`
 * to its URL, and connects mongoose. Tears everything down after the
 * file's tests finish so subsequent files start clean.
 *
 * Why per-file (not global): each test file gets its own DB so parallel
 * test workers can't trample each other's data. Boot cost amortises
 * across many tests in a file (most files have 5+ tests).
 *
 * Why this exists at all: pre-G3, every Mongo-touching test pointed at
 * the developer's real MONGODB_URI (or "" if unset, in which case the
 * test silently no-op'd via `connectMongo`'s null-URI guard). That made
 * the tests dependent on machine state and forced `fileParallelism:
 * false` to avoid collisions.
 */
import { beforeAll, afterAll } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

let server: MongoMemoryServer | null = null;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  process.env.MONGODB_URI = server.getUri();
  // Some test suites call `connectMongo()`; others import models directly
  // (which uses the default mongoose connection). Connect here so model
  // operations work either way.
  await mongoose.connect(process.env.MONGODB_URI);
}, 60_000); // first run downloads the Mongo binary; allow up to a minute

afterAll(async () => {
  await mongoose.disconnect().catch(() => { /* best-effort */ });
  if (server) {
    await server.stop().catch(() => { /* best-effort */ });
    server = null;
  }
});
