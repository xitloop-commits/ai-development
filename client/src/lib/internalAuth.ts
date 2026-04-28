/**
 * Internal-API auth client (B1-followup).
 *
 * The browser reads the shared INTERNAL_API_SECRET from a loopback-only
 * endpoint at GET /api/_auth/bootstrap on first paint, then attaches it
 * as `X-Internal-Token` to every subsequent /api/* call (tRPC and raw
 * fetches alike).
 *
 * Threat model: the dashboard runs only on the same machine as the
 * server (HTTP_HOST=127.0.0.1 by default; see B2). Anyone with a
 * browser pointed at localhost:3000 already has the token. Bootstrap
 * isolation is provided by the server-side loopback IP guard on the
 * bootstrap endpoint — external callers (e.g. someone behind a misconfig'd
 * reverse proxy) get 403 before the secret is ever returned.
 */

let cachedSecret: string | null = null;

export async function bootstrapInternalAuth(): Promise<void> {
  try {
    const r = await fetch("/api/_auth/bootstrap", {
      method: "GET",
      credentials: "include",
    });
    if (!r.ok) {
      // 403 = not on loopback (someone exposed the dashboard publicly?)
      // empty-ok = server has no secret configured; warn-only mode tolerates this.
      console.warn(`[internalAuth] bootstrap returned HTTP ${r.status}; X-Internal-Token will be omitted`);
      cachedSecret = "";
      return;
    }
    const body = (await r.json()) as { secret?: string };
    cachedSecret = body.secret ?? "";
    if (!cachedSecret) {
      console.info("[internalAuth] server has no INTERNAL_API_SECRET configured — header omitted (warn-only mode)");
    }
  } catch (err) {
    console.warn(`[internalAuth] bootstrap fetch failed: ${(err as Error).message} — header omitted`);
    cachedSecret = "";
  }
}

/** The token to send. Empty string when unset; callers should omit the header. */
export function getInternalToken(): string {
  return cachedSecret ?? "";
}

/**
 * Build a Headers-compatible object that includes X-Internal-Token when
 * present, or an empty object when not. Useful for raw fetch() calls.
 */
export function authHeaders(): Record<string, string> {
  const t = getInternalToken();
  return t ? { "X-Internal-Token": t } : {};
}

/** Test-only — let unit tests inject a known secret without hitting fetch. */
export function _setInternalTokenForTesting(value: string | null): void {
  cachedSecret = value;
}
