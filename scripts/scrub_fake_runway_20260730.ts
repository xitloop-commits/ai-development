/**
 * Remove today's FAKE Runway trades — the ones the nearTargetFrac=0 bug
 * instant-exited at open (banked half the target with no price move). Criterion:
 * exitStrategy=runway, opened 2026-07-30, held < 15s. Recomputes the day
 * aggregates and rolls the fakes' net P&L out of the trading pool. Backs up the
 * day record + capital state. Dry-run by default; --apply to write.
 */
import "dotenv/config";
import mongoose from "mongoose";
const APPLY = process.argv.includes("--apply");
const T = "2026-07-30";
const r2 = (n:number)=>Math.round(n*100)/100;
function istD(ms?:number|null){if(!ms)return "?";const d=new Date(ms+5.5*3600000);return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;}
function hms(ms?:number|null){if(!ms)return "-";const d=new Date(ms+5.5*3600000);return `${String(d.getUTCHours()).padStart(2,"0")}:${String(d.getUTCMinutes()).padStart(2,"0")}:${String(d.getUTCSeconds()).padStart(2,"0")}`;}
function recompute(day:any){
  const trades=day.trades??[]; const inst=new Set<string>(); let pnl=0,chg=0,qty=0,oc=0;
  for(const t of trades){inst.add(t.instrument);qty+=Math.abs(t.qty??0);
    if(t.status==="OPEN"){const dir=(t.type??"").includes("BUY")?1:-1;t.unrealizedPnl=r2((t.ltp-t.entryPrice)*t.qty*dir);pnl+=t.unrealizedPnl;chg+=t.charges??0;oc+=t.charges??0;}
    else{pnl+=t.pnl??0;chg+=t.charges??0;}}
  day.totalPnl=r2(pnl-oc);day.totalCharges=r2(chg);day.totalQty=qty;day.instruments=[...inst];
  day.actualCapital=r2((day.tradeCapital??0)+day.totalPnl);day.deviation=r2((day.tradeCapital??0)+day.totalPnl-(day.originalProjCapital??0));
  return day;
}
async function main(){
  await mongoose.connect(process.env.MONGODB_URI!);
  const db=mongoose.connection.db!;
  const dayCol=db.collection("day_records"); const psCol=db.collection("portfolio_state");
  const days=await dayCol.find({channel:"paper"}).toArray();
  const ps=await psCol.findOne({channel:"paper"});
  let removedNet=0, removedCount=0; const touched:any[]=[];
  for(const day of days){
    const trades=day.trades??[];
    const fakes=trades.filter((t:any)=>t.exitStrategy==="runway"&&istD(t.openedAt)===T&&t.openedAt&&t.closedAt&&(t.closedAt-t.openedAt)<15000);
    if(!fakes.length)continue;
    console.log(`\nday idx${day.dayIndex}: ${fakes.length} fake runway trades:`);
    for(const f of fakes) console.log(`  ${hms(f.openedAt)}→${hms(f.closedAt)} ${f.instrument} ${f.strike} ${f.type} entry=${f.entryPrice} exit=${f.exitPrice} pnl=${Math.round(f.pnl??0)} ${f.exitReason}`);
    removedNet+=fakes.reduce((s:number,t:any)=>s+(t.pnl??0),0); removedCount+=fakes.length;
    day.trades=trades.filter((t:any)=>!fakes.includes(t));
    recompute(day); touched.push(day);
  }
  console.log(`\nTOTAL: ${removedCount} fake runway trades, net ₹${Math.round(removedNet)} to roll out of the pool.`);
  console.log(`pool ${ps?.tradingPool} -> ${r2((ps?.tradingPool??0)-removedNet)}`);
  if(!APPLY){console.log("\nDRY RUN — re-run with --apply");await mongoose.disconnect();return;}
  if(removedCount===0){await mongoose.disconnect();return;}
  await db.collection("day_records_bak_scrub_20260730").insertMany(await dayCol.find({channel:"paper",dayIndex:{$in:touched.map(d=>d.dayIndex)}}).toArray());
  await db.collection("portfolio_state_bak_scrub_20260730").insertOne({...ps});
  for(const day of touched) await dayCol.updateOne({_id:day._id},{$set:{trades:day.trades,totalPnl:day.totalPnl,totalCharges:day.totalCharges,totalQty:day.totalQty,instruments:day.instruments,actualCapital:day.actualCapital,deviation:day.deviation}});
  await psCol.updateOne({_id:ps!._id},{$set:{tradingPool:r2((ps?.tradingPool??0)-removedNet)}});
  console.log("applied + backed up (*_bak_scrub_20260730).");
  await mongoose.disconnect();
}
main().catch(e=>{console.error(e);process.exit(1)});
