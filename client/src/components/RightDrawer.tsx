/**
 * RightSidebar — In-flow push sidebar for Signals Feed + Alert History.
 * Visible by default, pushes center content. Fully disappears when hidden.
 */
import SignalsFeed from '@/components/SignalsFeed';
import AlertHistory from '@/components/AlertHistory';
import type { Signal } from '@/lib/types';

interface RightSidebarProps {
  visible: boolean;
  signals: Signal[];
}

export default function RightSidebar({ visible, signals }: RightSidebarProps) {
  if (!visible) return null;

  return (
    <aside className="w-[320px] shrink-0 border-l border-border bg-background flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-4 pt-3 pb-2">
        <h2 className="text-[11px] font-bold tracking-widest uppercase text-muted-foreground">
          Signals & Alerts
        </h2>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-3">
        <div className="flex-1">
          <SignalsFeed signals={signals} />
        </div>
        <AlertHistory />
      </div>
    </aside>
  );
}
