/**
 * ribbonGeometryRecorder — persists per-candle MA/SMA5 ribbon geometry for the
 * LOCKED/traded ATM contract into the `ribbon_geometry` time-series collection.
 *
 * A single server-side poll loop (Partha 2026-08-22):
 *   - Replay running → records that run's points (mode "replay" + runId) at the
 *     run's timeframe (fixed at start), capped at the sim clock.
 *   - Otherwise (real-time) → records mode "paper" AND "live" (same market data)
 *     at the signal-detector timeframe (common config).
 * Only CLOSED candles are written (the forming candle is left out), deduped by
 * remembering the last candle time per series. Same shared ribbon math the chart
 * uses, so recorded points match what's drawn.
 */
import mongoose from "mongoose";
import { RibbonGeometry, type RibbonMode, type RibbonSide, type RibbonSource } from "./ribbonGeometryModel";
import { bucketTicksToCandles } from "../../shared/candles";
import { maRibbonSignal } from "../../shared/chartLines";
import { getCommonConfig } from "../portfolio/aiModeConfig";
import { readOptionContractTicks } from "../chartData";
import { getLock } from "../portfolio/strikeLock";
import { getReplayLock } from "../replay/replayLock";
import { getReplayStatus, replayCutoffTs } from "../replay/tickReplay";
import { getActiveRunId, getRun } from "../replay/replayRuns";
import { createLogger } from "../broker/logger";

const log = createLogger("SEA", "RibbonGeom");

const SIDES: RibbonSide[] = ["CE", "PE"];
const SOURCES: RibbonSource[] = ["ma", "sma5"];
const POLL_MS = 5000;

/** Last recorded candle time (epoch sec) per series, so we insert only new,
 *  CLOSED candles. Keyed mode:runId:instrument:securityId:side:source:tf. */
const lastT = new Map<string, number>();
let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;

function todayIST(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

/** ticks ascending — count of entries with t <= cutoff (binary search). */
function countUpTo(t: number[], cutoff: number): number {
  if (!Number.isFinite(cutoff)) return t.length;
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] <= cutoff) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

interface Job {
  mode: RibbonMode;
  date: string;
  cutoff: number;
  tf: number;
  runId?: string;
  replay: boolean;
}

async function recordOnce(): Promise<void> {
  if (mongoose.connection.readyState !== 1) return;
  const common = getCommonConfig();
  const ta = common.trendAngle;
  const fixedRef = Math.max(ta.fixedPctPer45 || 0.2, 0.001);
  const enabled = Object.keys(common.instrumentEnabled ?? {}).filter(
    (k) => common.instrumentEnabled[k] !== false,
  );
  if (!enabled.length) return;

  const rp = getReplayStatus();
  const jobs: Job[] = [];
  if (rp.running && rp.date) {
    const runId = getActiveRunId() ?? undefined;
    let tf = common.sma5CandleSec;
    if (runId) {
      const run = await getRun(runId);
      if (run?.timeframeSec) tf = run.timeframeSec;
    }
    jobs.push({ mode: "replay", date: rp.date, cutoff: replayCutoffTs() ?? Infinity, tf, runId, replay: true });
  } else {
    const now = Date.now() / 1000;
    const tf = common.sma5CandleSec;
    jobs.push({ mode: "paper", date: todayIST(), cutoff: now, tf, replay: false });
    jobs.push({ mode: "live", date: todayIST(), cutoff: now, tf, replay: false });
  }

  for (const job of jobs) {
    for (const inst of enabled) {
      const lock = job.replay ? await getReplayLock(inst, job.date) : await getLock(inst);
      if (!lock) continue;
      for (const side of SIDES) {
        const leg = side === "CE" ? lock.ce : lock.pe;
        if (!leg?.securityId) continue;
        const raw = await readOptionContractTicks(inst, job.date, leg.securityId);
        if (!raw.t.length) continue;
        const end = countUpTo(raw.t, job.cutoff);
        if (end < 3) continue;
        const signal = bucketTicksToCandles(raw.t.slice(0, end), raw.ltp.slice(0, end), job.tf);
        if (signal.length < 2) continue;
        const closeByT = new Map(signal.map((c) => [c.t, c.close]));
        for (const source of SOURCES) {
          const buckets = maRibbonSignal(signal, { ...ta, source });
          if (buckets.length < 2) continue;
          const key = `${job.mode}:${job.runId ?? ""}:${inst}:${leg.securityId}:${side}:${source}:${job.tf}`;
          const seen = lastT.get(key) ?? 0;
          // Only fully CLOSED candles — drop the last (still-forming) bucket.
          const usable = buckets.slice(0, buckets.length - 1).filter((b) => b.t > seen);
          if (!usable.length) continue;
          const docs = usable.map((b) => ({
            t: new Date(b.t * 1000),
            meta: {
              instrument: inst,
              securityId: leg.securityId,
              side,
              strike: leg.strike,
              source,
              timeframeSec: job.tf,
              mode: job.mode,
              runId: job.runId,
              date: job.date,
            },
            line: b.line,
            close: closeByT.get(b.t) ?? b.line,
            slopePct: b.pct,
            deg: b.deg,
            geoDeg: (Math.atan(b.pct / fixedRef) * 180) / Math.PI,
            trend: b.trend,
          }));
          try {
            await RibbonGeometry.insertMany(docs, { ordered: false });
            lastT.set(key, usable[usable.length - 1].t);
          } catch (e) {
            log.warn(`insert failed (${key}): ${(e as Error)?.message ?? e}`);
          }
        }
      }
    }
  }
}

export function startRibbonGeometryRecorder(): void {
  if (timer) return;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await recordOnce();
    } catch (e) {
      log.warn(`recordOnce: ${(e as Error)?.message ?? e}`);
    } finally {
      busy = false;
    }
  };
  timer = setInterval(tick, POLL_MS);
  log.important("Ribbon-geometry recorder started");
}

export function stopRibbonGeometryRecorder(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
