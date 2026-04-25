/**
 * Idempotency store for the Trade Executor Agent.
 *
 * Spec §3 rule 2: "Idempotent Always — Never double-execute (use execution IDs)".
 *
 * Phase 1: in-memory only. Records expire after 24h, which is well beyond
 * the longest expected trade lifecycle. A server restart drops the store —
 * acceptable while the system is dev-only. Phase 2 will persist records to
 * MongoDB so we survive process restarts and can recover stuck partials.
 */

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

class IdempotencyStore {
  private records = new Map<string, ExecutionRecord>();

  /**
   * Reserve an executionId. Returns the existing record if the id has been
   * seen before (caller should short-circuit and replay the cached result),
   * or null if the id is new and now claimed.
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
    return null;
  }

  /** Mark the execution as completed and cache its result for replay. */
  complete<T>(executionId: string, result: T): void {
    const record = this.records.get(executionId);
    if (!record) return;
    record.status = "completed";
    record.result = result;
    record.completedAt = Date.now();
  }

  /** Mark the execution as failed; future replays return the same error. */
  fail(executionId: string, error: string): void {
    const record = this.records.get(executionId);
    if (!record) return;
    record.status = "failed";
    record.error = error;
    record.completedAt = Date.now();
  }

  /** Test / dev hook — clears the store. */
  reset(): void {
    this.records.clear();
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
