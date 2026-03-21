/*
 * Terminal Noir — InstrumentCard Component (v2)
 * Enhanced with: Trade Direction signal, Wall Strength meters,
 * Breakout/Bounce prediction, Trade Setup (entry/target/SL),
 * IV & Theta assessment, Risk Flags, and Scoring Factors.
 */
import { useState } from 'react';
import {
  TrendingUp, TrendingDown, Minus, Shield, Target, Brain,
  ChevronDown, ChevronUp, AlertTriangle, Zap, Crosshair,
  Activity, BarChart3, Clock,
} from 'lucide-react';
import type { InstrumentData, WallAnalysis, TradeSetup, RiskFlag, ScoringFactor } from '@/lib/types';

const biasConfig = {
  BULLISH: { color: 'text-bullish', glow: 'glow-green', border: 'border-bullish/30', icon: TrendingUp, label: 'BULLISH' },
  BEARISH: { color: 'text-destructive', glow: 'glow-red', border: 'border-destructive/30', icon: TrendingDown, label: 'BEARISH' },
  RANGE_BOUND: { color: 'text-warning-amber', glow: 'glow-amber', border: 'border-warning-amber/30', icon: Minus, label: 'RANGE BOUND' },
  NEUTRAL: { color: 'text-info-cyan', glow: 'glow-cyan', border: 'border-info-cyan/30', icon: Minus, label: 'NEUTRAL' },
};

const directionConfig = {
  GO_CALL: { color: 'text-bullish', bg: 'bg-bullish/15', border: 'border-bullish/40', label: 'GO CALL', icon: TrendingUp },
  GO_PUT: { color: 'text-destructive', bg: 'bg-destructive/15', border: 'border-destructive/40', label: 'GO PUT', icon: TrendingDown },
  WAIT: { color: 'text-warning-amber', bg: 'bg-warning-amber/10', border: 'border-warning-amber/30', label: 'WAIT', icon: Minus },
};

const legacyAiConfig = {
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

function formatPrice(value: number): string {
  return value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function OIBar({ callOI, putOI }: { callOI: number; putOI: number }) {
  const total = callOI + putOI;
  const callPercent = total > 0 ? (callOI / total) * 100 : 50;
  return (
    <div className="w-full h-1.5 rounded-full bg-secondary/50 overflow-hidden flex">
      <div className="h-full bg-bullish/60 transition-all duration-500" style={{ width: `${callPercent}%` }} />
      <div className="h-full bg-destructive/60 transition-all duration-500" style={{ width: `${100 - callPercent}%` }} />
    </div>
  );
}

/* Wall Strength Meter — horizontal bar 0-100 with color gradient */
function WallStrengthMeter({ analysis, type }: { analysis: WallAnalysis; type: 'support' | 'resistance' }) {
  const strength = analysis.strength;
  const prediction = analysis.prediction;
  const probability = analysis.probability;

  // Color based on strength
  const barColor = strength > 65 ? 'bg-bullish' : strength > 35 ? 'bg-warning-amber' : 'bg-destructive';
  const textColor = strength > 65 ? 'text-bullish' : strength > 35 ? 'text-warning-amber' : 'text-destructive';

  // Prediction badge
  const predConfig: Record<string, { color: string; label: string }> = {
    BREAKOUT: { color: 'text-bullish', label: 'BREAKOUT' },
    BREAKDOWN: { color: 'text-destructive', label: 'BREAKDOWN' },
    BOUNCE: { color: 'text-info-cyan', label: 'BOUNCE' },
    UNCERTAIN: { color: 'text-muted-foreground', label: 'UNCERTAIN' },
  };
  const pred = predConfig[prediction] || predConfig['UNCERTAIN']!;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          {type === 'support' ? (
            <Shield className="h-3 w-3 text-bullish" />
          ) : (
            <Target className="h-3 w-3 text-destructive" />
          )}
          <span className="text-[9px] font-bold tracking-wider uppercase text-muted-foreground">
            {type === 'support' ? 'Support' : 'Resistance'}: {analysis.level}
          </span>
        </div>
        <span className={`text-[9px] font-bold tracking-wider ${textColor}`}>
          {strength}/100
        </span>
      </div>
      {/* Strength bar */}
      <div className="w-full h-1 rounded-full bg-secondary/50 overflow-hidden">
        <div
          className={`h-full ${barColor} transition-all duration-700`}
          style={{ width: `${strength}%` }}
        />
      </div>
      {/* Prediction + OI change */}
      <div className="flex items-center justify-between">
        <span className={`text-[9px] font-bold tracking-wider ${pred.color}`}>
          {pred.label} ({probability}%)
        </span>
        <span className={`text-[9px] tabular-nums ${analysis.oi_change >= 0 ? 'text-bullish' : 'text-destructive'}`}>
          OI: {analysis.oi_change >= 0 ? '+' : ''}{formatOI(analysis.oi_change)}
        </span>
      </div>
    </div>
  );
}

/* Trade Setup Section */
function TradeSetupSection({ setup }: { setup: TradeSetup }) {
  const isCall = setup.direction === 'GO_CALL';
  const accentColor = isCall ? 'text-bullish' : 'text-destructive';
  const accentBg = isCall ? 'bg-bullish/10' : 'bg-destructive/10';

  return (
    <div className={`rounded border ${isCall ? 'border-bullish/20' : 'border-destructive/20'} ${accentBg} p-2.5 space-y-2`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Crosshair className={`h-3 w-3 ${accentColor}`} />
          <span className={`text-[10px] font-bold tracking-wider ${accentColor}`}>
            TRADE SETUP
          </span>
        </div>
        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${accentBg} ${accentColor} border ${isCall ? 'border-bullish/30' : 'border-destructive/30'}`}>
          {setup.option_type} {setup.strike}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <div>
          <div className="text-[8px] text-muted-foreground tracking-wider uppercase">Entry</div>
          <div className="text-[11px] font-bold tabular-nums text-foreground">₹{formatPrice(setup.entry_price)}</div>
        </div>
        <div>
          <div className="text-[8px] text-muted-foreground tracking-wider uppercase">Target</div>
          <div className="text-[11px] font-bold tabular-nums text-bullish">
            ₹{formatPrice(setup.target_price)}
            <span className="text-[8px] ml-0.5">(+{setup.target_pct}%)</span>
          </div>
        </div>
        <div>
          <div className="text-[8px] text-muted-foreground tracking-wider uppercase">Stop Loss</div>
          <div className="text-[11px] font-bold tabular-nums text-destructive">
            ₹{formatPrice(setup.stop_loss)}
            <span className="text-[8px] ml-0.5">(-{setup.sl_pct}%)</span>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between pt-1 border-t border-white/5">
        <span className="text-[9px] text-muted-foreground">{setup.target_label}</span>
        <div className="flex items-center gap-2">
          <span className="text-[9px] text-muted-foreground">R:R</span>
          <span className={`text-[10px] font-bold tabular-nums ${setup.risk_reward >= 2 ? 'text-bullish' : setup.risk_reward >= 1 ? 'text-warning-amber' : 'text-destructive'}`}>
            1:{setup.risk_reward}
          </span>
          {setup.delta > 0 && (
            <>
              <span className="text-[9px] text-muted-foreground">Delta</span>
              <span className="text-[10px] font-bold tabular-nums text-info-cyan">{setup.delta}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* Risk Flags */
function RiskFlagsSection({ flags }: { flags: RiskFlag[] }) {
  if (!flags || flags.length === 0) return null;
  return (
    <div className="space-y-1">
      {flags.map((flag, i) => (
        <div
          key={i}
          className={`flex items-start gap-1.5 px-2 py-1 rounded text-[9px] leading-tight ${
            flag.type === 'danger'
              ? 'bg-destructive/10 text-destructive border border-destructive/20'
              : 'bg-warning-amber/10 text-warning-amber border border-warning-amber/20'
          }`}
        >
          <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
          <span>{flag.text}</span>
        </div>
      ))}
    </div>
  );
}

/* Scoring Factors — collapsible */
function ScoringFactorsSection({ factors }: { factors: Record<string, ScoringFactor> }) {
  const [expanded, setExpanded] = useState(false);
  if (!factors || Object.keys(factors).length === 0) return null;

  const sorted = Object.entries(factors).sort(
    (a, b) => Math.abs(b[1].score * b[1].weight) - Math.abs(a[1].score * a[1].weight)
  );

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-[9px] text-muted-foreground hover:text-foreground transition-colors"
      >
        <BarChart3 className="h-3 w-3" />
        <span className="tracking-wider uppercase font-bold">Scoring Factors</span>
        {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      </button>
      {expanded && (
        <div className="mt-1.5 space-y-1">
          {sorted.map(([name, factor]) => {
            const contribution = factor.score * factor.weight;
            const barWidth = Math.abs(contribution) * 100 * 3; // Scale for visibility
            const isPositive = contribution > 0;
            return (
              <div key={name} className="space-y-0.5">
                <div className="flex items-center justify-between">
                  <span className="text-[8px] text-muted-foreground capitalize">
                    {name.replace(/_/g, ' ')} ({(factor.weight * 100).toFixed(0)}%)
                  </span>
                  <span className={`text-[8px] font-bold tabular-nums ${isPositive ? 'text-bullish' : contribution < 0 ? 'text-destructive' : 'text-muted-foreground'}`}>
                    {contribution > 0 ? '+' : ''}{(contribution * 100).toFixed(1)}
                  </span>
                </div>
                <div className="w-full h-0.5 rounded-full bg-secondary/30 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${isPositive ? 'bg-bullish/60' : 'bg-destructive/60'}`}
                    style={{ width: `${Math.min(barWidth, 100)}%` }}
                  />
                </div>
                <div className="text-[7px] text-muted-foreground/60 leading-tight">{factor.detail}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* IV & Theta compact row */
function IVThetaRow({ data }: { data: InstrumentData }) {
  const iv = data.ivAssessment;
  const theta = data.thetaAssessment;
  if (!iv && !theta) return null;

  const ivColor = iv?.assessment === 'CHEAP' ? 'text-bullish' : iv?.assessment === 'EXPENSIVE' ? 'text-destructive' : 'text-info-cyan';

  return (
    <div className="flex items-center gap-3 flex-wrap">
      {iv && iv.assessment !== 'UNKNOWN' && (
        <div className="flex items-center gap-1">
          <Activity className="h-3 w-3 text-muted-foreground" />
          <span className="text-[9px] text-muted-foreground">IV:</span>
          <span className={`text-[9px] font-bold ${ivColor}`}>
            {iv.atm_iv}% ({iv.assessment})
          </span>
        </div>
      )}
      {theta && theta.days_to_expiry !== null && (
        <div className="flex items-center gap-1">
          <Clock className="h-3 w-3 text-muted-foreground" />
          <span className="text-[9px] text-muted-foreground">DTE:</span>
          <span className={`text-[9px] font-bold ${theta.days_to_expiry! <= 2 ? 'text-destructive' : theta.days_to_expiry! <= 4 ? 'text-warning-amber' : 'text-foreground'}`}>
            {theta.days_to_expiry}d
          </span>
          {theta.theta_per_day > 0 && (
            <span className="text-[9px] text-destructive tabular-nums">
              (-₹{theta.theta_per_day}/day)
            </span>
          )}
        </div>
      )}
    </div>
  );
}


export default function InstrumentCard({ data, bgImage }: InstrumentCardProps) {
  const bias = biasConfig[data.marketBias];
  const BiasIcon = bias.icon;

  // Use enhanced trade direction if available, fallback to legacy
  const hasEnhanced = !!data.tradeDirection;
  const dir = data.tradeDirection || (data.aiDecision === 'GO' ? 'GO_CALL' : 'WAIT');
  const dirCfg = directionConfig[dir] || directionConfig['WAIT']!;
  const DirIcon = dirCfg.icon;

  // Fallback for legacy AI decision display
  const legacyAi = legacyAiConfig[data.aiDecision];

  return (
    <div
      className={`group relative overflow-hidden rounded-md border ${bias.border} bg-card animate-fade-in-up transition-all duration-300 hover:border-opacity-60`}
    >
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

      <div className="relative z-10 p-4 pl-5 space-y-3">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <h3 className="font-display text-lg font-bold tracking-wide text-foreground">
              {data.displayName}
            </h3>
            {data.lastPrice > 0 && (
              <span className="text-sm font-bold tabular-nums text-info-cyan mt-0.5">
                ₹{formatPrice(data.lastPrice)}
                {data.atmStrike ? (
                  <span className="text-[9px] text-muted-foreground ml-2">ATM: {data.atmStrike}</span>
                ) : null}
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

        {/* Trade Direction Badge (enhanced) or Legacy AI Badge */}
        {hasEnhanced ? (
          <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded border ${dirCfg.border} ${dirCfg.bg}`}>
            <DirIcon className={`h-4 w-4 ${dirCfg.color}`} />
            <span className={`text-xs font-bold tracking-wider ${dirCfg.color}`}>
              {dirCfg.label}
            </span>
            <span className="text-[10px] text-muted-foreground">
              ({(data.aiConfidence * 100).toFixed(0)}% confidence)
            </span>
          </div>
        ) : (
          <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded border ${legacyAi.border} ${legacyAi.bg}`}>
            <Brain className={`h-3 w-3 ${legacyAi.color}`} />
            <span className={`text-[10px] font-bold tracking-wider ${legacyAi.color}`}>
              AI: {legacyAi.label}
            </span>
            <span className="text-[10px] text-muted-foreground">
              ({(data.aiConfidence * 100).toFixed(0)}%)
            </span>
          </div>
        )}

        {/* AI Rationale */}
        <p className="text-[11px] text-muted-foreground leading-relaxed line-clamp-2">
          {data.aiRationale}
        </p>

        {/* Trade Setup (if direction is GO_CALL or GO_PUT) */}
        {data.tradeSetup && (
          <TradeSetupSection setup={data.tradeSetup} />
        )}

        {/* Wall Strength Meters */}
        {(data.supportAnalysis || data.resistanceAnalysis) && (
          <div className="space-y-2">
            {data.supportAnalysis && data.supportAnalysis.level > 0 && (
              <WallStrengthMeter analysis={data.supportAnalysis} type="support" />
            )}
            {data.resistanceAnalysis && data.resistanceAnalysis.level > 0 && (
              <WallStrengthMeter analysis={data.resistanceAnalysis} type="resistance" />
            )}
          </div>
        )}

        {/* IV & Theta Row */}
        <IVThetaRow data={data} />

        {/* Risk Flags */}
        {data.riskFlags && data.riskFlags.length > 0 && (
          <RiskFlagsSection flags={data.riskFlags} />
        )}

        {/* OI Summary Row with Bar */}
        <div>
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
          <div className="px-0.5">
            <OIBar callOI={data.totalCallOI} putOI={data.totalPutOI} />
            <div className="flex justify-between mt-0.5">
              <span className="text-[8px] text-bullish/60 tracking-wider">CALLS</span>
              <span className="text-[8px] text-destructive/60 tracking-wider">PUTS</span>
            </div>
          </div>
        </div>

        {/* Support & Resistance (compact) */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="flex items-center gap-1 mb-1">
              <Shield className="h-3 w-3 text-bullish" />
              <span className="text-[9px] font-bold text-bullish tracking-wider uppercase">Support</span>
            </div>
            <div className="space-y-0.5">
              {data.supportLevels.slice(0, 3).map((level) => (
                <div key={level.strike} className="flex items-center justify-between hover:bg-secondary/20 rounded px-1 -mx-1 transition-colors">
                  <span className="text-[11px] tabular-nums text-foreground font-medium">{level.strike}</span>
                  <span className="text-[10px] tabular-nums text-muted-foreground">{formatOI(level.putOI)}</span>
                </div>
              ))}
            </div>
          </div>
          <div>
            <div className="flex items-center gap-1 mb-1">
              <Target className="h-3 w-3 text-destructive" />
              <span className="text-[9px] font-bold text-destructive tracking-wider uppercase">Resistance</span>
            </div>
            <div className="space-y-0.5">
              {data.resistanceLevels.slice(0, 3).map((level) => (
                <div key={level.strike} className="flex items-center justify-between hover:bg-secondary/20 rounded px-1 -mx-1 transition-colors">
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
                    strike.type === 'call' ? 'text-bullish bg-bullish/10' : 'text-destructive bg-destructive/10'
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

        {/* Scoring Factors (collapsible) */}
        {data.scoringFactors && (
          <ScoringFactorsSection factors={data.scoringFactors} />
        )}
      </div>
    </div>
  );
}
