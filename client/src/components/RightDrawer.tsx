/**
 * RightDrawer — Signals + Alerts as card-style tabs (T87 point 20).
 *
 * A tab bar (Signals | Alerts) in the same tab style as the left Watchlist
 * drawer; the active tab fills the drawer. Pushes center content; fully
 * disappears when hidden.
 */
import { useState } from 'react';
import { useDrawerPin } from '@/hooks/useDrawerPin';
import { PinButton } from '@/components/PinButton';
import SignalsFeed from '@/components/SignalsFeed';
import type { SEASignal } from '@/components/SignalsFeed';
import AlertHistory from '@/components/AlertHistory';
import { useAlerts } from '@/contexts/AlertContext';

interface RightSidebarProps {
  visible: boolean;
  signals: SEASignal[];
  onLoadOlder?: () => void;
  loadingOlder?: boolean;
  hasMore?: boolean;
}

type RightTab = 'signals' | 'alerts';

export default function RightSidebar({ visible, signals, onLoadOlder, loadingOlder, hasMore }: RightSidebarProps) {
  const [tab, setTab] = useState<RightTab>('signals');
  const { pinned, togglePin } = useDrawerPin('right');
  const { alerts } = useAlerts();
  if (!visible) return null;

  const TABS: { key: RightTab; label: string; count: number }[] = [
    { key: 'signals', label: 'Signals', count: signals.length },
    { key: 'alerts', label: 'Alerts', count: alerts.length },
  ];

  return (
    <aside className="w-[320px] shrink-0 border-l border-border bg-background flex flex-col overflow-hidden">
      {/* Card-style tabs */}
      <div className="flex items-stretch border-b border-border">
        {TABS.map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex-1 px-4 py-2 flex items-center justify-center gap-1.5 text-[0.625rem] font-bold tracking-wider uppercase transition-colors border-r border-border last:border-r-0 ${
                active ? 'bg-secondary/50 text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/30'
              }`}
            >
              {t.label}
              <span className={`min-w-[1.125rem] px-1 rounded-full text-[0.5625rem] tabular-nums leading-tight ${
                active ? 'bg-info-cyan/20 text-info-cyan' : 'bg-secondary text-muted-foreground'
              }`}>
                {t.count}
              </span>
            </button>
          );
        })}
        <PinButton pinned={pinned} onToggle={togglePin} />
      </div>

      {/* Active tab fills the drawer, flush (both panes bring their own surface). */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {tab === 'signals' ? (
          <SignalsFeed
            signals={signals}
            onLoadOlder={onLoadOlder}
            loadingOlder={loadingOlder}
            hasMore={hasMore}
          />
        ) : (
          <AlertHistory />
        )}
      </div>
    </aside>
  );
}
