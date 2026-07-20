/**
 * LeftDrawer — Watchlist (T87).
 *
 * A single "Watchlist" tab replacing the old instrument-analysis cards. Two
 * sections, both a simple live-LTP list (no strike bar / no option picker —
 * the instrument bar is gone):
 *   • Indices — NIFTY / BANK NIFTY / CRUDE OIL / NATURAL GAS, underlying LTP.
 *     NIFTY + BANK NIFTY rows also carry the current expiry, ATM strike, a CE/PE
 *     toggle and a Long button (ctrl+click places a manual BUY).
 *   • Stocks  — search the Dhan scrip master, add, watch live LTP.
 * Pushes the center content; fully disappears when hidden.
 */
import { useInstrumentLiveState } from '@/hooks/useInstrumentLiveState';
import { WatchlistPane } from '@/components/WatchlistPane';
import { IndexOptionRow } from '@/components/IndexOptionRow';
import { useInstrumentColors } from '@/lib/useInstrumentColors';
import { useDrawerPin } from '@/hooks/useDrawerPin';
import { PinButton } from '@/components/PinButton';
import { ReplayPane } from '@/components/ReplayPane';
import { useState } from 'react';
import { useSelectedRunId } from '@/lib/replaySelection';

/** Minimal tab descriptor (kept for the MainScreen prop shape). */
interface SidebarInstrument {
  name: string;        // instrument key (NIFTY_50, BANKNIFTY, …)
  displayName: string;
  exchange?: string;
}

interface ResolvedFeedInstrument {
  name: string;
  securityId: string;
  exchange: string;
  mode: string;
}

const INDEX_LABELS: Record<string, string> = {
  NIFTY_50: 'NIFTY 50',
  BANKNIFTY: 'BANK NIFTY',
  CRUDEOIL: 'CRUDE OIL',
  NATURALGAS: 'NATURAL GAS',
};

/** Indices whose row carries the expiry / strike / CE-PE / Long controls.
 *  Crude + Gas are plain LTP rows for now — same live-state fields are there,
 *  so adding them is a one-line change once you want MCX manual entry. */
const OPTION_TRADEABLE = new Set(['NIFTY_50', 'BANKNIFTY']);

interface LeftSidebarProps {
  visible: boolean;
  instruments: SidebarInstrument[];
  resolvedInstruments?: ResolvedFeedInstrument[];
}

/** One index row — underlying LTP from the WS-pushed TFA live state (no poll).
 *  Keeps the per-instrument colour (a leading dot). */
function IndexRow({ name, label, color }: { name: string; label: string; color: string }) {
  // Canonical live-state key: NIFTY_50 → nifty50, BANKNIFTY → banknifty, …
  const key = name.toLowerCase().replace(/_/g, '');
  const state = useInstrumentLiveState<any>(key);
  const spot = state?.live?.spot_price ?? 0;
  return (
    <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-border/50 hover:bg-muted/30">
      <span className="h-2 w-2 rounded-full shrink-0" style={{ background: color }} />
      <span className="text-xs font-bold flex-1 truncate" style={{ color }}>{label}</span>
      <span className="text-xs font-bold tabular-nums text-foreground min-w-[64px] text-right">
        {spot > 0
          ? spot.toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
          : <span className="text-[0.625rem] italic text-muted-foreground">…</span>}
      </span>
    </div>
  );
}

export default function LeftSidebar({ visible, instruments }: LeftSidebarProps) {
  const { hexOf } = useInstrumentColors();
  const { pinned, togglePin } = useDrawerPin('left');
  const [tab, setTab] = useState<'watchlist' | 'replay'>('watchlist');
  const viewingRun = useSelectedRunId() != null;
  if (!visible) return null;

  return (
    <aside className="w-[320px] shrink-0 border-r border-border bg-background flex flex-col overflow-hidden">
      {/* Single Watchlist tab */}
      {/* Watchlist | Replay. Replay shows a dot while a run is being viewed on
          the desk, so it's obvious the desk isn't showing the live book. */}
      <div className="flex items-stretch border-b border-border bg-secondary/50">
        {(['watchlist', 'replay'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`flex-1 px-3 py-2 text-[0.625rem] font-bold tracking-wider uppercase transition-colors ${
              tab === t ? 'text-foreground bg-secondary' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {t === 'watchlist' ? 'Watchlist' : 'Replay'}
            {t === 'replay' && viewingRun && (
              <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-info-cyan align-middle" />
            )}
          </button>
        ))}
        <PinButton pinned={pinned} onToggle={togglePin} />
      </div>

      {tab === 'replay' ? (
        <div className="flex-1 min-h-0 overflow-hidden">
          <ReplayPane />
        </div>
      ) : (
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {/* Indices — underlying LTP list */}
        <div className="shrink-0 pt-1">
          {instruments.map((inst) => {
            const Row = OPTION_TRADEABLE.has(inst.name) ? IndexOptionRow : IndexRow;
            return (
              <Row
                key={inst.name}
                name={inst.name}
                label={INDEX_LABELS[inst.name] ?? inst.name}
                color={hexOf(inst.name)}
              />
            );
          })}
        </div>

        {/* Stocks — search + watchlist (live LTP) */}
        <div className="flex-1 min-h-0 flex flex-col mt-1 border-t border-border">
          <div className="flex-1 min-h-0">
            <WatchlistPane />
          </div>
        </div>
      </div>
      )}
    </aside>
  );
}
