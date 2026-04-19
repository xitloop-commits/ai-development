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

const TAB_COLORS: Record<string, { active: string; text: string }> = {
  NIFTY_50: { active: 'bg-info-cyan/15 text-info-cyan', text: 'text-info-cyan' },
  BANKNIFTY: { active: 'bg-bullish/15 text-bullish', text: 'text-bullish' },
  CRUDEOIL: { active: 'bg-warning-amber/15 text-warning-amber', text: 'text-warning-amber' },
  NATURALGAS: { active: 'bg-destructive/15 text-destructive', text: 'text-destructive' },
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
      {/* Tabs — same style as workspace tabs */}
      <div className="flex items-stretch border-b border-border">
        {instruments.map((inst, idx) => {
          const isActive = idx === activeTab;
          const colors = TAB_COLORS[inst.name] ?? { active: 'bg-foreground/15 text-foreground', text: 'text-foreground' };
          return (
            <button
              key={inst.name}
              onClick={() => setActiveTab(idx)}
              className={`flex-1 px-4 py-2 text-[0.625rem] font-bold tracking-wider uppercase transition-colors border-r border-border last:border-r-0 ${
                isActive
                  ? colors.active
                  : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'
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
