/**
 * Dhan Token Manager
 *
 * TOTP-based token generation for the Dhan API.
 * No external dependencies — uses Node built-in crypto.
 *
 * Scheduling is handled by Windows Task Scheduler (run-dhan-refresh.bat).
 * This module is used by:
 *   - scripts/dhan-token-refresh.mjs (standalone CLI)
 *   - BSA startup token check (future: ensureValidToken on connect)
 */

import crypto from "crypto";
import { getBrokerConfig } from "../../brokerConfig";
import { createLogger } from "../../logger";

const log = createLogger("DhanAuth");

const DHAN_GENERATE_TOKEN_URL = "https://auth.dhan.co/app/generateAccessToken";

// ─── TOTP (RFC 6238) — no external deps ────────────────────────

function base32Decode(encoded: string): Buffer {
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of encoded.toUpperCase().replace(/=+$/, "").replace(/\s/g, "")) {
    const idx = alpha.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

function generateTOTP(secret: string, windowOffset = 0): string {
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

// ─── Token Generation ────────────────────────────────────────────

/**
 * Generate a fresh Dhan access token using TOTP.
 * Reads credentials from broker_configs.auth in MongoDB.
 * Falls back to env vars if auth sub-doc is not populated.
 */
export async function generateDhanToken(brokerId: string): Promise<string> {
  const config = await getBrokerConfig(brokerId);
  const auth   = (config as any)?.auth ?? {};

  const clientId   = auth.clientId   ?? process.env.DHAN_CLIENT_ID;
  const pin        = auth.pin        ?? process.env.DHAN_PIN;
  const totpSecret = auth.totpSecret ?? process.env.DHAN_TOTP_SECRET;

  if (!clientId || !pin || !totpSecret) {
    throw new Error(
      "Missing Dhan auth credentials (clientId / pin / totpSecret). " +
      "Run: node scripts/dhan-update-credentials.mjs --totp <SECRET>"
    );
  }

  for (const offset of [0, 1, -1]) {
    const totp = generateTOTP(totpSecret, offset);
    log.debug(`generateDhanToken: trying TOTP window ${offset >= 0 ? "+" : ""}${offset}`);

    const url = `${DHAN_GENERATE_TOKEN_URL}` +
      `?dhanClientId=${encodeURIComponent(clientId)}` +
      `&pin=${encodeURIComponent(pin)}` +
      `&totp=${totp}`;

    let res: Response, rawText: string, body: any;
    try {
      res     = await fetch(url, { method: "POST", signal: AbortSignal.timeout(10_000) });
      rawText = await res.text();
      try { body = JSON.parse(rawText); } catch { body = null; }
    } catch (err: any) {
      throw new Error(`Network error reaching auth.dhan.co: ${err.message}`);
    }

    if (body?.accessToken) {
      log.info(`Token generated. Expires: ${body.expiryTime ?? "24h"}`);
      return body.accessToken;
    }

    const errMsg    = body?.message ?? body?.error ?? rawText;
    const isOtp     = /totp|otp|invalid.*code|code.*invalid/i.test(errMsg);
    const isRate    = /2 minute|rate|limit/i.test(errMsg);

    if (isRate) throw new Error(`Dhan rate limit: ${errMsg}`);
    if (isOtp)  { log.debug(`TOTP window ${offset} rejected — trying next`); continue; }

    throw new Error(`generateAccessToken failed: ${errMsg}`);
  }

  throw new Error(
    "All TOTP window offsets rejected. " +
    "Verify totpSecret is correct and system clock is accurate."
  );
}
