/**
 * TradeLimitBars — Progress bars showing trades/day, open positions, and exposure.
 * Displayed in the Trading Desk summary area.
 */
import { BarChart3, Activity, TrendingUp } from 'lucide-react';

interface TradeLimitBarsProps {
  tradesToday: number;
  maxTrades: number;
  openPositions: number;
  maxPositions: number;
  exposurePercent: number;
  maxExposurePercent: number;
}

function LimitBar({
  label,
  current,
  max,
  unit,
  icon: Icon,
}: {
  label: string;
  current: number;
  max: number;
  unit: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  const pct = max > 0 ? Math.min((current / max) * 100, 100) : 0;
  const color =
    pct >= 100 ? 'bg-loss-red' :
    pct >= 80 ? 'bg-warning-amber' :
    'bg-profit-green/70';
  const textColor =
    pct >= 100 ? 'text-loss-red' :
    pct >= 80 ? 'text-warning-amber' :
    'text-profit-green';

  return (
    <div className="flex items-center gap-2">
      <Icon className="h-3 w-3 text-muted-foreground flex-shrink-0" />
      <span className="text-[9px] text-muted-foreground w-16 truncate">{label}</span>
      <div className="flex-1 h-1.5 bg-border rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={`text-[9px] font-bold w-16 text-right ${textColor}`}>
        {current}{unit} / {max}{unit}
      </span>
    </div>
  );
}

export default function TradeLimitBars({
  tradesToday,
  maxTrades,
  openPositions,
  maxPositions,
  exposurePercent,
  maxExposurePercent,
}: TradeLimitBarsProps) {
  return (
    <div className="space-y-1.5 p-2 border border-border rounded-md bg-card">
      <LimitBar
        label="Trades"
        current={tradesToday}
        max={maxTrades}
        unit=""
        icon={BarChart3}
      />
      <LimitBar
        label="Positions"
        current={openPositions}
        max={maxPositions}
        unit=""
        icon={Activity}
      />
      <LimitBar
        label="Exposure"
        current={Math.round(exposurePercent)}
        max={maxExposurePercent}
        unit="%"
        icon={TrendingUp}
      />
    </div>
  );
}
