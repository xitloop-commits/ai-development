/**
 * Dhan Auth — Token validation, expiry detection, HTTP client
 *
 * Handles:
 * 1. Token expiry calculation (updatedAt + expiresIn vs now)
 * 2. Token validation against Dhan GET /fundlimit
 * 3. 401 detection and status update
 * 4. Centralized HTTP client with auth headers
 */

import {
  DHAN_API_BASE,
  DHAN_ENDPOINTS,
  DHAN_TOKEN_EXPIRY_MS,
  DHAN_TOKEN_EXPIRY_BUFFER_MS,
  DHAN_AUTH_ERROR_CODES,
} from "./constants";
import type { DhanFundLimitResponse, DhanErrorResponse } from "./types";
import {
  getBrokerConfig,
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
  options?: { timeout?: number }
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
 * Updates the broker config to mark token as expired.
 */
export async function handleDhan401(brokerId: string): Promise<void> {
  console.warn(`[DhanAuth] 401 detected for broker "${brokerId}". Marking token as expired.`);

  await updateBrokerCredentials(brokerId, {
    status: "expired",
  });

  await updateBrokerConnection(brokerId, {
    apiStatus: "error",
    lastApiCall: Date.now(),
  });
}
