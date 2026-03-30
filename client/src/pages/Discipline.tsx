/*
 * Terminal Noir — Discipline Dashboard Page (Placeholder)
 * Trading discipline score, rule violations, trends, and analytics.
 * Will be implemented in Features 14–20.
 */
import {
  Shield, AlertTriangle, TrendingUp, Clock,
  Ban, Timer, Target, BarChart3,
} from 'lucide-react';

const DISCIPLINE_RULES = [
  { icon: Ban, label: 'Daily Loss Limit', value: '3%', status: 'active', color: 'text-bullish' },
  { icon: AlertTriangle, label: 'Max Consecutive Losses', value: '3 trades', status: 'active', color: 'text-bullish' },
  { icon: Target, label: 'Max Trades/Day', value: '5', status: 'active', color: 'text-bullish' },
  { icon: BarChart3, label: 'Max Open Positions', value: '3', status: 'active', color: 'text-bullish' },
  { icon: Timer, label: 'Revenge Trade Cooldown', value: '15 min', status: 'active', color: 'text-bullish' },
  { icon: Target, label: 'Max Position Size', value: '10%', status: 'active', color: 'text-bullish' },
  { icon: BarChart3, label: 'Max Total Exposure', value: '30%', status: 'active', color: 'text-bullish' },
  { icon: Clock, label: 'No Trading First 15 min', value: '9:15–9:30', status: 'active', color: 'text-bullish' },
  { icon: Clock, label: 'No Trading Last 15 min', value: '3:15–3:30', status: 'active', color: 'text-bullish' },
  { icon: Shield, label: 'Pre-Trade Gate', value: 'ON', status: 'active', color: 'text-bullish' },
  { icon: Target, label: 'Min R:R Ratio', value: '1:1.5', status: 'active', color: 'text-bullish' },
  { icon: Shield, label: 'Journal Enforcement', value: 'ON', status: 'active', color: 'text-bullish' },
];

export default function Discipline() {
  return (
    <div className="container py-6">
      {/* Page Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="font-display text-xl sm:text-2xl font-bold tracking-tight text-foreground">
            Discipline Dashboard
          </h1>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Trading discipline score, rule adherence, and behavioral analytics
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded border border-info-cyan/30 bg-info-cyan/5">
            <Shield className="h-4 w-4 text-info-cyan" />
            <span className="text-lg font-bold tabular-nums text-info-cyan font-display">100</span>
            <span className="text-[9px] text-muted-foreground tracking-wider uppercase">/100</span>
          </div>
        </div>
      </div>

      {/* Score + Stats Grid */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <div className="border border-border rounded-md bg-card p-4">
          <div className="text-[9px] text-muted-foreground tracking-wider uppercase mb-1">Today's Score</div>
          <div className="text-2xl font-bold tabular-nums text-info-cyan font-display">100</div>
          <div className="text-[10px] text-bullish mt-1">No violations</div>
        </div>
        <div className="border border-border rounded-md bg-card p-4">
          <div className="text-[9px] text-muted-foreground tracking-wider uppercase mb-1">Weekly Average</div>
          <div className="text-2xl font-bold tabular-nums text-info-cyan font-display">96</div>
          <div className="text-[10px] text-muted-foreground mt-1">Last 7 days</div>
        </div>
        <div className="border border-border rounded-md bg-card p-4">
          <div className="text-[9px] text-muted-foreground tracking-wider uppercase mb-1">Violations Today</div>
          <div className="text-2xl font-bold tabular-nums text-bullish font-display">0</div>
          <div className="text-[10px] text-muted-foreground mt-1">Rules broken</div>
        </div>
        <div className="border border-border rounded-md bg-card p-4">
          <div className="text-[9px] text-muted-foreground tracking-wider uppercase mb-1">Current Streak</div>
          <div className="text-2xl font-bold tabular-nums text-bullish font-display">5d</div>
          <div className="text-[10px] text-bullish mt-1">Winning streak</div>
        </div>
      </div>

      {/* Two-column layout: Rules + Chart placeholder */}
      <div className="grid grid-cols-2 gap-4">
        {/* Active Rules */}
        <div className="border border-border rounded-md bg-card">
          <div className="px-4 py-3 border-b border-border">
            <span className="text-[10px] font-bold text-info-cyan tracking-wider uppercase">
              Active Discipline Rules
            </span>
          </div>
          <div className="p-3 space-y-1">
            {DISCIPLINE_RULES.map((rule, i) => {
              const Icon = rule.icon;
              return (
                <div key={i} className="flex items-center justify-between px-3 py-2 rounded hover:bg-secondary/30 transition-colors">
                  <div className="flex items-center gap-2">
                    <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-[11px] text-foreground">{rule.label}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] tabular-nums text-muted-foreground">{rule.value}</span>
                    <div className="h-1.5 w-1.5 rounded-full bg-bullish" />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Chart Placeholder */}
        <div className="border border-border rounded-md bg-card">
          <div className="px-4 py-3 border-b border-border">
            <span className="text-[10px] font-bold text-info-cyan tracking-wider uppercase">
              Discipline Score Trend
            </span>
          </div>
          <div className="flex flex-col items-center justify-center p-8">
            <TrendingUp className="h-10 w-10 text-muted-foreground/20 mb-3" />
            <p className="text-[12px] text-muted-foreground font-bold">Score Trend Chart — Coming Soon</p>
            <p className="text-[10px] text-muted-foreground/60 mt-1 text-center">
              Monthly discipline score trend, P&L correlation overlay,
              and violation heatmap will be displayed here.
            </p>
          </div>

          {/* Violations Log Placeholder */}
          <div className="px-4 py-3 border-t border-border">
            <span className="text-[10px] font-bold text-warning-amber tracking-wider uppercase">
              Recent Violations
            </span>
          </div>
          <div className="p-4 text-center">
            <p className="text-[11px] text-muted-foreground">No violations recorded today</p>
          </div>
        </div>
      </div>
    </div>
  );
}
