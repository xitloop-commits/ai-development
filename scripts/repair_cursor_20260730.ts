/**
 * One-off (2026-07-30): the clawback rewound paper currentDayIndex to 1 while the
 * ACTIVE cycle is idx3 (holds all of 7-27..7-30's trades), so the desk showed an
 * empty "day 1". Point currentDayIndex back at the ACTIVE day so the desk shows
 * the live cycle again. The code fix (T145) stops the clawback rewinding the
 * cursor going forward. Dry-run by default; --apply to write (backs up first).
 */
import "dotenv/config";
import mongoose from "mongoose";
const APPLY = process.argv.includes("--apply");
async function main(){
  await mongoose.connect(process.env.MONGODB_URI!);
  const db=mongoose.connection.db!;
  const ps=await db.collection("portfolio_state").findOne({channel:"paper"});
  const active=await db.collection("day_records").findOne({channel:"paper",status:"ACTIVE"},{sort:{dayIndex:-1}});
  console.log(`currentDayIndex=${ps?.currentDayIndex}  activeDayIndex=${active?.dayIndex} (trades=${(active?.trades??[]).length})`);
  if(!active){console.log("no ACTIVE day — abort");await mongoose.disconnect();return;}
  if(ps?.currentDayIndex===active.dayIndex){console.log("already aligned — no change");await mongoose.disconnect();return;}
  console.log(`Would set currentDayIndex ${ps?.currentDayIndex} → ${active.dayIndex}`);
  if(!APPLY){console.log("DRY RUN — re-run with --apply");await mongoose.disconnect();return;}
  await db.collection("portfolio_state_bak_20260730").insertOne({...ps});
  await db.collection("portfolio_state").updateOne({_id:ps!._id},{$set:{currentDayIndex:active.dayIndex}});
  console.log(`applied. currentDayIndex=${active.dayIndex}. Backed up to portfolio_state_bak_20260730. Refresh the desk.`);
  await mongoose.disconnect();
}
main().catch(e=>{console.error(e);process.exit(1)});
