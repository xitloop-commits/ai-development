/**
 * One-off maintenance: recompute charges (+ net P&L) on the CURRENT day's already
 * -closed paper trades using the corrected statutory rates (STT 0.15%, exch
 * 0.03503% — see server/userSettings.ts). Fixes charges baked in at close time
 * under the old (too-low) rates, then re-derives the day aggregates and adjusts
 * the capital counters by the delta.
 *
 * IDEMPOTENT: on a second run every trade already has the correct charges, so the
 * per-trade delta is 0 and the capital counters aren't touched again.
 *
 * Only CLOSED trades are recomputed (open trades bake charges in at close). The
 * live tick reconcile skips closed trades, so this is safe to run intraday; the
 * only tiny race is a trade closing during the sub-second capital-counter update.
 *
 *   npx tsx scripts/recompute_charges.ts               # ai-paper (default)
 *   npx tsx scripts/recompute_charges.ts ai-paper my-paper testing-paper
 */
import "dotenv/config";
import { connectMongo, disconnectMongo } from "../server/mongo";
import { getUserSettings } from "../server/userSettings";
import {
  getCapitalState,
  getDayRecord,
  upsertDayRecord,
  updateCapitalState,
} from "../server/portfolio/state";
import { calculateTradeCharges } from "../server/portfolio/charges";
import { recalculateDayAggregates } from "../server/portfolio/compounding";
import type { Channel } from "../server/portfolio/state";

const round2 = (x: number) => Math.round(x * 100) / 100;

async function main(): Promise<void> {
  const dry = !!process.env.DRY_RUN;
  const args = process.argv.slice(2);
  const targets = (args.length ? args : ["ai-paper"]) as Channel[];

  await connectMongo();
  const rates = (await getUserSettings(1)).charges.rates as any[];

  for (const channel of targets) {
    const state = await getCapitalState(channel);
    const day = await getDayRecord(channel, state.currentDayIndex);
    if (!day) {
      console.log(`${channel}: no current day record — skipped`);
      continue;
    }

    let n = 0;
    let deltaPnl = 0;
    let deltaCharges = 0;
    for (const t of day.trades) {
      if (t.status !== "CLOSED" || t.exitPrice == null) continue;
      const isBuy = t.type.includes("BUY");
      const direction = isBuy ? 1 : -1;
      const gross = (t.exitPrice - t.entryPrice) * t.qty * direction;
      const exchange: "NSE" | "MCX" =
        t.instrument.includes("CRUDE") || t.instrument.includes("NATURAL") ? "MCX" : "NSE";
      const res = calculateTradeCharges(
        { entryPrice: t.entryPrice, exitPrice: t.exitPrice, qty: t.qty, isBuy, exchange },
        rates as any,
      );
      const oldCharges = t.charges ?? 0;
      const oldPnl = t.pnl ?? 0;
      const newPnl = round2(gross - res.total);
      deltaCharges += res.total - oldCharges;
      deltaPnl += newPnl - oldPnl;
      t.charges = res.total;
      t.chargesBreakdown = res.breakdown;
      t.pnl = newPnl;
      n++;
    }

    const updated = recalculateDayAggregates(day);
    if (!dry) {
      await upsertDayRecord(channel, updated);
      if (Math.abs(deltaPnl) > 0.005 || Math.abs(deltaCharges) > 0.005) {
        const fresh = await getCapitalState(channel); // fresh read shrinks the race window
        await updateCapitalState(channel, {
          sessionPnl: round2(fresh.sessionPnl + deltaPnl),
          cumulativePnl: round2(fresh.cumulativePnl + deltaPnl),
          cumulativeCharges: round2(fresh.cumulativeCharges + deltaCharges),
        });
      }
    }

    console.log(
      `${dry ? "[DRY] " : ""}${channel}: ${n} closed trades recomputed | charges +₹${deltaCharges.toFixed(2)} | ` +
        `net P&L ₹${deltaPnl.toFixed(2)} | day realized+unreal ₹${round2((updated as any).totalPnl ?? 0)}`,
    );
  }

  await disconnectMongo();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
