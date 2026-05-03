/**
 * Idempotency store for the Trade Executor Agent.
 *
 * Spec §3 rule 2: "Idempotent Always — Never double-execute (use execution IDs)".
 *
 * Phase 2: writes through to MongoDB so executor_executions survives a
 * server restart. Mongo is the durable source; the in-memory map is a
 * read cache for the hot path (TEA submitTrade calls reserve() before
 * every broker handoff).
 *
 * Boot sequence:
 *   1. server connects to MongoDB
 *   2. tradeExecutor.start() calls idempotencyStore.loadFromMongo()
 *      to hydrate recent (< 24 h) records back into the in-memory cache
 *   3. submitTrade / modifyOrder / exitTrade run as before
 *
 * Records older than 24 h are auto-pruned by a TTL index on createdAt.
 */

import mongoose, { Schema } from "mongoose";
import { createLogger } from "../broker/logger";

const log = createLogger("TEA", "Idempotency");

const TTL_MS = 24 * 60 * 60 * 1000;

export type ExecutionStatus = "in_progress" | "completed" | "failed";

export interface ExecutionRecord<TResult = unknown> {
  executionId: string;
  status: ExecutionStatus;
  result?: TResult;
  error?: string;
  createdAt: number;
  completedAt?: number;
}

// ─── Mongoose model ─────────────────────────────────────────────

const executionRecordSchema = new Schema(
  {
    executionId: { type: String, required: true, unique: true },
    status: { type: String, required: true, default: "in_progress" },
    result: { type: Schema.Types.Mixed, default: null },
    error: { type: String, default: null },
    createdAt: { type: Date, required: true, default: () => new Date(), expires: TTL_MS / 1000 },
    completedAt: { type: Date, default: null },
  },
  { timestamps: false, collection: "executor_executions" },
);

export const ExecutionRecordModel = mongoose.model("ExecutionRecord", executionRecordSchema);

// ─── Store ──────────────────────────────────────────────────────

class IdempotencyStore {
  private records = new Map<string, ExecutionRecord>();

  /**
   * Reserve an executionId. Returns the existing record if the id has been
   * seen before (caller should short-circuit and replay the cached result),
   * or null if the id is new and now claimed.
   *
   * Memory cache is the primary lookup; Mongo writes are fire-and-forget
   * for durability. Boot-time loadFromMongo() seeds the cache.
   */
  reserve<T>(executionId: string): ExecutionRecord<T> | null {
    this.cleanup();
    const existing = this.records.get(executionId);
    if (existing) return existing as ExecutionRecord<T>;

    const record: ExecutionRecord<T> = {
      executionId,
      status: "in_progress",
      createdAt: Date.now(),
    };
    this.records.set(executionId, record as ExecutionRecord);
    this.persistAsync(record);
    return null;
  }

  /** Mark the execution as completed and cache its result for replay. */
  complete<T>(executionId: string, result: T): void {
    const record = this.records.get(executionId);
    if (!record) return;
    record.status = "completed";
    record.result = result;
    record.completedAt = Date.now();
    this.persistAsync(record);
  }

  /** Mark the execution as failed; future replays return the same error. */
  fail(executionId: string, error: string): void {
    const record = this.records.get(executionId);
    if (!record) return;
    record.status = "failed";
    record.error = error;
    record.completedAt = Date.now();
    this.persistAsync(record);
  }

  /**
   * Hydrate the in-memory cache with recent records from Mongo. Called
   * once at server boot from tradeExecutor.start(). Skips silently if
   * Mongo is unreachable so the executor can still run with in-memory
   * dedup.
   */
  async loadFromMongo(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - TTL_MS);
      const docs = await ExecutionRecordModel.find({ createdAt: { $gte: cutoff } }).lean();
      for (const d of docs) {
        const rec: ExecutionRecord = {
          executionId: d.executionId,
          status: d.status as ExecutionStatus,
          result: d.result ?? undefined,
          error: d.error ?? undefined,
          createdAt: d.createdAt instanceof Date ? d.createdAt.getTime() : Number(d.createdAt),
          completedAt: d.completedAt ? (d.completedAt instanceof Date ? d.completedAt.getTime() : Number(d.completedAt)) : undefined,
        };
        this.records.set(rec.executionId, rec);
      }
      log.info(`hydrated ${docs.length} records from MongoDB`);
    } catch (err: any) {
      log.warn(`loadFromMongo failed (continuing in-memory only): ${err?.message ?? err}`);
    }
  }

  /** Test / dev hook — clears the in-memory store. Mongo unaffected. */
  reset(): void {
    this.records.clear();
  }

  /**
   * Fire-and-forget upsert to Mongo. Failures are logged but not
   * propagated — the in-memory store still serves correctly within
   * the current process.
   */
  private persistAsync(record: ExecutionRecord): void {
    ExecutionRecordModel.updateOne(
      { executionId: record.executionId },
      {
        $set: {
          status: record.status,
          result: record.result ?? null,
          error: record.error ?? null,
          completedAt: record.completedAt ? new Date(record.completedAt) : null,
        },
        $setOnInsert: {
          executionId: record.executionId,
          createdAt: new Date(record.createdAt),
        },
      },
      { upsert: true },
    ).catch((err: any) => {
      log.warn(`persist ${record.executionId} failed: ${err?.message ?? err}`);
    });
  }

  /** Prune records older than TTL. Called opportunistically on each reserve(). */
  private cleanup(): void {
    const now = Date.now();
    const expired: string[] = [];
    this.records.forEach((rec, id) => {
      if (now - rec.createdAt > TTL_MS) expired.push(id);
    });
    expired.forEach((id) => this.records.delete(id));
  }
}

export const idempotencyStore = new IdempotencyStore();
