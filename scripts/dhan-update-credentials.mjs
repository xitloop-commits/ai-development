/**
 * Dhan Update Credentials — Store auth credentials in MongoDB
 *
 * MongoDB (broker_configs.auth.{clientId, pin, totpSecret}) is the single
 * source of truth for Dhan auth credentials. The server reads only these
 * fields; .env is no longer consulted at runtime (a one-time bootstrap
 * migration in initBrokerService() copies any leftover .env values once,
 * after which they can be deleted from .env).
 *
 * Usage:
 *   # Primary trading account (default brokerId="dhan-primary-ac"):
 *   node scripts/dhan-update-credentials.mjs --clientId <ID> --pin <PIN> --totp <BASE32_SECRET>
 *
 *   # Spouse's AI + Data account:
 *   node scripts/dhan-update-credentials.mjs --brokerId dhan-secondary-ac --clientId <ID> --pin <PIN> --totp <BASE32_SECRET>
 *
 *   # Manual token escape-hatch (bypasses TOTP — only if a token must be set by hand):
 *   node scripts/dhan-update-credentials.mjs --brokerId dhan-primary-ac --accessToken <JWT>
 *
 *   # Inspect what's stored (masked):
 *   node scripts/dhan-update-credentials.mjs --show
 *   node scripts/dhan-update-credentials.mjs --brokerId dhan-secondary-ac --show
 *
 * Reads MONGODB_URI from .env (only). All credential flags must be passed
 * explicitly — no env-var defaults for clientId / pin / totp / accessToken.
 */

import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

// ─── Parse CLI args ─────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : null;
}

const showOnly       = args.includes("--show");
const totpArg        = getArg("--totp");
const pinArg         = getArg("--pin");
const clientArg      = getArg("--clientId");
const accessTokenArg = getArg("--accessToken");
const brokerIdArg    = getArg("--brokerId");

const BROKER_ID = brokerIdArg ?? "dhan-primary-ac";
const isPrimary = BROKER_ID === "dhan-primary-ac";

// ─── Helpers ────────────────────────────────────────────────────

function log(msg) {
  const time = new Date().toLocaleTimeString("en-IN");
  console.log(`[${time}] ${msg}`);
}

function mask(value) {
  if (!value) return "(not set)";
  if (value.length <= 4) return "****";
  return value.slice(0, 2) + "*".repeat(value.length - 4) + value.slice(-2);
}

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error("\n[ERROR] MONGODB_URI must be set in .env\n");
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  const db = mongoose.connection.db;

  // ── Show current stored values ───────────────────────────────
  if (showOnly) {
    const doc = await db.collection("broker_configs").findOne({ brokerId: BROKER_ID });
    if (!doc) {
      console.error(`[ERROR] No broker_config found with brokerId="${BROKER_ID}"`);
      process.exit(1);
    }
    const auth = doc.auth ?? {};
    const creds = doc.credentials ?? {};
    console.log(`\n  Stored credentials for brokerId="${BROKER_ID}":`);
    console.log(`    [auth]  clientId:    ${mask(auth.clientId)}`);
    console.log(`    [auth]  pin:         ${mask(auth.pin)}`);
    console.log(`    [auth]  totpSecret:  ${mask(auth.totpSecret)}`);
    console.log(`    [live]  accessToken: ${mask(creds.accessToken)}`);
    console.log(`    [live]  clientId:    ${mask(creds.clientId)}`);
    console.log();
    await mongoose.disconnect();
    return;
  }

  // ── Manual direct-token escape hatch ─────────────────────────
  // Writes a token straight to credentials.accessToken, bypassing the TOTP
  // refresh flow. Only for emergencies — normal accounts mint their token at
  // server startup via TOTP (--totp/--pin).
  if (accessTokenArg) {
    const update = {
      "credentials.accessToken": accessTokenArg,
      "credentials.updatedAt": Date.now(),
      "credentials.status": "valid",
    };
    if (clientArg) update["credentials.clientId"] = clientArg;

    const result = await db.collection("broker_configs").updateOne(
      { brokerId: BROKER_ID },
      { $set: update },
    );
    if (result.matchedCount === 0) {
      console.error(`[ERROR] No broker_config found with brokerId="${BROKER_ID}"`);
      process.exit(1);
    }
    log(`Direct-set access token saved to MongoDB (brokerId="${BROKER_ID}"):`);
    log(`  accessToken: ${mask(accessTokenArg)}`);
    if (clientArg) log(`  clientId:    ${mask(clientArg)}`);
    console.log(
      "\n  [WARN] --accessToken bypasses TOTP refresh. Normally accounts mint their " +
      "token at server startup via --totp/--pin; use direct-set only as an emergency escape hatch.\n"
    );
    await mongoose.disconnect();
    return;
  }

  // ── Resolve values: CLI flag > .env > existing in MongoDB ───
  const existingDoc = await db.collection("broker_configs").findOne({ brokerId: BROKER_ID });
  if (!existingDoc) {
    console.error(`[ERROR] No broker_config found with brokerId="${BROKER_ID}". Seed the document first.`);
    process.exit(1);
  }

  const existing = existingDoc.auth ?? {};

  // No .env defaults — credentials live in MongoDB only. Use --show to see
  // what's stored, then pass explicit flags for any field you want to change.
  const clientId   = clientArg  ?? existing.clientId;
  const pin        = pinArg     ?? existing.pin;
  const totpSecret = totpArg    ?? existing.totpSecret;

  if (!totpArg && !pinArg && !clientArg) {
    console.error(
      "\n[ERROR] No credential flags provided.\n" +
      "  --brokerId <ID>          Target broker config (default \"dhan-primary-ac\"; \"dhan-secondary-ac\" for spouse)\n" +
      "  --totp <BASE32_SECRET>   Set the TOTP secret (live accounts)\n" +
      "  --pin  <PIN>             Set the login PIN (live accounts)\n" +
      "  --clientId <ID>          Set the Dhan client ID\n" +
      "  --accessToken <JWT>      Direct-set access token (emergency escape hatch — bypasses TOTP)\n" +
      "  --show                   Print current stored values (masked)\n"
    );
    process.exit(1);
  }

  if (!totpSecret) {
    console.error("\n[ERROR] --totp is required on first run (no existing totpSecret in MongoDB)\n");
    process.exit(1);
  }

  // ── Write to MongoDB ─────────────────────────────────────────
  const update = {};
  if (clientId)   update["auth.clientId"]   = clientId;
  if (pin)        update["auth.pin"]        = pin;
  if (totpSecret) update["auth.totpSecret"] = totpSecret;

  const result = await db.collection("broker_configs").updateOne(
    { brokerId: BROKER_ID },
    { $set: update }
  );

  if (result.matchedCount === 0) {
    console.error(`[ERROR] No broker_config found with brokerId="${BROKER_ID}"`);
    process.exit(1);
  }

  log(`Credentials saved to MongoDB (brokerId="${BROKER_ID}"):`);
  if (clientId)   log(`  clientId:   ${mask(clientId)}`);
  if (pin)        log(`  pin:        ${mask(pin)}`);
  if (totpSecret) log(`  totpSecret: ${mask(totpSecret)}`);

  console.log("\n  Done. TokenManager will use these on next server start / token refresh.\n");

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("\n[ERROR]", err.message);
  process.exit(1);
});
