/**
 * Shared agent-aware logger — pino under the hood.
 *
 * Format examples:
 *   dev (pino-pretty):
 *     [10:15:23.456] INFO  (PA:TickHandler) [req=a3f1c2b9 trade=t-281]: Started — listening for ticks
 *   prod (raw JSON, ready for Loki / Datadog / etc.):
 *     {"level":30,"time":...,"agent":"PA","module":"TickHandler","requestId":"a3f1c2b9","tradeId":"t-281","msg":"Started — listening for ticks"}
 *
 * Goals (preserved from the prior hand-rolled formatter):
 *   1. The agent prefix (BSA / PA / TEA / RCA / DE / BOOT) is *visible* —
 *      so log readers can trace flow across agent boundaries.
 *   2. Structured: every line is JSON in prod; pretty-printed in dev.
 *   3. Correlation: every line carries `requestId` (and `tradeId` /
 *      `signalId` when in scope) via AsyncLocalStorage — see
 *      `server/_core/correlationContext.ts`.
 *
 * Usage (unchanged from the previous implementation):
 *   const log = createLogger("PA", "TickHandler");
 *   const log = createLogger("TEA", "Executor");
 *   const log = createLogger("BSA", "Dhan");
 *
 * Legacy single-argument calls (`createLogger("Dhan")`) default to agent=BSA.
 */
import pino, { type Logger as PinoLogger } from "pino";
import { getCorrelationFields } from "../_core/correlationContext";

// ─── Types ─────────────────────────────────────────────────────

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

const KNOWN_AGENTS: ReadonlyArray<AgentCode> = ["BSA", "PA", "TEA", "RCA", "DE", "BOOT"];

function isKnownAgent(s: string): s is AgentCode {
  return (KNOWN_AGENTS as readonly string[]).includes(s);
}

// ─── Pino root ─────────────────────────────────────────────────

/**
 * Whether to use pino-pretty for human-readable colored output. Auto-on
 * when stdout is a TTY and we're not in production; can be forced off
 * with `LOG_PRETTY=false` (e.g. when piping into a JSON log shipper in
 * a dev container).
 */
const usePretty =
  process.env.LOG_PRETTY === "false"
    ? false
    : process.env.NODE_ENV !== "production" && process.stdout?.isTTY === true;

const root: PinoLogger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: undefined, // strip pid/hostname; agent+module is enough
  // mixin is invoked on every emit and merged into the log object — this
  // is where AsyncLocalStorage correlation IDs land.
  mixin: () => getCorrelationFields(),
  ...(usePretty
    ? {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:HH:MM:ss.l",
            messageFormat: "({agent}:{module}) {msg}",
            // agent + module are already rendered in messageFormat; suppress
            // the data-field dump below each line so each log entry is one row.
            ignore: "pid,hostname,agent,module",
          },
        },
      }
    : {}),
});

// ─── Factory ───────────────────────────────────────────────────

/**
 * Create a logger. Returns a thin adapter over a pino child so the call
 * surface (debug / info / warn / error / important) matches the prior
 * hand-rolled API verbatim.
 *
 *   createLogger("PA", "TickHandler") → child{ agent:"PA", module:"TickHandler" }
 *   createLogger("TEA", "Executor")   → child{ agent:"TEA", module:"Executor" }
 *   createLogger("BSA", "Dhan")       → child{ agent:"BSA", module:"Dhan" }
 *
 * Legacy single-arg form defaults agent=BSA for backward compat:
 *   createLogger("Mock")  → child{ agent:"BSA", module:"Mock" }
 */
export function createLogger(agentOrModule: string, module?: string): Logger {
  let agent: AgentCode;
  let mod: string;
  if (module === undefined) {
    agent = "BSA";
    mod = agentOrModule;
  } else {
    agent = isKnownAgent(agentOrModule) ? agentOrModule : "BSA";
    mod = module;
  }

  const child = root.child({ agent, module: mod });

  // Pino accepts an object as the first arg and a message as the second;
  // wrapper expects (msg, ...args) with `args` being arbitrary positional
  // values that the prior shim spread into console.* . Stash them under
  // `args` so they survive the JSON pipeline.
  function emit(level: "debug" | "info" | "warn" | "error", msg: string, args: unknown[]): void {
    if (args.length === 0) {
      child[level](msg);
    } else {
      // Coalesce a single Error arg into a real pino `err` field so
      // pino-pretty / log shippers serialize stack traces properly.
      if (args.length === 1 && args[0] instanceof Error) {
        child[level]({ err: args[0] }, msg);
      } else {
        child[level]({ args }, msg);
      }
    }
  }

  return {
    debug:     (msg, ...args) => emit("debug", msg, args),
    info:      (msg, ...args) => emit("info",  msg, args),
    warn:      (msg, ...args) => emit("warn",  msg, args),
    error:     (msg, ...args) => emit("error", msg, args),
    important: (msg, ...args) => emit("info",  `${msg} 🥂`, args),
  };
}

// ─── Boot legend ───────────────────────────────────────────────

/** Human description shown in the boot legend. */
const AGENT_DESCRIPTIONS: Record<AgentCode, string> = {
  BSA:  "Broker Service Agent — adapter routing, broker WS, kill switches",
  PA:   "Portfolio Agent — capital, positions, drawdown, audit log",
  TEA:  "Trade Executor Agent — single execution gateway",
  RCA:  "Risk Control Agent — open-position monitor, exit triggers",
  DE:   "Discipline Agent — pre-trade gate, cooldowns, circuit breaker",
  BOOT: "Server Boot — Express + tRPC bootstrap, MongoDB, lifecycle",
};

/**
 * Print the agent legend at boot. Goes through the root pino logger so
 * the legend lines are themselves structured (queryable for "show me
 * everything from agent X").
 */
export function printAgentLegend(): void {
  const legend = root.child({ agent: "BOOT", module: "Legend" });
  legend.info("── Agent Legend ──");
  for (const code of KNOWN_AGENTS) {
    legend.info(`  ${code.padEnd(4)}  ${AGENT_DESCRIPTIONS[code]}`);
  }
}

// ─── Test/internal hooks ───────────────────────────────────────

/**
 * Exported for unit tests so they can spy on / replace pino streams
 * without going through `createLogger`. Not intended for production code.
 */
export const _rootLoggerForTests: PinoLogger = root;
