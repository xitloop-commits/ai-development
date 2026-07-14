/**
 * pull_daily.mjs — Phase-0b swing spike: 5-year DAILY history puller.
 *
 * Dhan's daily endpoint returns a fixed ~20 recent bars (ignores the date range)
 * and its intraday only reaches ~5.5 months — too short for a daily/swing model.
 * So for this research spike we source free daily EOD history from Yahoo Finance
 * (<symbol>.NS), which serves years. Isolated in research/ — no production touch.
 *
 * Writes one CSV per stock -> data/research/stock_spike/daily/<SYMBOL>.csv
 * Usage: node scripts/stock_spike/pull_daily.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve(process.cwd(), "data", "research", "stock_spike", "daily");
const UNIVERSE = [
  "RELIANCE", "TCS", "HDFCBANK", "ICICIBANK", "INFY", "SBIN", "AXISBANK", "KOTAKBANK",
  "LT", "BHARTIARTL", "ITC", "HINDUNILVR", "BAJFINANCE", "MARUTI", "SUNPHARMA", "TATASTEEL",
  "WIPRO", "ADANIENT", "ASIANPAINT", "HCLTECH", "NTPC", "POWERGRID", "ULTRACEMCO", "TITAN",
  "BAJAJFINSV", "ONGC", "COALINDIA", "NESTLEIND", "GRASIM", "JSWSTEEL", "DRREDDY", "CIPLA",
  "EICHERMOT", "HEROMOTOCO", "BRITANNIA", "TECHM", "INDUSINDBK", "PFC", "RECLTD", "IRCTC",
  "BEL", "HAL", "ADANIPORTS", "DLF",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pull(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}.NS?range=5y&interval=1d`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  const j = await res.json();
  const r = j?.chart?.result?.[0];
  if (!r || !r.timestamp) return 0;
  const ts = r.timestamp;
  const q = r.indicators.quote[0];
  const lines = ["timestamp,open,high,low,close,volume"];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i], v = q.volume[i];
    if (c == null || o == null || v == null) continue;   // drop incomplete bars
    lines.push(`${ts[i]},${o},${h},${l},${c},${v}`);
  }
  writeFileSync(resolve(OUT, `${sym}.csv`), lines.join("\n") + "\n");
  return lines.length - 1;
}

(async () => {
  mkdirSync(OUT, { recursive: true });
  console.log(`Pulling 5yr daily for ${UNIVERSE.length} stocks (Yahoo) -> ${OUT}`);
  let ok = 0, total = 0;
  for (const sym of UNIVERSE) {
    try {
      const n = await pull(sym);
      if (n > 0) { ok++; total += n; console.log(`  ${sym.padEnd(11)} ${String(n).padStart(5)} bars`); }
      else console.log(`  ${sym.padEnd(11)} MISS (no Yahoo data)`);
    } catch (e) {
      console.log(`  ${sym.padEnd(11)} ERR ${e.message}`);
    }
    await sleep(400);
  }
  console.log(`Done. ${ok}/${UNIVERSE.length} stocks, ${total} daily bars.`);
})();
