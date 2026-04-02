/**
 * LoadingStates — Reusable skeleton loaders and empty state components
 * for production polish across the ATS application.
 */
import {
  BookOpen, BarChart3, Bot, Wifi, WifiOff,
  AlertTriangle, RefreshCw, Inbox, Settings,
  TrendingUp, Shield, Zap,
} from 'lucide-react';

// ─── Skeleton Primitives ─────────────────────────────────────

export function SkeletonBox({ className = '' }: { className?: string }) {
  return <div className={`bg-secondary/20 animate-pulse rounded ${className}`} />;
}

export function SkeletonText({ width = 'w-24', className = '' }: { width?: string; className?: string }) {
  return <div className={`h-3 bg-secondary/20 animate-pulse rounded ${width} ${className}`} />;
}

// ─── Section Skeletons ───────────────────────────────────────

export function SummaryBarSkeleton() {
  return (
    <div className="flex items-stretch gap-px bg-border/30 rounded-md overflow-hidden">
      {[1, 2, 3, 4].map(i => (
        <div key={i} className="flex-1 bg-card px-3 py-2 space-y-1.5">
          <SkeletonText width="w-16" />
          <SkeletonBox className="h-5 w-20" />
          <SkeletonText width="w-12" />
        </div>
      ))}
    </div>
  );
}

export function TradingDeskSkeleton() {
  return (
    <div className="space-y-2">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <SkeletonBox className="h-6 w-6 rounded" />
          <SkeletonText width="w-32" />
        </div>
        <div className="flex gap-1">
          <SkeletonBox className="h-6 w-16 rounded" />
          <SkeletonBox className="h-6 w-16 rounded" />
        </div>
      </div>
      {/* Summary cells */}
      <div className="grid grid-cols-9 gap-1">
        {Array.from({ length: 9 }).map((_, i) => (
          <SkeletonBox key={i} className="h-10 rounded" />
        ))}
      </div>
      {/* Table rows */}
      <div className="space-y-1">
        {Array.from({ length: 6 }).map((_, i) => (
          <SkeletonBox key={i} className="h-8 rounded" />
        ))}
      </div>
    </div>
  );
}

export function DrawerSkeleton() {
  return (
    <div className="p-3 space-y-3">
      <SkeletonText width="w-28" />
      {[1, 2, 3].map(i => (
        <div key={i} className="space-y-1.5 p-2 rounded border border-border">
          <div className="flex items-center gap-2">
            <SkeletonBox className="h-4 w-4 rounded" />
            <SkeletonText width="w-20" />
          </div>
          <SkeletonBox className="h-12 rounded" />
          <SkeletonText width="w-full" />
        </div>
      ))}
    </div>
  );
}

export function FooterSkeleton() {
  return (
    <div className="flex items-center justify-between px-4 py-1.5">
      {[1, 2, 3, 4].map(i => (
        <SkeletonText key={i} width="w-24" />
      ))}
    </div>
  );
}

// ─── Empty States ────────────────────────────────────────────

interface EmptyStateProps {
  icon: React.ElementType;
  title: string;
  description: string;
  action?: { label: string; onClick: () => void };
  iconColor?: string;
}

export function EmptyState({ icon: Icon, title, description, action, iconColor = 'text-muted-foreground/40' }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-8 px-4 text-center space-y-2">
      <Icon className={`h-10 w-10 ${iconColor}`} />
      <h3 className="text-[11px] font-bold text-foreground tracking-wide">{title}</h3>
      <p className="text-[9px] text-muted-foreground max-w-xs leading-relaxed">{description}</p>
      {action && (
        <button onClick={action.onClick}
          className="mt-1 px-3 py-1 rounded bg-info-cyan/15 border border-info-cyan/40 text-info-cyan text-[9px] font-bold tracking-wider hover:bg-info-cyan/25 transition-colors">
          {action.label}
        </button>
      )}
    </div>
  );
}

export function NoTradesEmpty({ onAddTrade }: { onAddTrade?: () => void }) {
  return (
    <EmptyState
      icon={Inbox}
      title="No Trades Yet"
      description="Your trading desk is empty. Start by injecting capital in Settings, then place your first trade."
      action={onAddTrade ? { label: 'LOG FIRST TRADE', onClick: onAddTrade } : undefined}
    />
  );
}

export function NoCapitalEmpty({ onOpenSettings }: { onOpenSettings?: () => void }) {
  return (
    <EmptyState
      icon={TrendingUp}
      title="No Capital Configured"
      description="Inject your starting capital to begin the 250-day compounding journey. Open Settings to get started."
      action={onOpenSettings ? { label: 'OPEN SETTINGS', onClick: onOpenSettings } : undefined}
      iconColor="text-warning-amber/40"
    />
  );
}

export function NoAiDecisionsEmpty() {
  return (
    <EmptyState
      icon={Bot}
      title="AI Engine Not Running"
      description="No AI decisions available. Start the AI Decision Engine to generate trading signals."
      iconColor="text-info-cyan/40"
    />
  );
}

export function NoDisciplineDataEmpty() {
  return (
    <EmptyState
      icon={Shield}
      title="No Discipline Data"
      description="Discipline tracking starts automatically when you place your first trade. Your score, streaks, and violations will appear here."
      iconColor="text-warning-amber/40"
    />
  );
}

// ─── Error States ────────────────────────────────────────────

interface ErrorStateProps {
  message: string;
  onRetry?: () => void;
  compact?: boolean;
}

export function ErrorState({ message, onRetry, compact = false }: ErrorStateProps) {
  if (compact) {
    return (
      <div className="flex items-center gap-2 px-2 py-1.5 rounded bg-destructive/5 border border-destructive/20">
        <AlertTriangle className="h-3 w-3 text-destructive shrink-0" />
        <span className="text-[9px] text-destructive/80 truncate">{message}</span>
        {onRetry && (
          <button onClick={onRetry} className="shrink-0 text-destructive hover:text-destructive/80">
            <RefreshCw className="h-3 w-3" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center py-6 px-4 text-center space-y-2">
      <AlertTriangle className="h-8 w-8 text-destructive/60" />
      <p className="text-[10px] text-destructive/80 max-w-xs">{message}</p>
      {onRetry && (
        <button onClick={onRetry}
          className="flex items-center gap-1 px-2 py-1 rounded bg-destructive/10 border border-destructive/30 text-destructive text-[9px] font-bold tracking-wider hover:bg-destructive/20 transition-colors">
          <RefreshCw className="h-3 w-3" /> RETRY
        </button>
      )}
    </div>
  );
}

// ─── Connection Status ───────────────────────────────────────

export function ConnectionStatus({ connected, label }: { connected: boolean; label: string }) {
  return (
    <div className="flex items-center gap-1">
      {connected ? (
        <Wifi className="h-2.5 w-2.5 text-bullish" />
      ) : (
        <WifiOff className="h-2.5 w-2.5 text-destructive" />
      )}
      <span className={`text-[7px] tracking-wider uppercase ${connected ? 'text-bullish' : 'text-destructive'}`}>
        {label}: {connected ? 'OK' : 'DOWN'}
      </span>
    </div>
  );
}

// ─── Toast Helpers ───────────────────────────────────────────

export const toastMessages = {
  tradeLogged: () => ({ title: 'Trade Logged', description: 'Your trade has been recorded in the journal.' }),
  tradeClosed: (pnl: number) => ({
    title: pnl >= 0 ? 'Trade Closed — Profit' : 'Trade Closed — Loss',
    description: `P&L: ${pnl >= 0 ? '+' : ''}₹${pnl.toFixed(2)}`,
  }),
  settingsSaved: () => ({ title: 'Settings Saved', description: 'Your preferences have been updated.' }),
  capitalInjected: (amount: number) => ({
    title: 'Capital Injected',
    description: `₹${amount.toLocaleString('en-IN')} added to your capital pool.`,
  }),
  circuitBreakerTripped: () => ({
    title: 'Circuit Breaker Tripped',
    description: 'Daily loss limit reached. Trading is blocked for today.',
  }),
  cooldownActive: (minutes: number) => ({
    title: 'Cooldown Active',
    description: `Please wait ${minutes} minutes before your next trade.`,
  }),
  brokerConnected: (name: string) => ({
    title: 'Broker Connected',
    description: `${name} adapter is now active.`,
  }),
  brokerDisconnected: () => ({
    title: 'Broker Disconnected',
    description: 'Connection to broker lost. Reconnecting...',
  }),
};
