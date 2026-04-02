/**
 * LeftDrawer — Slide-in panel from the left for Instrument Analysis Cards.
 * Uses Sheet (Radix dialog) for the drawer mechanics.
 * Tabbed navigation for each instrument.
 */
import { useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import InstrumentCard from '@/components/InstrumentCard';
import type { InstrumentData } from '@/lib/types';

const NIFTY_BG = 'https://d2xsxph8kpxj0f.cloudfront.net/310519663447231618/hZHDUL7Uaz8bz3VADXMZ3Y/nifty-card-bg-JXr3vgp8ArcCjeDYxuHp5e.webp';
const CRUDE_BG = 'https://d2xsxph8kpxj0f.cloudfront.net/310519663447231618/hZHDUL7Uaz8bz3VADXMZ3Y/crude-card-bg-9ALVSYhrmD5LJG7UAqvQuP.webp';
const NATGAS_BG = 'https://d2xsxph8kpxj0f.cloudfront.net/310519663447231618/hZHDUL7Uaz8bz3VADXMZ3Y/natgas-card-bg-9652MS4YtP9ssiQqHZSrhd.webp';

const bgMap: Record<string, string> = {
  NIFTY_50: NIFTY_BG,
  BANKNIFTY: NIFTY_BG,
  CRUDEOIL: CRUDE_BG,
  NATURALGAS: NATGAS_BG,
};

const TAB_LABELS: Record<string, string> = {
  NIFTY_50: 'NIFTY',
  BANKNIFTY: 'BNIFTY',
  CRUDEOIL: 'CRUDE',
  NATURALGAS: 'NATGAS',
};

const TAB_COLORS: Record<string, string> = {
  NIFTY_50: 'text-info-cyan border-info-cyan',
  BANKNIFTY: 'text-bullish border-bullish',
  CRUDEOIL: 'text-warning-amber border-warning-amber',
  NATURALGAS: 'text-destructive border-destructive',
};

interface ResolvedFeedInstrument {
  name: string;
  securityId: string;
  exchange: string;
  mode: string;
}

interface LeftDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  instruments: InstrumentData[];
  resolvedInstruments?: ResolvedFeedInstrument[];
}

export default function LeftDrawer({ open, onOpenChange, instruments, resolvedInstruments }: LeftDrawerProps) {
  const [activeTab, setActiveTab] = useState(0);

  const currentInstrument = instruments[activeTab] ?? instruments[0];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="left"
        className="w-[480px] sm:max-w-[480px] p-0 flex flex-col bg-background border-r border-border"
      >
        <SheetHeader className="px-4 pt-4 pb-0">
          <SheetTitle className="text-[11px] font-bold tracking-widest uppercase text-muted-foreground">
            Instrument Analysis
          </SheetTitle>
        </SheetHeader>

        {/* Tabs */}
        <div className="flex items-center gap-1 px-4 pt-2 pb-0">
          {instruments.map((inst, idx) => {
            const isActive = idx === activeTab;
            const colorClass = TAB_COLORS[inst.name] ?? 'text-foreground border-foreground';
            return (
              <button
                key={inst.name}
                onClick={() => setActiveTab(idx)}
                className={`px-3 py-1.5 rounded-t text-[10px] font-bold tracking-wider uppercase border-b-2 transition-colors ${
                  isActive
                    ? `${colorClass} bg-card`
                    : 'text-muted-foreground border-transparent hover:text-foreground hover:bg-accent'
                }`}
              >
                {TAB_LABELS[inst.name] ?? inst.name}
              </button>
            );
          })}
        </div>

        {/* Instrument Card */}
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {currentInstrument ? (
            <InstrumentCard
              data={currentInstrument}
              bgImage={bgMap[currentInstrument.name]}
              feedExchange={resolvedInstruments?.find(r => r.name === currentInstrument.name)?.exchange}
              feedSecurityId={resolvedInstruments?.find(r => r.name === currentInstrument.name)?.securityId}
            />
          ) : (
            <div className="flex items-center justify-center h-full">
              <p className="text-[11px] text-muted-foreground">
                No instruments available
              </p>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
