/**
 * T118 — one-off: re-base the ai-live book to ₹0 so it can be funded by hand.
 *
 * WHY. ai-live used to be backed by the SECONDARY (spouse's) Dhan account, and
 * its opening balance was auto-seeded from that account's start-of-day limit.
 * Dhan whitelists an API key against one IP and refuses to reuse an IP already
 * registered elsewhere, so with a single static IP at home only the primary
 * account can place orders. ai-live now points at the primary account
 * (AI_LIVE_BROKER_ID=dhan-primary-ac).
 *
 * That makes the seeded balance wrong twice over: it is money in a DIFFERENT
 * account, and leaving it would make the two books (my-live + ai-live) add up to
 * roughly twice the cash that actually exists.
 *
 * WHAT IT DOES. Sets ai-live's pools to 0 and clears `seededAt`, which marks the
 * book "not funded" — discipline gates refuse to trade it and the Add Fund
 * button becomes the way in (portfolio/router.ts `inject` re-establishes an
 * unseeded book at the amount you add). Writes one CAPITAL_ADJUSTED ledger row
 * so the passbook explains the drop instead of the money just vanishing.
 *
 * SAFE TO RUN because ai-live has never placed a trade — verified before
 * writing, and the script REFUSES to run if that is no longer true.
 *
 * Usage:  npx tsx scripts/rebase_ai_live_book.ts [--apply]
 *         (dry-run by default — prints what it would do and exits)
 */
import "dotenv/config";
import mongoose from "mongoose";

const APPLY = process.argv.includes("--apply");

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI not set");
  await mongoose.connect(uri);
  const db = mongoose.connection.db!;

  const state = await db.collection("portfolio_state").findOne({ channel: "ai-live" });
  if (!state) {
    console.log("ai-live has no capital book yet — nothing to re-base.");
    return;
  }

  // Refuse on any history: re-basing a book that has traded would orphan the
  // P&L those trades produced.
  const trades = await db.collection("position_state").countDocuments({ channel: "ai-live" });
  if (trades > 0) {
    console.error(
      `REFUSING: ai-live has ${trades} trade(s) on record. This script is only safe ` +
      `on a book that has never traded. Reconcile by hand instead.`,
    );
    process.exitCode = 1;
    return;
  }

  const trading = Number(state.tradingPool) || 0;
  const reserve = Number(state.reservePool) || 0;
  const total = Math.round((trading + reserve) * 100) / 100;

  console.log(`ai-live book today : trading ₹${trading.toLocaleString("en-IN")} ` +
              `+ reserve ₹${reserve.toLocaleString("en-IN")} = ₹${total.toLocaleString("en-IN")}`);
  console.log(`trades on record   : ${trades}`);
  console.log(`after re-base      : ₹0, marked unfunded — use Add Fund to put real money in`);

  if (!APPLY) {
    console.log("\nDRY RUN — re-run with --apply to write.");
    return;
  }

  const now = Date.now();
  await db.collection("portfolio_state").updateOne(
    { channel: "ai-live" },
    {
      $set: {
        tradingPool: 0,
        reservePool: 0,
        initialFunding: 0,
        cumulativePnl: 0,
        cumulativeCharges: 0,
        seededAt: null,
        updatedAt: now,
      },
    },
  );

  // Written through recordCapitalEvent so the row lands in the same
  // {eventId, channel, eventType, payload, timestamp} shape every other ledger
  // row uses — a hand-rolled insert would be invisible to the passbook builder.
  const { recordCapitalEvent } = await import("../server/portfolio/capitalLedger");
  await recordCapitalEvent({
    channel: "ai-live",
    type: "CAPITAL_ADJUSTED",
    amount: -total,
    tradingPoolAfter: 0,
    reservePoolAfter: 0,
    tradingDelta: -trading,
    reserveDelta: -reserve,
    note:
      `Book re-based to ₹0 — ai-live moved from the secondary account to the ` +
      `primary one (single whitelisted IP). The ₹${total.toLocaleString("en-IN")} ` +
      `shown here was the secondary account's money and was never traded.`,
    detail: { reason: "T118 shared-account move", previousTotal: total, tradesEver: 0 },
  });
  void now;

  console.log("\nDone. ai-live is now unfunded — add funds from the net-worth panel.");
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
