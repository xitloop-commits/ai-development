/**
 * BSA Shared Logger
 *
 * Provides a consistent log format across all BSA modules:
 *
 *   2026-04-11 10:15:23.456 [INFO ] [BSA:Service] All adapters initialised.
 *   2026-04-11 10:15:23.457 [WARN ] [BSA:Dhan] No access token configured.
 *   2026-04-11 10:15:23.458 [ERROR] [BSA:DhanWS] Connection refused
 *
 * Each module's entire log line is tinted with a unique color.
 * The level indicator always uses its own conventional color:
 *   DEBUG → dim gray   INFO → green   WARN → yellow   ERROR → red
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

/** Level indicator colors — always consistent regardless of module. */
const LEVEL_COLOR: Record<Level, string> = {
  DEBUG: "\x1b[90m",  // dim gray
  INFO:  "\x1b[32m",  // green
  WARN:  "\x1b[33m",  // yellow
  ERROR: "\x1b[31m",  // red
};

const BOLD  = "\x1b[1m";
const RESET = "\x1b[0m";

/**
 * Unique line-tint color per module.
 * Every character of the log line (except the level indicator) appears in this color.
 * Modules not listed here fall back to the color pool below.
 */
const MODULE_COLORS: Record<string, string> = {
  Service:     "\x1b[36m",         // cyan
  Config:      "\x1b[35m",         // magenta
  REST:        "\x1b[34m",         // blue
  Router:      "\x1b[94m",         // bright blue
  Dhan:        "\x1b[96m",         // bright cyan
  DhanAuth:    "\x1b[95m",         // bright magenta
  DhanWS:      "\x1b[93m",         // bright yellow
  DhanOrderWS: "\x1b[91m",         // bright red
  ScripMaster: "\x1b[92m",         // bright green
  SubManager:  "\x1b[97m",         // bright white
  Mock:        "\x1b[37m",         // light gray
  TickWS:      "\x1b[38;5;208m",   // orange
};

/** Fallback color pool for dynamically-named modules. */
const COLOR_POOL = Object.values(MODULE_COLORS);
const _dynamicColorMap = new Map<string, string>();

function getModuleColor(module: string): string {
  if (MODULE_COLORS[module]) return MODULE_COLORS[module];
  if (!_dynamicColorMap.has(module)) {
    _dynamicColorMap.set(module, COLOR_POOL[_dynamicColorMap.size % COLOR_POOL.length]);
  }
  return _dynamicColorMap.get(module)!;
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
  function emit(level: Level, msg: string, args: unknown[]): void {
    let line: string;

    if (USE_COLOR) {
      const mc  = getModuleColor(module);
      const lc  = LEVEL_COLOR[level];
      // Level indicator: level color → reset → back to module color
      const lvl = `${lc}${level.padEnd(5)}${RESET}${mc}`;
      // Module tag: bold → reset → back to module color
      const tag = `${BOLD}BSA:${module}${RESET}${mc}`;
      // Full line in module color; level indicator temporarily overrides it
      line = `${mc}${ts()} [${lvl}] [${tag}] ${msg}${RESET}`;
    } else {
      line = `${ts()} [${level.padEnd(5)}] [BSA:${module}] ${msg}`;
    }

    const fn = level === "ERROR"
      ? console.error
      : level === "WARN"
        ? console.warn
        : console.log;

    args.length > 0 ? fn(line, ...args) : fn(line);
  }

  return {
    debug: (msg, ...args) => emit("DEBUG", msg, args),
    info:  (msg, ...args) => emit("INFO",  msg, args),
    warn:  (msg, ...args) => emit("WARN",  msg, args),
    error: (msg, ...args) => emit("ERROR", msg, args),
  };
}
