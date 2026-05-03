/**
 * Dhan Auth — Token validation, expiry detection, HTTP client
 *
 * Handles:
 * 1. Token expiry calculation (updatedAt + expiresIn vs now)
 * 2. Token validation against Dhan GET /fundlimit
 * 3. 401 detection and status update
 * 4. Centralized HTTP client with auth headers
 */

import { createLogger } from "../../logger";

const log = createLogger("BSA", "DhanAuth");

import {
  DHAN_API_BASE,
  DHAN_ENDPOINTS,
  DHAN_TOKEN_EXPIRY_MS,
  DHAN_TOKEN_EXPIRY_BUFFER_MS,
  DHAN_AUTH_ERROR_CODES,
} from "./constants";
import type { DhanFundLimitResponse, DhanErrorResponse } from "./types";
import {
  updateBrokerCredentials,
  updateBrokerConnection,
} from "../../brokerConfig";

// ─── Token Expiry Helpers ──────────────────────────────────────

export interface TokenExpiryInfo {
  isExpired: boolean;
  isExpiringSoon: boolean; // within buffer window
  expiresAt: number; // UTC ms
  remainingMs: number;
  updatedAt: number;
}

/**
 * Calculate token expiry status from stored credentials.
 */
export function calculateTokenExpiry(
  updatedAt: number,
  expiresIn: number = DHAN_TOKEN_EXPIRY_MS
): TokenExpiryInfo {
  const now = Date.now();
  const expiresAt = updatedAt + expiresIn;
  const remainingMs = expiresAt - now;

  return {
    isExpired: remainingMs <= 0,
    isExpiringSoon: remainingMs > 0 && remainingMs <= DHAN_TOKEN_EXPIRY_BUFFER_MS,
    expiresAt,
    remainingMs: Math.max(0, remainingMs),
    updatedAt,
  };
}

// ─── HTTP Client ───────────────────────────────────────────────

export interface DhanApiResponse<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error: DhanErrorResponse | null;
  isAuthError: boolean;
}

/**
 * Make an authenticated request to Dhan API.
 * Automatically handles 401 detection and connection status updates.
 */
export async function dhanRequest<T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  endpoint: string,
  accessToken: string,
  body?: Record<string, unknown>,
  options?: { timeout?: number; clientId?: string }
): Promise<DhanApiResponse<T>> {
  const url = endpoint.startsWith("http")
    ? endpoint
    : `${DHAN_API_BASE}${endpoint}`;

  const timeout = options?.timeout ?? 10000;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "access-token": accessToken,
    };

    if (options?.clientId) {
      headers["client-id"] = options.clientId;
    }

    const fetchOptions: RequestInit = {
      method,
      headers,
      signal: controller.signal,
    };

    if (body && (method === "POST" || method === "PUT")) {
      fetchOptions.body = JSON.stringify(body);
    }

    const response = await fetch(url, fetchOptions);
    clearTimeout(timer);

    const isAuthError = DHAN_AUTH_ERROR_CODES.includes(response.status);

    if (!response.ok) {
      let errorData: DhanErrorResponse | null = null;
      try {
        errorData = (await response.json()) as DhanErrorResponse;
      } catch {
        // Response body may not be JSON
      }

      return {
        ok: false,
        status: response.status,
        data: null,
        error: errorData ?? {
          errorType: "HTTP_ERROR",
          errorCode: String(response.status),
          errorMessage: response.statusText,
        },
        isAuthError,
      };
    }

    const data = (await response.json()) as T;
    return { ok: true, status: response.status, data, error: null, isAuthError: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isAbort = message.includes("abort");

    return {
      ok: false,
      status: 0,
      data: null,
      error: {
        errorType: isAbort ? "TIMEOUT" : "NETWORK_ERROR",
        errorCode: "0",
        errorMessage: message,
      },
      isAuthError: false,
    };
  }
}

// ─── Token Validation ──────────────────────────────────────────

/**
 * Validate a Dhan access token by calling GET /fundlimit.
 * This is a lightweight endpoint that confirms the token is valid.
 */
export async function validateDhanToken(
  accessToken: string
): Promise<{
  valid: boolean;
  clientId?: string;
  error?: string;
  fundData?: DhanFundLimitResponse;
}> {
  const result = await dhanRequest<DhanFundLimitResponse>(
    "GET",
    DHAN_ENDPOINTS.FUND_LIMIT,
    accessToken
  );

  if (result.ok && result.data) {
    return {
      valid: true,
      clientId: result.data.dhanClientId,
      fundData: result.data,
    };
  }

  if (result.isAuthError) {
    return {
      valid: false,
      error: `Token invalid or expired (HTTP ${result.status})`,
    };
  }

  return {
    valid: false,
    error: result.error?.errorMessage ?? `Dhan API error (HTTP ${result.status})`,
  };
}

// ─── Token Update Flow ─────────────────────────────────────────

/**
 * Update the Dhan access token:
 * 1. Validate against Dhan API
 * 2. If valid, save to MongoDB with new updatedAt
 * 3. Update connection status
 * 4. If invalid, save with "expired" status
 */
export async function updateDhanToken(
  brokerId: string,
  newToken: string,
  clientId?: string
): Promise<{
  success: boolean;
  message: string;
  clientId?: string;
}> {
  // Step 1: Validate the new token
  const validation = await validateDhanToken(newToken);

  if (validation.valid) {
    // Step 2: Save valid token to MongoDB
    const resolvedClientId = clientId ?? validation.clientId ?? "";

    await updateBrokerCredentials(brokerId, {
      accessToken: newToken,
      clientId: resolvedClientId,
      updatedAt: Date.now(),
      expiresIn: DHAN_TOKEN_EXPIRY_MS,
      status: "valid",
    });

    // Step 3: Update connection status
    await updateBrokerConnection(brokerId, {
      apiStatus: "connected",
      lastApiCall: Date.now(),
    });

    return {
      success: true,
      message: "Token validated and saved successfully.",
      clientId: resolvedClientId,
    };
  }

  // Token is invalid — save with expired status
  await updateBrokerCredentials(brokerId, {
    accessToken: newToken,
    clientId: clientId ?? "",
    updatedAt: Date.now(),
    expiresIn: DHAN_TOKEN_EXPIRY_MS,
    status: "expired",
  });

  await updateBrokerConnection(brokerId, {
    apiStatus: "error",
    lastApiCall: Date.now(),
  });

  return {
    success: false,
    message: validation.error ?? "Token validation failed.",
  };
}

// ─── 401 Handler ───────────────────────────────────────────────

/**
 * Handle a 401 response from Dhan API.
 *
 * Updates the broker config to mark token as expired, then triggers
 * an immediate token refresh via TOTP (coalesced so concurrent 401s
 * from multiple in-flight calls don't hammer Dhan's auth endpoint).
 *
 * Before 2026-04-17: this function only marked status=expired and waited
 * for some other code path to call _tryAutoRefresh. That caused an
 * ~18-minute silent delay on 2026-04-16 07:42-08:00 where 401s kept
 * flowing until an internal feed health check incidentally triggered
 * the refresh. This now does it immediately.
 */

// Coalescing lock — only one TOTP refresh in flight at a time per broker.
// Exported so the DhanAdapter can coalesce its own _tryAutoRefresh calls with
// the one we fire from the 401 handler (prevents double TOTP generation).
export const _inflightRefresh = new Map<string, Promise<string | null>>();

// Backoff: after a failed refresh (rate limit), don't retry for this many ms.
// Dhan rate limit is "once every 2 minutes", so we wait 150s to be safe.
const _REFRESH_BACKOFF_MS = 150_000;
const _lastRefreshFailure = new Map<string, number>();

/**
 * Best-effort Telegram notification. Silently no-ops if credentials missing.
 * Used to alert the user on mid-day token regen events so they aren't invisible.
 */
async function notifyTelegram(message: string): Promise<void> {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;   // silently skip if not configured
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "HTML",
        disable_notification: false,
      }),
    });
  } catch (err) {
    // Never let a notification failure affect the actual refresh flow.
    log.warn(`Telegram notification failed: ${(err as Error).message}`);
  }
}

export async function handleDhan401(brokerId: string): Promise<string | null> {
  // If a refresh is already in flight, just wait on it — don't re-mark expired
  // (that would overwrite the "valid" status set by the in-flight refresh)
  if (_inflightRefresh.has(brokerId)) {
    log.info(`401 for "${brokerId}" — refresh already in flight, coalescing.`);
    return _inflightRefresh.get(brokerId)!;
  }

  // Backoff: if last refresh failed (rate limit), don't retry until cooldown expires
  const lastFail = _lastRefreshFailure.get(brokerId) ?? 0;
  const elapsed = Date.now() - lastFail;
  if (lastFail > 0 && elapsed < _REFRESH_BACKOFF_MS) {
    const waitSec = Math.ceil((_REFRESH_BACKOFF_MS - elapsed) / 1000);
    log.debug(`401 for "${brokerId}" — backoff active, retry in ${waitSec}s.`);
    return null;
  }

  log.warn(`401 detected for broker "${brokerId}". Triggering refresh.`);
  await updateBrokerCredentials(brokerId, { status: "expired" });
  await updateBrokerConnection(brokerId, {
    apiStatus: "error",
    lastApiCall: Date.now(),
  });

  // Import lazily to avoid circular dep with tokenManager.
  const { generateDhanToken } = await import("./tokenManager");

  const p = (async (): Promise<string | null> => {
    try {
      log.info(`Auto-refreshing Dhan token via TOTP (triggered by 401)...`);
      const newToken = await generateDhanToken(brokerId);
      // updateDhanToken is defined in this same file — call directly
      const result = await updateDhanToken(brokerId, newToken);
      if (result.success) {
        _lastRefreshFailure.delete(brokerId);
        log.warn(
          `Token auto-refreshed successfully after 401 — new token valid 24h.`
        );
        const now = new Date().toLocaleString("en-IN", {
          timeZone: "Asia/Kolkata",
        });
        await notifyTelegram(
          `🔑 <b>Dhan token auto-refreshed</b>\n` +
          `Broker: <code>${brokerId}</code>\n` +
          `Time:   ${now} IST\n` +
          `Trigger: 401 received → TOTP regen successful\n` +
          `Valid for: 24h`
        );
        return newToken;
      } else {
        log.error(`Token update to Mongo failed: ${result.message}`);
        await notifyTelegram(
          `⚠️ <b>Dhan token refresh FAILED</b>\n` +
          `Broker: <code>${brokerId}</code>\n` +
          `Reason: ${result.message}\n` +
          `Action required: investigate server logs.`
        );
        return null;
      }
    } catch (err: any) {
      log.error(`Auto-refresh from 401 handler failed: ${err.message}`);
      _lastRefreshFailure.set(brokerId, Date.now());
      return null;
    } finally {
      _inflightRefresh.delete(brokerId);
    }
  })();

  _inflightRefresh.set(brokerId, p);
  return p;
}
