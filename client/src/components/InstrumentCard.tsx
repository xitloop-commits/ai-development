/*
 * Terminal Noir — InstrumentCard Component
 * Large data tile for each instrument showing bias, S&R, OI, and AI decision.
 * Card border glows green (bullish), red (bearish), or cyan (neutral).
 * Polished with OI bar visualization and hover effects.
 */
import { TrendingUp, TrendingDown, Minus, Shield, Target, Brain } from 'lucide-react';
import type { InstrumentData } from '@/lib/types';

const biasConfig = {
  BULLISH: { color: 'text-bullish', glow: 'glow-green', border: 'border-bullish/30', icon: TrendingUp, label: 'BULLISH' },
  BEARISH: { color: 'text-destructive', glow: 'glow-red', border: 'border-destructive/30', icon: TrendingDown, label: 'BEARISH' },
  RANGE_BOUND: { color: 'text-warning-amber', glow: 'glow-amber', border: 'border-warning-amber/30', icon: Minus, label: 'RANGE BOUND' },
  NEUTRAL: { color: 'text-info-cyan', glow: 'glow-cyan', border: 'border-info-cyan/30', icon: Minus, label: 'NEUTRAL' },
};

const aiConfig = {
  GO: { color: 'text-bullish', bg: 'bg-bullish/10', border: 'border-bullish/30', label: 'GO' },
  NO_GO: { color: 'text-destructive', bg: 'bg-destructive/10', border: 'border-destructive/30', label: 'NO GO' },
  WAIT: { color: 'text-warning-amber', bg: 'bg-warning-amber/10', border: 'border-warning-amber/30', label: 'WAIT' },
};

interface InstrumentCardProps {
  data: InstrumentData;
  bgImage?: string;
}

function formatOI(value: number): string {
  if (Math.abs(value) >= 1000000) return (value / 1000000).toFixed(1) + 'M';
  if (Math.abs(value) >= 1000) return (value / 1000).toFixed(0) + 'K';
  return value.toString();
}

function OIBar({ callOI, putOI }: { callOI: number; putOI: number }) {
  const total = callOI + putOI;
  const callPercent = total > 0 ? (callOI / total) * 100 : 50;
  return (
    <div className="w-full h-1.5 rounded-full bg-secondary/50 overflow-hidden flex">
      <div
        className="h-full bg-bullish/60 transition-all duration-500"
        style={{ width: `${callPercent}%` }}
      />
      <div
        className="h-full bg-destructive/60 transition-all duration-500"
        style={{ width: `${100 - callPercent}%` }}
      />
    </div>
  );
}

export default function InstrumentCard({ data, bgImage }: InstrumentCardProps) {
  const bias = biasConfig[data.marketBias];
  const ai = aiConfig[data.aiDecision];
  const BiasIcon = bias.icon;

  return (
    <div
      className={`group relative overflow-hidden rounded-md border ${bias.border} bg-card animate-fade-in-up transition-all duration-300 hover:border-opacity-60`}
    >
      {/* Background image overlay */}
      {bgImage && (
        <div
          className="absolute inset-0 opacity-10 group-hover:opacity-15 bg-cover bg-center transition-opacity duration-500"
          style={{ backgroundImage: `url(${bgImage})` }}
        />
      )}

      {/* Glow effect on left edge based on bias */}
      <div className={`absolute left-0 top-0 bottom-0 w-0.5 ${
        data.marketBias === 'BULLISH' ? 'bg-bullish' :
        data.marketBias === 'BEARISH' ? 'bg-destructive' :
        data.marketBias === 'RANGE_BOUND' ? 'bg-warning-amber' : 'bg-info-cyan'
      }`} />

      {/* Content */}
      <div className="relative z-10 p-4 pl-5">
        {/* Header */}
        <div className="flex items-start justify-between mb-3">
          <div>
            <h3 className="font-display text-lg font-bold tracking-wide text-foreground">
              {data.displayName}
            </h3>
            {data.lastPrice > 0 && (
              <span className="text-sm font-bold tabular-nums text-info-cyan mt-0.5">
                ₹{data.lastPrice.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            )}
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-[10px] text-muted-foreground tracking-wider">{data.exchange}</span>
              <span className="text-[10px] text-muted-foreground">|</span>
              <span className="text-[10px] text-muted-foreground tracking-wider">EXP: {data.expiry}</span>
              <span className="text-[10px] text-muted-foreground">|</span>
              <span className="text-[10px] text-muted-foreground tracking-wider">{data.strikesFound} strikes</span>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <BiasIcon className={`h-4 w-4 ${bias.color}`} />
            <span className={`text-xs font-bold tracking-wider ${bias.color}`}>{bias.label}</span>
          </div>
        </div>

        {/* AI Decision Badge */}
        <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded border ${ai.border} ${ai.bg} mb-3`}>
          <Brain className={`h-3 w-3 ${ai.color}`} />
          <span className={`text-[10px] font-bold tracking-wider ${ai.color}`}>
            AI: {ai.label}
          </span>
          <span className="text-[10px] text-muted-foreground">
            ({(data.aiConfidence * 100).toFixed(0)}%)
          </span>
        </div>

        {/* AI Rationale */}
        <p className="text-[11px] text-muted-foreground leading-relaxed mb-4 line-clamp-2">
          {data.aiRationale}
        </p>

        {/* OI Summary Row with Bar */}
        <div className="mb-4">
          <div className="grid grid-cols-3 gap-3 mb-2">
            <div className="bg-secondary/50 rounded px-2.5 py-1.5">
              <div className="text-[9px] text-muted-foreground tracking-wider uppercase mb-0.5">Call OI</div>
              <div className="text-sm font-bold tabular-nums text-bullish">{formatOI(data.totalCallOI)}</div>
            </div>
            <div className="bg-secondary/50 rounded px-2.5 py-1.5">
              <div className="text-[9px] text-muted-foreground tracking-wider uppercase mb-0.5">Put OI</div>
              <div className="text-sm font-bold tabular-nums text-destructive">{formatOI(data.totalPutOI)}</div>
            </div>
            <div className="bg-secondary/50 rounded px-2.5 py-1.5">
              <div className="text-[9px] text-muted-foreground tracking-wider uppercase mb-0.5">PCR</div>
              <div className="text-sm font-bold tabular-nums text-info-cyan">{data.pcrRatio.toFixed(2)}</div>
            </div>
          </div>
          {/* OI Balance Bar */}
          <div className="px-0.5">
            <OIBar callOI={data.totalCallOI} putOI={data.totalPutOI} />
            <div className="flex justify-between mt-0.5">
              <span className="text-[8px] text-bullish/60 tracking-wider">CALLS</span>
              <span className="text-[8px] text-destructive/60 tracking-wider">PUTS</span>
            </div>
          </div>
        </div>

        {/* Support & Resistance */}
        <div className="grid grid-cols-2 gap-3 mb-4">
          {/* Support */}
          <div>
            <div className="flex items-center gap-1 mb-1.5">
              <Shield className="h-3 w-3 text-bullish" />
              <span className="text-[9px] font-bold text-bullish tracking-wider uppercase">Support</span>
            </div>
            <div className="space-y-0.5">
              {data.supportLevels.slice(0, 3).map((level) => (
                <div key={level.strike} className="flex items-center justify-between group/row hover:bg-secondary/20 rounded px-1 -mx-1 transition-colors">
                  <span className="text-[11px] tabular-nums text-foreground font-medium">{level.strike}</span>
                  <span className="text-[10px] tabular-nums text-muted-foreground">{formatOI(level.putOI)}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Resistance */}
          <div>
            <div className="flex items-center gap-1 mb-1.5">
              <Target className="h-3 w-3 text-destructive" />
              <span className="text-[9px] font-bold text-destructive tracking-wider uppercase">Resistance</span>
            </div>
            <div className="space-y-0.5">
              {data.resistanceLevels.slice(0, 3).map((level) => (
                <div key={level.strike} className="flex items-center justify-between group/row hover:bg-secondary/20 rounded px-1 -mx-1 transition-colors">
                  <span className="text-[11px] tabular-nums text-foreground font-medium">{level.strike}</span>
                  <span className="text-[10px] tabular-nums text-muted-foreground">{formatOI(level.callOI)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Active Strikes */}
        <div>
          <div className="text-[9px] font-bold text-info-cyan tracking-wider uppercase mb-1.5">Active Strikes</div>
          <div className="space-y-1">
            {data.activeStrikes.slice(0, 3).map((strike, i) => (
              <div key={i} className="flex items-center justify-between bg-secondary/30 hover:bg-secondary/50 rounded px-2 py-1 transition-colors">
                <div className="flex items-center gap-2">
                  <span className={`text-[10px] font-bold px-1 rounded ${
                    strike.type === 'call'
                      ? 'text-bullish bg-bullish/10'
                      : 'text-destructive bg-destructive/10'
                  }`}>
                    {strike.type === 'call' ? 'CE' : 'PE'}
                  </span>
                  <span className="text-[11px] tabular-nums text-foreground">{strike.strike}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`text-[10px] tabular-nums font-medium ${strike.oiChange >= 0 ? 'text-bullish' : 'text-destructive'}`}>
                    {strike.oiChange >= 0 ? '+' : ''}{formatOI(strike.oiChange)}
                  </span>
                  <span className="text-[9px] text-warning-amber tracking-wider font-medium">{strike.signal}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
