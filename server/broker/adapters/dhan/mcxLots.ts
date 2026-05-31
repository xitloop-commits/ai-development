/**
 * MCX commodity lot-size source.
 *
 * MCX lot sizes (CRUDEOIL=100, NATURALGAS=1250, …) are fixed by the exchange and
 * are NOT carried in Dhan's scrip master (it reports lot=1 for every MCX
 * contract) nor any Dhan API. The only place Dhan publishes them is the
 * commodities lot-size page, which embeds the values as structured JSON in its
 * Next.js __NEXT_DATA__ blob:
 *
 *   props.pageProps.listData[] = { sym: "CRUDEOIL", fo_dt: [{ ls: "100 BBL", exp_dt }], opt_dt: [...] }
 *
 * We fetch + parse that on startup and daily. There is NO fallback: if a needed
 * MCX lot can't be resolved here the caller must reject the trade rather than
 * guess (a wrong commodity lot mis-sizes a real-money order by 100×+).
 *
 * NSE lots (NIFTY, BANKNIFTY) are unaffected — they come from the scrip master.
 */
import { createLogger } from "../../logger";

const log = createLogger("BSA", "McxLots");

const SOURCE_URL = "https://dhan.co/commodities-lot-size/";
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily

let mcxLots = new Map<string, number>();
let lastFetchAt = 0;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Pure parser: extract symbol→lot from the page HTML's __NEXT_DATA__ JSON.
 * Throws if the structure is missing or no lots parse (so a layout change is
 * loud, not silent). Exported for unit testing without a network call.
 */
export function parseMcxLotsFromHtml(html: string): Map<string, number> {
  const match = html.match(
    /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
  );
  if (!match) throw new Error("MCX lot page: __NEXT_DATA__ script not found");

  const data = JSON.parse(match[1]) as {
    props?: { pageProps?: { listData?: Array<Record<string, unknown>> } };
  };
  const list = data?.props?.pageProps?.listData;
  if (!Array.isArray(list)) throw new Error("MCX lot page: listData missing");

  const out = new Map<string, number>();
  for (const item of list) {
    const sym = String(item?.sym ?? "").toUpperCase().trim();
    const foDt = item?.fo_dt as Array<{ ls?: string }> | undefined;
    const optDt = item?.opt_dt as Array<{ ls?: string }> | undefined;
    const lsStr = foDt?.[0]?.ls ?? optDt?.[0]?.ls; // e.g. "100 BBL", "1250 mmBtu"
    if (!sym || !lsStr) continue;
    const lot = parseInt(String(lsStr).trim(), 10); // parseInt stops at the unit
    if (Number.isFinite(lot) && lot > 0) out.set(sym, lot);
  }
  if (out.size === 0) throw new Error("MCX lot page: no lot sizes parsed");
  return out;
}

/** Fetch the page and refresh the cache. Throws on network / parse failure. */
export async function refreshMcxLots(): Promise<number> {
  const res = await fetch(SOURCE_URL, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`MCX lot page HTTP ${res.status}`);
  const parsed = parseMcxLotsFromHtml(await res.text());

  // Alert on any changed lot vs the previous load — an MCX revision should be
  // noticed, not silently absorbed.
  parsed.forEach((lot, sym) => {
    const prev = mcxLots.get(sym);
    if (prev != null && prev !== lot) {
      log.warn(`MCX lot CHANGED for ${sym}: ${prev} -> ${lot} (verify exchange revision)`);
    }
  });

  mcxLots = parsed;
  lastFetchAt = Date.now();
  log.info(
    `MCX lots loaded: ${parsed.size} commodities ` +
      `(CRUDEOIL=${parsed.get("CRUDEOIL") ?? "?"}, NATURALGAS=${parsed.get("NATURALGAS") ?? "?"})`,
  );
  return parsed.size;
}

/** Authoritative MCX lot for a symbol, or undefined if not loaded/known. */
export function getMcxLot(symbol: string): number | undefined {
  return mcxLots.get(symbol.toUpperCase().replace(/\s+/g, ""));
}

/** True once at least one successful load has populated the cache. */
export function mcxLotsLoaded(): boolean {
  return mcxLots.size > 0;
}

/** Refresh now, then every 24h. Initial-load failure is logged (non-fatal); the
 *  fail-fast happens at trade time when a lot can't be resolved. */
export function startMcxLotScheduler(): void {
  void refreshMcxLots().catch((e) =>
    log.error(`MCX lot initial load failed: ${e?.message ?? e}`),
  );
  if (!refreshTimer) {
    refreshTimer = setInterval(() => {
      void refreshMcxLots().catch((e) =>
        log.warn(`MCX lot refresh failed (keeping last good): ${e?.message ?? e}`),
      );
    }, REFRESH_INTERVAL_MS);
  }
}

/** Test-only reset. */
export function _resetMcxLotsForTesting(): void {
  mcxLots = new Map();
  lastFetchAt = 0;
}
