/**
 * Dhan Token Refresh — Check expiry and generate a new token if needed
 *
 * Reads auth credentials (clientId, pin, totpSecret) from MongoDB,
 * checks whether the stored access token is expired or expiring soon,
 * and if so generates a fresh token via TOTP and saves it back.
 *
 * Usage:
 *   node scripts/dhan-token-refresh.mjs           ← check + refresh if needed
 *   node scripts/dhan-token-refresh.mjs --force   ← always refresh
 *   node scripts/dhan-token-refresh.mjs --status  ← print status only, no refresh
 *
 * Exit codes:
 *   0 — token is valid (or was refreshed successfully)
 *   1 — refresh failed
 */

import crypto from "crypto";
import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

// ─── Config ─────────────────────────────────────────────────────

const BROKER_ID                = "dhan";
const DHAN_GENERATE_TOKEN_URL  = "https://auth.dhan.co/app/generateAccessToken";
const DHAN_API_BASE            = "https://api.dhan.co/v2";
const DHAN_TOKEN_EXPIRY_MS     = 24 * 60 * 60 * 1000;  // 24 h
const DHAN_TOKEN_EXPIRY_BUFFER = 60 * 60 * 1000;       // refresh when < 1 h left

// ─── Helpers ─────────────────────────────────────────────────────

function log(msg) {
  const t = new Date().toLocaleTimeString("en-IN", { hour12: false });
  console.log(`[${t}] ${msg}`);
}

function fmtMs(ms) {
  if (ms <= 0) return "expired";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ─── TOTP (RFC 6238) — no external deps ──────────────────────────

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
  const hmac   = crypto.createHmac("sha1", base32Decode(secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code   = (
    ((hmac[offset]     & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) <<  8) |
     (hmac[offset + 3] & 0xff)
  ) % 1_000_000;
  return code.toString().padStart(6, "0");
}

// ─── Token Generation ─────────────────────────────────────────────

async function generateToken(clientId, pin, totpSecret) {
  for (const offset of [0, 1, -1]) {
    const totp = generateTOTP(totpSecret, offset);
    const url  = `${DHAN_GENERATE_TOKEN_URL}`
               + `?dhanClientId=${encodeURIComponent(clientId)}`
               + `&pin=${encodeURIComponent(pin)}`
               + `&totp=${totp}`;

    let res, rawText, body;
    try {
      res     = await fetch(url, { method: "POST", signal: AbortSignal.timeout(10_000) });
      rawText = await res.text();
      try { body = JSON.parse(rawText); } catch { body = null; }
    } catch (err) {
      throw new Error(`Network error reaching auth.dhan.co: ${err.message}`);
    }

    if (body?.accessToken) {
      log(`Token generated (TOTP window ${offset >= 0 ? "+" : ""}${offset}).`);
      return body.accessToken;
    }

    const errMsg = body?.message ?? body?.error ?? rawText;
    const isOtp  = /totp|otp|invalid.*code|code.*invalid/i.test(errMsg);
    const isRate = /2 minute|rate|limit/i.test(errMsg);

    if (isRate)  throw new Error(`Dhan rate limit hit: ${errMsg}`);
    if (isOtp)   { log(`TOTP window ${offset} rejected — trying next.`); continue; }

    throw new Error(`generateAccessToken failed: ${errMsg}`);
  }

  throw new Error(
    "All TOTP window offsets rejected. " +
    "Check totpSecret and ensure system clock is accurate."
  );
}

// ─── Token Validation ─────────────────────────────────────────────

async function validateToken(accessToken) {
  const res = await fetch(`${DHAN_API_BASE}/fundlimit`, {
    headers: { "access-token": accessToken, Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  return res.ok;
}

// ─── Main ─────────────────────────────────────────────────────────

const args       = process.argv.slice(2);
const forceFlag  = args.includes("--force");
const statusOnly = args.includes("--status");

async function main() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error("\n  ERROR: MONGODB_URI is not set in .env\n");
    process.exit(1);
  }

  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 5000 });
  const db = mongoose.connection.db;

  const doc = await db.collection("broker_configs").findOne({ brokerId: BROKER_ID });
  if (!doc) {
    console.error(`\n  ERROR: No broker_config found for brokerId="${BROKER_ID}"\n`);
    await mongoose.disconnect();
    process.exit(1);
  }

  // ── Expiry check ────────────────────────────────────────────────
  const creds       = doc.credentials ?? {};
  const updatedAt   = creds.updatedAt  ?? 0;
  const expiresIn   = creds.expiresIn  ?? DHAN_TOKEN_EXPIRY_MS;
  const tokenStatus = creds.status     ?? "unknown";

  const now         = Date.now();
  const expiresAt   = updatedAt + expiresIn;
  const remainingMs = expiresAt - now;
  const isExpired   = remainingMs <= 0;
  const isExpSoon   = remainingMs > 0 && remainingMs <= DHAN_TOKEN_EXPIRY_BUFFER;

  log(`Token status: ${tokenStatus}  |  remaining: ${fmtMs(remainingMs)}`);

  if (statusOnly) {
    await mongoose.disconnect();
    process.exit(0);
  }

  const needsRefresh = forceFlag || isExpired || isExpSoon || tokenStatus !== "valid";

  if (!needsRefresh) {
    log("Token is valid — no refresh needed.");
    await mongoose.disconnect();
    process.exit(0);
  }

  const reason = forceFlag   ? "--force flag"
               : isExpired   ? "token expired"
               : isExpSoon   ? `expiring soon (${fmtMs(remainingMs)} left)`
               :               `status="${tokenStatus}"`;
  log(`Refreshing token (reason: ${reason})...`);

  // ── Resolve auth credentials ────────────────────────────────────
  const auth       = doc.auth ?? {};
  const clientId   = auth.clientId   ?? process.env.DHAN_CLIENT_ID;
  const pin        = auth.pin        ?? process.env.DHAN_PIN;
  const totpSecret = auth.totpSecret ?? process.env.DHAN_TOTP_SECRET;

  if (!clientId || !pin || !totpSecret) {
    console.error(
      "\n  ERROR: Missing Dhan auth credentials (clientId / pin / totpSecret).\n" +
      "  Run: node scripts/dhan-update-credentials.mjs --totp <SECRET>\n"
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  // ── Generate new token ──────────────────────────────────────────
  let newToken;
  try {
    newToken = await generateToken(clientId, pin, totpSecret);
  } catch (err) {
    console.error(`\n  ERROR generating token: ${err.message}\n`);
    await mongoose.disconnect();
    process.exit(1);
  }

  // ── Validate the new token ──────────────────────────────────────
  log("Validating new token against Dhan API...");
  const valid = await validateToken(newToken);
  if (!valid) {
    console.error("\n  ERROR: New token failed validation against /fundlimit\n");
    await mongoose.disconnect();
    process.exit(1);
  }

  // ── Save to MongoDB ─────────────────────────────────────────────
  const ts = Date.now();
  await db.collection("broker_configs").updateOne(
    { brokerId: BROKER_ID },
    {
      $set: {
        "credentials.accessToken":  newToken,
        "credentials.updatedAt":    ts,
        "credentials.expiresIn":    DHAN_TOKEN_EXPIRY_MS,
        "credentials.status":       "valid",
        "connection.apiStatus":     "connected",
        "connection.lastApiCall":   ts,
      },
    }
  );

  log("Token refreshed and saved successfully.");
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("\n  ERROR:", err.message, "\n");
  process.exit(1);
});
