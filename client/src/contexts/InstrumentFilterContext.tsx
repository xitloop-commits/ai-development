/**
 * InstrumentFilterContext — Manages which instruments are visible on the dashboard.
 * Persists user preferences in localStorage AND syncs to the backend so
 * Python modules can poll the active instruments list and skip disabled ones.
 */
import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';
import { trpc } from '@/lib/trpc';

const STORAGE_KEY = 'ats_instrument_filter';

/** All available instruments in the system */
export const ALL_INSTRUMENTS = [
  { key: 'NIFTY_50', displayName: 'NIFTY 50', exchange: 'NSE' },
  { key: 'BANKNIFTY', displayName: 'BANK NIFTY', exchange: 'NSE' },
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
  /** Whether the backend sync is in progress */
  isSyncing: boolean;
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

  // tRPC mutation to sync active instruments to the backend
  const syncMutation = trpc.trading.setActiveInstruments.useMutation();
  const syncTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced sync to backend — waits 500ms after last change to avoid rapid-fire
  const syncToBackend = useCallback(
    (instruments: Set<InstrumentKey>) => {
      if (syncTimeoutRef.current) {
        clearTimeout(syncTimeoutRef.current);
      }
      syncTimeoutRef.current = setTimeout(() => {
        syncMutation.mutate({ instruments: Array.from(instruments) });
      }, 500);
    },
    [syncMutation],
  );

  // Persist locally and sync to backend whenever the set changes
  useEffect(() => {
    saveEnabledInstruments(enabledInstruments);
    syncToBackend(enabledInstruments);
  }, [enabledInstruments]); // eslint-disable-line react-hooks/exhaustive-deps

  // On mount, also sync current state to backend (in case server restarted)
  const hasSyncedOnMount = useRef(false);
  useEffect(() => {
    if (!hasSyncedOnMount.current) {
      hasSyncedOnMount.current = true;
      syncMutation.mutate({ instruments: Array.from(enabledInstruments) });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
        isSyncing: syncMutation.isPending,
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
