/**
 * DisciplineOverlay — Placeholder for Phase 4 implementation.
 * Will contain: Circuit Breakers, Trade Limits, Pre-Trade Gate, Expiry Controls.
 */
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Shield, Construction } from 'lucide-react';

interface DisciplineOverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function DisciplineOverlay({ open, onOpenChange }: DisciplineOverlayProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl h-[70vh] p-0 gap-0 bg-background border-border overflow-hidden">
        <DialogHeader className="px-6 pt-5 pb-3 border-b border-border">
          <DialogTitle className="flex items-center gap-2 text-base font-display font-bold tracking-tight">
            <Shield className="h-4 w-4 text-info-cyan" />
            Discipline Engine
            <span className="text-[9px] text-muted-foreground tracking-widest uppercase ml-2">
              Ctrl+D to toggle
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8">
          <Construction className="h-12 w-12 text-muted-foreground" />
          <div className="text-center space-y-2">
            <h3 className="font-display text-lg font-bold text-foreground">
              Coming in Phase 4
            </h3>
            <p className="text-[11px] text-muted-foreground max-w-md">
              The Discipline Engine will enforce trading rules in real-time, including circuit breakers,
              trade limits, cooldown periods, pre-trade gates, and expiry controls. All violations will
              be logged and scored.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3 mt-4 max-w-sm w-full">
            {[
              { label: 'Circuit Breakers', desc: 'Auto-halt on loss limits' },
              { label: 'Trade Limits', desc: 'Max trades per day/session' },
              { label: 'Pre-Trade Gate', desc: 'Checklist + rationale required' },
              { label: 'Expiry Controls', desc: 'Per-instrument expiry rules' },
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
