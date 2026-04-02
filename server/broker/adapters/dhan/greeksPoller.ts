/**
 * Dhan Greeks/IV REST Poller
 *
 * Component B of the Hybrid Architecture:
 * - Polls /v2/optionchain every 60 seconds for Greeks & IV data
 * - Merges Greeks into the tick cache for a unified data view
 * - Only polls for instruments that have active ATM windows
 * - Respects Dhan rate limits (5 data calls/second, 100K/day)
 *
 * The WS feed provides real-time LTP/Volume/OI/Depth but NOT Greeks.
 * This poller fills that gap with periodic REST calls.
 */

import type { ExchangeSegment } from "../../types.js";
import { DHAN_API_BASE, DHAN_ENDPOINTS, DHAN_RATE_LIMITS } from "./constants.js";
import { RateLimiter } from "./utils.js";

const LOG_PREFIX = "[GreeksPoller]";
const rateLimiter = new RateLimiter(10, 250);

// ─── Types ─────────────────────────────────────────────────────

export interface GreeksData {
  securityId: string;
  exchange: ExchangeSegment;
  strike: number;
  optionType: "CE" | "PE";
  iv: number; // implied volatility
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  timestamp: number; // UTC ms
}

export interface GreeksSnapshot {
  underlying: string;
  expiry: string;
  strikes: GreeksData[];
  fetchedAt: number;
}

interface PollTarget {
  underlying: string;
  underlyingSecId: string; // Dhan security ID for the underlying
  expiry: string; // ISO date
  exchange: ExchangeSegment;
}

export interface GreeksPollerConfig {
  accessToken: string;
  clientId: string;
  pollIntervalMs?: number; // default 60_000
  onGreeksUpdate: (snapshot: GreeksSnapshot) => void;
  onError: (error: Error) => void;
}

// ─── GreeksPoller Class ────────────────────────────────────────

export class GreeksPoller {
  private config: GreeksPollerConfig;
  private pollInterval: number;
  private targets = new Map<string, PollTarget>(); // key: "underlying:expiry"
  private timer: ReturnType<typeof setInterval> | null = null;
  private isPolling = false;
  private cache = new Map<string, GreeksSnapshot>(); // latest snapshot per target

  constructor(config: GreeksPollerConfig) {
    this.config = config;
    this.pollInterval = config.pollIntervalMs || 60_000;
  }

  // ── Public API ─────────────────────────────────────────────────

  /**
   * Add a target to poll Greeks for.
   * Typically called when an ATM window is set up.
   */
  addTarget(target: PollTarget): void {
    const key = `${target.underlying}:${target.expiry}`;
    this.targets.set(key, target);
    console.log(
      `${LOG_PREFIX} Added target: ${target.underlying} exp=${target.expiry}`
    );

    // Immediately poll this target
    this.pollTarget(target).catch((err) =>
      console.error(`${LOG_PREFIX} Initial poll failed for ${key}:`, err.message)
    );
  }

  /**
   * Remove a target from polling.
   */
  removeTarget(underlying: string, expiry: string): void {
    const key = `${underlying}:${expiry}`;
    this.targets.delete(key);
    this.cache.delete(key);
    console.log(`${LOG_PREFIX} Removed target: ${underlying} exp=${expiry}`);
  }

  /**
   * Start the periodic polling loop.
   */
  start(): void {
    if (this.timer) return;

    console.log(
      `${LOG_PREFIX} Starting with ${this.pollInterval / 1000}s interval`
    );

    this.timer = setInterval(() => {
      this.pollAll();
    }, this.pollInterval);

    // Also poll immediately on start
    this.pollAll();
  }

  /**
   * Stop the polling loop.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isPolling = false;
    console.log(`${LOG_PREFIX} Stopped`);
  }

  /**
   * Get the latest cached Greeks for a target.
   */
  getLatestGreeks(underlying: string, expiry: string): GreeksSnapshot | undefined {
    return this.cache.get(`${underlying}:${expiry}`);
  }

  /**
   * Get Greeks for a specific security ID from cache.
   */
  getGreeksForSecurity(securityId: string): GreeksData | undefined {
    for (const snapshot of Array.from(this.cache.values())) {
      const found = snapshot.strikes.find((s: any) => s.securityId === securityId);
      if (found) return found;
    }
    return undefined;
  }

  // ── Private Methods ────────────────────────────────────────────

  private async pollAll(): Promise<void> {
    if (this.isPolling || this.targets.size === 0) return;
    this.isPolling = true;

    try {
      for (const target of Array.from(this.targets.values())) {
        try {
          await this.pollTarget(target);
          // Small delay between targets to respect rate limits
          await new Promise((r) => setTimeout(r, 250));
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          console.error(
            `${LOG_PREFIX} Poll failed for ${target.underlying}:`,
            error.message
          );
          this.config.onError(error);
        }
      }
    } finally {
      this.isPolling = false;
    }
  }

  private async pollTarget(target: PollTarget): Promise<void> {
    // Rate limit check
    await rateLimiter.acquire();

    const url = `${DHAN_API_BASE}${DHAN_ENDPOINTS.OPTION_CHAIN}`;
    const body = {
      UnderlyingScrip: parseInt(target.underlyingSecId, 10),
      ExpiryDate: target.expiry,
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "access-token": this.config.accessToken,
        "client-id": this.config.clientId,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(
        `Option chain fetch failed: ${response.status} ${response.statusText}`
      );
    }

    const data = await response.json() as {
      data?: Array<{
        security_id?: string;
        strike_price?: number;
        option_type?: string;
        iv?: number;
        greeks?: {
          delta?: number;
          gamma?: number;
          theta?: number;
          vega?: number;
        };
      }>;
    };

    if (!data.data || !Array.isArray(data.data)) {
      console.warn(
        `${LOG_PREFIX} No data in option chain response for ${target.underlying}`
      );
      return;
    }

    const strikes: GreeksData[] = data.data
      .filter((row) => row.security_id && row.iv !== undefined)
      .map((row) => ({
        securityId: String(row.security_id),
        exchange: target.exchange,
        strike: row.strike_price || 0,
        optionType: (row.option_type === "CE" ? "CE" : "PE") as "CE" | "PE",
        iv: row.iv || 0,
        delta: row.greeks?.delta || 0,
        gamma: row.greeks?.gamma || 0,
        theta: row.greeks?.theta || 0,
        vega: row.greeks?.vega || 0,
        timestamp: Date.now(),
      }));

    const snapshot: GreeksSnapshot = {
      underlying: target.underlying,
      expiry: target.expiry,
      strikes,
      fetchedAt: Date.now(),
    };

    const key = `${target.underlying}:${target.expiry}`;
    this.cache.set(key, snapshot);

    console.log(
      `${LOG_PREFIX} Fetched ${strikes.length} Greeks for ${target.underlying} exp=${target.expiry}`
    );

    this.config.onGreeksUpdate(snapshot);
  }
}
