/**
 * reentryOnTrend.ts — re-enter a signal-cohort trade that got stopped out
 * (SL / MTP / TSL) while the trend was still running.
 *
 * WHY: the cohort detectors (SMA5, MA-Signal) are EDGE-triggered — they fire
 * LONG_CE only on the candle-close cross, then stay silent while price rides
 * above the line. So when the exit engine stops us out mid-trend, nothing
 * re-fires until a full flip-and-flip-back, and we sit out the rest of the move.
 *
 * WHAT: on a premature (strategy) exit of an AI signal-cohort trade, arm a short
 * timer. When it fires, if the detector hasn't FLIPPED since our exit (no
 * opposite-side or exit signal arrived), re-submit the SAME direction through
 * the normal entry chain (POST /validateTrade, origin=AI) — a fresh signal, in
 * effect: it re-sizes, re-prices, and re-checks every discipline gate. Capped
 * per leg so a chop can't churn.
 *
 * Config: CommonConfig.reentryOnTrend { enabled, windowSec, maxReentries }.
 * Keyed per LEG (instrument+cohort+side), channel-agnostic — an AI re-fire fans
 * to whichever books are on, exactly like the original signal, so we arm ONCE
 * per leg however many books' twins stopped out.
 */

import { createLogger } from "../broker/logger";
import { getCommonConfig } from "./aiModeConfig";
import { SeaSignalModel } from "../seaSignalStore";
import { logFolderFor } from "../seaSignals";
import type { Channel, TradeRecord } from "./state";

const log = createLogger("REENTRY");

/** Detectors this applies to (edge-triggered cross detectors). */
const SIGNAL_COHORTS = new Set(["sma5_signal", "ma_signal"]);
/** Exit reasons that count as a PREMATURE stop-out (not the model's own EXIT). */
const PREMATURE = new Set(["SL_HIT", "TSL_HIT", "TP_HIT"]);
/** Forget a leg's re-entry count after this idle gap → a later move is a new leg. */
const COUNT_RESET_MS = 10 * 60 * 1000;

type Side = "CE" | "PE";

interface LegState {
  timer: ReturnType<typeof setTimeout> | null; // pending arm (dedups double-arm)
  count: number; // re-entries placed for the current leg
  lastAt: number; // when the last re-entry was placed (for the reset window)
}

const legs = new Map<string, LegState>();

function sideOf(t: TradeRecord): Side | null {
  if (t.type.startsWith("CALL")) return "CE";
  if (t.type.startsWith("PUT")) return "PE";
  return null;
}

function exchangeOf(instrument: string): "NSE" | "MCX" {
  const k = instrument.toLowerCase();
  return k.includes("crude") || k.includes("natural") || k.includes("gas") ? "MCX" : "NSE";
}

/**
 * Arm a trend re-entry after a signal-cohort trade closes. Safe to call on every
 * close — it self-filters (feature off, wrong cohort/reason, hand trade, cap
 * reached, already armed) and never throws.
 */
export function armReentryOnTrend(closed: TradeRecord, channel: Channel, reason: string): void {
  try {
    const cfg = getCommonConfig().reentryOnTrend;
    if (!cfg?.enabled) return;
    if (!PREMATURE.has(reason)) return;
    const cohort = closed.cohort ?? "";
    if (!SIGNAL_COHORTS.has(cohort)) return;
    if ((closed.source ?? null) !== "ai") return; // AI-originated legs only
    const side = sideOf(closed);
    if (!side || closed.strike == null) return;

    const folder = logFolderFor(closed.instrument);
    const legKey = `${folder}:${cohort}:${side}`;
    const now = Date.now();
    let leg = legs.get(legKey);
    if (leg && now - leg.lastAt > COUNT_RESET_MS) leg = undefined; // stale → new leg
    if (!leg) { leg = { timer: null, count: 0, lastAt: now }; legs.set(legKey, leg); }

    if (leg.timer) return; // already armed for this leg — one re-entry in flight
    if (leg.count >= cfg.maxReentries) {
      log.info(`re-entry capped ${legKey} (${leg.count}/${cfg.maxReentries}) — skipping`);
      return;
    }

    const armAt = now;
    leg.timer = setTimeout(() => {
      leg!.timer = null;
      void fire(closed, channel, side, cohort, folder, legKey, armAt);
    }, Math.max(1, cfg.windowSec) * 1000);
    log.info(`re-entry armed ${legKey} in ${cfg.windowSec}s (after ${reason})`);
  } catch (err: any) {
    log.error(`armReentryOnTrend failed: ${err?.message ?? err}`);
  }
}

/** Did the detector flip since `sinceTs`? (an opposite-side entry or our-side
 *  exit signal was emitted) — if so the trend reversed and we must NOT re-enter. */
async function detectorFlipped(folder: string, cohort: string, side: Side, sinceTs: number): Promise<boolean> {
  const opposite: Side = side === "CE" ? "PE" : "CE";
  try {
    const rows = (await SeaSignalModel.find({ ts: { $gte: sinceTs }, cohort })
      .select("action instrument -_id")
      .lean()) as Array<{ action?: string; instrument?: string }>;
    return rows.some((r) => {
      if (logFolderFor(r.instrument ?? "") !== folder) return false;
      const a = String(r.action ?? "");
      return a === `EXIT_${side}` || a === `LONG_${opposite}`;
    });
  } catch {
    // On a store hiccup, be conservative and treat it as "flipped" (skip re-entry).
    return true;
  }
}

async function fire(
  closed: TradeRecord,
  channel: Channel,
  side: Side,
  cohort: string,
  folder: string,
  legKey: string,
  armAt: number,
): Promise<void> {
  try {
    const cfg = getCommonConfig().reentryOnTrend;
    if (!cfg?.enabled) return; // toggled off during the wait

    // Trend reversed? (detector flipped since we exited) → stand down, new leg.
    if (await detectorFlipped(folder, cohort, side, armAt)) {
      log.info(`re-entry stood down ${legKey} — detector flipped in the window`);
      legs.delete(legKey);
      return;
    }

    // Something already re-took this leg (a real cross re-entered, or a twin is
    // still open) → don't stack a duplicate.
    const { portfolioAgent } = await import("../portfolio");
    for (const ch of ["paper", "live"] as Channel[]) {
      const open = await portfolioAgent.listOpenTrades(ch).catch(() => []);
      if (open.some((t) => logFolderFor(t.instrument) === folder && (t.cohort ?? "") === cohort && sideOf(t) === side)) {
        log.info(`re-entry skipped ${legKey} — a ${side} ${cohort} position is already open on ${ch}`);
        return;
      }
    }

    const leg = legs.get(legKey);
    if (leg && leg.count >= cfg.maxReentries) return;

    const port = Number(process.env.PORT) || 3000;
    const secret = process.env.INTERNAL_API_SECRET ?? "";
    const payload = {
      executionId: `REARM-${closed.id}-${(leg?.count ?? 0) + 1}-${Date.now()}`,
      channel, // origin=AI re-fans to enabled books; posted channel is a seed
      origin: "AI" as const,
      instrument: closed.instrument,
      exchange: exchangeOf(closed.instrument),
      transactionType: "BUY" as const, // long options
      optionType: side,
      strike: closed.strike,
      expiry: closed.expiry ?? undefined,
      contractSecurityId: closed.contractSecurityId ?? undefined,
      entryPrice: closed.entryPrice > 0 ? closed.entryPrice : 1, // re-priced to live LTP on submit
      cohort,
      // T170 — mark this placement as a trend re-entry (#N of this leg) so the
      // desk row can badge + tint it distinctly from a fresh signal trade.
      reentryNo: (leg?.count ?? 0) + 1,
      stopLoss: null,
      takeProfit: null,
    };
    const resp = await fetch(`http://localhost:${port}/api/discipline/validateTrade`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(secret ? { "X-Internal-Token": secret } : {}) },
      body: JSON.stringify(payload),
    });
    const body: any = await resp.json().catch(() => ({}));
    const placed = resp.ok && (body?.success || body?.tradeId || body?.results?.some((r: any) => r.success));
    if (placed) {
      const l = legs.get(legKey) ?? { timer: null, count: 0, lastAt: Date.now() };
      l.count += 1; l.lastAt = Date.now();
      legs.set(legKey, l);
      log.important(`re-entry PLACED ${legKey} (#${l.count}/${cfg.maxReentries})`);
    } else {
      log.info(`re-entry not placed ${legKey} — ${body?.reason ?? `HTTP ${resp.status}`}`);
    }
  } catch (err: any) {
    log.error(`re-entry fire failed ${legKey}: ${err?.message ?? err}`);
  }
}

/** Test hook — clear all pending arms + counters. */
export function _resetReentryState(): void {
  for (const leg of Array.from(legs.values())) if (leg.timer) clearTimeout(leg.timer);
  legs.clear();
}
