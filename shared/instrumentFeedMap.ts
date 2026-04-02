/**
 * Instrument Feed Map
 *
 * Maps UI instrument keys (NIFTY_50, BANKNIFTY, etc.) to the
 * securityId + exchange needed for broker feed subscriptions.
 *
 * For Dhan: securityIds come from scrip master (underlying index futures).
 * For Mock: uses MOCK-* prefixed IDs that the MockAdapter recognizes.
 *
 * This is used by the frontend to auto-subscribe instruments on load.
 */

export interface FeedInstrument {
  /** UI instrument key (matches tradingStore key) */
  name: string;
  /** Broker security ID for the underlying (index spot/futures) */
  securityId: string;
  /** Exchange segment for feed subscription */
  exchange: "NSE_FNO" | "BSE_FNO" | "MCX_COMM";
  /** Feed mode */
  mode: "ticker" | "quote" | "full";
}

/**
 * Default feed instruments for the 4 tracked underlyings.
 * securityIds here are for the Mock adapter.
 * The server can override these with real Dhan securityIds at runtime.
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
