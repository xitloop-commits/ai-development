/**
 * Dhan Token Refresh — generate a fresh access token via TOTP and STORE it.
 *
 * This is the "actually mint + persist" companion to dhan-update-credentials.mjs
 * (which only stores inputs or shows). It mirrors the server's startup logic
 * (server/broker/adapters/dhan/tokenManager.ts) exactly: reads
 * broker_configs.auth.{clientId, pin, totpSecret}, generates a TOTP, calls Dhan's
 * generateAccessToken, and on success writes broker_configs.credentials
 * {accessToken, updatedAt, status:"valid"}.
 *
 * Usage:
 *   node scripts/dhan-token-refresh.mjs                                # dhan-primary-ac
 *   node scripts/dhan-token-refresh.mjs --brokerId dhan-secondary-ac   # spouse account
 *
 * Reads MONGODB_URI from .env. Makes ONE mint attempt (up to 3 TOTP windows on
 * OTP errors, like the server). Prints masked values only — never the raw token.
 */

import mongoose from "mongoose";
import dotenv from "dotenv";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const DHAN_GENERATE_TOKEN_URL = "https://auth.dhan.co/app/generateAccessToken";

const args = process.argv.slice(2);
const getArg = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const BROKER_ID = getArg("--brokerId") ?? "dhan-primary-ac";

function mask(v) {
  if (!v) return "(not set)";
  if (v.length <= 4) return "****";
  return v.slice(0, 2) + "*".repeat(Math.max(0, v.length - 4)) + v.slice(-2);
}

// ─── TOTP (RFC 6238) — ported verbatim from tokenManager.ts ───────
function base32Decode(encoded) {
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0;
  const out = [];
  for (const ch of encoded.toUpperCase().replace(/=+$/, "").replace(/\s/g, "")) {
    const idx = alpha.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

function generateTOTP(secret, windowOffset = 0) {
  const counter = BigInt(Math.floor(Date.now() / 1000 / 30) + windowOffset);
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(counter);
  const hmac = crypto.createHmac("sha1", base32Decode(secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  ) % 1_000_000;
  return code.toString().padStart(6, "0");
}

async function main() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) { console.error("\n[ERROR] MONGODB_URI must be set in .env\n"); process.exit(1); }

  await mongoose.connect(mongoUri);
  const db = mongoose.connection.db;

  const doc = await db.collection("broker_configs").findOne({ brokerId: BROKER_ID });
  if (!doc) { console.error(`[ERROR] No broker_config for brokerId="${BROKER_ID}"`); await mongoose.disconnect(); process.exit(1); }

  const auth = doc.auth ?? {};
  const { clientId, pin, totpSecret } = auth;
  if (!clientId || !pin || !totpSecret) {
    console.error(`[ERROR] Missing auth for "${BROKER_ID}" — clientId=${mask(clientId)} pin=${mask(pin)} totp=${mask(totpSecret)}`);
    await mongoose.disconnect();
    process.exit(1);
  }

  // ── --check: print the codes our stored secret generates, NO Dhan call ──
  // Compare these to your authenticator app for this account. A mismatch means
  // the stored totpSecret is stale (2FA reset/re-register) → fix with --totp.
  if (args.includes("--check")) {
    const t = new Date();
    console.log(`\n  TOTP self-check for "${BROKER_ID}"  (local time ${t.toLocaleTimeString("en-IN")})`);
    console.log(`    stored totpSecret: ${mask(totpSecret)}`);
    for (const off of [-1, 0, 1]) {
      console.log(`      window ${off >= 0 ? "+" : ""}${off}: ${generateTOTP(totpSecret, off)}`);
    }
    console.log(`\n  Compare 'window +0' to your authenticator app's current 6-digit code for this account.`);
    console.log(`  Match → secret is correct (PIN is the issue).  Mismatch → stored secret is stale.\n`);
    await mongoose.disconnect();
    return;
  }

  console.log(`\n  Minting token for brokerId="${BROKER_ID}"`);
  console.log(`    clientId=${mask(clientId)}  pin=${mask(pin)}  totpSecret=${mask(totpSecret)}\n`);

  let token = null;
  let lastErr = "";
  for (const offset of [0, 1, -1]) {
    const totp = generateTOTP(totpSecret, offset);
    const url = `${DHAN_GENERATE_TOKEN_URL}?dhanClientId=${encodeURIComponent(clientId)}&pin=${encodeURIComponent(pin)}&totp=${totp}`;
    let res, rawText, body;
    try {
      res = await fetch(url, { method: "POST", signal: AbortSignal.timeout(10_000) });
      rawText = await res.text();
      try { body = JSON.parse(rawText); } catch { body = null; }
    } catch (err) {
      lastErr = `Network error reaching auth.dhan.co: ${err.message}`;
      break;
    }
    if (body?.accessToken) { token = body.accessToken; console.log(`  ✅ Dhan minted a token (TOTP window ${offset >= 0 ? "+" : ""}${offset}). Expires: ${body.expiryTime ?? "24h"}`); break; }

    const errMsg = body?.message ?? body?.error ?? rawText ?? `HTTP ${res?.status}`;
    lastErr = errMsg;
    const isOtp = /totp|otp|invalid.*code|code.*invalid/i.test(errMsg);
    const isRate = /2 minute|rate|limit/i.test(errMsg);
    console.log(`  ✗ window ${offset >= 0 ? "+" : ""}${offset}: ${errMsg}`);
    if (isRate) { console.error(`\n  [STOP] Dhan rate limit — not retrying.\n`); break; }
    if (isOtp) continue; // only TOTP errors are worth another time window
    break; // pin / account errors are not retryable
  }

  if (!token) {
    console.error(`\n  ❌ Token NOT generated for "${BROKER_ID}". Dhan said: ${lastErr}`);
    console.error(`     (broker_configs was NOT modified.)\n`);
    await mongoose.disconnect();
    process.exit(2);
  }

  const now = Date.now();
  const result = await db.collection("broker_configs").updateOne(
    { brokerId: BROKER_ID },
    { $set: { "credentials.accessToken": token, "credentials.clientId": clientId, "credentials.updatedAt": now, "credentials.status": "valid" } },
  );

  const after = await db.collection("broker_configs").findOne({ brokerId: BROKER_ID });
  const creds = after?.credentials ?? {};
  console.log(`\n  ✅ Stored to broker_configs (matched=${result.matchedCount}, modified=${result.modifiedCount}):`);
  console.log(`    accessToken: ${mask(creds.accessToken)}`);
  console.log(`    status:      ${creds.status}`);
  console.log(`    updatedAt:   ${new Date(creds.updatedAt).toISOString()}  (epoch ${creds.updatedAt})`);
  console.log(`\n  ⚠ Restart BSA so it loads this fresh token (it reads tokens only at startup).\n`);

  await mongoose.disconnect();
}

main().catch(async (e) => { console.error(`\n[FATAL] ${e?.message ?? e}\n`); try { await mongoose.disconnect(); } catch {} process.exit(1); });