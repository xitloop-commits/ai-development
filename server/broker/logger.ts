/**
 * BSA Shared Logger
 *
 * Provides a consistent log format across all BSA modules:
 *
 *   2026-04-11 10:15:23.456 [INFO ] [BSA:Service    ] All adapters initialised.
 *   2026-04-11 10:15:23.457 [WARN ] [BSA:Dhan       ] No access token configured.
 *   2026-04-11 10:15:23.458 [ERROR] [BSA:DhanWS     ] Connection refused
 *
 * Usage:
 *   import { createLogger } from "../logger";
 *   const log = createLogger("Dhan");
 *   log.info("Order placed: ORD-12345");
 *   log.warn("Token expiring soon");
 *   log.error("Connection refused", err);
 *
 * Module names used across BSA:
 *   Service      — brokerService.ts
 *   Config       — brokerConfig.ts
 *   REST         — brokerRoutes.ts  (Express REST endpoints for Python)
 *   Router       — brokerRouter.ts  (tRPC procedures for frontend)
 *   Dhan         — adapters/dhan/index.ts
 *   DhanAuth     — adapters/dhan/auth.ts
 *   DhanWS       — adapters/dhan/websocket.ts  (market feed)
 *   DhanOrderWS  — adapters/dhan/orderUpdateWs.ts
 *   ScripMaster  — adapters/dhan/scripMaster.ts
 *   SubManager   — adapters/dhan/subscriptionManager.ts
 *   Mock         — adapters/mock/index.ts
 *   TickWS       — tickWs.ts
 */

// ─── Types ─────────────────────────────────────────────────────

type Level = "DEBUG" | "INFO" | "WARN" | "ERROR";

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info (msg: string, ...args: unknown[]): void;
  warn (msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

// ─── ANSI colors (only when stdout is a real terminal) ─────────

const USE_COLOR = process.stdout?.isTTY === true;

const C = {
  DEBUG: "\x1b[90m",   // dim gray
  INFO:  "\x1b[32m",   // green
  WARN:  "\x1b[33m",   // yellow
  ERROR: "\x1b[31m",   // red
  BOLD:  "\x1b[1m",
  RESET: "\x1b[0m",
};

function color(level: Level, s: string): string {
  return USE_COLOR ? `${C[level]}${s}${C.RESET}` : s;
}

function bold(s: string): string {
  return USE_COLOR ? `${C.BOLD}${s}${C.RESET}` : s;
}

// ─── Timestamp ─────────────────────────────────────────────────

function ts(): string {
  // e.g. "2026-04-11 10:15:23.456"
  return new Date().toISOString().replace("T", " ").slice(0, 23);
}

// ─── Factory ───────────────────────────────────────────────────

/**
 * Creates a logger for a named BSA module.
 *
 * @param module - Short module name, e.g. "Dhan", "DhanWS", "Service"
 */
export function createLogger(module: string): Logger {
  // Pad level to 5 chars so columns align: "DEBUG", "INFO ", "WARN ", "ERROR"
  function emit(level: Level, msg: string, args: unknown[]): void {
    const lvl  = color(level, level.padEnd(5));
    const tag  = bold(`BSA:${module}`);
    const line = `${ts()} [${lvl}] [${tag}] ${msg}`;

    const fn = level === "ERROR"
      ? console.error
      : level === "WARN"
        ? console.warn
        : console.log;

    if (args.length > 0) {
      fn(line, ...args);
    } else {
      fn(line);
    }
  }

  return {
    debug: (msg, ...args) => emit("DEBUG", msg, args),
    info:  (msg, ...args) => emit("INFO",  msg, args),
    warn:  (msg, ...args) => emit("WARN",  msg, args),
    error: (msg, ...args) => emit("ERROR", msg, args),
  };
}
