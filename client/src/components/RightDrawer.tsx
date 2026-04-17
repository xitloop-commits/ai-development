/**
 * RightSidebar — In-flow push sidebar for Signals Feed + Alert History.
 * Visible by default, pushes center content. Fully disappears when hidden.
 *
 * Capital Pools and Discipline have been moved to the footer.
 */
import SignalsFeed from '@/components/SignalsFeed';
import type { SEASignal } from '@/components/SignalsFeed';
import AlertHistory from '@/components/AlertHistory';

interface RightSidebarProps {
  visible: boolean;
  signals: SEASignal[];
}

export default function RightSidebar({ visible, signals }: RightSidebarProps) {
  if (!visible) return null;

  return (
    <aside className="w-[320px] shrink-0 border-l border-border bg-background flex flex-col overflow-hidden">
      {/* Signals & Alerts Header */}
      <div className="px-4 pt-3 pb-2 border-b border-border/50">
        <h2 className="text-[0.6875rem] font-bold tracking-widest uppercase text-muted-foreground">
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
