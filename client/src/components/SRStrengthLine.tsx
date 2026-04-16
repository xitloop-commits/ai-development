/*
 * Terminal Noir — S/R Strength Line Component
 * Horizontal bar chart showing S5..S1 → ATM → R1..R5 with:
 *   - OI size as bar height
 *   - Intraday change % since market open
 *   - Activity labels (layman + technical)
 *   - Trend arrows
 *   - BOUNCE/BREAKOUT prediction badges
 *   - Color coding: green=strengthening, red=weakening, blue=stable, amber=ATM
 */
import type { SRLevel } from '@/lib/types';

interface SRStrengthLineProps {
  levels: SRLevel[];
}

function formatOI(value: number): string {
  if (Math.abs(value) >= 1000000) return (value / 1000000).toFixed(1) + 'M';
  if (Math.abs(value) >= 1000) return (value / 1000).toFixed(0) + 'K';
  return value.toString();
}

function getBarColor(status: SRLevel['barStatus']): string {
  switch (status) {
    case 'strengthening': return 'bg-gradient-to-t from-emerald-700 to-emerald-500';
    case 'weakening': return 'bg-gradient-to-t from-red-800 to-red-500';
    case 'stable': return 'bg-gradient-to-t from-blue-800 to-blue-500';
    case 'atm': return 'bg-gradient-to-t from-amber-700 to-amber-500';
    default: return 'bg-gradient-to-t from-slate-700 to-slate-500';
  }
}

function getBarShadow(status: SRLevel['barStatus']): string {
  switch (status) {
    case 'strengthening': return '0 0 8px rgba(16,185,129,0.3)';
    case 'weakening': return '0 0 8px rgba(239,68,68,0.2)';
    case 'atm': return '0 0 12px rgba(245,158,11,0.4)';
    default: return 'none';
  }
}

function getChangeColor(pct: number): string {
  if (pct > 2) return 'text-emerald-400 bg-emerald-500/15';
  if (pct < -2) return 'text-red-400 bg-red-500/15';
  return 'text-slate-400 bg-slate-500/15';
}

function getActivityColor(label: string): string {
  if (label === 'Sellers Entering' || label === 'Buyers Entering') return 'text-emerald-400';
  if (label === 'Sellers Exiting' || label === 'Buyers Exiting') return 'text-red-400';
  return 'text-slate-400';
}

function getTrendColor(trend: SRLevel['trend']): string {
  if (trend === 'strong_up' || trend === 'up') return 'text-emerald-400';
  if (trend === 'strong_down' || trend === 'down') return 'text-red-400';
  return 'text-slate-500';
}

function getLabelColor(type: SRLevel['type']): string {
  if (type === 'support') return 'text-cyan-400';
  if (type === 'resistance') return 'text-violet-400';
  return 'text-amber-400';
}

export default function SRStrengthLine({ levels }: SRStrengthLineProps) {
  if (!levels || levels.length === 0) return null;

  // Compute max OI for bar height scaling
  const maxOI = Math.max(...levels.filter(l => l.type !== 'atm').map(l => l.oi), 1);

  return (
    <div className="space-y-1">
      {/* Zone labels */}
      <div className="flex items-center justify-between px-1">
        <span className="text-[0.5rem] font-bold tracking-widest text-cyan-400/70 uppercase">
          ◄ Support (Put OI)
        </span>
        <span className="text-[0.5rem] font-bold tracking-widest text-violet-400/70 uppercase">
          Resistance (Call OI) ►
        </span>
      </div>

      {/* Bar chart area */}
      <div className="relative">
        {/* Horizontal axis line */}
        <div
          className="absolute left-0 right-0 h-[2px] z-0"
          style={{
            bottom: '68px',
            background: 'linear-gradient(to right, rgba(34,211,238,0.2), rgba(51,65,85,0.6), rgba(245,158,11,0.6), rgba(51,65,85,0.6), rgba(167,139,250,0.2))',
          }}
        />

        <div className="flex items-end justify-center gap-0">
          {levels.map((level) => {
            const barHeight = level.type === 'atm'
              ? 32
              : Math.max(12, (level.oi / maxOI) * 60);

            return (
              <div
                key={level.label}
                className="flex-1 flex flex-col items-center min-w-0 group relative"
              >
                {/* OI value */}
                {level.type !== 'atm' && (
                  <div className="text-[0.5rem] text-slate-400 tabular-nums mb-0.5 truncate">
                    {formatOI(level.oi)}
                  </div>
                )}
                {level.type === 'atm' && (
                  <div className="text-[0.5rem] text-amber-400 font-bold mb-0.5">LTP</div>
                )}

                {/* Intraday change badge */}
                {level.type !== 'atm' ? (
                  <div className={`text-[0.4375rem] font-bold px-1 py-[1px] rounded mb-0.5 tabular-nums ${getChangeColor(level.oiChangePct)}`}>
                    {level.oiChangePct > 0 ? '+' : ''}{level.oiChangePct.toFixed(1)}%
                  </div>
                ) : (
                  <div className="text-[0.4375rem] invisible mb-0.5">—</div>
                )}

                {/* Activity label (layman + technical) */}
                {level.type !== 'atm' ? (
                  <div className="text-center mb-0.5 leading-tight h-[22px] flex flex-col justify-end">
                    <div className={`text-[0.4375rem] font-bold truncate ${getActivityColor(level.activityLabel)}`}>
                      {level.activityLabel}
                    </div>
                    <div className="text-[0.375rem] text-slate-500 truncate">
                      ({level.technicalLabel})
                    </div>
                  </div>
                ) : (
                  <div className="h-[22px]" />
                )}

                {/* OI Bar */}
                <div className="w-full flex items-end justify-center" style={{ height: '64px' }}>
                  <div
                    className={`w-[60%] max-w-[28px] rounded-t-sm transition-all duration-500 ${getBarColor(level.barStatus)}`}
                    style={{
                      height: `${barHeight}px`,
                      boxShadow: getBarShadow(level.barStatus),
                    }}
                  />
                </div>

                {/* Trend arrow */}
                {level.type !== 'atm' ? (
                  <div className={`text-[0.5625rem] mt-0.5 ${getTrendColor(level.trend)}`}>
                    {level.trendArrow}
                  </div>
                ) : (
                  <div className="mt-0.5">
                    <div className="w-2 h-2 rounded-full bg-amber-400 mx-auto" style={{ boxShadow: '0 0 6px rgba(245,158,11,0.6)' }} />
                  </div>
                )}

                {/* Prediction badge */}
                {level.prediction && level.prediction !== 'UNCERTAIN' ? (
                  <div className={`text-[0.375rem] font-bold px-1 py-[1px] rounded mt-0.5 whitespace-nowrap ${
                    level.prediction === 'BOUNCE'
                      ? 'text-emerald-400 bg-emerald-500/20 border border-emerald-500/30'
                      : level.prediction === 'BREAKOUT'
                        ? 'text-amber-400 bg-amber-500/20 border border-amber-500/30'
                        : 'text-red-400 bg-red-500/20 border border-red-500/30'
                  }`}>
                    {level.prediction} {level.predictionProbability}%
                  </div>
                ) : (
                  <div className="h-[14px] mt-0.5" />
                )}

                {/* Tick mark */}
                <div className={`mt-0.5 mx-auto ${
                  level.type === 'atm' ? 'w-[3px] h-3 bg-amber-400' : 'w-[2px] h-2 bg-slate-600'
                }`} />

                {/* Strike label */}
                <div className={`text-[0.5rem] tabular-nums font-medium mt-0.5 truncate ${
                  level.type === 'atm' ? 'text-amber-400 font-bold text-[0.5625rem]' : 'text-slate-300'
                }`}>
                  {level.strike.toLocaleString('en-IN')}
                </div>

                {/* Level label (S5, S4, ... ATM, R1, R2...) */}
                <div className={`text-[0.5rem] font-bold ${getLabelColor(level.type)}`}>
                  {level.type === 'atm' ? '● ATM' : level.label}
                </div>

                {/* Hover tooltip */}
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block z-20 pointer-events-none">
                  <div className="bg-slate-900 border border-slate-700 rounded px-2 py-1.5 shadow-lg whitespace-nowrap text-left">
                    <div className="text-[0.5625rem] font-bold text-foreground">{level.label}: {level.strike.toLocaleString('en-IN')}</div>
                    {level.type !== 'atm' && (
                      <>
                        <div className="text-[0.5rem] text-slate-400">OI: {formatOI(level.oi)} (Open: {formatOI(level.openOI)})</div>
                        <div className={`text-[0.5rem] font-bold ${level.oiChangePct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          Change: {level.oiChangePct > 0 ? '+' : ''}{level.oiChangePct.toFixed(1)}% ({level.oiChangeAbs > 0 ? '+' : ''}{formatOI(level.oiChangeAbs)})
                        </div>
                        <div className={`text-[0.5rem] ${getActivityColor(level.activityLabel)}`}>
                          {level.activityLabel} ({level.technicalLabel})
                        </div>
                        <div className="text-[0.5rem] text-slate-400">Strength: {level.strength}/100</div>
                        {level.prediction && level.prediction !== 'UNCERTAIN' && (
                          <div className={`text-[0.5rem] font-bold ${level.prediction === 'BOUNCE' ? 'text-emerald-400' : 'text-amber-400'}`}>
                            {level.prediction}: {level.predictionProbability}%
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Legend row */}
      <div className="flex items-center justify-center gap-3 pt-1 border-t border-white/5">
        <div className="flex items-center gap-1">
          <div className="w-2 h-2 rounded-sm bg-emerald-500" />
          <span className="text-[0.4375rem] text-slate-500">Strengthening</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-2 h-2 rounded-sm bg-red-500" />
          <span className="text-[0.4375rem] text-slate-500">Weakening</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-2 h-2 rounded-sm bg-blue-500" />
          <span className="text-[0.4375rem] text-slate-500">Stable</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-2 h-2 rounded-sm bg-amber-500" />
          <span className="text-[0.4375rem] text-slate-500">ATM</span>
        </div>
      </div>
    </div>
  );
}
