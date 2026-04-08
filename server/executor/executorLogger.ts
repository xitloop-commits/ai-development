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
  const line = `${LOG_PREFIX} ${JSON.stringify(entry)}\n`;
  fs.appendFileSync(LOG_FILE, line, 'utf8');
  if (level === 'error' || level === 'warn') {
    // Also print to stderr
    console.error(line);
  } else {
    console.log(line);
  }
}

// Usage examples:
// logExecutor('debug', 'Received trade', { executionId, details: trade });
// logExecutor('info', 'Order placed', { executionId, orderId, details: order });
// logExecutor('error', 'Order failed', { executionId, error });
