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

  /** securityId → expiry from the scrip master, or null when it isn't known. */
  const lookup = (secId: unknown): string | null =>
    secId ? getScripBySecurityId(String(secId))?.expiryDateOnly || null : null;

  for (const t of rows) {
    // Equity has no expiry and never will — leave those alone entirely.
    const isOption = typeof t.type === "string" && /CALL|PUT/.test(t.type);
    if (!isOption) { notAnOption++; continue; }

    const secId = t.contractSecurityId;
    const expiry = lookup(secId);
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

  // ── The copy the DESK actually reads ──────────────────────────────
  // day_records embeds its OWN trades[] array — the legacy nested array
  // position_state was extracted from. Fixing position_state alone leaves the
  // UI unchanged no matter how many times the server is restarted, which is
  // exactly what happened on the first run of this script.
  const dayCol = db.collection("day_records");
  const dayDocs = await dayCol.find({}).toArray();
  let embeddedNull = 0;
  let embeddedFixable = 0;
  for (const day of dayDocs) {
    for (const t of Array.isArray(day.trades) ? day.trades : []) {
      if (t.expiry) continue;
      if (!(typeof t.type === "string" && /CALL|PUT/.test(t.type))) continue;
      embeddedNull++;
      if (lookup(t.contractSecurityId)) embeddedFixable++;
    }
  }
  console.log(`\nday_records embedded copies with no expiry : ${embeddedNull}`);
  console.log(`  resolvable                              : ${embeddedFixable}`);

  if (!APPLY) {
    console.log("\nDRY RUN — re-run with --apply to write.");
    return;
  }

  let written = 0;
  for (const f of fixable) {
    await col.updateOne({ _id: new mongoose.Types.ObjectId(f.id) }, { $set: { expiry: f.expiry } });
    written++;
  }
  console.log(`\nposition_state : ${written} trade(s) updated.`);

  let embeddedWritten = 0;
  let docsTouched = 0;
  for (const day of dayDocs) {
    const trades = Array.isArray(day.trades) ? day.trades : [];
    if (!trades.length) continue;
    let touched = false;
    for (const t of trades) {
      if (t.expiry) continue;
      if (!(typeof t.type === "string" && /CALL|PUT/.test(t.type))) continue;
      const expiry = lookup(t.contractSecurityId);
      if (!expiry) continue;
      t.expiry = expiry;
      touched = true;
      embeddedWritten++;
    }
    if (touched) {
      await dayCol.updateOne({ _id: day._id }, { $set: { trades } });
      docsTouched++;
    }
  }
  console.log(`day_records    : ${embeddedWritten} embedded trade(s) across ${docsTouched} day doc(s).`);
  console.log("\nDone. Restart the API server to reload both.");
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
