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
  upsertDayRecord,
} from "./state";
import type { Channel, TradeRecord, CapitalState, DayRecord } from "./state";
import { recalculateDayAggregates } from "./compounding";
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
  reason: "TP_HIT" | "SL_HIT";
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
const TICK_CHANNELS: Channel[] = ["my-live", "my-paper", "ai-live", "ai-paper", "testing-live"];

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
const TP_TRAIL_PERCENT = 1.5;

// LIVE only — min gap between broker TP-ratchet emits per trade (TEA also caps
// total modifies per order). Keeps us well under Dhan's 25-modify-per-order limit.
const TP_EMIT_THROTTLE_MS = 30_000;

class TickHandler extends EventEmitter {
  private running = false;
  /** Latest tick per instrument key, drained each processing pass. */
  private pendingUpdates = new Map<string, TickData>();
  /** Serialize processing passes so async updateChannel calls never overlap. */
  private processing = false;
  private hasPending = false;
  /** Trades with an exit already emitted, awaiting TEA's close. Stops the
   *  per-tick detector from firing duplicate exits for the same trade. */
  private exitingTrades = new Set<string>();
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
  /** LIVE only — last time we emitted a broker TP-ratchet for a trade. Throttles
   *  the emit so we don't flood TEA (which also enforces the per-order modify cap). */
  private lastTpEmitAt = new Map<string, number>();
  /** Per-channel cache of (capital, day, broker config). See ChannelStateCache. */
  private readonly stateCache = new Map<Channel, ChannelStateCache>();

  constructor() {
    super();
    this.setMaxListeners(50);
  }

  /** Test/shutdown hook — drop the per-channel state cache. */
  clearStateCache(): void {
    this.stateCache.clear();
  }

  private async getChannelStateCached(channel: Channel): Promise<ChannelStateCache | null> {
    const now = Date.now();
    const cached = this.stateCache.get(channel);
    if (cached && cached.expiresAt > now) return cached;

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

    // Update every channel that gets MTM-driven updates
    for (const channel of TICK_CHANNELS) {
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
      this.exitingTrades.forEach((id) => {
        if (!openIds.has(id)) this.exitingTrades.delete(id);
      });
    }

    // Read trailing stop config from broker settings (centralized). Gate/hold/gap
    // are the single source the UI TradeBar reads too, so both behave identically.
    const trailingStopEnabled = brokerConfig?.settings?.trailingStopEnabled ?? false;
    const trailingStopPercent = brokerConfig?.settings?.trailingStopPercent ?? 2.0;
    const tslGatePercent = brokerConfig?.settings?.trailingActivationGatePercent ?? 2.0;
    const tslHoldMs = (brokerConfig?.settings?.trailingActivationHoldSeconds ?? 10) * 1000;

    let anyUpdated = false;
    const tradesToExit: Array<{ trade: TradeRecord; reason: "TP_HIT" | "SL_HIT"; exitPrice: number }> = [];

    for (const trade of openTrades) {
      // Exit already emitted for this trade; wait for TEA to close it rather
      // than firing the same exit again on the next tick.
      if (this.exitingTrades.has(trade.id)) continue;
      for (const tick of ticks) {
        if (!tickMatchesTrade(tick, trade)) continue;

        // Update LTP + stamp the tick timestamp so RCA's stale-price
        // monitor can detect broker disconnects / illiquid contracts.
        trade.ltp = tick.ltp;
        trade.lastTickAt = Date.now();
        anyUpdated = true;

        // ── LIVE channels ────────────────────────────────────────────────
        // The broker (Dhan Super Order) enforces the SL/TP/native-trailing
        // exits, so we do NOT run the paper exit detection here. We DO drive the
        // dynamic layer for Super Order trades: arm the gated TSL once, and
        // ratchet the TP (both via throttled events → TEA → leg modify). Plain
        // live orders (no superOrderId) have no broker bracket to modify, so
        // they're skipped (pre-existing unprotected behavior — see Phase 1 gate).
        if (channel === "my-live" || channel === "ai-live" || channel === "testing-live") {
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
                ? tick.ltp * (1 + TP_TRAIL_PERCENT / 100)
                : tick.ltp * (1 - TP_TRAIL_PERCENT / 100);
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

        // Trailing stop is a workspace-wide switch (broker config), not a
        // per-trade flag. It does NOT trail immediately: price must first clear
        // breakeven by the gate %, held continuously for the hold time, before
        // the stop arms. Once armed, the stop trails the peak by the gap % and
        // is floored at breakeven so a pullback can never give back charges.
        if (trailingStopEnabled && trade.stopLossPrice !== null) {
          const breakeven = trade.breakevenPrice ?? trade.entryPrice;
          const gatePrice = isBuy
            ? breakeven * (1 + tslGatePercent / 100)
            : breakeven * (1 - tslGatePercent / 100);
          const pastGate = isBuy ? tick.ltp >= gatePrice : tick.ltp <= gatePrice;

          // Activation: arm on first gate-clear, activate once the hold elapses,
          // reset if the gate breaks before then.
          if (!this.tslActivated.has(trade.id)) {
            if (pastGate) {
              const armedAt = this.tslArmedAt.get(trade.id);
              if (armedAt == null) {
                this.tslArmedAt.set(trade.id, Date.now());
              } else if (Date.now() - armedAt >= tslHoldMs) {
                this.tslActivated.add(trade.id);
                this.tslArmedAt.delete(trade.id);
                // Stamp activation time ONCE (survives restart — don't overwrite
                // if already set). Drives the UI's "TSL running" stopwatch.
                if (trade.tslActivatedAt == null) {
                  trade.tslActivatedAt = Date.now();
                  anyUpdated = true;
                }
                // TEMP DIAGNOSTIC ([XSYNC] client/server exit-sync confirmation).
                log.important(`[XSYNC-SVR] TSL-ACTIVATED ${channel} trade=${trade.id} ${trade.instrument} ltp=${tick.ltp} gate=${Math.round(gatePrice * 100) / 100} stop=${trade.stopLossPrice} held=${tslHoldMs}ms`);
              }
            } else {
              this.tslArmedAt.delete(trade.id);
            }
          }

          if (this.tslActivated.has(trade.id)) {
            const trailedRaw = isBuy
              ? newPeak * (1 - trailingStopPercent / 100)
              : newPeak * (1 + trailingStopPercent / 100);
            // Floor at breakeven — the stop never gives back the charges.
            const floored = isBuy
              ? Math.max(trailedRaw, breakeven)
              : Math.min(trailedRaw, breakeven);
            const trailedSL = Math.round(floored * 100) / 100;
            // Only trail in the favorable direction (never widen the stop).
            const shouldTrail = isBuy
              ? trailedSL > trade.stopLossPrice
              : trailedSL < trade.stopLossPrice;
            if (shouldTrail) {
              // TEMP DIAGNOSTIC ([XSYNC] exit-sync): stop trailed up.
              log.info(`[XSYNC-SVR] TSL-TRAIL ${channel} trade=${trade.id} ltp=${tick.ltp} peak=${newPeak} stop ${trade.stopLossPrice}→${trailedSL}`);
              trade.stopLossPrice = trailedSL;
              anyUpdated = true;
            }
          }
        }

        // ── Trailing Take-Profit (only when TSL is on) ───────
        // Keep the target TP_TRAIL_PERCENT ahead of the LTP's high-water mark,
        // ratcheting only in the favorable direction (never retreats when price
        // pulls back). The trailing stop books the actual exit on a reversal;
        // this TP only fires if price gaps past it in a single tick.
        if (trailingStopEnabled && trade.targetPrice !== null) {
          const candidateTP = isBuy
            ? tick.ltp * (1 + TP_TRAIL_PERCENT / 100)
            : tick.ltp * (1 - TP_TRAIL_PERCENT / 100);
          const rounded = Math.round(candidateTP * 100) / 100;
          const raise = isBuy ? rounded > trade.targetPrice : rounded < trade.targetPrice;
          if (raise) {
            // TEMP DIAGNOSTIC ([XSYNC] exit-sync): TP trailed up.
            log.info(`[XSYNC-SVR] TP-TRAIL ${channel} trade=${trade.id} ltp=${tick.ltp} tp ${trade.targetPrice}→${rounded}`);
            trade.targetPrice = rounded;
            anyUpdated = true;
          }
        }

        if (trade.targetPrice !== null) {
          const tpHit = isBuy
            ? tick.ltp >= trade.targetPrice
            : tick.ltp <= trade.targetPrice;
          if (tpHit) {
            // TEMP DIAGNOSTIC ([XSYNC] exit-sync): TP hit → exit emit.
            log.important(`[XSYNC-SVR] TP-HIT ${channel} trade=${trade.id} ${trade.instrument} ltp=${tick.ltp} target=${trade.targetPrice} → emit exit`);
            this.peakPrices.delete(peakKey); // cleanup
            this.tslArmedAt.delete(trade.id);
            this.tslActivated.delete(trade.id);
            this.exitingTrades.add(trade.id);
            // TP fills at the breaching tick: a favorable gap gives you the
            // better price (the stop side caps the loss; the target lets a
            // jump-through run in your favor).
            tradesToExit.push({ trade, reason: "TP_HIT", exitPrice: tick.ltp });
            continue; // Don't check SL if TP hit
          }
        }
        if (trade.stopLossPrice !== null) {
          const slHit = isBuy
            ? tick.ltp <= trade.stopLossPrice
            : tick.ltp >= trade.stopLossPrice;
          if (slHit) {
            // TEMP DIAGNOSTIC ([XSYNC] exit-sync): SL/TSL hit → exit emit. tsl=true
            // means this was a trailed-stop exit, false a hard-SL exit.
            log.important(`[XSYNC-SVR] SL-HIT ${channel} trade=${trade.id} ${trade.instrument} ltp=${tick.ltp} stop=${trade.stopLossPrice} tsl=${this.tslActivated.has(trade.id)} → emit exit`);
            this.peakPrices.delete(peakKey); // cleanup
            this.tslArmedAt.delete(trade.id);
            this.tslActivated.delete(trade.id);
            this.exitingTrades.add(trade.id);
            // Fill at the stop LEVEL, not the (possibly gapped) breaching tick,
            // so a fast move past the stop still realizes only the configured
            // SL/TSL %, not the deeper price the tick happened to print.
            tradesToExit.push({ trade, reason: "SL_HIT", exitPrice: trade.stopLossPrice });
          }
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
    for (const ft of fresh.trades) {
      if (ft.status !== "OPEN") continue;
      const live = liveById.get(ft.id);
      if (!live) continue;
      ft.ltp = live.ltp;
      ft.lastTickAt = live.lastTickAt;
      if (live.peakLtp != null) ft.peakLtp = live.peakLtp;
      if (live.stopLossPrice != null) ft.stopLossPrice = live.stopLossPrice;
      // Trailing take-profit: the live record may have ratcheted the target up.
      if (live.targetPrice != null) ft.targetPrice = live.targetPrice;
      // TSL activation timestamp (for the UI stopwatch) — stamp once, never clear.
      if (live.tslActivatedAt != null) ft.tslActivatedAt = live.tslActivatedAt;
    }
    const updated = recalculateDayAggregates(fresh);
    await upsertDayRecord(channel, updated);

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
