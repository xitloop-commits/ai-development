/**
 * Module 3: Time Windows
 *
 * - No trading after market open: blocks first N minutes (high-volatility gap-open)
 * - No trading before market close: blocks last N minutes
 * - Lunch break pause: optional block during lunch (NSE only)
 *
 * Time windows are exchange-specific. NSE and MCX have different market hours.
 * All times are in IST (UTC+5:30).
 */

import type { Exchange, DisciplineEngineSettings, ModuleCheckResult } from "./types";
import { MARKET_HOURS, parseTimeToMinutes, getISTNow } from "./types";

export interface TimeWindowResult extends ModuleCheckResult {
  blockedUntil?: string;
  exchange?: string;
  blockType?: "market_open" | "market_close" | "lunch_break";
}

/**
 * Get the current IST time as hours and minutes.
 */
function getISTTime(now?: Date): { hours: number; minutes: number; totalMinutes: number } {
  const ist = now ?? getISTNow();
  const hours = ist.getUTCHours();
  const minutes = ist.getUTCMinutes();
  return { hours, minutes, totalMinutes: hours * 60 + minutes };
}

/**
 * Format minutes-since-midnight as "HH:MM AM/PM".
 */
function formatTime(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${m.toString().padStart(2, "0")} ${period}`;
}

/**
 * Check all time window rules for a given exchange.
 */
export function checkTimeWindow(
  exchange: Exchange,
  settings: DisciplineEngineSettings,
  now?: Date
): TimeWindowResult {
  const { totalMinutes } = getISTTime(now);
  const mh = MARKET_HOURS[exchange];
  const marketOpenMin = mh.openHour * 60 + mh.openMin;
  const marketCloseMin = mh.closeHour * 60 + mh.closeMin;

  // 1. Check no-trading-after-open block
  if (settings.noTradingAfterOpen.enabled) {
    const blockMinutes = exchange === "NSE"
      ? settings.noTradingAfterOpen.nseMinutes
      : settings.noTradingAfterOpen.mcxMinutes;

    const blockEndMin = marketOpenMin + blockMinutes;

    if (totalMinutes >= marketOpenMin && totalMinutes < blockEndMin) {
      return {
        passed: false,
        reason: `Market open volatility — Trading blocked for ${exchange}`,
        blockedUntil: formatTime(blockEndMin),
        exchange,
        blockType: "market_open",
      };
    }
  }

  // 2. Check no-trading-before-close block
  if (settings.noTradingBeforeClose.enabled) {
    const blockMinutes = exchange === "NSE"
      ? settings.noTradingBeforeClose.nseMinutes
      : settings.noTradingBeforeClose.mcxMinutes;

    const blockStartMin = marketCloseMin - blockMinutes;

    if (totalMinutes >= blockStartMin && totalMinutes <= marketCloseMin) {
      return {
        passed: false,
        reason: `Market close approaching — Trading blocked for ${exchange}`,
        blockedUntil: formatTime(marketCloseMin),
        exchange,
        blockType: "market_close",
      };
    }
  }

  // 3. Check lunch break pause (NSE only)
  if (exchange === "NSE" && settings.lunchBreakPause.enabled) {
    const lunchStart = parseTimeToMinutes(settings.lunchBreakPause.startTime);
    const lunchEnd = parseTimeToMinutes(settings.lunchBreakPause.endTime);

    if (totalMinutes >= lunchStart && totalMinutes < lunchEnd) {
      return {
        passed: false,
        reason: "Lunch break pause active",
        blockedUntil: formatTime(lunchEnd),
        exchange,
        blockType: "lunch_break",
      };
    }
  }

  // 4. Check if outside market hours entirely
  if (totalMinutes < marketOpenMin || totalMinutes > marketCloseMin) {
    return {
      passed: false,
      reason: `${exchange} market is closed`,
      blockedUntil: formatTime(marketOpenMin),
      exchange,
    };
  }

  return { passed: true, exchange };
}

/**
 * Get the full timeline segments for visualization.
 * Returns an array of { start, end, type } for the given exchange.
 */
export function getTimelineSegments(
  exchange: Exchange,
  settings: DisciplineEngineSettings
): Array<{ startMin: number; endMin: number; type: "blocked" | "active" | "lunch" }> {
  const mh = MARKET_HOURS[exchange];
  const marketOpenMin = mh.openHour * 60 + mh.openMin;
  const marketCloseMin = mh.closeHour * 60 + mh.closeMin;
  const segments: Array<{ startMin: number; endMin: number; type: "blocked" | "active" | "lunch" }> = [];

  let cursor = marketOpenMin;

  // Open block
  if (settings.noTradingAfterOpen.enabled) {
    const blockMin = exchange === "NSE" ? settings.noTradingAfterOpen.nseMinutes : settings.noTradingAfterOpen.mcxMinutes;
    segments.push({ startMin: cursor, endMin: cursor + blockMin, type: "blocked" });
    cursor = cursor + blockMin;
  }

  // Lunch break (NSE only)
  if (exchange === "NSE" && settings.lunchBreakPause.enabled) {
    const lunchStart = parseTimeToMinutes(settings.lunchBreakPause.startTime);
    const lunchEnd = parseTimeToMinutes(settings.lunchBreakPause.endTime);

    if (cursor < lunchStart) {
      segments.push({ startMin: cursor, endMin: lunchStart, type: "active" });
    }
    segments.push({ startMin: lunchStart, endMin: lunchEnd, type: "lunch" });
    cursor = lunchEnd;
  }

  // Close block
  if (settings.noTradingBeforeClose.enabled) {
    const blockMin = exchange === "NSE" ? settings.noTradingBeforeClose.nseMinutes : settings.noTradingBeforeClose.mcxMinutes;
    const closeBlockStart = marketCloseMin - blockMin;

    if (cursor < closeBlockStart) {
      segments.push({ startMin: cursor, endMin: closeBlockStart, type: "active" });
    }
    segments.push({ startMin: closeBlockStart, endMin: marketCloseMin, type: "blocked" });
  } else if (cursor < marketCloseMin) {
    segments.push({ startMin: cursor, endMin: marketCloseMin, type: "active" });
  }

  return segments;
}
