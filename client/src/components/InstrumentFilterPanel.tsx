/**
 * InstrumentFilterPanel — Toggle instruments on/off in the Control Panel.
 * Terminal Noir styling with exchange badges and visual feedback.
 */
import { Switch } from '@/components/ui/switch';
import {
  useInstrumentFilter,
  ALL_INSTRUMENTS,
  type InstrumentKey,
} from '@/contexts/InstrumentFilterContext';
import { Eye, EyeOff, LayoutGrid, Loader2, CloudOff } from 'lucide-react';

const INSTRUMENT_ICONS: Record<InstrumentKey, string> = {
  NIFTY_50: '📊',
  BANKNIFTY: '🏦',
  CRUDEOIL: '🛢️',
  NATURALGAS: '🔥',
};

export default function InstrumentFilterPanel() {
  const { enabledInstruments, toggleInstrument, enableAll, enabledCount, isSyncing } =
    useInstrumentFilter();

  const allEnabled = enabledCount === ALL_INSTRUMENTS.length;

  return (
    <div className="space-y-3">
      {/* Section Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <LayoutGrid className="h-3 w-3 text-info-cyan" />
          <span className="text-[9px] font-bold text-info-cyan tracking-wider uppercase">
            Instruments
          </span>
        </div>
        <button
          onClick={enableAll}
          className={`text-[8px] tracking-wider uppercase px-1.5 py-0.5 rounded transition-colors ${
            allEnabled
              ? 'text-muted-foreground bg-secondary/30'
              : 'text-info-cyan bg-info-cyan/10 hover:bg-info-cyan/20 border border-info-cyan/30'
          }`}
        >
          {allEnabled ? 'All Active' : 'Show All'}
        </button>
      </div>

      {/* Instrument Toggles */}
      <div className="space-y-1.5">
        {ALL_INSTRUMENTS.map((inst) => {
          const isOn = enabledInstruments.has(inst.key);
          return (
            <div
              key={inst.key}
              className={`flex items-center justify-between rounded p-2 transition-all ${
                isOn
                  ? 'bg-secondary/40 border border-border'
                  : 'bg-secondary/10 border border-transparent opacity-60'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-sm">{INSTRUMENT_ICONS[inst.key]}</span>
                <div>
                  <div className="flex items-center gap-1.5">
                    <span className={`text-[10px] font-bold tracking-wider ${
                      isOn ? 'text-foreground' : 'text-muted-foreground'
                    }`}>
                      {inst.displayName}
                    </span>
                    <span className={`text-[8px] px-1 py-0.5 rounded ${
                      inst.exchange === 'NSE'
                        ? 'bg-info-cyan/10 text-info-cyan'
                        : 'bg-warning-amber/10 text-warning-amber'
                    }`}>
                      {inst.exchange}
                    </span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                {isOn ? (
                  <Eye className="h-3 w-3 text-bullish" />
                ) : (
                  <EyeOff className="h-3 w-3 text-muted-foreground" />
                )}
                <Switch
                  checked={isOn}
                  onCheckedChange={() => toggleInstrument(inst.key)}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* Active count + sync status */}
      <div className="text-center space-y-1">
        <span className="text-[9px] text-muted-foreground tabular-nums">
          {enabledCount} of {ALL_INSTRUMENTS.length} instruments active
        </span>
        <div className="flex items-center justify-center gap-1">
          {isSyncing ? (
            <>
              <Loader2 className="h-2.5 w-2.5 text-info-cyan animate-spin" />
              <span className="text-[8px] text-info-cyan">Syncing to pipeline...</span>
            </>
          ) : (
            <span className="text-[8px] text-muted-foreground">Pipeline synced</span>
          )}
        </div>
      </div>
    </div>
  );
}
