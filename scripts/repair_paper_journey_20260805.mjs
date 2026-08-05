/**
 * One-off repair (2026-08-05): collapse the scrambled paper journey (29 cycles
 * all dated today, created by the pre-fix intraday day-completion bug) back to a
 * single clean Day 1.
 *
 * Backup taken first: portfolio_state_bak_20260805_prebfix + day_records_bak_...
 * To restore: copy those *_bak_* collections back over portfolio_state/day_records.
 *
 * Run: node scripts/repair_paper_journey_20260805.mjs
 */
import mongoose from 'mongoose';
await mongoose.connect('mongodb://localhost:27017/lucky_baskar');
const db = mongoose.connection.db;
const money = (n) => '₹' + Math.round(n || 0).toLocaleString('en-IN');
const round = (n) => Math.round(n * 100) / 100;

// 1) merge all embedded trades from the 29 paper day_records
const dr = await db.collection('day_records').find({ channel: 'paper' }).sort({ dayIndex: 1 }).toArray();
const merged = [];
for (const d of dr) for (const t of (d.trades || [])) merged.push(t);
console.log(`merged embedded trades from ${dr.length} cycles: ${merged.length}`);

const totalPnl = round(merged.reduce((s, t) => s + (t.pnl || 0), 0));
const totalCharges = round(merged.reduce((s, t) => s + (t.charges || 0), 0));
const totalQty = merged.reduce((s, t) => s + (t.qty || 0), 0);
const instruments = [...new Set(merged.map((t) => t.instrument).filter(Boolean))];

// 2) build the single clean Day 1 (ACTIVE, 2026-08-05, fresh 1L capital)
const tradeCapital = 100000, targetPercent = 5;
const targetAmount = round(tradeCapital * targetPercent / 100);
const projCapital = round(tradeCapital + targetAmount);
const day1 = {
  dayIndex: 1, date: '2026-08-05', dateEnd: null, tradeCapital, targetPercent, targetAmount,
  projCapital, originalProjCapital: projCapital, actualCapital: round(tradeCapital + totalPnl),
  deviation: round(tradeCapital + totalPnl - projCapital), trades: merged, totalPnl, totalCharges,
  totalQty, instruments, status: 'ACTIVE', rating: 'future', channel: 'paper',
};
console.log(`Day 1: trades=${merged.length} totalPnl=${money(totalPnl)} charges=${money(totalCharges)} qty=${totalQty} instruments=${instruments.join(',')}`);

// 3) replace day_records: delete all paper, insert Day 1
const del = await db.collection('day_records').deleteMany({ channel: 'paper' });
await db.collection('day_records').insertOne(day1);
console.log(`deleted ${del.deletedCount} paper day_records, inserted clean Day 1`);

// 4) portfolio_state: back to day 1, fresh capital
const psUpd = await db.collection('portfolio_state').updateOne({ channel: 'paper' }, {
  $set: {
    currentDayIndex: 1, tradingPool: tradeCapital, reservePool: 0, targetPercent,
    cumulativePnl: totalPnl, cumulativeCharges: totalCharges, profitHistory: [],
  },
});
console.log(`portfolio_state updated: ${psUpd.modifiedCount}`);

// 5) position_state: all of today's trades -> dayIndex 1
const CUT_lo = Date.parse('2026-08-05T00:00:00+05:30'), CUT_hi = Date.parse('2026-08-06T00:00:00+05:30');
const posUpd = await db.collection('position_state').updateMany(
  { channel: 'paper', openedAt: { $gte: CUT_lo, $lt: CUT_hi } }, { $set: { dayIndex: 1 } },
);
console.log(`position_state trades re-homed to dayIndex 1: ${posUpd.modifiedCount}`);

const ps = await db.collection('portfolio_state').findOne({ channel: 'paper' });
const days = await db.collection('day_records').find({ channel: 'paper' }).toArray();
console.log(`\nAFTER: currentDayIndex=${ps.currentDayIndex} tradingPool=${money(ps.tradingPool)} reserve=${money(ps.reservePool)}  |  day_records paper: ${days.length}`);
await mongoose.disconnect();
