/**
 * Instrument Feed Map
 *
 * Maps UI instrument keys (NIFTY_50, BANKNIFTY, etc.) to the
 * securityId + exchange needed for broker feed subscriptions.
 *
 * For Dhan live:
 *   - NIFTY  → IDX_I:13  (index segment)
 *   - BANKNIFTY → IDX_I:25
 *   - CRUDEOIL/NATURALGAS → MCX_COMM:{resolved at runtime from scrip master}
 *
 * For Mock: uses MOCK-* prefixed IDs that the MockAdapter recognizes.
 *
 * The frontend calls `broker.feed.resolveInstruments` at runtime to get
 * the correct securityId + exchange for the active broker adapter.
 */

export interface FeedInstrument {
  /** UI instrument key (matches tradingStore key) */
  name: string;
  /** Broker security ID for the underlying (index spot/futures) */
  securityId: string;
  /** Exchange segment for feed subscription */
  exchange: string; // IDX_I, NSE_EQ, NSE_FNO, BSE_FNO, MCX_COMM
  /** Feed mode */
  mode: "ticker" | "quote" | "full";
}

/**
 * Default feed instruments — used ONLY as fallback for Mock adapter.
 * Real Dhan IDs are resolved at runtime via `broker.feed.resolveInstruments`.
 */
export const DEFAULT_FEED_INSTRUMENTS: FeedInstrument[] = [
  {
    name: "NIFTY_50",
    securityId: "NIFTY_50",
    exchange: "NSE_FNO",
    mode: "full",
  },
  {
    name: "BANKNIFTY",
    securityId: "BANKNIFTY",
    exchange: "NSE_FNO",
    mode: "full",
  },
  {
    name: "CRUDEOIL",
    securityId: "CRUDEOIL",
    exchange: "MCX_COMM",
    mode: "full",
  },
  {
    name: "NATURALGAS",
    securityId: "NATURALGAS",
    exchange: "MCX_COMM",
    mode: "full",
  },
];

/** Map from UI instrument name to feed key "exchange:securityId" */
export function getFeedKey(name: string): string | undefined {
  const inst = DEFAULT_FEED_INSTRUMENTS.find((i) => i.name === name);
  if (!inst) return undefined;
  return `${inst.exchange}:${inst.securityId}`;
}
