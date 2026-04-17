/**
 * RightSidebar — In-flow push sidebar for Signals Feed + Alert History.
 * Visible by default, pushes center content. Fully disappears when hidden.
 *
 * Layout: flex column with SignalsFeed taking remaining space (flex-1)
 * and AlertHistory fixed at the bottom. SignalsFeed owns its own
 * scrollbar (scrollbar-thin scrollbar-cyan, matching TradingDesk).
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
      {/* SignalsFeed takes all available space — has its own sticky header + scroll */}
      <div className="flex-1 min-h-0 px-2 pt-2 pb-1">
        <SignalsFeed signals={signals} />
      </div>

      {/* AlertHistory at bottom — fixed height, collapsible */}
      <div className="shrink-0 px-2 pb-2">
        <AlertHistory />
      </div>
    </aside>
  );
}
