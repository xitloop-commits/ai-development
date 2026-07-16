/**
 * Dhan margin-calculator check — verify /margincalculator returns the real
 * per-order margin (leverage-aware) before we wire it into the capital check.
 *
 * Read-only: queries the margin required for an order; places NOTHING.
 *
 * Usage (defaults = REC 1000 intraday, the case we captured):
 *   node scripts/dhan-margin-check.mjs
 *   node scripts/dhan-margin-check.mjs --security 15355 --qty 1000 --product INTRADAY --price 355
 *   node scripts/dhan-margin-check.mjs --product CNC     # delivery (1x)
 *   node scripts/dhan-margin-check.mjs --product MTF
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const args = process.argv.slice(2);
const arg = (f, d) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : d; };

const BROKER_ID = arg("--brokerId", "dhan-primary-ac");
const securityId = arg("--security", "15355"); // RECLTD
const quantity = Number(arg("--qty", "1000"));
const productType = arg("--product", "INTRADAY"); // INTRADAY | CNC | MTF | MARGIN
const price = Number(arg("--price", "355"));
const side = arg("--side", "BUY");
const segment = arg("--segment", "NSE_EQ");

const DHAN_API_BASE = "https://api.dhan.co/v2";

async function main() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) { console.error("\n[ERROR] MONGODB_URI must be set in .env\n"); process.exit(1); }
  await mongoose.connect(mongoUri);
  const db = mongoose.connection.db;

  const doc = await db.collection("broker_configs").findOne({ brokerId: BROKER_ID });
  if (!doc) { console.error(`[ERROR] No broker_config for "${BROKER_ID}"`); await mongoose.disconnect(); process.exit(1); }
  const clientId = doc.auth?.clientId ?? doc.credentials?.clientId;
  const accessToken = doc.credentials?.accessToken;
  if (!clientId || !accessToken) {
    console.error(`[ERROR] Missing clientId/accessToken for "${BROKER_ID}"`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const body = {
    dhanClientId: String(clientId),
    exchangeSegment: segment,
    transactionType: side,
    quantity,
    productType,
    securityId: String(securityId),
    price,
    triggerPrice: 0,
  };

  console.log(`\n  POST ${DHAN_API_BASE}/margincalculator`);
  console.log(`  ${side} ${quantity} securityId=${securityId} (${segment}) ${productType} @ ${price}`);
  console.log(`  full value = ${(quantity * price).toLocaleString("en-IN")}\n`);

  let res, json, raw;
  try {
    res = await fetch(`${DHAN_API_BASE}/margincalculator`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "access-token": accessToken, "client-id": String(clientId) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    raw = await res.text();
    try { json = JSON.parse(raw); } catch { json = null; }
  } catch (err) {
    console.error(`  [ERROR] network: ${err.message}`);
    await mongoose.disconnect();
    process.exit(2);
  }

  if (!res.ok || !json) {
    console.error(`  [ERROR] HTTP ${res?.status}: ${raw?.slice(0, 400)}`);
    await mongoose.disconnect();
    process.exit(2);
  }

  console.log("  Response:");
  console.log(JSON.stringify(json, null, 2).split("\n").map((l) => "    " + l).join("\n"));
  const tm = json.totalMargin ?? json.total_margin;
  if (tm != null) {
    const lev = (quantity * price) / tm;
    console.log(`\n  ==> totalMargin = ${Number(tm).toLocaleString("en-IN")}   (~${lev.toFixed(2)}x leverage)\n`);
  }

  await mongoose.disconnect();
}

main().catch(async (e) => { console.error(`\n[FATAL] ${e?.message ?? e}\n`); try { await mongoose.disconnect(); } catch {} process.exit(1); });
