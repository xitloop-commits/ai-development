import mongoose from "mongoose";
import { createLogger } from "./broker/logger";

const log = createLogger("BOOT", "MongoDB");

// ─── Configuration ───────────────────────────────────────────────
const MONGODB_URI = process.env.MONGODB_URI ?? "";
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

// ─── Connection State ────────────────────────────────────────────
let isConnecting = false;
let connectionError: string | null = null;

/**
 * Connect to MongoDB with retry logic.
 * Safe to call multiple times — will no-op if already connected/connecting.
 */
export async function connectMongo(): Promise<void> {
  if (mongoose.connection.readyState === 1) return; // already connected
  if (isConnecting) return; // connection in progress

  if (!MONGODB_URI) {
    connectionError = "MONGODB_URI environment variable is not set";
    log.error(connectionError);
    return;
  }

  isConnecting = true;
  connectionError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      log.info(`Connecting (attempt ${attempt}/${MAX_RETRIES})...`);
      await mongoose.connect(MONGODB_URI, {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 10000,
      });
      log.important(`Connected successfully to ${mongoose.connection.name}`);
      isConnecting = false;
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Attempt ${attempt} failed: ${message}`);

      if (attempt < MAX_RETRIES) {
        log.info(`Retrying in ${RETRY_DELAY_MS}ms...`);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      } else {
        connectionError = `Failed after ${MAX_RETRIES} attempts: ${message}`;
        log.error(connectionError);
      }
    }
  }

  isConnecting = false;
}

/**
 * Gracefully disconnect from MongoDB.
 */
export async function disconnectMongo(): Promise<void> {
  if (mongoose.connection.readyState === 0) return; // already disconnected
  try {
    await mongoose.disconnect();
    log.important("Disconnected");
  } catch (err) {
    log.error("Error disconnecting", err as Error);
  }
}

/**
 * Health check — returns connection status and metadata.
 */
export function getMongoHealth(): {
  status: "connected" | "connecting" | "disconnected" | "error";
  database: string | null;
  host: string | null;
  readyState: number;
  error: string | null;
} {
  const conn = mongoose.connection;
  const readyState = conn.readyState;

  let status: "connected" | "connecting" | "disconnected" | "error";
  if (readyState === 1) {
    status = "connected";
  } else if (readyState === 2 || isConnecting) {
    status = "connecting";
  } else if (connectionError) {
    status = "error";
  } else {
    status = "disconnected";
  }

  return {
    status,
    database: readyState === 1 ? conn.name : null,
    host: readyState === 1 ? (conn.host ?? null) : null,
    readyState,
    error: connectionError,
  };
}

/**
 * Ping MongoDB to verify the connection is alive.
 * Returns latency in ms, or -1 if unreachable.
 */
export async function pingMongo(): Promise<number> {
  if (mongoose.connection.readyState !== 1) return -1;

  const start = Date.now();
  try {
    await mongoose.connection.db!.admin().ping();
    return Date.now() - start;
  } catch {
    return -1;
  }
}

// ─── Mongoose Event Listeners ────────────────────────────────────
mongoose.connection.on("connected", () => {
  log.info("Connection established");
});

mongoose.connection.on("disconnected", () => {
  log.warn("Connection lost");
});

mongoose.connection.on("error", (err) => {
  log.error(`Connection error: ${err.message}`);
  connectionError = err.message;
});

// ─── Graceful Shutdown ───────────────────────────────────────────
// Mongo runs LAST in the shutdown sequence (priority 1000). Other hooks
// at lower priorities may still be flushing writes when shutdown begins.
import { registerShutdownHook } from "./_core/shutdown";
registerShutdownHook("mongo", disconnectMongo, 1000);
