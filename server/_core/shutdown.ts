/**
 * Centralised graceful-shutdown coordinator (B5).
 *
 * Long-lived modules register a hook here; on SIGINT/SIGTERM (or an
 * uncaughtException calling runShutdown directly) the hooks fire in
 * priority order — low priorities first (stop accepting new work),
 * high priorities last (mongo disconnect, final flush).
 *
 * Conventions:
 *   <  100  reserved (refuse new work, flip kill switches)
 *     100  agents flushing in-flight work (tradeExecutor, portfolioAgent)
 *     200  idempotency / persistent queues
 *     500  WS connections (tickWs, broker adapter WS)
 *    1000  mongo (last — agents may still be writing at 500)
 *
 * Each hook runs against a 5s per-hook budget. Total shutdown budget
 * is 15s (covers 3 sequential 5s slips). After that we force exit.
 *
 * Idempotent: a second SIGINT during shutdown is logged + ignored.
 */
import { createLogger } from "../broker/logger";

const log = createLogger("BOOT", "Shutdown");

const HOOK_TIMEOUT_MS = 5_000;
const TOTAL_BUDGET_MS = 15_000;

interface Hook {
  name: string;
  priority: number;
  fn: () => Promise<void> | void;
}

const hooks: Hook[] = [];
let shuttingDown = false;
let signalHandlersInstalled = false;

export function registerShutdownHook(
  name: string,
  fn: () => Promise<void> | void,
  priority = 100,
): void {
  if (hooks.some((h) => h.name === name)) {
    log.warn(`Shutdown hook "${name}" registered twice — replacing.`);
    const idx = hooks.findIndex((h) => h.name === name);
    hooks.splice(idx, 1);
  }
  hooks.push({ name, fn, priority });
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`hook "${label}" timed out after ${ms}ms`)), ms);
    if (typeof t.unref === "function") t.unref();
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/**
 * Run every registered hook in priority order. Resolves when all hooks
 * have finished (or timed out). Idempotent — second call returns the
 * same in-flight promise.
 */
let inFlight: Promise<void> | null = null;
export function runShutdown(reason: string): Promise<void> {
  if (inFlight) return inFlight;
  shuttingDown = true;
  log.important(`Graceful shutdown initiated: ${reason}`);

  inFlight = (async () => {
    const ordered = [...hooks].sort((a, b) => a.priority - b.priority);
    const overall = setTimeout(() => {
      log.error(`Shutdown total budget (${TOTAL_BUDGET_MS}ms) exceeded — forcing exit(1)`);
      process.exit(1);
    }, TOTAL_BUDGET_MS);
    if (typeof overall.unref === "function") overall.unref();

    for (const hook of ordered) {
      const start = Date.now();
      try {
        const result = hook.fn();
        if (result instanceof Promise) {
          await withTimeout(result, HOOK_TIMEOUT_MS, hook.name);
        }
        log.info(`✓ ${hook.name} (${Date.now() - start}ms, prio ${hook.priority})`);
      } catch (err) {
        log.error(`✗ ${hook.name} failed: ${(err as Error).message}`);
        // Continue with remaining hooks — do not let one bad hook block mongo.
      }
    }
    clearTimeout(overall);
    log.important("Graceful shutdown complete");
  })();
  return inFlight;
}

/** Has shutdown begun? Modules can short-circuit new work when true. */
export function isShuttingDown(): boolean {
  return shuttingDown;
}

/**
 * Install SIGINT + SIGTERM handlers. Called once at boot. Idempotent.
 */
export function installSignalHandlers(): void {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;

  const onSignal = (sig: "SIGINT" | "SIGTERM") => {
    if (shuttingDown) {
      log.warn(`Received ${sig} while already shutting down — ignoring.`);
      return;
    }
    void runShutdown(sig).then(() => process.exit(0));
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
}

/** Test-only — clear hooks and reset state. */
export function _resetShutdownForTesting(): void {
  hooks.length = 0;
  shuttingDown = false;
  inFlight = null;
}

/** Test-only — peek at registered hook count + ordering. */
export function _getHooksForTesting(): ReadonlyArray<Hook> {
  return [...hooks].sort((a, b) => a.priority - b.priority);
}
