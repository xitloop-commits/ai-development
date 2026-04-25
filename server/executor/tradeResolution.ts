/**
 * Trade resolution helpers — translate UI intent into a fully-resolved
 * trade request for tradeExecutor.submitTrade.
 *
 * The UI (NewTradeForm, TradeButton on signals) sends a partial intent:
 * instrument + side + capital%, occasionally a strike/expiry. The server
 * resolves the missing pieces (lot size, contract security id, nearest
 * expiry, default SL/TP percentages from broker config) before TEA places
 * the actual order.
 *
 * Extracted from server/portfolio/router.ts during TEA Phase 1 commit 6
 * so both the legacy `portfolio.placeTrade` and the new
 * `executor.placeTrade` use the same resolution path. Phase 2 will fold
 * these into executor's normalization layer per spec §3.
 */

import { getActiveBroker } from "../broker/brokerService";
import { getActiveBrokerConfig } from "../broker/brokerConfig";

// ─── Daily / per-trade target settings ─────────────────────────

/** Daily target % from broker config; falls back to engine default of 5. */
export async function getDailyTargetPercent(): Promise<number> {
  const config = await getActiveBrokerConfig();
  return config?.settings?.dailyTargetPercent ?? 5;
}

/**
 * Per-instrument trade TP / SL %. Options default to 30% TP, others to 2%.
 * SL falls back to broker `defaultSL` (default 10%).
 */
export async function getTradeTargetPercent(
  instrument: string,
): Promise<{ tpPercent: number; slPercent: number }> {
  const config = await getActiveBrokerConfig();
  const isOption = /CALL|PUT|CE|PE/i.test(instrument);
  const tpPercent = isOption
    ? (config?.settings?.tradeTargetOptions ?? 30)
    : (config?.settings?.tradeTargetOther ?? 2);
  const slPercent = config?.settings?.defaultSL ?? 10;
  return { tpPercent, slPercent };
}

// ─── Underlying / expiry resolution ────────────────────────────

/**
 * Map UI instrument name → { underlying, exchangeSegment } for expiry-list
 * lookup. Live broker needs numeric securityId; paper broker accepts the
 * symbolic underlying directly.
 */
export async function resolveUnderlyingForExpiry(
  instrument: string,
): Promise<{ underlying: string; exchangeSegment: string } | null> {
  const norm = instrument.toUpperCase().replace(/\s+/g, "");
  const config = await getActiveBrokerConfig();
  const isPaper = config?.isPaperBroker ?? true;

  if (isPaper) {
    const map: Record<string, { underlying: string; segment: string }> = {
      NIFTY50: { underlying: "NIFTY", segment: "IDX_I" },
      NIFTY: { underlying: "NIFTY", segment: "IDX_I" },
      BANKNIFTY: { underlying: "BANKNIFTY", segment: "IDX_I" },
      CRUDEOIL: { underlying: "CRUDEOIL", segment: "MCX_COMM" },
      CRUDE: { underlying: "CRUDEOIL", segment: "MCX_COMM" },
      NATURALGAS: { underlying: "NATURALGAS", segment: "MCX_COMM" },
    };
    const m = map[norm];
    return m ? { underlying: m.underlying, exchangeSegment: m.segment } : null;
  }

  const idxMap: Record<string, { securityId: string; segment: string }> = {
    NIFTY50: { securityId: "13", segment: "IDX_I" },
    NIFTY: { securityId: "13", segment: "IDX_I" },
    BANKNIFTY: { securityId: "25", segment: "IDX_I" },
  };
  if (idxMap[norm]) {
    return { underlying: idxMap[norm].securityId, exchangeSegment: idxMap[norm].segment };
  }

  const broker = getActiveBroker();
  if ((norm === "CRUDEOIL" || norm === "CRUDE" || norm === "NATURALGAS") && broker?.resolveMCXFutcom) {
    const mcxSym = norm === "CRUDE" ? "CRUDEOIL" : norm;
    const result = await broker.resolveMCXFutcom(mcxSym);
    if (result) {
      return { underlying: String(result.securityId), exchangeSegment: "MCX_COMM" };
    }
  }
  return null;
}

/**
 * Nearest (earliest) expiry for an instrument. Returns null when the broker
 * is unavailable or the underlying maps to no expiries.
 */
export async function resolveNearestExpiry(instrument: string): Promise<string | null> {
  const broker = getActiveBroker();
  if (!broker) return null;
  const resolved = await resolveUnderlyingForExpiry(instrument);
  if (!resolved) return null;
  try {
    const list = await broker.getExpiryList(resolved.underlying, resolved.exchangeSegment);
    if (!list || list.length === 0) return null;
    const sorted = [...list].sort(
      (a, b) => new Date(`${a}T00:00:00`).getTime() - new Date(`${b}T00:00:00`).getTime(),
    );
    return sorted[0];
  } catch {
    return null;
  }
}

// ─── Option contract resolution ────────────────────────────────

/**
 * Resolve option contract securityId + current LTP for
 * (instrument, expiry, strike, isCall). Picks the nearest strike when the
 * exact one isn't in the chain. Returns null if the broker / chain is
 * unavailable or has no LTP.
 *
 * Used so trade LTP polling subscribes to the option leg (not spot), and so
 * signal-initiated trades can refresh entry price against the live chain
 * rather than the stale value carried on the SEA signal.
 */
export async function resolveContract(
  instrument: string,
  expiry: string,
  strike: number,
  isCall: boolean,
): Promise<{ secId: string; ltp: number; strike: number } | null> {
  const broker = getActiveBroker();
  if (!broker) {
    console.warn(`[resolveContract] No active broker for ${instrument}`);
    return null;
  }
  const resolved = await resolveUnderlyingForExpiry(instrument);
  if (!resolved) {
    console.warn(`[resolveContract] Could not resolve underlying for ${instrument}`);
    return null;
  }
  try {
    const chain = await broker.getOptionChain(
      resolved.underlying,
      expiry,
      resolved.exchangeSegment,
    );
    const rows = chain.rows ?? [];
    if (rows.length === 0) {
      console.warn(`[resolveContract] Empty option chain for ${instrument} ${expiry}`);
      return null;
    }
    let row = rows.find((r: any) => r.strike === strike);
    if (!row) {
      row = rows.reduce((best: any, r: any) =>
        Math.abs(r.strike - strike) < Math.abs(best.strike - strike) ? r : best,
      );
      console.warn(
        `[resolveContract] Strike ${strike} not in chain for ${instrument}; using nearest ${row.strike}`,
      );
    }
    const secId = isCall ? row.callSecurityId : row.putSecurityId;
    const ltp = isCall ? row.callLTP : row.putLTP;
    if (!secId || !ltp || ltp <= 0) {
      console.warn(
        `[resolveContract] Missing secId/ltp for ${instrument} ${row.strike} ${isCall ? "CE" : "PE"}: secId=${secId}, ltp=${ltp}`,
      );
      return null;
    }
    return { secId, ltp, strike: row.strike };
  } catch (err: any) {
    console.warn(`[resolveContract] getOptionChain failed for ${instrument} ${expiry}: ${err?.message}`);
    return null;
  }
}

// ─── Lot size resolution ───────────────────────────────────────

/** Lot size for an option underlying. Returns null when unavailable. */
export async function resolveLotSize(instrument: string): Promise<number | null> {
  const broker = getActiveBroker();
  if (!broker?.getLotSize) return null;
  const norm = instrument.toUpperCase().replace(/\s+/g, "");
  const lotSymbol =
    norm === "NIFTY50" || norm === "NIFTY" ? "NIFTY"
    : norm === "BANKNIFTY" ? "BANKNIFTY"
    : norm === "CRUDEOIL" || norm === "CRUDE" ? "CRUDEOIL"
    : norm === "NATURALGAS" ? "NATURALGAS"
    : instrument;
  try {
    const ls = await broker.getLotSize(lotSymbol);
    return ls && ls > 0 ? ls : null;
  } catch {
    return null;
  }
}
