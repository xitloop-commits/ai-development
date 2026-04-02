/**
 * JournalOverlay — Placeholder for Phase 5 implementation.
 * Will contain: Trade Journal with mandatory post-trade entries, streaks, and AI paper tab.
 */
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { BookOpen, Construction } from 'lucide-react';

interface JournalOverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function JournalOverlay({ open, onOpenChange }: JournalOverlayProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl h-[70vh] p-0 gap-0 bg-background border-border overflow-hidden">
        <DialogHeader className="px-6 pt-5 pb-3 border-b border-border">
          <DialogTitle className="flex items-center gap-2 text-base font-display font-bold tracking-tight">
            <BookOpen className="h-4 w-4 text-warning-amber" />
            Trade Journal
            <span className="text-[9px] text-muted-foreground tracking-widest uppercase ml-2">
              Ctrl+J to toggle
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8">
          <Construction className="h-12 w-12 text-muted-foreground" />
          <div className="text-center space-y-2">
            <h3 className="font-display text-lg font-bold text-foreground">
              Coming in Phase 5
            </h3>
            <p className="text-[11px] text-muted-foreground max-w-md">
              The Trade Journal will enforce mandatory post-trade entries with emotion tagging,
              lesson extraction, and performance tracking. Includes streak tracking and an
              AI Paper Trading comparison tab.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3 mt-4 max-w-sm w-full">
            {[
              { label: 'Journal Entries', desc: 'Mandatory post-trade logging' },
              { label: 'Emotion Tags', desc: 'Track emotional state per trade' },
              { label: 'Streaks', desc: 'Win/loss streak tracking' },
              { label: 'AI Paper Tab', desc: 'Compare your trades vs AI' },
            ].map((item) => (
              <div key={item.label} className="border border-border rounded-md p-3 bg-card">
                <span className="text-[10px] font-bold tracking-wider uppercase text-muted-foreground block">
                  {item.label}
                </span>
                <span className="text-[9px] text-muted-foreground/70">{item.desc}</span>
              </div>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
