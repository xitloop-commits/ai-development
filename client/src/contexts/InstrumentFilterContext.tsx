/**
 * InstrumentFilterContext — Manages which instruments are visible on the dashboard.
 * Persists user preferences in localStorage.
 */
import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from 'react';

const STORAGE_KEY = 'ats_instrument_filter';

/** All available instruments in the system */
export const ALL_INSTRUMENTS = [
  { key: 'NIFTY_50', displayName: 'NIFTY 50', exchange: 'NSE' },
  { key: 'CRUDEOIL', displayName: 'CRUDE OIL', exchange: 'MCX' },
  { key: 'NATURALGAS', displayName: 'NATURAL GAS', exchange: 'MCX' },
] as const;

export type InstrumentKey = (typeof ALL_INSTRUMENTS)[number]['key'];

interface InstrumentFilterContextValue {
  /** Set of currently enabled instrument keys */
  enabledInstruments: Set<InstrumentKey>;
  /** Toggle a single instrument on/off */
  toggleInstrument: (key: InstrumentKey) => void;
  /** Enable all instruments */
  enableAll: () => void;
  /** Disable all instruments */
  disableAll: () => void;
  /** Check if a specific instrument is enabled */
  isEnabled: (key: InstrumentKey) => boolean;
  /** Number of enabled instruments */
  enabledCount: number;
}

const InstrumentFilterContext = createContext<InstrumentFilterContextValue | null>(null);

function loadEnabledInstruments(): Set<InstrumentKey> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as string[];
      const validKeys = new Set(ALL_INSTRUMENTS.map((i) => i.key));
      const filtered = parsed.filter((k) => validKeys.has(k as InstrumentKey)) as InstrumentKey[];
      if (filtered.length > 0) {
        return new Set(filtered);
      }
    }
  } catch {
    // Corrupt data — reset to all enabled
  }
  return new Set(ALL_INSTRUMENTS.map((i) => i.key));
}

function saveEnabledInstruments(enabled: Set<InstrumentKey>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(enabled)));
  } catch {
    // Storage unavailable
  }
}

export function InstrumentFilterProvider({ children }: { children: ReactNode }) {
  const [enabledInstruments, setEnabledInstruments] = useState<Set<InstrumentKey>>(
    loadEnabledInstruments,
  );

  // Persist whenever the set changes
  useEffect(() => {
    saveEnabledInstruments(enabledInstruments);
  }, [enabledInstruments]);

  const toggleInstrument = useCallback((key: InstrumentKey) => {
    setEnabledInstruments((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        // Don't allow disabling all — keep at least one
        if (next.size > 1) {
          next.delete(key);
        }
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const enableAll = useCallback(() => {
    setEnabledInstruments(new Set(ALL_INSTRUMENTS.map((i) => i.key)));
  }, []);

  const disableAll = useCallback(() => {
    // Keep at least the first instrument enabled
    setEnabledInstruments(new Set([ALL_INSTRUMENTS[0].key]));
  }, []);

  const isEnabled = useCallback(
    (key: InstrumentKey) => enabledInstruments.has(key),
    [enabledInstruments],
  );

  return (
    <InstrumentFilterContext.Provider
      value={{
        enabledInstruments,
        toggleInstrument,
        enableAll,
        disableAll,
        isEnabled,
        enabledCount: enabledInstruments.size,
      }}
    >
      {children}
    </InstrumentFilterContext.Provider>
  );
}

export function useInstrumentFilter(): InstrumentFilterContextValue {
  const ctx = useContext(InstrumentFilterContext);
  if (!ctx) {
    throw new Error('useInstrumentFilter must be used within an InstrumentFilterProvider');
  }
  return ctx;
}
