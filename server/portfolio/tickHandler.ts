/**
 * Portfolio Agent — Tick Handler (was: pnlEngine)
 *
 * Internal service of PortfolioAgent. Subscribes to tickBus and feeds
 * open positions for mark-to-market + auto-exit on TP/SL.
 *
 * Lifecycle is owned by portfolioAgent.start() / stop(). Consumers should
 * use the portfolioAgent singleton — this module's `tickHandler` export
 * is for PA's internal use only.
 *
 * Flow: tickBus.on("tick") → match open trades → update LTP/P&L → persist
 *       → emit pnlUpdate (consumed by SSE / live UI)
 */
import { EventEmitter } from "events";
import { tickBus } from "../broker/tickBus";
import { createLogger } from "../broker/logger";
import {
  getCapitalState,
  getDayRecord,
  patchTradeInDay,
  patchDayAggregates,
  dayAggregateFields,
} from "./state";
import type { Channel, TradeRecord, CapitalState, DayRecord } from "./state";
import { recalculateDayAggregates, createDayRecord } from "./compounding";
import { getActiveRunId, getRun, updateRunTrades } from "../replay/replayRuns";
import { nowMs } from "../replay/tickReplay";
import { getExitConfig, getCommonConfig, type CandleAnchor, type SidewaysMode } from "./aiModeConfig";
import { nearestSupportBelow, computeSwingLevels } from "./swingLevels";
import { netPnlAtPrice, loadChargeRates } from "./netRsExit";
import { getActiveBrokerConfig } from "../broker/brokerConfig";
import type { TickData } from "../broker/types";

const log = createLogger("PA", "TickHandler");

// ─── Types ──────────────────────────────────────────────────────

export interface PnlSnapshot {
  channel: Channel;
  dayIndex: number;
  trades: Array<{
    id: string;
    instrument: string;
    ltp: number;
    unrealizedPnl: number;
    status: string;
  }>;
  totalPnl: number;
  updatedAt: number;
}

/**
 * Fired by tickHandler when an open paper trade hits its TP or SL on an
 * incoming tick. The actual close is the responsibility of the listener
 * (TEA), which routes through portfolioAgent.closeTrade — preserving the
 * single-writer invariant.
 */
export interface AutoExitEvent {
  channel: Channel;
  tradeId: string;
  reason: "TP_HIT" | "SL_HIT" | "TSL_HIT";
  exitPrice: number;
  timestamp: number;
}

/**
 * LIVE-only (Super Order trades): fired once when the gated trailing stop should
 * arm at the broker. TEA listens and modifies the STOP_LOSS_LEG (move to
 * breakeven + set native trailingJump). Single-writer: TEA owns the broker call.
 */
export interface BrokerTslArmEvent {
  channel: Channel;
  tradeId: string;
}

/**
 * LIVE-only (Super Order trades): fired (throttled) when the trailing
 * take-profit should ratchet up. TEA listens and modifies the TARGET_LEG,
 * applying its own throttle + the per-order modify-cap budget.
 */
export interface BrokerTpRatchetEvent {
  channel: Channel;
  tradeId: string;
  targetPrice: number;
}

/** Channels whose open trades get tick-driven MTM + auto-SL/TP. */
const TICK_CHANNELS: Channel[] = ["paper", "live"];

// ─── Instrument → Trade Mapping ─────────────────────────────────

/**
 * Maps instrument names to the securityId used in tick data.
 * For now, trades use instrument names (NIFTY_50, BANKNIFTY, etc.)
 * and ticks use the same names as securityId in mock mode.
 * For Dhan, the adapter resolves securityId from scrip master.
 */
export function tickMatchesTrade(tick: TickData, trade: TradeRecord): boolean {
  // Option trades with a specific contract: ONLY match via contractSecurityId.
  // This prevents underlying-price ticks from being applied to option trades where
  // TP/SL prices are expressed in option-premium terms (CE and PE behave identically
  // in premium space — both profit when premium rises for BUY, falls for SELL).
  if (trade.contractSecurityId) {
    return tick.securityId === trade.contractSecurityId;
  }

  // Direct match: securityId equals instrument name
  if (tick.securityId === trade.instrument) return true;

  // Underlying instrument name aliases (futures / non-option trades)
  const nameMap: Record<string, string[]> = {
    NIFTY_50:   ["NIFTY_50", "NIFTY 50", "NIFTY"],
    BANKNIFTY:  ["BANKNIFTY", "BANK NIFTY", "BANK_NIFTY"],
    CRUDEOIL:   ["CRUDEOIL", "CRUDE OIL", "CRUDE_OIL"],
    NATURALGAS: ["NATURALGAS", "NATURAL GAS", "NATURAL_GAS"],
  };

  for (const [, aliases] of Object.entries(nameMap)) {
    if (aliases.includes(tick.securityId) && aliases.includes(trade.instrument)) {
      return true;
    }
  }

  return false;
}

// ─── Tick Handler (formerly PnlEngine) ─────────────────────────
//
// Subscribes to tickBus and feeds open positions for MTM + auto-exit on
// TP/SL. Owned by PortfolioAgent — see portfolioAgent.start() / stop().
// Emits "pnlUpdate" snapshots that downstream UI consumers can subscribe
// to for live P&L. Class kept as a self-contained service so PA can
// orchestrate lifecycle without a circular dep.

/**
 * Per-channel snapshot cached by `processPendingUpdates` so a 500ms tick
 * batch on a quiet channel (no open trades, or no tick→trade match) does
 * not hit Mongo on every call. Invalidated on TTL expiry or whenever a
 * trade matched in the last batch (so persisted state is re-read fresh).
 */
interface ChannelStateCache {
  state: CapitalState;
  day: DayRecord | null;
  brokerConfig: Awaited<ReturnType<typeof getActiveBrokerConfig>>;
  expiresAt: number;
}

const STATE_CACHE_TTL_MS = 2000;
// Exit detection runs per-tick (live), but the Mongo P&L/LTP write is throttled
// to at most once per channel per this interval — same write cadence as the old
// 500ms batch, just decoupled from detection so stops react instantly.
const PERSIST_THROTTLE_MS = 500;

// Trailing take-profit (active only when the trailing stop is enabled): keep the
// target this many % ahead of the LTP's high-water mark, ratcheting in the
// favorable direction only (never retreats). Lets a winner run — the trailing
// stop books the exit on a reversal; the TP only fires on a single-tick gap past it.
// Trailing take-profit % now lives in the shared Sprint exit config (AI menu).

// LIVE only — min gap between broker TP-ratchet emits per trade (TEA also caps
// total modifies per order). Keeps us well under Dhan's 25-modify-per-order limit.
const TP_EMIT_THROTTLE_MS = 30_000;

// Entry-pending grace window: how long to wait for the first live tick to fill a
// placeholder entry before giving up and keeping the snapshot price.
const ENTRY_FILL_TIMEOUT_MS = 15_000;

// Exit-retry window (T86 β): once an exit is emitted the trade is guarded so the
// same exit doesn't fire every tick while TEA closes it. But if the close never
// completes (executor error / lost event) the trade would stay OPEN and guarded
// forever. So the guard is TIME-BOXED — after this long still OPEN, the exit is
// re-detected and re-emitted (a normal close finishes in ms).
const EXIT_RETRY_MS = 30_000;

/** Per-trade state for the dynamic candle-based honour-exit TSL. Aggregates the
 *  option-premium ticks into 1-min candles, computes each candle's Heikin-Ashi
 *  open/close (same recursion as sma5_signal.py so it matches the HA chart), and
 *  keeps a rolling buffer of completed HA candles plus the ratcheted stop. */
interface DynTslCandleState {
  minute: number | null;          // current 1-min bucket (epoch seconds // 60)
  o: number; h: number; l: number; c: number; // in-progress raw OHLC
  haOpenPrev: number | null;      // prior HA open  (recursive)
  haClosePrev: number | null;     // prior HA close (recursive)
  completed: Array<{ open: number; close: number; high: number; low: number; t?: number }>; // completed candles (rolling); t = bucket start epoch sec
  stop: number | null;            // ratcheted trailing level (never loosens)
  /** T167 — progress candles only (for the candle-TSL sideways="ignore" mode).
   *  A completed candle enters here ONLY when it makes a new favourable extreme
   *  (new high for a long / new low for a short) vs `runFav`. The x-back trail
   *  then counts progress candles, so the stop HOLDS through sideways chop and
   *  steps up only on a genuine new high. Unused when sideways="count". */
  progress?: Array<{ open: number; close: number; high: number; low: number; t?: number }>;
  /** T167 — running favourable extreme across counted candles (the high-water
   *  mark that decides whether a new candle is "progress" vs "sideways"). */
  runFav?: number | null;
  /** T167 viz — bucket-start epoch-sec of the candle the current stop is anchored
   *  to (the x-back candle), for the chart to outline it. */
  anchorTime?: number | null;
  /** T167 viz — bucket-start epoch-secs of the sideways candles that were
   *  IGNORED (rolling, bounded), for the chart to dim them. */
  ignoredTimes?: number[];
  /** History-seed status (2026-08-14, Partha: "the candles already exist").
   *  A fresh state kicks a one-shot async seed from the option-day index so
   *  the x-back trail exists from the trade's FIRST tick instead of waiting
   *  xBack live minutes. "pending" while the fetch runs; "done"/"failed"
   *  after. Failure = today's behaviour (warm from entry). */
  seed?: "pending" | "done" | "failed";
  /** TSL config fingerprint (xBack|candle_sec|anchor|useHa|sideways) the state
   *  was built with. When the common TSL config changes mid-trade, the state is
   *  rebuilt so the new settings apply to OPEN trades (Partha 2026-08-24). */
  cfgSig?: string;
}

class TickHandler extends EventEmitter {
  private running = false;
  /** Latest tick per instrument key, drained each processing pass. */
  private pendingUpdates = new Map<string, TickData>();
  /** Serialize processing passes so async updateChannel calls never overlap. */
  private processing = false;
  private hasPending = false;
  /** tradeId → epoch ms the exit was last emitted. Stops the per-tick detector
   *  firing duplicate exits while TEA closes it; TIME-BOXED (EXIT_RETRY_MS) so a
   *  close that never completes gets re-detected instead of stuck forever (T86 β).
   *  Pruned when the trade leaves the OPEN set. */
  private exitingTrades = new Map<string, number>();
  /** Last Mongo-persist time per channel — throttles the P&L write. */
  private lastPersistAt = new Map<Channel, number>();
  /** Track peak price per trade for trailing stop logic. Key = tradeId */
  private peakPrices = new Map<string, number>();
  /** Trailing-stop activation gate: tradeId → epoch ms when price first cleared
   *  the gate. Cleared if the gate breaks before the hold elapses. */
  private tslArmedAt = new Map<string, number>();
  /** Trailing-stop activated set: tradeIds whose gate held long enough. Once in,
   *  the stop trails (floored at breakeven) for the rest of the trade's life. */
  private tslActivated = new Set<string>();
  /** LADDER (T147) TSL-arm clock: tradeId → the ms epoch price last crossed into
   *  favour and has since stayed there (cleared the moment it drops back to
   *  at-or-against entry). ladderDecide arms the TSL after tslArmSec of it. */
  private ladderFavSince = new Map<string, number>();
  /** Dynamic candle-based TSL state per trade (ladder honour-exit, "candles"
   *  mode). Builds the option-premium 1-min Heikin-Ashi candles from ticks and
   *  keeps the ratcheted-up trailing level. Key = tradeId. */
  private dynTslState = new Map<string, DynTslCandleState>();
  /** Zone-timer clock: tradeId → ms epoch of the last tick, used to accumulate
   *  msBelowEntry / msAboveEntry (time underwater vs in profit) per trade. */
  private zoneLastTickAt = new Map<string, number>();
  /** LIVE only — last time we emitted a broker TP-ratchet for a trade. Throttles
   *  the emit so we don't flood TEA (which also enforces the per-order modify cap). */
  private lastTpEmitAt = new Map<string, number>();
  /** Per-channel cache of (capital, day, broker config). See ChannelStateCache. */
  private readonly stateCache = new Map<Channel, ChannelStateCache>();

  constructor() {
    super();
    this.setMaxListeners(50);
  }

  /** Dynamic candle-based honour-exit TSL. Feed each option-premium tick; on a
   *  1-min candle close it finalises the HA candle, then sets the trailing stop
   *  to the HA open/close of the candle `xBack` bars ago, ratcheting UP only (a
   *  premium-long option: CE and PE both profit as the premium rises, so the stop
   *  always sits below price and never loosens). Returns the current level, or
   *  null during warmup (fewer than `xBack` completed candles). Pure per-trade
   *  state — no exit decision here; ladderDecide reads the level via dynTslLevel.
   *
   *  HA recursion mirrors sma5_signal.py exactly, so the levels match the HA chart. */
  private dynTslLevel(
    tradeId: string,
    lttSec: number,
    ltp: number,
    isBuy: boolean,
    xBack: number,
    src: CandleAnchor,
    useHa: boolean,
    candleSec: number,
    instrument?: string,
    securityId?: string | null,
    sideways: SidewaysMode = "count",
    maxGapPct: number = 0,
  ): { level: number | null; closedBelow: boolean } {
    // Candle size in seconds — matches the trade's SIGNAL timeframe (2026-08-18:
    // was hardcoded 60s / 1-min; now the SMA5/MA candle_sec so "everything works
    // on the same candle"). Guard against a bad value.
    const cs = Number.isFinite(candleSec) && candleSec >= 1 ? Math.round(candleSec) : 60;
    // Fingerprint the state-shaping TSL config. If it changed since this trade's
    // state was built (operator edited xBack / timeframe / anchor / sideways in
    // common settings), DROP the state so it rebuilds on the new config — the
    // change then applies to the OPEN trade. (value/mode/enabled are read live.)
    const cfgSig = `${Math.max(1, xBack)}|${cs}|${src}|${useHa ? 1 : 0}|${sideways}`;
    let cur = this.dynTslState.get(tradeId);
    if (cur && cur.cfgSig !== undefined && cur.cfgSig !== cfgSig) {
      this.dynTslState.delete(tradeId);
      cur = undefined;
    }
    if (!Number.isFinite(lttSec) || !Number.isFinite(ltp)) return { level: cur?.stop ?? null, closedBelow: false };
    let st = cur;
    if (!st) {
      st = { minute: null, o: ltp, h: ltp, l: ltp, c: ltp, haOpenPrev: null, haClosePrev: null, completed: [], stop: null, progress: [], runFav: null, cfgSig };
      this.dynTslState.set(tradeId, st);
      // History seed (2026-08-14): the chart's candles exist before entry —
      // use them, so the x-back trail is live from the first tick.
      if (instrument && securityId) {
        st.seed = "pending";
        void this.seedDynTsl(tradeId, st, instrument, securityId, Math.floor(lttSec / cs), isBuy, xBack, src, useHa, cs, sideways, ltp);
      }
    }
    const minute = Math.floor(lttSec / cs);
    if (st.minute === null) {
      st.minute = minute;
      st.o = st.h = st.l = st.c = ltp;
      return { level: st.stop, closedBelow: false };
    }
    if (minute === st.minute) {
      st.c = ltp;
      if (ltp > st.h) st.h = ltp;
      if (ltp < st.l) st.l = ltp;
      return { level: st.stop, closedBelow: false }; // intra-candle: level frozen, never a close-breach
    }
    // A new minute began → the current candle just CLOSED. Take its open/close as
    // Heikin-Ashi (smoother) or RAW (matches a raw candlestick chart) per config.
    let candleClose: number;
    let candleOpen: number;
    if (useHa) {
      candleClose = (st.o + st.h + st.l + st.c) / 4;
      candleOpen = st.haOpenPrev === null ? (st.o + st.c) / 2 : (st.haOpenPrev + (st.haClosePrev as number)) / 2;
      st.haOpenPrev = candleOpen;
      st.haClosePrev = candleClose;
    } else {
      candleOpen = st.o;   // raw open  = first tick of the minute
      candleClose = st.c;  // raw close = last tick of the minute
    }
    // Close-confirmed breach: did THIS candle close beyond the level that was live
    // DURING it (i.e. before this candle ratchets it)? Intra-candle wicks are
    // ignored — only the close counts. `closedBelow` is a one-tick pulse.
    const levelDuringCandle = st.stop;
    const closedBelow = levelDuringCandle !== null && (isBuy ? candleClose < levelDuringCandle : candleClose > levelDuringCandle);
    const rec = { open: candleOpen, close: candleClose, high: st.h, low: st.l, t: st.minute * cs };
    st.completed.push(rec);
    // Keep only what the lookback needs (plus a little slack).
    const keep = Math.max(Math.max(1, xBack) + 2, 120); // keep ~120 for swing highs (Next-T TP)
    if (st.completed.length > keep) st.completed.splice(0, st.completed.length - keep);
    // T167 — track "progress" candles (those making a new favourable extreme vs
    // runFav) so the sideways="ignore" mode can x-back over progress candles only.
    // In "count" mode this list is unused and the path below is byte-identical to
    // pre-T167 (open/close over st.completed).
    const fav = isBuy ? rec.high : rec.low;
    if (st.runFav == null || (isBuy ? fav > st.runFav : fav < st.runFav)) {
      st.runFav = fav;
      (st.progress ??= []).push(rec);
      if (st.progress.length > keep) st.progress.splice(0, st.progress.length - keep);
    } else if (sideways === "ignore") {
      // Viz — remember the IGNORED (sideways) candle so the chart can dim it.
      (st.ignoredTimes ??= []).push(rec.t);
      if (st.ignoredTimes.length > 240) st.ignoredTimes.splice(0, st.ignoredTimes.length - 240);
    }
    // Candidate = the chosen O/H/L/C of the candle `xBack` bars back (1 = the
    // candle that just closed). In "ignore" mode we count progress candles only,
    // so the stop HOLDS through sideways chop. Ratchet UP only — a lower candle
    // never loosens it.
    // Prefer the progress list (sideways=ignore), but FALL BACK to all completed
    // candles when there aren't yet `xBack` progress candles — so the trailing
    // stop ALWAYS has a level (a trade is never left with no TSL). Fixed 2026-08-23.
    const primary = sideways === "ignore" ? (st.progress ?? []) : st.completed;
    const arr = primary.length >= Math.max(1, xBack) ? primary : st.completed;
    const idx = Math.max(0, arr.length - Math.max(1, xBack));
    if (arr.length > 0) {
      const c0 = arr[idx];
      st.anchorTime = c0.t ?? null; // viz — the candle the stop is pinned to
      let candidate = src === "open" ? c0.open : src === "close" ? c0.close : src === "high" ? c0.high : c0.low;
      // T167 loose-cap: if the anchored stop lags more than maxGapPct% below the
      // current premium (for a long), tighten it to the x-back candle's HIGH so
      // the trail never sits that far behind price. (Short: tighten to the LOW.)
      if (maxGapPct > 0 && ltp > 0) {
        const gap = isBuy ? (ltp - candidate) / ltp : (candidate - ltp) / ltp;
        if (gap > maxGapPct / 100) candidate = isBuy ? c0.high : c0.low;
      }
      if (st.stop === null) st.stop = candidate;
      else st.stop = isBuy ? Math.max(st.stop, candidate) : Math.min(st.stop, candidate);
    }
    // Start the next candle.
    st.minute = minute;
    st.o = st.h = st.l = st.c = ltp;
    return { level: st.stop, closedBelow };
  }

  /** One-shot history seed for a fresh candle-TSL state (2026-08-14, Partha:
   *  "TSL looks backward — the candles already exist"). Reads the contract's
   *  session ticks from the option-day index (instant), builds the 1-min
   *  candles STRICTLY BEFORE the trade's first live minute with the HA
   *  recursion run from the session start (matches the chart), then merges:
   *  seeded candles are prepended, the HA hand-off is applied only if no live
   *  candle completed meanwhile, and the stop is the ratcheted x-back value
   *  over the merged history (never loosening an existing level). Best-effort:
   *  any failure leaves the legacy warm-from-entry behaviour. */
  private async seedDynTsl(
    tradeId: string,
    st: DynTslCandleState,
    instrument: string,
    securityId: string,
    firstLiveMinute: number,
    isBuy: boolean,
    xBack: number,
    src: CandleAnchor,
    useHa: boolean,
    candleSec: number,
    sideways: SidewaysMode = "count",
    entry: number = 0,
  ): Promise<void> {
    try {
      const cs = Number.isFinite(candleSec) && candleSec >= 1 ? Math.round(candleSec) : 60;
      const { readOptionContractTicks } = await import("../chartData");
      const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
      const ticks = await readOptionContractTicks(instrument, today, securityId);
      // The trade may have closed (state dropped) while we fetched.
      if (this.dynTslState.get(tradeId) !== st) return;
      const n = Math.min(ticks.t.length, ticks.ltp.length);
      if (n === 0) { st.seed = "failed"; return; }
      // Raw candles (at the signal timeframe) for buckets BEFORE the first live one.
      type C = { minute: number; o: number; h: number; l: number; c: number };
      const raw: C[] = [];
      for (let i = 0; i < n; i++) {
        const m = Math.floor(ticks.t[i] / cs);
        if (m >= firstLiveMinute) break; // arrays are chronological
        const p = ticks.ltp[i];
        if (!(p > 0)) continue;
        const last = raw[raw.length - 1];
        if (!last || last.minute !== m) raw.push({ minute: m, o: p, h: p, l: p, c: p });
        else { last.c = p; if (p > last.h) last.h = p; if (p < last.l) last.l = p; }
      }
      if (raw.length === 0) { st.seed = "failed"; return; }
      // HA recursion from the session start — same maths as the live path.
      const seeded: Array<{ open: number; close: number; high: number; low: number; t: number }> = [];
      let haOpenPrev: number | null = null;
      let haClosePrev: number | null = null;
      for (const k of raw) {
        let open: number;
        let close: number;
        if (useHa) {
          close = (k.o + k.h + k.l + k.c) / 4;
          open = haOpenPrev === null ? (k.o + k.c) / 2 : (haOpenPrev + (haClosePrev as number)) / 2;
          haOpenPrev = open;
          haClosePrev = close;
        } else {
          open = k.o;
          close = k.c;
        }
        seeded.push({ open, close, high: k.h, low: k.l, t: k.minute * cs });
      }
      // Merge: seeded history strictly precedes anything the live path built.
      const noLiveCandleYet = st.completed.length === 0;
      st.completed = [...seeded, ...st.completed];
      if (useHa && noLiveCandleYet && st.haOpenPrev === null) {
        st.haOpenPrev = haOpenPrev;   // continue the chart-accurate recursion
        st.haClosePrev = haClosePrev;
      }
      // T167 — rebuild the progress list + runFav over the merged history so the
      // sideways="ignore" x-back has its pre-entry progress candles too.
      st.progress = [];
      st.runFav = null;
      for (const c of st.completed) {
        const f = isBuy ? c.high : c.low;
        if (st.runFav == null || (isBuy ? f > st.runFav : f < st.runFav)) {
          st.runFav = f;
          st.progress.push(c);
        }
      }
      // Viz — dim the pre-entry sideways (ignored) candles too.
      if (sideways === "ignore") {
        const progT = new Set(st.progress.map((c) => c.t));
        st.ignoredTimes = st.completed
          .filter((c) => c.t != null && !progT.has(c.t))
          .map((c) => c.t as number)
          .slice(-240);
      }
      // Seed the stop from the x-back candle AS OF ENTRY — the candle `back` bars
      // before the first live candle — NOT a ratchet-max over the whole session.
      // The old loop took Math.max over every pre-entry candle, which latched the
      // DAY'S HIGH premium as the "trailing stop", so a trade that entered hours
      // later at a lower price got a stop far above its own entry/peak (phantom
      // "Secured" profit, exit on candle 1). Fixed 2026-08-18. Ratcheting forward
      // is the live path's job; here we only set the starting level.
      // Rider support-start (T171): place the INITIAL stop at the nearest swing LOW
      // below entry (a real support). Fall back to the x-back candle low if no
      // swing support exists yet. From the next candle on, the live path trails
      // the x-back candle low as usual.
      const support = isBuy && entry > 0
        ? nearestSupportBelow(st.completed.map((c) => ({ t: c.t ?? 0, high: c.high, low: c.low })), entry, 2)
        : null;
      const back = Math.max(1, xBack);
      // Prefer the progress list (sideways=ignore); fall back to ALL completed
      // candles when there aren't yet `back` progress candles, so a stop ALWAYS
      // seeds at entry (never a null/absent TSL). Fixed 2026-08-23.
      const primary = sideways === "ignore" ? st.progress : st.completed;
      const seedArr = primary.length >= back ? primary : st.completed;
      const idx = Math.max(0, seedArr.length - back); // the x-back candle at the entry boundary
      if (support != null) {
        st.stop = st.stop === null ? support : isBuy ? Math.max(st.stop, support) : Math.min(st.stop, support);
        const supCandle = st.completed.find((c) => c.low === support);
        st.anchorTime = supCandle?.t ?? null; // viz — pin to the support candle
      } else if (seedArr.length > 0) {
        const c0 = seedArr[idx];
        st.anchorTime = c0.t ?? null; // viz — the candle the seeded stop is pinned to
        const cand = src === "open" ? c0.open : src === "close" ? c0.close : src === "high" ? c0.high : c0.low;
        st.stop = st.stop === null ? cand : isBuy ? Math.max(st.stop, cand) : Math.min(st.stop, cand);
      }
      // Trim to the rolling window the live path maintains.
      const keep = Math.max(back + 2, 120); // keep ~120 for swing highs (Next-T TP)
      if (st.completed.length > keep) st.completed.splice(0, st.completed.length - keep);
      if (st.progress.length > keep) st.progress.splice(0, st.progress.length - keep);
      st.seed = "done";
    } catch {
      st.seed = "failed"; // legacy warm-from-entry behaviour
    }
  }

  /** T167 viz — read the candle-TSL highlight state for a trade: the anchor
   *  candle's bucket time (to outline gold on the chart) + the ignored sideways
   *  candle times (to dim). Empty when the trade has no candle-TSL state. */
  private dynTslViz(tradeId: string): { anchorTime: number | null; ignoredTimes: number[] } {
    const st = this.dynTslState.get(tradeId);
    return { anchorTime: st?.anchorTime ?? null, ignoredTimes: st?.ignoredTimes ?? [] };
  }

  /** T171 Next-T TP — swing HIGH prices for a trade, from the same candle history
   *  the candle-TSL keeps (~120 bars). Empty until the trade has candle state. */
  private dynTslSwingHighs(tradeId: string): number[] {
    const st = this.dynTslState.get(tradeId);
    if (!st || !st.completed.length) return [];
    const bars = st.completed.map((c) => ({ t: c.t ?? 0, high: c.high, low: c.low }));
    return computeSwingLevels(bars, 2, 8).highs.map((h) => h.price);
  }

  /** Drop the per-channel state cache. Pass a channel to drop just that one — used
   *  after a manual trade edit so the next tick re-reads the trade FRESH (with the
   *  new SL/TP + slOverridden/tpOverridden), instead of recomputing over the edit
   *  from a stale cached copy and re-persisting the old level. */
  clearStateCache(channel?: Channel): void {
    if (channel) this.stateCache.delete(channel);
    else this.stateCache.clear();
  }

  /** Push a manual SL/TP price edit into the LIVE cached day so the per-tick
   *  reconcile copies the edited value rather than the stale cached one. Without
   *  this a user's TP/SL edit is clobbered on the next persist (the reconcile
   *  copies live.targetPrice/stopLossPrice onto the fresh DB read). No-op when
   *  the channel isn't cached (next read is fresh anyway). */
  applyTradeEdit(
    channel: Channel,
    tradeId: string,
    patch: {
      stopLossPrice?: number | null;
      targetPrice?: number | null;
      stopLossDisabled?: boolean;
      targetDisabled?: boolean;
      tslMode?: "auto" | "manual";
      manualExitOnly?: boolean;
      /** T171 — collapsed to "rider"; mirrored here so a per-tick persist keeps it. */
      exitStrategy?: string;
    },
  ): void {
    const cached = this.stateCache.get(channel);
    if (!cached || !cached.day) return;
    const trade = cached.day.trades.find((t) => t.id === tradeId);
    if (!trade) return;
    // Mirror the edit onto the LIVE cached trade so the per-tick persist writes
    // the new value instead of clobbering it back to the cached one. Covers the
    // risk-flag toggles too (SL/TP-disable, TSL mode, manual-exit-only) — without
    // this the flag "moves then resets" every tick.
    if (patch.stopLossPrice !== undefined) trade.stopLossPrice = patch.stopLossPrice;
    if (patch.targetPrice !== undefined) trade.targetPrice = patch.targetPrice;
    if (patch.exitStrategy !== undefined) trade.exitStrategy = patch.exitStrategy;
    if (patch.stopLossDisabled !== undefined) trade.stopLossDisabled = patch.stopLossDisabled;
    if (patch.targetDisabled !== undefined) trade.targetDisabled = patch.targetDisabled;
    if (patch.tslMode !== undefined) trade.tslMode = patch.tslMode;
    if (patch.manualExitOnly !== undefined) trade.manualExitOnly = patch.manualExitOnly;
  }

  private async getChannelStateCached(channel: Channel): Promise<ChannelStateCache | null> {
    const now = Date.now();
    const cached = this.stateCache.get(channel);
    if (cached && cached.expiresAt > now) return cached;

    // T97 — while a replay run is open it OWNS the `paper` tick slot: the run's
    // trades get the exits, and the real paper book is left frozen.
    //
    // That freeze is deliberate, not a side effect. The ticks arriving during a
    // replay are RECORDED prices from another day; marking genuine paper
    // positions to them would corrupt real P&L with fictional quotes. No new
    // paper trades can appear either — appendTrade redirects them to the run.
    const runId = getActiveRunId();
    if (runId && channel === "paper") {
      const run = await getRun(runId);
      if (!run) return null;
      const day = {
        ...createDayRecord(1, run.openingCapital, 5, run.openingCapital, channel, "ACTIVE"),
        trades: run.trades ?? [],
      };
      const brokerConfig = await getActiveBrokerConfig();
      const entry: ChannelStateCache = {
        state: { tradingPool: run.openingCapital, reservePool: 0, currentDayIndex: 1 } as CapitalState,
        day,
        brokerConfig,
        expiresAt: now + STATE_CACHE_TTL_MS,
      };
      this.stateCache.set(channel, entry);
      return entry;
    }

    let state: CapitalState;
    try {
      state = await getCapitalState(channel);
    } catch {
      return null; // DB not connected
    }
    const day = await getDayRecord(channel, state.currentDayIndex);
    const brokerConfig = await getActiveBrokerConfig();
    const entry: ChannelStateCache = { state, day, brokerConfig, expiresAt: now + STATE_CACHE_TTL_MS };
    this.stateCache.set(channel, entry);
    return entry;
  }

  /** Start listening to tick bus */
  start(): void {
    if (this.running) return;
    this.running = true;
    tickBus.on("tick", this.handleTick);
    log.important("Started — listening for ticks");
  }

  /** Stop listening */
  stop(): void {
    this.running = false;
    tickBus.off("tick", this.handleTick);
    this.pendingUpdates.clear();
    this.hasPending = false;
    log.important("Stopped");
  }

  /** Handle incoming tick — process live (per tick). Exit detection runs every
   *  tick; the Mongo write inside is throttled, so DB load stays bounded. */
  private handleTick = (tick: TickData): void => {
    const key = `${tick.exchange}:${tick.securityId}`;
    this.pendingUpdates.set(key, tick);
    this.scheduleProcess();
  };

  /** Run a processing pass now if idle; otherwise note that more ticks arrived
   *  mid-pass and re-run once the current pass finishes. Guarantees a single
   *  in-flight updateChannel chain at a time — no cache/DB races. */
  private scheduleProcess(): void {
    if (this.processing) {
      this.hasPending = true;
      return;
    }
    this.processing = true;
    void this.processPendingUpdates().finally(() => {
      this.processing = false;
      if (this.hasPending) {
        this.hasPending = false;
        this.scheduleProcess();
      }
    });
  };

  /** Process all pending tick updates */
  private async processPendingUpdates(): Promise<void> {
    const ticks = Array.from(this.pendingUpdates.values());
    this.pendingUpdates.clear();

    if (ticks.length === 0) return;

    // Update every channel that gets MTM-driven updates.
    //
    // T97 — while a replay run is open, `paper` is substituted for the run and
    // the LIVE books are skipped entirely. These ticks are recorded prices from
    // another day: marking a real live / live position to them would show
    // fictional P&L and, worse, could trip its SL/TP and fire a REAL exit order
    // at a price that never existed today.
    const replaying = getActiveRunId() != null;
    for (const channel of TICK_CHANNELS) {
      if (replaying && channel !== "paper") continue;
      try {
        await this.updateChannel(channel, ticks);
      } catch (err) {
        // Silently skip — DB might not be connected
      }
    }
  }

  /** Update open trades in a channel with new tick data */
  private async updateChannel(
    channel: Channel,
    ticks: TickData[]
  ): Promise<void> {
    const cached = await this.getChannelStateCached(channel);
    if (!cached) return; // DB not connected
    const { state, day, brokerConfig } = cached;
    if (!day) return;

    const openTrades = day.trades.filter((t) => t.status === "OPEN");
    if (openTrades.length === 0) return;

    // Prune the exit guard: drop ids for trades TEA has since closed (no longer
    // in the open set) so the guard can't leak or block a future re-open.
    if (this.exitingTrades.size > 0) {
      const openIds = new Set(openTrades.map((t) => t.id));
      this.exitingTrades.forEach((_ts, id) => {
        if (!openIds.has(id)) this.exitingTrades.delete(id);
      });
    }
    // Same for the dynamic-TSL candle state — drop any trade no longer open so
    // its per-trade candle buffer can't leak across the day (any close route).
    if (this.dynTslState.size > 0) {
      const openIds = new Set(openTrades.map((t) => t.id));
      this.dynTslState.forEach((_st, id) => {
        if (!openIds.has(id)) this.dynTslState.delete(id);
      });
    }

    // Dhan-managed trailing config (the `sprint` sub-config) — only used on the
    // Dhan-managed path below to arm the broker-side super-order TSL. The
    // Lubas-managed exit is the Master block (Rider).
    const sprintCfg = getExitConfig(channel).sprint;
    const trailingStopEnabled = sprintCfg.trailingStopEnabled;
    const trailingStopPercent = sprintCfg.trailingStopPercent;
    // Trailing distance source: "config" = fixed gap% below the peak;
    // "signal" = the trade's own initial (model) SL distance.
    const trailingDistanceSource = sprintCfg.trailingDistanceSource;
    const tslGatePercent = sprintCfg.trailingActivationGatePercent;
    const tslHoldMs = sprintCfg.trailingActivationHoldSeconds * 1000;

    // T141 — master SL/TP/TSL (Rider, common block): the ONLY exit model now.
    // The charge-rate table (net-₹ math) is loaded once per batch (cached ~60s),
    // only when a master ₹-mode side is on — no cost for the all-% common case.
    const cc = getCommonConfig();
    const master = cc.masterExits;
    const mTP = master.tp.enabled, mSL = master.sl.enabled, mTSL = master.tsl.enabled;
    const masterNeedsRates =
      (mTP && master.tp.tpMode === "fixed" && master.tp.mode === "rupees") ||
      (mSL && master.sl.mode === "rupees") ||
      // TSL needs the rate table only in the ₹ peak-clamp mode (candle mode is
      // price-based; % mode is premium-based).
      (mTSL && master.tsl.trailMode === "peak" && master.tsl.mode === "rupees");

    const chargeRates = masterNeedsRates ? await loadChargeRates() : [];

    let anyUpdated = false;
    const tradesToExit: Array<{ trade: TradeRecord; reason: "TP_HIT" | "SL_HIT" | "TSL_HIT"; exitPrice: number }> = [];

    for (const trade of openTrades) {
      // Exit already emitted for this trade; wait for TEA to close it rather
      // than firing the same exit again on the next tick — but only within the
      // retry window, so a close that silently failed gets re-detected (T86 β).
      const guardedAt = this.exitingTrades.get(trade.id);
      if (guardedAt != null && Date.now() - guardedAt < EXIT_RETRY_MS) continue;

      // Entry-fill timeout: if the first live tick never arrives (illiquid
      // contract / feed gap), stop waiting after a grace window and keep the
      // placeholder entry so the trade isn't stuck unpriced forever.
      if (
        trade.entryPending &&
        nowMs() - trade.openedAt > ENTRY_FILL_TIMEOUT_MS
      ) {
        trade.entryPending = false;
        anyUpdated = true;
      }

      for (const tick of ticks) {
        if (!tickMatchesTrade(tick, trade)) continue;

        // Entry-pending fill: the first live tick for this contract IS the real
        // fill. Overwrite the placeholder entry and shift SL/TP/breakeven by the
        // same delta so their rupee distances hold. Runs BEFORE the TP/SL checks
        // below so a corrected entry can't instantly trigger an exit.
        if (trade.entryPending) {
          const prev = trade.entryPrice;
          const delta = tick.ltp - prev;
          trade.entryPrice = tick.ltp;
          if (trade.targetPrice != null) trade.targetPrice += delta;
          if (trade.stopLossPrice != null) trade.stopLossPrice += delta;
          if (trade.originalStopLossPrice != null) trade.originalStopLossPrice += delta;
          if (trade.breakevenPrice != null) trade.breakevenPrice += delta;
          if (trade.peakLtp != null) trade.peakLtp = tick.ltp;
          trade.entryPending = false;
          log.important(
            `[XSYNC-SVR] ENTRY-FILL ${channel} trade=${trade.id} ${trade.instrument} ` +
              `${Math.round(prev * 100) / 100}→${Math.round(tick.ltp * 100) / 100} (first live tick)`,
          );
        }

        // Update LTP + stamp the tick timestamp so RCA's stale-price
        // monitor can detect broker disconnects / illiquid contracts.
        trade.ltp = tick.ltp;
        trade.lastTickAt = nowMs();
        anyUpdated = true;

        // ── LIVE channels ────────────────────────────────────────────────
        // LIVE exit ownership (AI-menu "Lubas exit" toggle, default on).
        //
        // Lubas-managed (default): fall through to the SAME exit detection the
        // paper path runs below — staged strategy, Glide disaster stop, Sprint
        // TP/SL/TSL. That path emits autoExitDetected → recordAutoExit →
        // exitTrade, which already places a REAL market exit on live channels.
        // This is the only way Runway/Anchor/Glide/trailing work on live, since
        // Dhan legs can hold only a fixed SL + fixed TP. These trades carry no
        // superOrderId (the entry gate placed a plain order).
        //
        // Dhan-managed (toggle off): the broker Super Order enforces SL/TP; we
        // only drive the dynamic layer (arm gated TSL, ratchet TP via leg
        // modify) and skip our own detection.
        if (channel === "live" && !getCommonConfig().lubasManagedExit) {
          if (trailingStopEnabled && trade.superOrderId) {
            const lBuy = trade.type.includes("BUY");
            const breakeven = trade.breakevenPrice ?? trade.entryPrice;
            const gatePrice = lBuy
              ? breakeven * (1 + tslGatePercent / 100)
              : breakeven * (1 - tslGatePercent / 100);
            const pastGate = lBuy ? tick.ltp >= gatePrice : tick.ltp <= gatePrice;

            // Gated activation — arm at the broker exactly once when the gate holds.
            if (!this.tslActivated.has(trade.id)) {
              if (pastGate) {
                const armedAt = this.tslArmedAt.get(trade.id);
                if (armedAt == null) {
                  this.tslArmedAt.set(trade.id, Date.now());
                } else if (Date.now() - armedAt >= tslHoldMs) {
                  this.tslActivated.add(trade.id);
                  this.tslArmedAt.delete(trade.id);
                  if (trade.tslActivatedAt == null) {
                    trade.tslActivatedAt = Date.now();
                    anyUpdated = true;
                  }
                  log.important(`[XSYNC-SVR] TSL-ACTIVATED(live) ${channel} trade=${trade.id} ${trade.instrument} ltp=${tick.ltp} gate=${Math.round(gatePrice * 100) / 100} super=${trade.superOrderId}`);
                  this.emit("brokerTslArm", { channel, tradeId: trade.id } satisfies BrokerTslArmEvent);
                }
              } else {
                this.tslArmedAt.delete(trade.id);
              }
            }

            // Trailing take-profit — ratchet the TARGET_LEG up (throttled emit;
            // TEA enforces the step threshold + per-order modify budget).
            if (trade.targetPrice !== null) {
              const candidateTP = lBuy
                ? tick.ltp * (1 + getExitConfig(channel).sprint.tpTrailPercent / 100)
                : tick.ltp * (1 - getExitConfig(channel).sprint.tpTrailPercent / 100);
              const rounded = Math.round(candidateTP * 100) / 100;
              const raise = lBuy ? rounded > trade.targetPrice : rounded < trade.targetPrice;
              const lastEmit = this.lastTpEmitAt.get(trade.id) ?? 0;
              if (raise && Date.now() - lastEmit >= TP_EMIT_THROTTLE_MS) {
                this.lastTpEmitAt.set(trade.id, Date.now());
                this.emit("brokerTpRatchet", { channel, tradeId: trade.id, targetPrice: rounded } satisfies BrokerTpRatchetEvent);
              }
            }
          }
          continue;
        }
        const isBuy = trade.type.includes("BUY");

        // ── Trailing Stop Logic ──────────────────────────────
        // Track peak price and dynamically trail the stop loss.
        // Source priority for currentPeak (Wave 1, restart-safe):
        //   1. Persisted `trade.peakLtp` if set (survives server restart)
        //   2. In-memory `peakPrices` Map (fast path, current process)
        //   3. `trade.entryPrice` (cold start)
        const peakKey = trade.id;
        const currentPeak =
          trade.peakLtp ??
          this.peakPrices.get(peakKey) ??
          trade.entryPrice;
        const newPeak = isBuy
          ? Math.max(currentPeak, tick.ltp)
          : Math.min(currentPeak, tick.ltp);
        this.peakPrices.set(peakKey, newPeak);
        if (newPeak !== currentPeak) {
          // Only persist on a real ratchet event — avoids touching Mongo
          // every tick (the upsertDayRecord call below already persists
          // the trade record when anyUpdated is set).
          trade.peakLtp = newPeak;
        }

        // Mirror of the peak: the MOST-ADVERSE price seen (lowest for a BUY,
        // highest for a SELL). Together peak↔trough are the trade's full travel
        // (max favourable + max adverse excursion) drawn on the TradeBar and
        // frozen on close. Seeded at entry so a trade that only ever moves in its
        // favour keeps a trough of exactly the entry.
        const currentTrough = trade.troughLtp ?? trade.entryPrice;
        const newTrough = isBuy
          ? Math.min(currentTrough, tick.ltp)
          : Math.max(currentTrough, tick.ltp);
        if (newTrough !== currentTrough) {
          trade.troughLtp = newTrough;
          anyUpdated = true;
        }

        // Zone timers — cumulative ms the LTP spent BELOW entry (underwater) vs
        // ABOVE it (in profit), drawn as tiny MM:SS on the TradeBar. Accumulated
        // in-memory each tick (like peakLtp); rides on the next anyUpdated persist,
        // so no per-tick Mongo write. In-memory last-tick map is restart-safe: the
        // totals persist, only the in-flight delta is lost on a restart.
        {
          const nowMs = Date.now();
          const lastZone = this.zoneLastTickAt.get(trade.id);
          if (lastZone != null) {
            const dt = nowMs - lastZone;
            if (dt > 0 && dt < 60_000) { // ignore gaps > 1 min (feed stall / restart)
              const fav = isBuy ? tick.ltp - trade.entryPrice : trade.entryPrice - tick.ltp;
              if (fav < 0) trade.msBelowEntry = (trade.msBelowEntry ?? 0) + dt;
              else if (fav > 0) trade.msAboveEntry = (trade.msAboveEntry ?? 0) + dt;
            }
          }
          this.zoneLastTickAt.set(trade.id, nowMs);
        }


        // ── Master exits (T141) ──────────────────────────────────────────
        // Common-block master SL/TP/TSL OVERRIDE every strategy's own level of
        // that kind for EVERY trade. Evaluated FIRST; the matching per-strategy
        // side is suppressed below via the mTP/mSL/mTSL guards. Runs only on the
        // Lubas-managed path (after the Dhan-managed early-continue above).
        if ((mTP || mSL || mTSL) && !trade.entryPending && trade.entryPrice > 0 && trade.qty > 0) {
          const needNet =
            (mTP && master.tp.tpMode === "fixed" && master.tp.mode === "rupees") ||
            (mSL && master.sl.mode === "rupees") ||
            (mTSL && master.tsl.trailMode === "peak" && master.tsl.mode === "rupees");
          const curNet = needNet ? netPnlAtPrice(trade, tick.ltp, chargeRates) : 0;
          const pctLevel = (v: number, favourable: boolean) =>
            trade.entryPrice * (1 + (isBuy === favourable ? v : -v) / 100);

          let masterHit: { reason: "TP_HIT" | "SL_HIT" | "TSL_HIT"; exitPrice: number } | null = null;
          // TP first (bank profit), then SL, then TSL.
          if (mTP) {
            let hit = false;
            if (master.tp.tpMode === "nextT" && isBuy) {
              // Next-T (Rider): target the nearest swing HIGH above price that
              // clears >= minYieldPct above entry (steps up as each is passed).
              // No swing high above price (trend) → NO early cap, ride with the
              // TSL; only the wide safety cap fires.
              const minTarget = trade.entryPrice * (1 + master.tp.minYieldPct / 100);
              const target = this.dynTslSwingHighs(trade.id)
                .filter((h) => h > tick.ltp && h >= minTarget)
                .sort((a, b) => a - b)[0] ?? null; // nearest above price
              const cap = master.tp.safetyCapPct > 0
                ? trade.entryPrice * (1 + master.tp.safetyCapPct / 100) : null;
              trade.targetPrice = target ?? cap ?? null; // drawn on the bar; steps up
              anyUpdated = true;
              if (target != null && tick.ltp >= target) hit = true;
              else if (cap != null && tick.ltp >= cap) hit = true;
            } else {
              hit = master.tp.mode === "rupees"
                ? curNet >= master.tp.value
                : (isBuy ? tick.ltp >= pctLevel(master.tp.value, true) : tick.ltp <= pctLevel(master.tp.value, true));
            }
            if (hit) masterHit = { reason: "TP_HIT", exitPrice: tick.ltp };
          }
          if (!masterHit && mSL) {
            const hit = master.sl.mode === "rupees"
              ? curNet <= -master.sl.value
              : (isBuy ? tick.ltp <= pctLevel(master.sl.value, false) : tick.ltp >= pctLevel(master.sl.value, false));
            if (hit) masterHit = { reason: "SL_HIT", exitPrice: tick.ltp };
          }
          if (!masterHit && mTSL) {
            // T167 — armed at ENTRY (no profit-gate). Mode B (candle) trails to the
            // O/H/L/C of the x-back candle; Mode A (peak) trails a % / ₹ distance
            // below the running peak.
            let hit = false;
            if (master.tsl.trailMode === "candle") {
              // Mode B (Rider) — the candle trailer ratchets the level UP on candle
              // CLOSES (to the x-back candle low), but the EXIT fires INTRA-CANDLE
              // the instant a tick crosses below the current level (T167 2026-08-21).
              // No waiting for the candle to close → no give-back; exit AT the stop.
              const cs = trade.cohort === "ma_signal" ? cc.maCandleSec : cc.sma5CandleSec;
              const dyn = this.dynTslLevel(
                trade.id, tick.ltt, tick.ltp, isBuy, master.tsl.xBack, master.tsl.anchor,
                false, cs, trade.instrument, trade.contractSecurityId, master.tsl.sideways,
                master.tsl.maxGapPct,
              );
              trade.dynTslLevel = dyn.level ?? null;
              const viz = this.dynTslViz(trade.id);
              trade.tslAnchorTime = viz.anchorTime;
              trade.tslIgnoredTimes = viz.ignoredTimes;
              hit = dyn.level != null && (isBuy ? tick.ltp < dyn.level : tick.ltp > dyn.level);
            } else if (master.tsl.mode === "rupees") {
              // Mode A ₹ — give back at most `value` ₹ of net P&L from the running
              // peak-net. Armed at entry: no `peakNet > 0` gate, so it trails from
              // the first tick like a ₹ stop that ratchets up with profit.
              const peakNet = netPnlAtPrice(trade, newPeak, chargeRates);
              hit = peakNet - curNet >= master.tsl.value;
            } else {
              // Mode A % — trail `value`% below the peak premium, armed at entry
              // (peak starts at entry, so the stop is live immediately).
              const stop = isBuy ? newPeak * (1 - master.tsl.value / 100) : newPeak * (1 + master.tsl.value / 100);
              hit = isBuy ? tick.ltp <= stop : tick.ltp >= stop;
            }
            if (hit) masterHit = { reason: "TSL_HIT", exitPrice: tick.ltp };
          }
          if (masterHit) {
            log.important(
              `[XSYNC-SVR] MASTER-${masterHit.reason} ${channel} trade=${trade.id} ${trade.instrument} ` +
                `ltp=${tick.ltp} net=${needNet ? Math.round(curNet) : "-"} → emit exit`,
            );
            this.peakPrices.delete(peakKey);
            this.tslArmedAt.delete(trade.id);
            this.tslActivated.delete(trade.id);
            this.exitingTrades.set(trade.id, Date.now());
            tradesToExit.push({ trade, ...masterHit });
            continue;
          }

          // Not exiting — write the master levels onto the trade so the TradeBar
          // DRAWS them (the strategy's markers are overridden). ₹ levels use the
          // gross ₹/qty distance for display (charges shift the true level a hair;
          // the exit check above is the exact authority). TSL shows the trailing
          // stop only once the peak is in profit.
          const r2 = (x: number) => Math.round(x * 100) / 100;
          // premium price for a net-₹ or % distance on the given side.
          const toPrice = (v: number, mode: string, favourable: boolean) =>
            mode === "rupees"
              ? trade.entryPrice + (isBuy === favourable ? 1 : -1) * (v / trade.qty)
              : pctLevel(v, favourable);
          if (mTP && master.tp.tpMode !== "nextT") { trade.targetPrice = r2(toPrice(master.tp.value, master.tp.mode, true)); anyUpdated = true; }
          // Downside display = the tighter of the master hard-SL and the armed TSL.
          let stopDisp: number | null = mSL ? toPrice(master.sl.value, master.sl.mode, false) : null;
          if (mTSL) {
            // Armed at entry — draw the trailing stop from the first tick (no
            // profit gate). Candle mode uses the ratcheted x-back level set above.
            let tslStop: number | null = null;
            if (master.tsl.trailMode === "candle") {
              tslStop = trade.dynTslLevel ?? null;
            } else {
              tslStop = master.tsl.mode === "rupees"
                ? newPeak - (isBuy ? 1 : -1) * (master.tsl.value / trade.qty)
                : (isBuy ? newPeak * (1 - master.tsl.value / 100) : newPeak * (1 + master.tsl.value / 100));
            }
            if (tslStop != null) {
              stopDisp = stopDisp == null ? tslStop : (isBuy ? Math.max(stopDisp, tslStop) : Math.min(stopDisp, tslStop));
            }
          }
          if (stopDisp != null) { trade.stopLossPrice = r2(stopDisp); anyUpdated = true; }
        }

      }
    }

    // Emit autoExitDetected for each triggered trade — TEA listens and
    // routes the close through portfolioAgent.closeTrade so the single-
    // writer invariant holds. tickHandler is detection-only; it does NOT
    // mutate the trade record itself.
    for (const { trade, reason, exitPrice } of tradesToExit) {
      const event: AutoExitEvent = {
        channel,
        tradeId: trade.id,
        reason,
        exitPrice,
        timestamp: Date.now(),
      };
      this.emit("autoExitDetected", event);
    }

    if (!anyUpdated) return;

    // Throttle the Mongo write: persist at most once per channel per
    // PERSIST_THROTTLE_MS, OR immediately when an exit fired (so the closing
    // state lands promptly). Between writes the in-memory `day` (held in
    // stateCache) carries the live LTP / peak / trailed-SL, and the per-tick
    // detector reads from it — detection stays live with no DB write per tick.
    const hadExit = tradesToExit.length > 0;
    const lastPersist = this.lastPersistAt.get(channel) ?? 0;
    if (!hadExit && Date.now() - lastPersist < PERSIST_THROTTLE_MS) {
      return; // updates remain in the cached day; a later pass persists them
    }
    this.lastPersistAt.set(channel, Date.now());

    // T97 — a replay run persists to its own document. It is NOT single-writer:
    // the SEA cross/leg-end EXIT closes run trades (closeTradeInRun) and each new
    // signal appends one (appendTradeToRun), both reading the run fresh. Blindly
    // writing back our cached array clobbered those — a just-closed trade came
    // back OPEN, a just-added trade vanished. So MERGE our live fields onto a
    // fresh read (same as the paper path below): overlay only OPEN trades, never
    // touch a CLOSED one, never drop a trade the fresh read carries.
    const activeRun = getActiveRunId();
    if (activeRun && channel === "paper") {
      const freshRun = await getRun(activeRun);
      if (!freshRun) { this.stateCache.delete(channel); return; }
      const liveById = new Map(day.trades.map((t) => [t.id, t]));
      for (const ft of freshRun.trades) {
        if (ft.status !== "OPEN") continue; // a concurrent close stays closed
        const live = liveById.get(ft.id);
        if (!live) continue; // a concurrently-appended trade we haven't cached yet
        ft.ltp = live.ltp;
        ft.lastTickAt = live.lastTickAt;
        ft.entryPending = live.entryPending;
        if (live.peakLtp != null) ft.peakLtp = live.peakLtp;
        if (live.troughLtp != null) ft.troughLtp = live.troughLtp;
        if (live.msBelowEntry != null) ft.msBelowEntry = live.msBelowEntry;
        if (live.msAboveEntry != null) ft.msAboveEntry = live.msAboveEntry;
        if (live.stopLossPrice != null) ft.stopLossPrice = live.stopLossPrice;
        if (live.dynTslLevel !== undefined) ft.dynTslLevel = live.dynTslLevel; // real candle-TSL (rolls)
        if (live.targetPrice != null) ft.targetPrice = live.targetPrice;
        if (live.tslActivatedAt != null) ft.tslActivatedAt = live.tslActivatedAt;
        if (!live.entryPending) {
          ft.entryPrice = live.entryPrice;
          if (live.breakevenPrice != null) ft.breakevenPrice = live.breakevenPrice;
        }
      }
      const recomputed = recalculateDayAggregates({ ...day, trades: freshRun.trades });
      await updateRunTrades(activeRun, recomputed.trades);
      // Adopt the merged trades so the next tick builds on the fresh state (picks
      // up external closes / new trades immediately, not after the cache TTL).
      day.trades = recomputed.trades;
      return;
    }

    // Persist by MERGING onto a fresh read of the day — never write back the whole
    // cached snapshot, or we'd clobber trades that were placed (appended) since the
    // snapshot loaded. We only own the live fields (ltp, lastTickAt, peakLtp,
    // trailed stopLossPrice); copy those onto the matching OPEN trades in the fresh
    // record and leave everything else (new trades, TEA-closed trades) untouched.
    const fresh = await getDayRecord(channel, day.dayIndex);
    if (!fresh) {
      // Day was removed (e.g. workspace cleared) since our snapshot — don't
      // resurrect it. Drop the stale cache and bail.
      this.stateCache.delete(channel);
      return;
    }
    const liveById = new Map(day.trades.map((t) => [t.id, t]));
    // Pass 1 — overlay each OPEN trade's live fields onto the fresh record
    // (in-memory only, no DB write yet). The per-trade unrealizedPnl is
    // recomputed from the fresh ltp by recalculateDayAggregates below, and we
    // want that fresh value in the SAME atomic patch — so day_records stays the
    // single fresh source of truth that position_state overlays from (T86 ③).
    const patches = new Map<string, Partial<TradeRecord>>();
    for (const ft of fresh.trades) {
      if (ft.status !== "OPEN") continue;
      const live = liveById.get(ft.id);
      if (!live) continue;
      const patch: Partial<TradeRecord> = {
        ltp: live.ltp,
        lastTickAt: live.lastTickAt,
        // Entry-fill correction (paper first-tick / live avg-missing fallback):
        // persist entryPending BOTH ways — else a reload resurrects entryPending
        // and the entry re-fills every tick (2026-07-02 regression).
        entryPending: live.entryPending,
      };
      if (live.peakLtp != null) patch.peakLtp = live.peakLtp;
      // Mirror of peakLtp + the zone timers — same live-owned tracking, so they
      // MUST ride this whitelist too or they never reach day_records /
      // position_state (they were tracked in memory but silently dropped here).
      if (live.troughLtp != null) patch.troughLtp = live.troughLtp;
      if (live.msBelowEntry != null) patch.msBelowEntry = live.msBelowEntry;
      if (live.msAboveEntry != null) patch.msAboveEntry = live.msAboveEntry;
      if (live.stopLossPrice != null) patch.stopLossPrice = live.stopLossPrice;
      if (live.dynTslLevel !== undefined) patch.dynTslLevel = live.dynTslLevel; // real candle-TSL (rolls)
      // T167 candle-TSL highlight — persist the anchor + ignored candle times so
      // tradesForChart can hand them to the chart (anchor is a small number;
      // ignored array only written when non-empty).
      if (live.tslAnchorTime !== undefined) patch.tslAnchorTime = live.tslAnchorTime;
      if (live.tslIgnoredTimes && live.tslIgnoredTimes.length) patch.tslIgnoredTimes = live.tslIgnoredTimes;
      // Trailing take-profit: the live record may have ratcheted the target up.
      if (live.targetPrice != null) patch.targetPrice = live.targetPrice;
      // TSL activation timestamp (UI stopwatch) — stamp once, never clear.
      if (live.tslActivatedAt != null) patch.tslActivatedAt = live.tslActivatedAt;
      // Operator-owned risk flags (toggled via updateTrade → applyTradeEdit).
      if (live.stopLossDisabled !== undefined) patch.stopLossDisabled = live.stopLossDisabled;
      if (live.targetDisabled !== undefined) patch.targetDisabled = live.targetDisabled;
      if (live.tslMode !== undefined) patch.tslMode = live.tslMode;
      if (live.manualExitOnly !== undefined) patch.manualExitOnly = live.manualExitOnly;
      if (!live.entryPending) {
        patch.entryPrice = live.entryPrice;
        if (live.breakevenPrice != null) patch.breakevenPrice = live.breakevenPrice;
      }
      Object.assign(ft, patch); // keep `fresh` in sync for the aggregate recompute
      patches.set(ft.id, patch);
    }
    // Recompute per-trade unrealizedPnl (from the fresh ltp) + day aggregates.
    const updated = recalculateDayAggregates(fresh);
    // Pass 2 — persist each changed trade ATOMICALLY, now carrying the fresh
    // unrealizedPnl too. `requireOpen` no-ops the write if the close path already
    // flipped this trade to CLOSED, and the patch never touches `status` — so a
    // persist can NEVER revert a completed close back to OPEN (the T86 β
    // stuck-open cause). `silent` batches the single UI push into the aggregate
    // write below.
    let anyPatched = false;
    for (const ft of fresh.trades) {
      const patch = patches.get(ft.id);
      if (!patch) continue;
      patch.unrealizedPnl = ft.unrealizedPnl; // recomputed just above
      const res = await patchTradeInDay(channel, day.dayIndex, ft.id, patch, undefined, {
        requireOpen: true,
        silent: true,
      });
      if (res) anyPatched = true;
    }
    if (anyPatched) {
      await patchDayAggregates(channel, day.dayIndex, dayAggregateFields(updated));
    }

    // A tick matched an open trade and we just persisted. Drop the cached
    // snapshot so the next batch re-reads fresh state from Mongo (TEA may
    // have closed the trade in response to autoExitDetected, etc.).
    this.stateCache.delete(channel);

    // Emit snapshot for SSE consumers
    const snapshot: PnlSnapshot = {
      channel,
      dayIndex: state.currentDayIndex,
      trades: updated.trades
        .filter((t) => t.status === "OPEN")
        .map((t) => ({
          id: t.id,
          instrument: t.instrument,
          ltp: t.ltp,
          unrealizedPnl: t.unrealizedPnl,
          status: t.status,
        })),
      totalPnl: updated.totalPnl,
      updatedAt: Date.now(),
    };
    this.emit("pnlUpdate", snapshot);
  }

}

// ─── Singleton ──────────────────────────────────────────────────

export const tickHandler = new TickHandler();
