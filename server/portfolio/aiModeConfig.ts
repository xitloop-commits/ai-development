/**
 * aiModeConfig.ts — the trading configuration store.
 *
 * Four layers:
 *   1. `exits` — Sprint / Runway / Anchor / Glide tunables. Shared across books
 *      for now (a per-book split is a separate change).
 *   2. `common` (T129) — system-wide knobs that are ONE value for the whole
 *      platform: MA-detector reversal size, RCA global exits, EOD square-off,
 *      and who owns live exits (Lubas vs Dhan). Behind their own Settings menu.
 *   3/4. `paper` / `live`, each split into an `ai` and a `manual` stream (T127).
 *      Per (book, origin): cohorts, strategies, sizing, order type.
 *
 * Reads by apply-path:
 *   - tickHandler (exit engine)  → getExitConfig() [shared] · getCommonConfig()
 *   - risk-control (placement)   → getActiveStrategies(book, kind), order
 *   - validateTrade (sizing)     → getAiConfig(book, kind).sizing
 *   - RcaMonitor / square-off    → globalExitsForChannel / squareoffForChannel
 *
 * Persisted to config/ai_mode_config.json, hydrated at boot, deep-merged over
 * defaults so knobs added later fall through. initAiConfig migrates older
 * shapes (three-block, and pre-common) forward and re-persists the result.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
// T171 (Rider) — the 5-strategy framework is gone; `exitStrategy` is now always
// "rider" and the only live exit config is the Master block (masterExits) plus
// the `sprint` sub-config, which the Dhan-managed path still uses to drive the
// broker-side trailing stop.
import type { Channel } from "./state";

/**
 * T127 — the config is addressed by (book, origin), giving FOUR blocks:
 * paper·ai, paper·manual, live·ai, live·manual.
 *
 * Before this there were three blocks — paper, live, manual — and `manual` was
 * book-agnostic, so a hand-placed trade used the same size whether it landed on
 * paper or on live. You cannot size 10 lots on paper and 1 lot on live for your
 * own trades until manual splits per book, which is what this does.
 */
export type Book = "paper" | "live";
/** Who placed the trade, collapsed to the two config streams. USER → manual;
 *  AI and RCA → ai. */
export type OriginKind = "ai" | "manual";
/** T171 — collapsed to a single exit model. Every trade is "rider". */
export type StrategyName = "rider";

export interface CohortsConfig {
  scalp: boolean;
  trend: boolean;
  ma: boolean;
  sma5: boolean; // SMA-5 price-cross cohort (2026-08-05) — rides, exits on the cross
  sma_model: boolean; // T154 learned SMA5 rider (external runner) — paper-only watch cohort
  swing: boolean; // shown in the UI but has no gate — always false for now
  // T129 — `revPct` moved to CommonConfig: it is a single detector parameter
  // (one SEA process), so two books cannot hold different values. It lived here
  // per-block and the union sync had to arbitrarily pick one; now it is common.
}

export interface SizingConfig {
  /** Per-instrument size: lots, or % of capital. */
  perInstrument: Record<string, { mode: "lots" | "percent" | "amount"; value: number }>;
}

export interface OrderConfig {
  orderType: "LIMIT" | "MARKET";
  productType: "INTRADAY" | "CNC";
}

/**
 * How an SL / TP number is read:
 *   "percent" — a % move in the option PREMIUM price (the original behaviour).
 *   "rupees"  — a NET ₹ P&L on the whole position, AFTER round-trip charges.
 *               The tick engine computes live net P&L (premium move × qty −
 *               entry+exit charges) and exits when it crosses the ₹ threshold,
 *               so one figure means the same money on any lot size.
 */
export type ExitLevelMode = "percent" | "rupees";

/** Sprint (fixed SL/TP + trailing). Part of the SHARED exit config. */
export interface SprintConfig {
  // Interpreted per slMode / tpMode: percent → % of entry premium; rupees → net
  // ₹ P&L (after charges) on the whole position.
  slMode: ExitLevelMode;
  tpMode: ExitLevelMode;
  defaultSL: number; // % below entry (percent) OR net ₹ loss (rupees)
  defaultTP: number; // % above entry (percent) OR net ₹ profit (rupees)
  dailyTargetPercent: number;
  trailingStopEnabled: boolean;
  trailingStopPercent: number;
  trailingDistanceSource: "config" | "signal";
  trailingActivationGatePercent: number;
  trailingActivationHoldSeconds: number;
  /** Trailing take-profit: keeps the target this % ahead of the LTP high-water
   *  mark, ratcheting only favourably. Was hardcoded at 1.5 in tickHandler. */
  tpTrailPercent: number;
}

export interface GlobalExitsConfig {
  rcaMaxAgeMs: number; // age exit
  rcaStaleTickMs: number; // stale-tick exit
  rcaVolThreshold: number; // volatility exit
  // T133 — each RCA safety exit can be switched off individually. Default true,
  // so an old config (or a new install) keeps every guard on.
  ageEnabled: boolean;
  staleEnabled: boolean;
  volEnabled: boolean;
}

export interface SquareoffConfig {
  enabled: boolean;
  nseTime: string; // IST "HH:mm"
  mcxTime: string;
}

/** SHARED across paper / live / manual — one set of strategy exit knobs. */
export interface GlideConfig {
  /**
   * Disaster stop, % from entry. NOT a trading stop — Glide has no SL, TP or
   * trailing by design; it rides until MA-Signal sends its own EXIT.
   *
   * It exists because the ONLY thing that closes a Glide trade is SEA sending
   * that exit, and SEA tracks its open MA legs in memory (`_ma_open`). If SEA
   * restarts mid-leg that memory is gone, nothing will ever send the exit, and
   * the position would sit unprotected until EOD square-off. Set it wide enough
   * that normal MA behaviour never reaches it.
   */
  disasterSlPct: number;
  /**
   * T124 — give-back guard. Once a Glide trade has been up by at least
   * `giveBackArmPct` of entry, close it if it surrenders `giveBackPct` of that
   * PEAK GAIN. Set `giveBackPct` to 0 to switch the guard off entirely.
   *
   * This is NOT a stop-loss, and the distinction is the whole point. A stop
   * fires on a trade that never worked; this fires only on a trade that DID
   * work and is handing the profit back. A Glide trade that simply chops around
   * entry still rides to the MA EXIT untouched.
   *
   * Measured over 2026-07-22/23: 22 Glide trades reached ₹4,56,745 of peak
   * unrealised profit and booked ₹1,33,824 — 69% given back. Six that were in
   * profit finished as losses; the worst peaked at +₹8,775 and closed at
   * −₹51,550. The MA EXIT routinely arrives long after the move is over.
   *
   * Defaults are deliberately loose (arm at +10%, exit on giving back half)
   * so normal Glide behaviour is untouched and only a real collapse triggers.
   */
  giveBackArmPct: number;
  giveBackPct: number;
  /**
   * OPTIONAL take-profit for Glide (default OFF). Glide normally rides until the
   * MA EXIT; turn this on to also bank a hard target. `tpMode` reads `tp` as a %
   * of premium ("percent") or a NET ₹ profit after charges ("rupees"), exactly
   * like Sprint/Runway/Anchor. When off, Glide behaves as before.
   */
  tpEnabled: boolean;
  tpMode: ExitLevelMode;
  tp: number;
}

export interface SharedExitConfig {
  /** The Dhan-managed path's broker-side trailing-stop knobs. The Lubas-managed
   *  exit is the Master block (CommonConfig.masterExits); this remains only for
   *  the case where Dhan holds the SL/TP legs (lubasManagedExit off). */
  sprint: SprintConfig;
  // T129 — `lubasManagedExit` moved to CommonConfig (one live book, one owner).
}

/** Per-(book, origin) config. Cohorts / strategies / sizing / order genuinely
 *  differ by book and stream; the system-wide knobs live in CommonConfig. */
export type CohortKey = "scalp" | "trend" | "ma" | "sma5" | "sma_model" | "swing";

export interface AiModeConfig {
  cohorts: CohortsConfig;
  sizing: SizingConfig;
  order: OrderConfig;
}

/**
 * T129 — settings that are ONE value for the whole system, not per book.
 *
 * These sit behind their own Settings menu, not the AI menu, because editing
 * them "on the paper tab" changing live was a genuine foot-gun.
 *
 *  - `revPct` — a single SEA detector parameter (one process).
 *  - `globalExits` — RCA safety nets (age / stale / volatility).
 *  - `squareoff` — EOD flatten times; an exchange fact, not a book preference.
 *  - `lubasManagedExit` — who owns LIVE exits (app vs Dhan legs); one live book.
 */
/**
 * One master exit level. When `enabled`, it OVERRIDES the per-strategy level of
 * the same kind for EVERY trade (all strategies, all books). `value` is read per
 * `mode`: percent → % of premium; rupees → net ₹ P&L after charges.
 */
export interface MasterLevel {
  enabled: boolean;
  mode: ExitLevelMode;
  value: number;
}

/** TSL trailing style. "peak" = Mode A (trail a % / ₹ distance below the running
 *  peak). "candle" = Mode B (trail to the O/H/L/C of the candle x bars back). */
export type TslTrailMode = "peak" | "candle";
/** Which point of the x-back candle the candle-TSL anchors to. LOW = loosest
 *  (most room), HIGH = tightest; OPEN/CLOSE in between. Default LOW. */
export type CandleAnchor = "open" | "high" | "low" | "close";
/** How the candle-TSL treats a "sideways" candle (one that makes no new high for
 *  a long / no new low for a short vs the prior candle). "ignore" = it does NOT
 *  advance the x-back counter, so the stop HOLDS through chop and only steps up
 *  on a genuine new high; "count" = mechanical x-back (every candle counts). */
export type SidewaysMode = "ignore" | "count";

/** Master TSL level (T167). Armed at ENTRY (no profit-gate). Carries both the
 *  peak-clamp params (Mode A) and the candle-trail params (Mode B); `trailMode`
 *  selects which is live. Only one Master stop runs at a time — SL xor TSL. */
export interface MasterTslLevel {
  enabled: boolean;
  trailMode: TslTrailMode;
  // ── Mode A (peak clamp) ──
  /** percent = trail value% below the peak premium; rupees = give back at most
   *  value ₹ of net P&L from the peak. */
  mode: ExitLevelMode;
  value: number;
  // ── Mode B (candle-based) ──
  /** Which point of the x-back candle to trail to (default "low"). */
  anchor: CandleAnchor;
  /** Candles back the anchor sits (>=1) — the looseness knob. */
  xBack: number;
  /** Sideways-candle handling (see SidewaysMode). */
  sideways: SidewaysMode;
  /** Loose-cap (%). If the trailing stop lags more than this far below the
   *  current premium (for a long), tighten it to the x-back candle's HIGH so
   *  the trail never sits more than ~this% behind price. 0 = off. Default 10. */
  maxGapPct: number;
}

/** Master TP mode (T171 Next-T). "fixed" = a %/₹ target (mode+value). "nextT" =
 *  target the nearest swing HIGH above price that clears >= minYieldPct above
 *  entry, stepping T1→T2→T3; in a trend (no swing high above price) there is NO
 *  early cap — ride with the TSL — except a wide safetyCapPct ceiling. */
export type TpMode = "fixed" | "nextT";
export interface MasterTpLevel {
  enabled: boolean;
  tpMode: TpMode;
  // ── fixed (%/₹ target) ──
  mode: ExitLevelMode;
  value: number;
  // ── nextT (swing-high target) ──
  /** Min % above entry for a swing high to qualify as a target. Default 5. */
  minYieldPct: number;
  /** Wide safety cap (%) — the only ceiling in a trend; fires only on an extreme
   *  spike. 0 = off. Default 40. */
  safetyCapPct: number;
}

/**
 * Master SL / TP / TSL (T141). Live in the COMMON block so they span paper +
 * live + replay. Each is an independent switch; when on it is THE only level of
 * that kind for every trade and the matching per-strategy exit is suppressed:
 *   tp  → replaces every strategy's take-profit
 *   sl  → replaces every strategy's hard stop (Glide's disaster stop stays as a
 *         last-resort catastrophe backstop)
 *   tsl → replaces every strategy's trailing (Sprint trail, Runway trailing
 *         phase, Glide give-back). percent = trail value% below the peak
 *         premium; rupees = give back at most value ₹ of net P&L from the peak.
 */
export interface MasterExitsConfig {
  tp: MasterTpLevel;
  sl: MasterLevel;
  tsl: MasterTslLevel;
}

export interface CommonConfig {
  revPct: number;
  /** SMA5 reversal-confirmation candles (1 = off / flip on first cross; 2+ waits
   *  that many candles before a reversal exits — damps 1-candle whipsaw exits).
   *  Pushed to the running SEA like revPct. */
  sma5ExitConfirm: number;
  /** SMA5 line deadband (% of the line) the close must clear to flip; 0 = exact
   *  cross. Filters marginal pokes right at the line. Pushed to SEA like revPct. */
  sma5Buffer: number;
  /** SMA5 entry-watch candles — after a cross, wait this many candles that each
   *  close further in the trade's direction before entering; 0 = enter on the
   *  cross (original). Avoids buying a spike that reverts. Pushed to SEA. */
  sma5EntryWatch: number;
  /** SMA5 premium-confirm entry gate — when true, a CE/PE entry only fires if that
   *  option's premium is above its own SMA5 at the cross (else skipped). false =
   *  fire on the underlying cross regardless. Pushed to SEA. */
  sma5EntryGate: boolean;
  /** SMA5 detector candle timeframe in seconds (60=1m, 180=3m, 300=5m). Pushed to SEA. */
  sma5CandleSec: number;
  /** MA-Signal detector candle timeframe in seconds (60=1m, 180=3m, 300=5m). Pushed to SEA. */
  maCandleSec: number;
  globalExits: GlobalExitsConfig;
  squareoff: SquareoffConfig;
  lubasManagedExit: boolean;
  masterExits: MasterExitsConfig;
  /**
   * Re-enter a signal-cohort trade that got stopped out (SL / MTP / TSL) while
   * the trend was still running. The cohort detectors (SMA5, MA-Signal) fire
   * only on the candle-close cross, then go silent while price rides the line —
   * so a premature stop-out leaves us on the sidelines until a full flip. When
   * on, `windowSec` after such an exit we re-fire the SAME direction (unless the
   * detector has flipped meanwhile), capped at `maxReentries` per leg.
   */
  reentryOnTrend: { enabled: boolean; windowSec: number; maxReentries: number };
  /** T161 — session strike lock. CE locks at ATM−offset strikes, PE at
   *  ATM+offset (both ITM), computed once after open and enforced in the
   *  validateTrade AI path for the enabled books. Offset per instrument. */
  strikeLock: {
    paperEnabled: boolean;
    liveEnabled: boolean;
    perInstrument: Record<string, number>; // instrument → ITM offset in strikes (≥0)
  };
  /** T161 — per-instrument master switch (watchlist tick icon). OFF drops the
   *  instrument's signal ingest AND its AI placements on both books; manual
   *  row buys stay allowed. */
  instrumentEnabled: Record<string, boolean>;
  /** T162 — trend-angle ribbon/readout tunables (Settings ▸ Trend angle).
   *  Display/measurement only — no trading behaviour reads these yet. */
  trendAngle: {
    source: "ma" | "sma5";
    lookbackMin: number;          // 3–10 minutes
    scaleMode: "auto" | "fixed";
    fixedPctPer45: number;        // fixed mode: % per lookback = 45°
    grayPctile: number;           // 20–60 (percentile of |moves| that reads gray)
    smooth: boolean;              // history-polish passes
  };
}

/** One book's config: its own strategy-exit tunables (T134 — PER BOOK now, so
 *  paper can be tuned without touching live) plus its two placement streams. */
export interface BookConfig {
  exits: SharedExitConfig;
  ai: AiModeConfig;
  manual: AiModeConfig;
}

export interface AllAiConfig {
  /** System-wide knobs (detector, RCA, square-off, live-exit owner). */
  common: CommonConfig;
  paper: BookConfig;
  live: BookConfig;
  /** T137 — config used ONLY while a replay run is open. Same shape as a book,
   *  but its `manual` stream is unused (replay trades are all SEA-driven). Every
   *  resolver switches to this automatically when a run is active, so a replay
   *  can race a different strategy / size / exit set than paper or live. */
  replay: BookConfig;
}

// ─── Defaults (preserve current behaviour) ──────────────────────────────────

function baseExits(): SharedExitConfig {
  return {
    sprint: {
      slMode: "percent",
      tpMode: "percent",
      defaultSL: 2.0,
      defaultTP: 5.0,
      dailyTargetPercent: 5.0,
      trailingStopEnabled: true,
      trailingStopPercent: 2.0,
      trailingDistanceSource: "signal",
      trailingActivationGatePercent: 2.0,
      trailingActivationHoldSeconds: 10,
      tpTrailPercent: 1.5,
    },
  };
}

function baseCommon(): CommonConfig {
  return {
    revPct: 0.18,
    sma5ExitConfirm: 1, // off by default — flip on the first cross (original)
    sma5Buffer: 0, // no deadband by default — exact cross
    sma5EntryWatch: 0, // enter on the cross by default — no watch candles
    sma5EntryGate: false, // premium-confirm gate off by default (current behaviour)
    sma5CandleSec: 60, // 1-minute SMA5 candles by default
    maCandleSec: 60, // 1-minute MA-Signal candles by default
    globalExits: {
      rcaMaxAgeMs: 30 * 60 * 1000,
      rcaStaleTickMs: 5 * 60 * 1000,
      rcaVolThreshold: 0.7,
      ageEnabled: true,
      staleEnabled: true,
      volEnabled: true,
    },
    squareoff: { enabled: true, nseTime: "15:25", mcxTime: "23:25" },
    // Lubas owns live exits by default — the staged strategies + Glide only work
    // this way. Flip to false in Settings to hand SL/TP back to Dhan legs.
    lubasManagedExit: true,
    // Re-enter on a stop-out while the trend runs — on by default, 30s window,
    // 3 re-entries max per leg. See CommonConfig.reentryOnTrend.
    reentryOnTrend: { enabled: true, windowSec: 30, maxReentries: 3 },
    // T161 — strike lock: paper first, live off until a clean paper day.
    strikeLock: {
      paperEnabled: true,
      liveEnabled: false,
      perInstrument: { nifty50: 2, banknifty: 2, crudeoil: 2, naturalgas: 2 },
    },
    instrumentEnabled: { nifty50: true, banknifty: true, crudeoil: true, naturalgas: true },
    trendAngle: { source: "ma", lookbackMin: 5, scaleMode: "auto", fixedPctPer45: 0.2, grayPctile: 40, smooth: true },
    // T171 (Rider) — the Master block is the ONLY exit model. Default ON: Next-T
    // take-profit + a candle-trailing stop (TSL is the default downside, always
    // active). Hard SL OFF (the xor alternative — operator switches to it).
    masterExits: {
      tp: { enabled: true, tpMode: "nextT", mode: "percent", value: 10, minYieldPct: 5, safetyCapPct: 40 },
      sl: { enabled: false, mode: "percent", value: 10 },
      tsl: {
        enabled: true, trailMode: "candle", mode: "percent", value: 3,
        anchor: "low", xBack: 1, sideways: "ignore", maxGapPct: 10,
      },
    },
  };
}

function baseMode(): AiModeConfig {
  return {
    cohorts: { scalp: true, trend: false, ma: true, sma5: true, sma_model: true, swing: false },
    sizing: {
      perInstrument: {
        nifty50: { mode: "lots", value: 10 },
        banknifty: { mode: "lots", value: 10 },
        crudeoil: { mode: "lots", value: 10 },
        naturalgas: { mode: "lots", value: 10 },
      },
    },
    order: { orderType: "MARKET", productType: "INTRADAY" },
  };
}

/** A fresh MANUAL block: MA-Signal cohort, Glide strategy.
 *
 * ⚠️ A manual Glide trade is NOT closed by MA-Signal's exit. SEA closes the
 * specific trade IT opened (it stores the id at leg start), and a trade you
 * placed by hand was never in that map. So a manual Glide trade rides until YOU
 * close it, the disaster stop fires, or EOD square-off. That is the accepted
 * behaviour, not an oversight — but it is why Glide must never be reached by
 * accident. */
function baseManual(): AiModeConfig {
  const m = baseMode();
  m.cohorts = { ...m.cohorts, scalp: false, trend: false, ma: true, sma5: false, sma_model: false, swing: false };
  return m;
}

/** Every book uses the single Rider exit now; the blocks differ only in cohorts /
 *  sizing. Replay defaults to a copy of paper's AI setup. */
function defaultAll(): AllAiConfig {
  const paperAi = baseMode();
  const liveAi = baseMode();
  const replayAi = baseMode();
  return {
    common: baseCommon(),
    paper: { exits: baseExits(), ai: paperAi, manual: baseManual() },
    live: { exits: baseExits(), ai: liveAi, manual: baseManual() },
    replay: { exits: baseExits(), ai: replayAi, manual: baseManual() },
  };
}

// ─── Replay-aware book resolution (T137) ────────────────────────────────────

/** Registered at bootstrap so this module needn't import the replay stack (which
 *  imports back into it). True while a replay run is open. */
let replayActive: () => boolean = () => false;
export function _setReplayPredicate(fn: () => boolean): void {
  replayActive = fn;
}

export type EffBook = Book | "replay";
/** The config book a channel's trades resolve to: `replay` while a run is open
 *  (all trades are redirected to the run then), else the channel's own book. */
export function resolveBook(channel: Channel): EffBook {
  return replayActive() ? "replay" : bookForChannel(channel);
}

/** A book+origin block, addressed by the pair rather than a flat mode string. */
export function getAiConfig(book: EffBook, kind: OriginKind): AiModeConfig {
  return state[book][kind];
}

/** The origin stream a trade's origin maps to. USER → manual; everything else
 *  (AI, RCA) is treated as the AI stream. */
export function originKind(origin: "RCA" | "AI" | "USER"): OriginKind {
  return origin === "USER" ? "manual" : "ai";
}

/** The book a channel belongs to. */
export function bookForChannel(channel: Channel): Book {
  return channel === "paper" ? "paper" : "live";
}

// ─── State + persistence ────────────────────────────────────────────────────

const cfgPath = () => resolve(process.cwd(), "config", "ai_mode_config.json");

let state: AllAiConfig = defaultAll();

/** Recursively merge `src` onto `dst` (objects deep, everything else replaced). */
function deepMerge<T>(dst: T, src: unknown): T {
  if (src == null || typeof src !== "object" || Array.isArray(src)) return dst;
  for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
    const cur = (dst as Record<string, unknown>)[k];
    if (v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object") {
      deepMerge(cur, v);
    } else if (v !== undefined) {
      (dst as Record<string, unknown>)[k] = v;
    }
  }
  return dst;
}

const clampNum = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return Math.min(hi, Math.max(lo, n));
};
const isHHmm = (s: unknown): s is string => typeof s === "string" && /^\d{2}:\d{2}$/.test(s);

/** Clamp the shared exit config to safe ranges. */
/** Only "percent" or "rupees"; anything else (old config, bad edit) → percent. */
function exitMode(m: unknown): ExitLevelMode {
  return m === "rupees" ? "rupees" : "percent";
}
/** Clamp an SL/TP value by its mode: a % band, or a wide net-₹ band. */
function clampLevel(value: number, mode: ExitLevelMode, pctMax: number, pctDef: number, rsDef: number): number {
  return mode === "rupees"
    ? clampNum(value, 1, 10_00_000, rsDef) // net ₹ up to 10 lakh
    : clampNum(value, 0, pctMax, pctDef);
}

function sanitizeExits(e: SharedExitConfig): SharedExitConfig {
  e.sprint.slMode = exitMode(e.sprint.slMode);
  e.sprint.tpMode = exitMode(e.sprint.tpMode);
  e.sprint.defaultSL = clampLevel(e.sprint.defaultSL, e.sprint.slMode, 50, 2, 2000);
  e.sprint.defaultTP = clampLevel(e.sprint.defaultTP, e.sprint.tpMode, 100, 5, 3000);
  e.sprint.dailyTargetPercent = clampNum(e.sprint.dailyTargetPercent, 1, 20, 5);
  e.sprint.trailingStopEnabled = !!e.sprint.trailingStopEnabled;
  e.sprint.trailingStopPercent = clampNum(e.sprint.trailingStopPercent, 0.1, 50, 2);
  e.sprint.trailingDistanceSource = e.sprint.trailingDistanceSource === "config" ? "config" : "signal";
  e.sprint.trailingActivationGatePercent = clampNum(e.sprint.trailingActivationGatePercent, 0, 50, 2);
  e.sprint.trailingActivationHoldSeconds = Math.round(clampNum(e.sprint.trailingActivationHoldSeconds, 0, 120, 10));
  e.sprint.tpTrailPercent = clampNum(e.sprint.tpTrailPercent, 0.1, 50, 1.5);
  return e;
}

/** Clamp the system-wide common block. */
function sanitizeCommon(c: CommonConfig): CommonConfig {
  // revPct picks the MA-Signal detector MODE, it is not just a size:
  //   0        → 20-EMA SLOPE segmentation (the same computation the chart's
  //              green/red MA line draws, so colour flips ARE the signals).
  //   0.02–0.6 → raw price peak/trough reversal of that % (no averaging).
  // The old floor of 0.02 made 0 unreachable, so the EMA path could never be
  // selected — the detector short-circuits to reversal on `rev_pct > 0`.
  c.revPct = c.revPct === 0 ? 0 : clampNum(c.revPct, 0.02, 0.6, 0.18);
  c.sma5ExitConfirm = Math.round(clampNum(c.sma5ExitConfirm, 1, 10, 1));
  c.sma5Buffer = clampNum(c.sma5Buffer, 0, 5, 0);
  c.sma5EntryWatch = Math.round(clampNum(c.sma5EntryWatch, 0, 10, 0));
  c.sma5EntryGate = c.sma5EntryGate === true;
  c.sma5CandleSec = [60, 120, 180, 300].includes(Math.round(c.sma5CandleSec)) ? Math.round(c.sma5CandleSec) : 60;
  // T171 — ONE candle timeframe platform-wide: MA follows the (canonical) SMA5
  // timeframe, so signals, chart, tradebar and server all use a single number.
  c.maCandleSec = c.sma5CandleSec;
  c.globalExits.rcaMaxAgeMs = Math.round(clampNum(c.globalExits.rcaMaxAgeMs, 60_000, 6 * 3600_000, 30 * 60_000));
  c.globalExits.rcaStaleTickMs = Math.round(clampNum(c.globalExits.rcaStaleTickMs, 10_000, 3600_000, 5 * 60_000));
  c.globalExits.rcaVolThreshold = clampNum(c.globalExits.rcaVolThreshold, 0, 10, 0.7);
  c.globalExits.ageEnabled = c.globalExits.ageEnabled !== false;
  c.globalExits.staleEnabled = c.globalExits.staleEnabled !== false;
  c.globalExits.volEnabled = c.globalExits.volEnabled !== false;
  c.squareoff.enabled = !!c.squareoff.enabled;
  if (!isHHmm(c.squareoff.nseTime)) c.squareoff.nseTime = "15:25";
  if (!isHHmm(c.squareoff.mcxTime)) c.squareoff.mcxTime = "23:25";
  c.lubasManagedExit = !!c.lubasManagedExit;
  // T171 — drop the legacy cohort→strategy map if an old config still carries it.
  delete (c as { cohortStrategy?: unknown }).cohortStrategy;
  // T141 — master exits. Back-fill for an old config, then clamp each level by
  // its own mode (% band vs net-₹ band). TSL % caps at 90 (a >90% giveback is
  // meaningless); TP/SL % use the usual bands.
  if (!c.masterExits) {
    (c as CommonConfig).masterExits = {
      tp: { enabled: false, tpMode: "fixed", mode: "percent", value: 10, minYieldPct: 5, safetyCapPct: 40 },
      sl: { enabled: false, mode: "percent", value: 10 },
      tsl: {
        enabled: false, trailMode: "peak", mode: "percent", value: 3,
        anchor: "low", xBack: 1, sideways: "ignore", maxGapPct: 10,
      },
    };
  }
  const m = c.masterExits;
  // T171 — TP gained tpMode (fixed / nextT) + Next-T params; back-fill.
  m.tp.enabled = !!m.tp.enabled;
  m.tp.tpMode = m.tp.tpMode === "nextT" ? "nextT" : "fixed";
  m.tp.mode = exitMode(m.tp.mode);
  m.tp.value = clampLevel(m.tp.value, m.tp.mode, 100, 10, 3000);
  m.tp.minYieldPct = clampNum(m.tp.minYieldPct, 0, 100, 5);
  m.tp.safetyCapPct = clampNum(m.tp.safetyCapPct, 0, 500, 40); // 0 = off
  m.sl.enabled = !!m.sl.enabled; m.sl.mode = exitMode(m.sl.mode);
  m.sl.value = clampLevel(m.sl.value, m.sl.mode, 100, 10, 2000);
  // T167 — TSL gained trailMode + candle params; back-fill for old configs.
  m.tsl.enabled = !!m.tsl.enabled;
  m.tsl.trailMode = m.tsl.trailMode === "candle" ? "candle" : "peak";
  m.tsl.mode = exitMode(m.tsl.mode);
  m.tsl.value = clampLevel(m.tsl.value, m.tsl.mode, 90, 3, 1500);
  m.tsl.anchor = (["open", "high", "low", "close"] as const).includes(m.tsl.anchor) ? m.tsl.anchor : "low";
  m.tsl.xBack = Math.round(clampNum(m.tsl.xBack, 1, 20, 1));
  m.tsl.sideways = m.tsl.sideways === "count" ? "count" : "ignore";
  m.tsl.maxGapPct = clampNum(m.tsl.maxGapPct, 0, 100, 10); // 0 = off
  // T171 (Rider, spec-locked 2026-08-21) — SL xor TSL: exactly ONE downside stop.
  // TSL is the default and is always active unless the operator explicitly picks
  // the hard SL. (Supersedes the 2026-08-20 coexist note.) Both on → TSL wins;
  // both off → force TSL, so a trade is never left with no downside stop (the
  // Master block is now the only exit — there is no legacy fall-through).
  if (m.sl.enabled && m.tsl.enabled) m.sl.enabled = false;
  if (!m.sl.enabled && !m.tsl.enabled) m.tsl.enabled = true;
  // Re-entry-on-trend — back-fill for an old config, then coerce + clamp.
  if (!c.reentryOnTrend) (c as CommonConfig).reentryOnTrend = { enabled: true, windowSec: 30, maxReentries: 3 };
  const r = c.reentryOnTrend;
  r.enabled = r.enabled !== false;
  r.windowSec = Math.round(clampNum(r.windowSec, 5, 600, 30));
  r.maxReentries = Math.round(clampNum(r.maxReentries, 0, 20, 3));
  // T161 — strike lock + instrument switch. Back-fill for older configs.
  if (!c.strikeLock) {
    (c as CommonConfig).strikeLock = {
      paperEnabled: true,
      liveEnabled: false,
      perInstrument: { nifty50: 2, banknifty: 2, crudeoil: 2, naturalgas: 2 },
    };
  }
  const sl = c.strikeLock;
  sl.paperEnabled = sl.paperEnabled !== false;
  sl.liveEnabled = sl.liveEnabled === true; // live must be opted in explicitly
  if (!sl.perInstrument) sl.perInstrument = {};
  for (const k of ["nifty50", "banknifty", "crudeoil", "naturalgas"]) {
    sl.perInstrument[k] = Math.round(clampNum(sl.perInstrument[k], 0, 10, 2));
  }
  if (!c.instrumentEnabled) (c as CommonConfig).instrumentEnabled = {};
  for (const k of ["nifty50", "banknifty", "crudeoil", "naturalgas"]) {
    c.instrumentEnabled[k] = c.instrumentEnabled[k] !== false;
  }
  // T162 — trend-angle tunables. Back-fill + clamp.
  if (!c.trendAngle) {
    (c as CommonConfig).trendAngle = { source: "ma", lookbackMin: 5, scaleMode: "auto", fixedPctPer45: 0.2, grayPctile: 40, smooth: true };
  }
  const ta = c.trendAngle;
  ta.source = ta.source === "sma5" ? "sma5" : "ma";
  ta.lookbackMin = Math.round(clampNum(ta.lookbackMin, 1, 10, 5));
  ta.scaleMode = ta.scaleMode === "fixed" ? "fixed" : "auto";
  ta.fixedPctPer45 = clampNum(ta.fixedPctPer45, 0.01, 10, 0.2);
  ta.grayPctile = Math.round(clampNum(ta.grayPctile, 10, 60, 40)); // floor 10 (Partha 2026-08-13)
  ta.smooth = ta.smooth !== false;
  return c;
}

/** Clamp one block's config to safe ranges. */
function sanitizeMode(c: AiModeConfig): AiModeConfig {
  for (const k of ["scalp", "trend", "ma", "sma5", "sma_model", "swing"] as const) c.cohorts[k] = !!c.cohorts[k];
  // T171 — drop the legacy per-cohort strategy race if an old config carries it.
  delete (c as { strategies?: unknown }).strategies;
  delete (c as { cohortStrategies?: unknown }).cohortStrategies;
  for (const inst of Object.keys(c.sizing.perInstrument)) {
    const s = c.sizing.perInstrument[inst];
    s.mode = s.mode === "percent" ? "percent" : s.mode === "amount" ? "amount" : "lots";
    // Upper bound per mode: % ≤ 100, ₹ amount ≤ 20,00,000, lots ≤ 1000.
    const max = s.mode === "percent" ? 100 : s.mode === "amount" ? 2_000_000 : 1000;
    s.value = clampNum(s.value, 0, max, 10);
  }
  c.order.orderType = c.order.orderType === "LIMIT" ? "LIMIT" : "MARKET";
  c.order.productType = c.order.productType === "CNC" ? "CNC" : "INTRADAY";
  return c;
}

function persist(): void {
  try {
    writeFileSync(cfgPath(), JSON.stringify(state, null, 2) + "\n", "utf8");
  } catch {
    /* best-effort; live edits still apply this session without the file */
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/** The system-wide common block (detector, RCA, square-off, live-exit owner). */
export function getCommonConfig(): CommonConfig {
  return state.common;
}

/** Deep-merge a patch into the common block; clamp, persist, return it. */
export function updateCommonConfig(patch: unknown): CommonConfig {
  deepMerge(state.common, patch);
  sanitizeCommon(state.common);
  persist();
  return state.common;
}

/** Square-off times — one set for the whole system (T129). `channel` is kept in
 *  the signature so callers read unchanged; it no longer varies by book. */
export function squareoffForChannel(_channel: Channel): SquareoffConfig {
  return state.common.squareoff;
}

/** Global exits (age / stale / volatility) — system-wide (T129). */
export function globalExitsForChannel(_channel: Channel): GlobalExitsConfig {
  return state.common.globalExits;
}

/**
 * The cohort a MANUAL trade is tagged with, from the book's "My Trades" block.
 * First enabled wins (manual is one cohort per trade, not a race); nothing
 * enabled → ma_signal, the default this block ships with.
 *
 * The config uses the UI's short keys (`ma`) while trade records use the signal
 * engine's names (`ma_signal`) — translated here, in one place, rather than at
 * each call site. Getting that mapping wrong would tag trades with a cohort
 * that matches nothing downstream, including Glide's MA-only gate.
 */
export function resolveManualCohort(channel: Channel): string {
  const c = state[bookForChannel(channel)].manual.cohorts;
  if (c.ma) return "ma_signal";
  if (c.scalp) return "scalp";
  if (c.trend) return "trend";
  if (c.swing) return "swing";
  return "ma_signal";
}

/**
 * Opening SL / TP levels from the AI menu's SHARED Sprint config.
 *
 * The AI menu is the single authority for these. Previously the manual
 * placement path computed them from BROKER settings
 * (`broker_configs.settings.defaultSL` / `instrumentSl`) instead, so the AI
 * menu's Sprint SL was dead for every manual trade: two screens edited "the SL
 * %" and the one you'd expect to win was silently overruled.
 *
 * Returns concrete prices, never null, because the discipline gate reads
 * `req.stopLoss` — handing it null would let a manual trade reach the risk
 * check with no stop at all. Equity is handled by the CALLER (a discretionary
 * stock buy carries no auto SL/TP, and option-tuned percentages would produce a
 * nonsensical R:R).
 *
 * Only meaningful for Sprint. Runway/Anchor recompute both from entry on their
 * first tick, so for those this is just the opening placeholder that keeps the
 * gate fed.
 */
export function sprintOpeningLevels(
  channel: Channel,
  entry: number,
  isLong: boolean,
  qty?: number,
): { stopLoss: number; takeProfit: number } {
  const s = state[resolveBook(channel)].exits.sprint;
  const round2 = (x: number) => Math.round(x * 100) / 100;
  // The premium distance for a side, from its own mode:
  //   percent → % of entry;
  //   rupees  → the net ₹ figure spread over the position (₹ / qty). Charges
  //             shift the TRUE net level slightly — the per-tick net check
  //             (netRsExit) is the exact authority; this price only has to be
  //             sane for the discipline gate + TradeBar. With qty unknown, fall
  //             back to a wide 50% so it never front-runs the net check.
  const q = qty && qty > 0 ? qty : 0;
  const dist = (value: number, mode: ExitLevelMode) =>
    mode === "rupees" ? (q > 0 ? value / q : entry * 0.5) : entry * (value / 100);
  const slDist = dist(s.defaultSL, s.slMode);
  const tpDist = dist(s.defaultTP, s.tpMode);
  return {
    stopLoss: round2(isLong ? entry - slDist : entry + slDist),
    takeProfit: round2(isLong ? entry + tpDist : entry - tpDist),
  };
}

/** The Sprint / Runway / Anchor / Glide config for a channel's book (T134 —
 *  per book), or the replay block while a run is open (T137). */
export function getExitConfig(channel: Channel): SharedExitConfig {
  return state[resolveBook(channel)].exits;
}

/** Everything — for the UI. */
export function getAllAiConfig(): AllAiConfig {
  return state;
}

/** T171 — every trade is "rider" now (the 5-strategy race is gone). */
export function getActiveStrategies(_book: EffBook, _kind: OriginKind): StrategyName[] {
  return ["rider"];
}

/**
 * T171 — the exit strategy a trade runs is always "rider" now (the single
 * unified exit = the Master block). Kept as a shim so placement/executor call
 * sites need not change; cohort still drives the ENTRY signal, not the exit.
 */
export function resolveExitStrategy(
  _channel: Channel,
  _origin: "RCA" | "AI" | "USER",
  _isEquity: boolean,
  _cohort?: string | null,
): StrategyName {
  return "rider";
}

/** Signal cohort ("ma_signal"/"scalp"/…) → config key ("ma"/"scalp"/…), or null. */
export function cohortKey(cohort: string | null | undefined): CohortKey | null {
  return cohort === "ma_signal" ? "ma"
    : cohort === "sma5_signal" ? "sma5"
    : cohort === "sma_model" ? "sma_model"
    : cohort === "scalp" ? "scalp"
    : cohort === "trend" ? "trend"
    : cohort === "swing" ? "swing"
    : null;
}

/**
 * T171 — one signal now places ONE "rider" trade (the per-cohort strategy race
 * is gone). Kept as a shim so the RCA fan-out call site needs no change.
 */
export function enabledStrategiesForCohort(
  _channel: Channel,
  _origin: "RCA" | "AI" | "USER",
  _isEquity: boolean,
  _cohort?: string | null,
): StrategyName[] {
  return ["rider"];
}

/** Deep-merge a patch into one BOOK's exit config; clamp, persist, return it. */
export function updateExitConfig(book: EffBook, patch: unknown): SharedExitConfig {
  deepMerge(state[book].exits, patch);
  sanitizeExits(state[book].exits);
  persist();
  return state[book].exits;
}

/** Deep-merge a patch into one book+origin block; clamp, persist, return it. */
export function updateAiConfig(book: EffBook, kind: OriginKind, patch: unknown): AiModeConfig {
  deepMerge(state[book][kind], patch);
  sanitizeMode(state[book][kind]);
  persist();
  return state[book][kind];
}

/** Run every clamp: common, and each book's exits + two blocks. */
function sanitizeAll(): void {
  sanitizeCommon(state.common);
  for (const book of ["paper", "live", "replay"] as const) {
    sanitizeExits(state[book].exits);
    for (const kind of ["ai", "manual"] as const) sanitizeMode(state[book][kind]);
  }
}

/** Hydrate persisted overrides at server boot. Call once during bootstrap. */
export function initAiConfig(): void {
  state = defaultAll();
  try {
    const p = cfgPath();
    if (!existsSync(p)) return;
    const j = JSON.parse(readFileSync(p, "utf8"));
    if (j?.common) deepMerge(state.common, j.common);

    // T134 — exits moved from a top-level `exits` (shared) into each book. An
    // old file with top-level exits seeds BOTH books with it, so paper and live
    // start identical and diverge only as edited. A newer file carries
    // `paper.exits` / `live.exits`, merged below with the rest of the book.
    if (j?.exits) {
      deepMerge(state.paper.exits, j.exits);
      deepMerge(state.live.exits, j.exits);
    }

    // Shape migration. The file may be:
    //   - OLDEST (three blocks): `paper`/`live`/`manual`, each an AiModeConfig
    //     carrying its own cohorts.revPct / globalExits / squareoff, plus
    //     `exits.lubasManagedExit`.
    //   - T127 (four blocks): `paper`/`live`, each `{ai, manual}`, same fields.
    //   - T129 (this shape): the above PLUS a `common` block; per-block fields
    //     gone.
    // Detect the four-block shape by `paper.ai`.
    const isNested = j?.paper && typeof j.paper === "object" && "ai" in j.paper;
    if (isNested) {
      if (j.paper) deepMerge(state.paper, j.paper);
      if (j.live) deepMerge(state.live, j.live);
      // T137 — `replay` is new; an older nested file has no replay block, so it
      // keeps the default (a copy of paper's AI setup) until edited.
      if (j.replay) deepMerge(state.replay, j.replay);
    } else {
      if (j?.paper) deepMerge(state.paper.ai, j.paper);
      if (j?.live) deepMerge(state.live.ai, j.live);
      if (j?.manual) {
        deepMerge(state.paper.manual, j.manual);
        deepMerge(state.live.manual, j.manual);
      }
    }

    // T129 — if the file predates `common`, lift the system-wide values out of
    // wherever they used to live so nothing resets to default on upgrade.
    if (!j?.common) {
      const src = isNested ? j?.paper?.ai : j?.paper; // the AI paper block, old or new
      if (typeof src?.cohorts?.revPct === "number") state.common.revPct = src.cohorts.revPct;
      if (src?.globalExits) deepMerge(state.common.globalExits, src.globalExits);
      if (src?.squareoff) deepMerge(state.common.squareoff, src.squareoff);
      if (typeof j?.exits?.lubasManagedExit === "boolean")
        state.common.lubasManagedExit = j.exits.lubasManagedExit;
    }

    // Strip legacy keys deepMerge copied in from an old file — the new types
    // don't carry them and nothing reads them, but leaving them in the persisted
    // file is confusing. Their values were already lifted into `common` above.
    for (const book of ["paper", "live"] as const) {
      delete (state[book].exits as unknown as Record<string, unknown>).lubasManagedExit;
      for (const kind of ["ai", "manual"] as const) {
        const b = state[book][kind] as unknown as Record<string, unknown>;
        delete b.globalExits;
        delete b.squareoff;
        delete (b.cohorts as Record<string, unknown>).revPct;
      }
    }

    sanitizeAll();
    // Re-persist in the current shape so the on-disk file matches the running
    // one (drops the old per-block fields, writes `common`).
    persist();
  } catch {
    /* corrupt/absent file → run on defaults */
  }
}
