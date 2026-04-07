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
  useMemo,
  type ReactNode,
} from 'react';
import { trpc } from '@/lib/trpc';

const STORAGE_KEY = 'ats_instrument_filter';

/** Default 4 instruments (fallback while loading from API) */
const DEFAULT_INSTRUMENTS = [
  { key: 'NIFTY_50', displayName: 'NIFTY 50', exchange: 'NSE' },
  { key: 'BANKNIFTY', displayName: 'BANK NIFTY', exchange: 'NSE' },
  { key: 'CRUDEOIL', displayName: 'CRUDE OIL', exchange: 'MCX' },
  { key: 'NATURALGAS', displayName: 'NATURAL GAS', exchange: 'MCX' },
];

export type InstrumentKey = string;

interface InstrumentFilterContextValue {
  /** All configured instruments from the database */
  allInstruments: Array<{ key: string; displayName: string; exchange: string }>;
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

function loadEnabledInstruments(validKeys: Set<string>): Set<InstrumentKey> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as string[];
      const filtered = parsed.filter((k) => validKeys.has(k));
      if (filtered.length > 0) {
        return new Set(filtered);
      }
    }
  } catch {
    // Corrupt data — reset to all enabled
  }
  return new Set(Array.from(validKeys));
}

function saveEnabledInstruments(enabled: Set<InstrumentKey>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(enabled)));
  } catch {
    // Storage unavailable
  }
}

export function InstrumentFilterProvider({ children }: { children: ReactNode }) {
  // Load configured instruments from the database
  const { data: instrumentsData } = trpc.instruments.list.useQuery();
  const allInstruments = instrumentsData ?? DEFAULT_INSTRUMENTS;

  // Memoize validKeys to avoid creating a new Set on every render
  const validKeys = useMemo(
    () => new Set(allInstruments.map((i) => i.key)),
    [instrumentsData]
  );

  // Initialize enabled instruments from localStorage, filtered by valid keys
  const [enabledInstruments, setEnabledInstruments] = useState<Set<InstrumentKey>>(() =>
    loadEnabledInstruments(validKeys),
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
    if (!hasSyncedOnMount.current && allInstruments.length > 0) {
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
    setEnabledInstruments(new Set(allInstruments.map((i) => i.key)));
  }, [allInstruments]);

  const disableAll = useCallback(() => {
    // Keep at least the first instrument enabled
    if (allInstruments.length > 0) {
      setEnabledInstruments(new Set([allInstruments[0].key]));
    }
  }, [allInstruments]);

  const isEnabled = useCallback(
    (key: InstrumentKey) => enabledInstruments.has(key),
    [enabledInstruments],
  );

  return (
    <InstrumentFilterContext.Provider
      value={{
        allInstruments,
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
