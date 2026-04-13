// Trade Executor Agent Logger
// Dedicated logger for all executor debug/info/error logs

import fs from 'fs';
import path from 'path';

export type ExecutorLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ExecutorLogEntry {
  timestamp: string;
  level: ExecutorLogLevel;
  executionId?: string;
  tradeId?: string;
  orderId?: string;
  event: string;
  details?: any;
  error?: any;
}

const LOG_PREFIX = '[TradeExecutor]';
const LOG_FILE = path.join(process.cwd(), 'logs', 'trade-executor.log');

// ─── ANSI colors (only when stdout is a real terminal) ─────────

const USE_COLOR = process.stdout?.isTTY === true;

/** Level indicator colors — always consistent regardless of module. */
const LEVEL_COLOR: Record<ExecutorLogLevel, string> = {
  debug: "\x1b[90m",  // dim gray
  info:  "\x1b[32m",  // green
  warn:  "\x1b[33m",  // yellow
  error: "\x1b[31m",  // red
};

/** Unique line-tint color for the TradeExecutor module. */
const MODULE_COLOR = "\x1b[38;5;220m";  // gold
const BOLD  = "\x1b[1m";
const RESET = "\x1b[0m";

// ───────────────────────────────────────────────────────────────

function ensureLogDir() {
  const dir = path.dirname(LOG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function logExecutor(
  level: ExecutorLogLevel,
  event: string,
  meta: Partial<ExecutorLogEntry> = {}
) {
  ensureLogDir();
  const entry: ExecutorLogEntry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...meta,
  };

  // File: structured JSON (no colors)
  fs.appendFileSync(LOG_FILE, `${LOG_PREFIX} ${JSON.stringify(entry)}\n`, 'utf8');

  // Console: colored, human-readable
  const fn = (level === 'error' || level === 'warn') ? console.error : console.log;

  if (USE_COLOR) {
    const lc  = LEVEL_COLOR[level];
    // Level indicator: level color → reset → back to module color
    const lvl = `${lc}${level.toUpperCase().padEnd(5)}${RESET}${MODULE_COLOR}`;
    // Module tag: bold → reset → back to module color
    const tag = `${BOLD}TradeExecutor${RESET}${MODULE_COLOR}`;
    fn(`${MODULE_COLOR}${entry.timestamp} [${lvl}] [${tag}] ${event}${RESET}`);
  } else {
    fn(`${entry.timestamp} [${level.toUpperCase().padEnd(5)}] [TradeExecutor] ${event}`);
  }
}

// Usage examples:
// logExecutor('debug', 'Received trade', { executionId, details: trade });
// logExecutor('info', 'Order placed', { executionId, orderId, details: order });
// logExecutor('error', 'Order failed', { executionId, error });
