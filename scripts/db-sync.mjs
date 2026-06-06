/**
 * db-sync.mjs — export / import the local MongoDB (e.g. lucky_baskar) + .env
 * across machines, ENCRYPTED so the blob is safe to commit to git.
 *
 *   pnpm db:export   # dump DB + .env → encrypt → db-dump.enc (commit this)
 *   pnpm db:import   # decrypt db-dump.enc → restore DB (--drop) + .env
 *
 * Encryption: AES-256-GCM with a 32-byte key in `.db-sync.key` (gitignored),
 * generated on first export. Copy `.db-sync.key` to the OTHER machine's repo
 * root OUT-OF-BAND (USB / password manager) — NEVER commit it. Or set
 * DB_SYNC_KEY (base64) in the environment instead of the file.
 *
 *   Committed:  db-dump.enc      (encrypted — safe in git)
 *   Gitignored: db-dump/ (plaintext working dir), .db-sync.key (the key)
 *
 * Requires MongoDB Database Tools (mongodump/mongorestore — auto-detected) and
 * `tar` (built into Windows 10+/macOS/Linux).
 */

import { spawnSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DUMP_DIR = path.join(REPO_ROOT, "db-dump");
const ENC_FILE = path.join(REPO_ROOT, "db-dump.enc");
const KEY_FILE = path.join(REPO_ROOT, ".db-sync.key");

function readMongoUri() {
  if (process.env.MONGODB_URI) return process.env.MONGODB_URI;
  const envPath = path.join(REPO_ROOT, ".env");
  if (!fs.existsSync(envPath)) throw new Error("MONGODB_URI not set and no .env found");
  const m = fs.readFileSync(envPath, "utf8").match(/^\s*MONGODB_URI\s*=\s*(.+)\s*$/m);
  if (!m) throw new Error("MONGODB_URI not found in .env");
  return m[1].trim().replace(/^["']|["']$/g, "");
}

function dbNameFromUri(uri) {
  const m = uri.match(/\/([^/?]+)(\?|$)/);
  return m ? m[1] : "test";
}

// Find a MongoDB tool: PATH first, else the standard Windows install dirs.
function resolveTool(name) {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  for (const base of ["C:/Program Files/MongoDB/Tools", "C:/Program Files/MongoDB/Server"]) {
    try {
      for (const ver of fs.readdirSync(base)) {
        const p = path.join(base, ver, "bin", exe);
        if (fs.existsSync(p)) return p;
      }
    } catch {
      /* base dir absent */
    }
  }
  return name;
}

function run(cmd, args, prettyArgs, opts = {}) {
  console.log(`\n$ ${cmd} ${prettyArgs.join(" ")}\n`);
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.error && r.error.code === "ENOENT") {
    const hint =
      cmd.includes("mongo")
        ? "Install MongoDB Database Tools: https://www.mongodb.com/try/download/database-tools"
        : "`tar` is required (built into Windows 10+/macOS/Linux).";
    console.error(`\n✖ '${cmd}' not found. ${hint}\n`);
    process.exit(1);
  }
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function loadKey(forExport) {
  if (fs.existsSync(KEY_FILE)) return Buffer.from(fs.readFileSync(KEY_FILE, "utf8").trim(), "base64");
  if (process.env.DB_SYNC_KEY) return Buffer.from(process.env.DB_SYNC_KEY.trim(), "base64");
  if (forExport) {
    const key = crypto.randomBytes(32);
    fs.writeFileSync(KEY_FILE, key.toString("base64") + "\n");
    console.log("\n🔑 Generated encryption key → .db-sync.key (gitignored).");
    console.log("   Copy this file to the OTHER machine's repo root out-of-band before db:import.\n");
    return key;
  }
  throw new Error(
    "No .db-sync.key (and no DB_SYNC_KEY env). Copy .db-sync.key from the source machine first.",
  );
}

const encrypt = (buf, key) => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
};
const decrypt = (blob, key) => {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
};

const mode = process.argv[2];
if (!["export", "import"].includes(mode)) {
  console.error("Usage: node scripts/db-sync.mjs export|import");
  process.exit(1);
}

const uri = readMongoUri();
const dbName = dbNameFromUri(uri);
// Temp archive at the repo root so `tar` gets a relative, drive-letter-free
// filename (Windows bsdtar treats "C:\…" as a remote host). Cleaned up after.
const tgz = path.join(REPO_ROOT, "db-dump.tgz");

if (mode === "export") {
  if (fs.existsSync(DUMP_DIR)) fs.rmSync(DUMP_DIR, { recursive: true, force: true });
  fs.mkdirSync(DUMP_DIR, { recursive: true });
  run(resolveTool("mongodump"), [`--uri=${uri}`, `--out=${DUMP_DIR}`], ["--uri=<uri>", `--out=${DUMP_DIR}`]);

  const envSrc = path.join(REPO_ROOT, ".env");
  if (fs.existsSync(envSrc)) {
    fs.copyFileSync(envSrc, path.join(DUMP_DIR, ".env"));
    console.log("  bundled .env");
  }

  run("tar", ["-czf", "db-dump.tgz", "db-dump"], ["-czf", "db-dump.tgz", "db-dump"], { cwd: REPO_ROOT });
  fs.writeFileSync(ENC_FILE, encrypt(fs.readFileSync(tgz), loadKey(true)));
  fs.rmSync(tgz, { force: true });

  console.log(`\n✓ Exported '${dbName}' + .env → encrypted ${path.basename(ENC_FILE)} (safe to commit).`);
  console.log("  Next: git add db-dump.enc && commit; copy .db-sync.key to the other machine out-of-band.\n");
} else {
  // Prefer the committed encrypted blob; fall back to a plaintext db-dump/.
  if (fs.existsSync(ENC_FILE)) {
    let tgzBuf;
    try {
      tgzBuf = decrypt(fs.readFileSync(ENC_FILE), loadKey(false));
    } catch {
      console.error("\n✖ Decryption failed — wrong or missing .db-sync.key.\n");
      process.exit(1);
    }
    fs.writeFileSync(tgz, tgzBuf);
    if (fs.existsSync(DUMP_DIR)) fs.rmSync(DUMP_DIR, { recursive: true, force: true });
    run("tar", ["-xzf", "db-dump.tgz"], ["-xzf", "db-dump.tgz"], { cwd: REPO_ROOT });
    fs.rmSync(tgz, { force: true });
  }

  const src = path.join(DUMP_DIR, dbName);
  if (!fs.existsSync(src)) {
    console.error(
      `✖ Nothing to import: no db-dump.enc and no ${src}.\n  Run 'pnpm db:export' on the source machine, commit db-dump.enc, pull here, and place .db-sync.key.`,
    );
    process.exit(1);
  }
  run(resolveTool("mongorestore"), [`--uri=${uri}`, "--drop", src], ["--uri=<uri>", "--drop", src]);

  const envBundle = path.join(DUMP_DIR, ".env");
  const envTarget = path.join(REPO_ROOT, ".env");
  if (fs.existsSync(envBundle)) {
    if (fs.existsSync(envTarget)) {
      console.log("  .env already present — left untouched (merge from db-dump/.env if needed).");
    } else {
      fs.copyFileSync(envBundle, envTarget);
      console.log("  restored .env");
    }
  }
  console.log(`\n✓ Imported '${dbName}' (+ .env) — matching collections dropped + replaced.\n`);
}
