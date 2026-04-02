/**
 * RightDrawer — Slide-in panel from the right for Signals Feed + Alert History.
 * Uses Sheet (Radix dialog) for the drawer mechanics.
 */
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import SignalsFeed from '@/components/SignalsFeed';
import AlertHistory from '@/components/AlertHistory';
import type { Signal } from '@/lib/types';

interface RightDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  signals: Signal[];
}

export default function RightDrawer({ open, onOpenChange, signals }: RightDrawerProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-[380px] sm:max-w-[380px] p-0 flex flex-col bg-background border-l border-border"
      >
        <SheetHeader className="px-4 pt-4 pb-0">
          <SheetTitle className="text-[11px] font-bold tracking-widest uppercase text-muted-foreground">
            Signals & Alerts
          </SheetTitle>
        </SheetHeader>

        {/* Signals Feed */}
        <div className="flex-1 overflow-y-auto px-2 py-2 space-y-3">
          <div className="h-[calc(100vh-220px)]">
            <SignalsFeed signals={signals} />
          </div>
          <AlertHistory />
        </div>
      </SheetContent>
    </Sheet>
  );
}
