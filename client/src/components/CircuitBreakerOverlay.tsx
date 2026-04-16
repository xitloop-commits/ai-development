/**
 * CircuitBreakerOverlay — Full-screen red overlay when daily loss limit is triggered.
 *
 * Blocks all interaction with the trading desk. Cannot be dismissed until next day.
 * Shows the loss amount, percentage, and a calming message.
 */
import { AlertOctagon, ShieldOff, Clock } from 'lucide-react';
import { formatINR } from '@/lib/formatINR';

interface CircuitBreakerOverlayProps {
  visible: boolean;
  dailyLoss: number;
  dailyLossPercent: number;
  threshold: number;
  triggeredAt?: string;
}

export default function CircuitBreakerOverlay({
  visible,
  dailyLoss,
  dailyLossPercent,
  threshold,
  triggeredAt,
}: CircuitBreakerOverlayProps) {
  if (!visible) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="max-w-md w-full mx-4 border-2 border-loss-red/50 rounded-lg bg-background p-8 text-center space-y-6">
        {/* Icon */}
        <div className="flex justify-center">
          <div className="relative">
            <AlertOctagon className="h-16 w-16 text-loss-red animate-pulse" />
            <ShieldOff className="h-6 w-6 text-loss-red absolute -bottom-1 -right-1" />
          </div>
        </div>

        {/* Title */}
        <div>
          <h2 className="text-xl font-display font-bold text-loss-red tracking-tight">
            CIRCUIT BREAKER TRIGGERED
          </h2>
          <p className="text-[0.6875rem] text-muted-foreground mt-1">
            Daily loss limit reached — all trading is disabled for today
          </p>
        </div>

        {/* Loss Details */}
        <div className="grid grid-cols-2 gap-3">
          <div className="border border-loss-red/20 rounded-md p-3 bg-loss-red/5">
            <div className="text-[0.5625rem] text-muted-foreground uppercase tracking-wider">Daily Loss</div>
            <div className="text-2xl font-bold font-display text-loss-red mt-1">
              {formatINR(Math.abs(dailyLoss))}
            </div>
          </div>
          <div className="border border-loss-red/20 rounded-md p-3 bg-loss-red/5">
            <div className="text-[0.5625rem] text-muted-foreground uppercase tracking-wider">Loss %</div>
            <div className="text-2xl font-bold font-display text-loss-red mt-1">
              {dailyLossPercent.toFixed(1)}%
              <span className="text-sm text-muted-foreground ml-1">/ {threshold}%</span>
            </div>
          </div>
        </div>

        {/* Message */}
        <div className="border border-border rounded-md p-4 bg-card text-left space-y-2">
          <p className="text-[0.625rem] text-muted-foreground leading-relaxed">
            The market will be here tomorrow. Protecting your capital is more important than
            recovering today's loss. Step away, review what happened, and come back with a clear mind.
          </p>
          <p className="text-[0.625rem] text-muted-foreground/60 leading-relaxed">
            This overlay cannot be dismissed. Trading will resume automatically at market open tomorrow.
          </p>
        </div>

        {/* Triggered Time */}
        {triggeredAt && (
          <div className="flex items-center justify-center gap-1.5 text-[0.5625rem] text-muted-foreground/50">
            <Clock className="h-3 w-3" />
            Triggered at {new Date(triggeredAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
          </div>
        )}

        {/* Actions */}
        <div className="space-y-2">
          <button
            className="w-full py-2.5 rounded border border-border text-[0.625rem] text-muted-foreground hover:bg-card transition-colors"
            onClick={() => {
              // Open journal to review trades
              const event = new KeyboardEvent('keydown', { key: 'j', ctrlKey: true });
              document.dispatchEvent(event);
            }}
          >
            Review Today's Trades in Journal
          </button>
          <button
            className="w-full py-2.5 rounded border border-border text-[0.625rem] text-muted-foreground hover:bg-card transition-colors"
            onClick={() => {
              // Open discipline overlay
              const event = new KeyboardEvent('keydown', { key: 'd', ctrlKey: true });
              document.dispatchEvent(event);
            }}
          >
            View Discipline Dashboard
          </button>
        </div>
      </div>
    </div>
  );
}
