/**
 * Shared agent-aware logger.
 *
 * Format:
 *   2026-04-25 10:15:23.456 [INFO ] [PA:TickHandler] Started — listening for ticks
 *   2026-04-25 10:15:23.500 [INFO ] [TEA:SeaBridge] placed LONG_CE BANKNIFTY signal=...
 *   2026-04-25 10:15:23.700 [INFO ] [BSA:Mock] Connected (paper trading mode)
 *
 * Goals:
 *   1. The agent prefix (BSA / PA / TEA / RCA / DE / BOOT) is *visible* —
 *      so log readers can trace flow across agent boundaries: e.g.
 *      [TEA:Executor] submitTrade → [BSA:Mock] placeOrder → [PA:Agent] appendTrade.
 *   2. Each agent has a base color family. Submodule lines inherit the
 *      family; the eye can quickly group by agent.
 *   3. Server boot prints a one-line legend so the colors are
 *      self-documenting.
 *
 * Usage:
 *   const log = createLogger("PA", "TickHandler");
 *   const log = createLogger("TEA", "Executor");
 *   const log = createLogger("BSA", "Dhan");
 *
 * Legacy single-argument calls (`createLogger("Dhan")`) default to agent=BSA
 * for backward compatibility — every BSA submodule used to import this
 * file when it was BSA-private.
 */

// ─── Types ─────────────────────────────────────────────────────

type Level = "DEBUG" | "INFO" | "WARN" | "ERROR";

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info (msg: string, ...args: unknown[]): void;
  warn (msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  /**
   * Emit at INFO level with a clinking-glasses marker (🥂) at the end —
   * grep-able milestone for agent start/stop, broker connect, server up.
   * Same semantics as Homebrew's 🍺 on `brew install` success.
   */
  important(msg: string, ...args: unknown[]): void;
}

/** Short agent codes used as the prefix of every tag. */
export type AgentCode = "BSA" | "PA" | "TEA" | "RCA" | "DE" | "BOOT";

// ─── ANSI colors ───────────────────────────────────────────────

const USE_COLOR = process.stdout?.isTTY === true;

const LEVEL_COLOR: Record<Level, string> = {
  DEBUG: "\x1b[90m",  // dim gray
  INFO:  "\x1b[32m",  // green
  WARN:  "\x1b[33m",  // yellow
  ERROR: "\x1b[31m",  // red
};

const BOLD  = "\x1b[1m";
const RESET = "\x1b[0m";

/**
 * Base color per agent. Every log line from the agent (regardless of
 * submodule) is tinted in this color, so the eye can group by agent.
 */
const AGENT_COLORS: Record<AgentCode, string> = {
  BSA:  "\x1b[36m",        // cyan         — Broker Service
  PA:   "\x1b[92m",        // bright green — Portfolio Agent
  TEA:  "\x1b[38;5;208m",  // orange       — Trade Executor Agent
  RCA:  "\x1b[35m",        // magenta      — Risk Control Agent
  DE:   "\x1b[33m",        // yellow       — Discipline Agent
  BOOT: "\x1b[37m",        // light gray   — server boot / shared
};

/** Human description shown in the boot legend. */
const AGENT_DESCRIPTIONS: Record<AgentCode, string> = {
  BSA:  "Broker Service Agent — adapter routing, broker WS, kill switches",
  PA:   "Portfolio Agent — capital, positions, drawdown, audit log",
  TEA:  "Trade Executor Agent — single execution gateway",
  RCA:  "Risk Control Agent — open-position monitor, exit triggers",
  DE:   "Discipline Agent — pre-trade gate, cooldowns, circuit breaker",
  BOOT: "Server Boot — Express + tRPC bootstrap, MongoDB, lifecycle",
};

function isKnownAgent(s: string): s is AgentCode {
  return s in AGENT_COLORS;
}

// ─── Timestamp ─────────────────────────────────────────────────

function ts(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 23);
}

// ─── Factory ───────────────────────────────────────────────────

/**
 * Create a logger.
 *
 *   createLogger("PA", "TickHandler") → [PA:TickHandler]
 *   createLogger("TEA", "Executor")   → [TEA:Executor]
 *   createLogger("BSA", "Dhan")       → [BSA:Dhan]
 *
 * Legacy single-arg form defaults agent=BSA for backward compat:
 *   createLogger("Mock")  → [BSA:Mock]
 */
export function createLogger(agentOrModule: string, module?: string): Logger {
  let agent: AgentCode;
  let mod: string;
  if (module === undefined) {
    // Legacy single-arg call → assume BSA
    agent = "BSA";
    mod = agentOrModule;
  } else {
    agent = isKnownAgent(agentOrModule) ? agentOrModule : "BSA";
    mod = module;
  }
  const tagColor = AGENT_COLORS[agent];

  function emit(level: Level, msg: string, args: unknown[]): void {
    let line: string;

    if (USE_COLOR) {
      const lc  = LEVEL_COLOR[level];
      const lvl = `${lc}${level.padEnd(5)}${RESET}${tagColor}`;
      const tag = `${BOLD}${agent}:${mod}${RESET}${tagColor}`;
      line = `${tagColor}${ts()} [${lvl}] [${tag}] ${msg}${RESET}`;
    } else {
      line = `${ts()} [${level.padEnd(5)}] [${agent}:${mod}] ${msg}`;
    }

    const fn = level === "ERROR"
      ? console.error
      : level === "WARN"
        ? console.warn
        : console.log;

    args.length > 0 ? fn(line, ...args) : fn(line);
  }

  return {
    debug:     (msg, ...args) => emit("DEBUG", msg, args),
    info:      (msg, ...args) => emit("INFO",  msg, args),
    warn:      (msg, ...args) => emit("WARN",  msg, args),
    error:     (msg, ...args) => emit("ERROR", msg, args),
    important: (msg, ...args) => emit("INFO",  `${msg} 🥂`, args),
  };
}

// ─── Boot legend ───────────────────────────────────────────────

/**
 * Print the agent legend. Called once at server boot so log readers can
 * see "what does each color mean" without consulting docs.
 */
export function printAgentLegend(): void {
  const out = console.log;
  out(""); // blank spacer
  out(USE_COLOR ? `${BOLD}── Agent Legend ──${RESET}` : "── Agent Legend ──");
  for (const code of Object.keys(AGENT_COLORS) as AgentCode[]) {
    const color = AGENT_COLORS[code];
    const desc = AGENT_DESCRIPTIONS[code];
    if (USE_COLOR) {
      out(`  ${color}${BOLD}${code.padEnd(4)}${RESET}${color}  ${desc}${RESET}`);
    } else {
      out(`  ${code.padEnd(4)}  ${desc}`);
    }
  }
  out(""); // blank spacer
}
