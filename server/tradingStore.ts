/**
 * In-memory instrument-config store.
 *
 * Holds the configured + active instrument keys that drive which instruments
 * the Python pipeline (TFA / SEA) processes. Read via /api/trading/active-
 * instruments and the trading.activeInstruments tRPC procedure.
 *
 * The legacy Fetcher/Analyzer option-chain + analysis data that used to live
 * here was removed (that pipeline is retired) — live instrument data now comes
 * from TFA features (trading.instrumentLiveState) + SEA signals.
 */

// Configured instruments (loaded from the DB at boot) and the subset currently
// active. Active defaults to all configured.
let configuredInstrumentKeys: string[] = [];
let activeInstruments: Set<string> = new Set();

/**
 * Set the configured instruments from the database. Called at server startup
 * after loading from the instruments collection, and after any add/remove.
 */
export function setConfiguredInstruments(
  instruments: Array<{ key: string; displayName: string; exchange: string }>,
): void {
  configuredInstrumentKeys = instruments.map((i) => i.key);
  // Initialize active instruments with all configured instruments.
  activeInstruments = new Set(configuredInstrumentKeys);
}

export function getActiveInstruments(): string[] {
  return Array.from(activeInstruments);
}

export function setActiveInstruments(instruments: string[]): void {
  // Validate: only allow known instrument keys, and keep at least one active.
  const valid = instruments.filter((k) => configuredInstrumentKeys.includes(k));
  activeInstruments = valid.length === 0 ? new Set(configuredInstrumentKeys) : new Set(valid);
}

export function getConfiguredInstrumentKeys(): string[] {
  return configuredInstrumentKeys;
}

export function isInstrumentActive(instrument: string): boolean {
  return activeInstruments.has(instrument);
}
