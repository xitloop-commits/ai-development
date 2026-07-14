/**
 * pull_candles.mjs — Phase-0 stock-spike historical puller.
 *
 * Pulls 1-min intraday OHLCV for a small liquid-large-cap universe from Dhan
 * via the running API's REST route (reuses its live token + scrip master), pages
 * the date range in <=80-day windows (under Dhan's ~90-day/call intraday cap),
 * dedupes on timestamp at window seams, and writes one CSV per stock to
 * data/research/stock_spike/candles/<symbol>_1m.csv.
 *
 * Precondition: the API server must be running with a VALID Dhan token
 * (GET /api/broker/status -> tokenStatus:"valid"). Intraday history lags ~1 day,
 * so pull up to T-2. Usage: node scripts/stock_spike/pull_candles.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const API = "http://localhost:3000/api/broker/charts/intraday";
const OUT = resolve(process.cwd(), "data", "research", "stock_spike", "candles");
const INTERVAL = "1";
const START = "2026-02-01";
const END = "2026-07-13";          // T-2 (intraday history lags ~1 day)
const WINDOW_DAYS = 80;

// symbol -> Dhan NSE_EQ securityId (resolved from the scrip master)
const STOCKS = {
  ICICIBANK: "4963", AXISBANK: "5900", SBIN: "3045", HDFCBANK: "1333",
  KOTAKBANK: "1922", PFC: "14299", RECLTD: "15355", INFY: "1594",
  RELIANCE: "2885", IRCTC: "13611", LT: "11483",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const addDays = (d, n) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

function windows(start, end) {
  const out = [];
  let s = start;
  while (s <= end) {
    let e = addDays(s, WINDOW_DAYS);
    if (e > end) e = end;
    out.push([s, e]);
    s = addDays(e, 1);
  }
  return out;
}

async function fetchWindow(securityId, from, to) {
  const body = {
    securityId, exchangeSegment: "NSE_EQ", instrument: "EQUITY", interval: INTERVAL,
    fromDate: `${from} 09:15:00`, toDate: `${to} 15:30:00`, oi: false,
  };
  const res = await fetch(API, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await res.json();
  if (!j.success) throw new Error(JSON.stringify(j).slice(0, 200));
  return j.data; // {open[],high[],low[],close[],volume[],timestamp[]}
}

async function pullStock(symbol, securityId) {
  const rows = new Map(); // ts -> [o,h,l,c,v]
  for (const [from, to] of windows(START, END)) {
    try {
      const d = await fetchWindow(securityId, from, to);
      const ts = d.timestamp || [];
      for (let i = 0; i < ts.length; i++) {
        rows.set(ts[i], [d.open[i], d.high[i], d.low[i], d.close[i], d.volume[i]]);
      }
    } catch (e) {
      console.error(`  ${symbol} ${from}..${to} FAILED: ${e.message}`);
    }
    await sleep(300);
  }
  const sorted = [...rows.keys()].sort((a, b) => a - b);
  const lines = ["timestamp,open,high,low,close,volume"];
  for (const t of sorted) { const [o, h, l, c, v] = rows.get(t); lines.push(`${t},${o},${h},${l},${c},${v}`); }
  writeFileSync(resolve(OUT, `${symbol}_1m.csv`), lines.join("\n") + "\n");
  const span = sorted.length
    ? `${new Date((sorted[0] + 19800) * 1000).toISOString().slice(0, 10)}..${new Date((sorted.at(-1) + 19800) * 1000).toISOString().slice(0, 10)}`
    : "empty";
  console.log(`  ${symbol.padEnd(10)} ${String(sorted.length).padStart(6)} bars  ${span}`);
  return sorted.length;
}

(async () => {
  mkdirSync(OUT, { recursive: true });
  console.log(`Pulling 1-min ${START}..${END} for ${Object.keys(STOCKS).length} stocks -> ${OUT}`);
  let total = 0;
  for (const [sym, sid] of Object.entries(STOCKS)) total += await pullStock(sym, sid);
  console.log(`Done. ${total} total bars across ${Object.keys(STOCKS).length} stocks.`);
})();
