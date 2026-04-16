/**
 * LeftSidebar — In-flow push sidebar for Instrument Analysis Cards.
 * Visible by default, pushes center content. Fully disappears when hidden.
 * Tabbed navigation for each instrument.
 */
import { useState } from 'react';
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

interface LeftSidebarProps {
  visible: boolean;
  instruments: InstrumentData[];
  resolvedInstruments?: ResolvedFeedInstrument[];
}

export default function LeftSidebar({ visible, instruments, resolvedInstruments }: LeftSidebarProps) {
  const [activeTab, setActiveTab] = useState(0);

  const currentInstrument = instruments[activeTab] ?? instruments[0];

  if (!visible) return null;

  return (
    <aside className="w-[360px] shrink-0 border-r border-border bg-background flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-4 pt-3 pb-0">
        <h2 className="text-[0.6875rem] font-bold tracking-widest uppercase text-muted-foreground">
          Instrument Analysis
        </h2>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 px-4 pt-2 pb-0">
        {instruments.map((inst, idx) => {
          const isActive = idx === activeTab;
          const colorClass = TAB_COLORS[inst.name] ?? 'text-foreground border-foreground';
          return (
            <button
              key={inst.name}
              onClick={() => setActiveTab(idx)}
              className={`px-3 py-1.5 rounded-t text-[0.625rem] font-bold tracking-wider uppercase border-b-2 transition-colors ${
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
            <p className="text-[0.6875rem] text-muted-foreground">
              No instruments available
            </p>
          </div>
        )}
      </div>
    </aside>
  );
}
