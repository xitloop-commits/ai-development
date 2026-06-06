/**
 * db-sync.mjs — export / import the local MongoDB (e.g. lucky_baskar) so the
 * desktop and laptop can share the same data. The DB is local per-machine
 * (mongodb://localhost), so it does NOT sync via git like docs/code.
 *
 *   node scripts/db-sync.mjs export   # dump local DB → db-dump/
 *   node scripts/db-sync.mjs import   # restore db-dump/ → local DB (drops + replaces)
 *
 * Or via pnpm:  pnpm db:export  /  pnpm db:import
 *
 * Requires MongoDB Database Tools (mongodump / mongorestore) on PATH:
 *   https://www.mongodb.com/try/download/database-tools
 *
 * ⚠ SECURITY: the dump contains broker credentials + TOTP secrets
 *   (broker_configs). `db-dump/` is gitignored — transfer it out-of-band
 *   (USB / private cloud). NEVER commit it or share it publicly.
 *
 * Workflow: on the source machine `pnpm db:export`, copy the `db-dump/` folder
 * to the same path on the other machine, then `pnpm db:import` there.
 */

import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DUMP_DIR = path.join(REPO_ROOT, "db-dump");

function readMongoUri() {
  if (process.env.MONGODB_URI) return process.env.MONGODB_URI;
  const envPath = path.join(REPO_ROOT, ".env");
  if (!fs.existsSync(envPath)) throw new Error("MONGODB_URI not set and no .env found");
  const txt = fs.readFileSync(envPath, "utf8");
  const m = txt.match(/^\s*MONGODB_URI\s*=\s*(.+)\s*$/m);
  if (!m) throw new Error("MONGODB_URI not found in .env");
  return m[1].trim().replace(/^["']|["']$/g, "");
}

function dbNameFromUri(uri) {
  const m = uri.match(/\/([^/?]+)(\?|$)/);
  return m ? m[1] : "test";
}

function run(cmd, args, prettyArgs) {
  console.log(`\n$ ${cmd} ${prettyArgs.join(" ")}\n`);
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.error && r.error.code === "ENOENT") {
    console.error(
      `\n✖ '${cmd}' not found. Install MongoDB Database Tools:\n` +
        `   https://www.mongodb.com/try/download/database-tools\n`,
    );
    process.exit(1);
  }
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const mode = process.argv[2];
if (!["export", "import"].includes(mode)) {
  console.error("Usage: node scripts/db-sync.mjs export|import");
  process.exit(1);
}

const uri = readMongoUri();
const dbName = dbNameFromUri(uri);

if (mode === "export") {
  fs.mkdirSync(DUMP_DIR, { recursive: true });
  run(
    "mongodump",
    [`--uri=${uri}`, `--out=${DUMP_DIR}`],
    ["--uri=<uri>", `--out=${DUMP_DIR}`],
  );
  console.log(`\n✓ Exported '${dbName}' → ${path.join(DUMP_DIR, dbName)}`);
  console.log("⚠ Contains broker credentials / TOTP — transfer privately; do NOT commit.\n");
} else {
  const src = path.join(DUMP_DIR, dbName);
  if (!fs.existsSync(src)) {
    console.error(
      `✖ No dump found at ${src}.\n  Run 'pnpm db:export' on the source machine and copy db-dump/ here first.`,
    );
    process.exit(1);
  }
  run(
    "mongorestore",
    [`--uri=${uri}`, "--drop", src],
    ["--uri=<uri>", "--drop", src],
  );
  console.log(`\n✓ Imported ${src} → '${dbName}' (matching collections dropped + replaced).\n`);
}
