/**
 * T123 — backfill `expiry` on option trades that were persisted without one.
 *
 * SEA's trade payload never carried an expiry (it sends the strike and the
 * contract securityId only), so every AI trade was written with `expiry: null`.
 * The executor now resolves it from the scrip master at submit time, but the
 * rows already on the books stay null until something fixes them — and a null
 * expiry hides the contract's identity and the Dhan-search copy string on every
 * one of those rows.
 *
 * The securityId is on each of those trades, and the scrip master maps it to an
 * expiry, so this is a pure lookup — nothing is invented. Rows whose securityId
 * the master doesn't know are left ALONE and reported, never guessed at.
 *
 * Usage:  npx tsx scripts/backfill_trade_expiry.ts [--apply]
 *         (dry-run by default — prints what it would change and exits)
 */
import "dotenv/config";
import mongoose from "mongoose";
import { downloadScripMaster, getScripBySecurityId } from "../server/broker/adapters/dhan/scripMaster";

const APPLY = process.argv.includes("--apply");

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI not set");

  // The master lives in memory, so it has to be loaded before any lookup. This
  // is the same download the API server does at boot.
  process.stdout.write("Loading scrip master… ");
  const count = await downloadScripMaster();
  console.log(`${count.toLocaleString("en-IN")} records`);

  await mongoose.connect(uri);
  const db = mongoose.connection.db!;
  const col = db.collection("position_state");

  const rows = await col
    .find({ $or: [{ expiry: null }, { expiry: "" }, { expiry: { $exists: false } }] })
    .toArray();

  const fixable: { id: string; expiry: string; label: string }[] = [];
  const unresolved: string[] = [];
  let notAnOption = 0;

  for (const t of rows) {
    // Equity has no expiry and never will — leave those alone entirely.
    const isOption = typeof t.type === "string" && /CALL|PUT/.test(t.type);
    if (!isOption) { notAnOption++; continue; }

    const secId = t.contractSecurityId;
    const expiry = secId ? getScripBySecurityId(String(secId))?.expiryDateOnly : undefined;
    const label = `${t.instrument} ${t.strike} ${t.type}`;
    if (expiry) fixable.push({ id: String(t._id), expiry, label });
    else unresolved.push(`${label} (securityId ${secId ?? "none"})`);
  }

  console.log(`\nrows with no expiry : ${rows.length}`);
  console.log(`  not an option     : ${notAnOption}  (left alone)`);
  console.log(`  resolvable        : ${fixable.length}`);
  console.log(`  NOT resolvable    : ${unresolved.length}  (left alone — never guessed)`);
  for (const u of unresolved.slice(0, 10)) console.log(`      ${u}`);
  if (unresolved.length > 10) console.log(`      … and ${unresolved.length - 10} more`);

  const byExpiry: Record<string, number> = {};
  for (const f of fixable) byExpiry[f.expiry] = (byExpiry[f.expiry] ?? 0) + 1;
  console.log("\n  would set:");
  for (const [e, n] of Object.entries(byExpiry).sort()) console.log(`      ${e}  ×${n}`);

  if (!APPLY) {
    console.log("\nDRY RUN — re-run with --apply to write.");
    return;
  }

  let written = 0;
  for (const f of fixable) {
    await col.updateOne({ _id: new mongoose.Types.ObjectId(f.id) }, { $set: { expiry: f.expiry } });
    written++;
  }
  console.log(`\nDone. ${written} trade(s) updated.`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
