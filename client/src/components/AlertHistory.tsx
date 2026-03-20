/**
 * AlertHistory — Collapsible panel showing the last 20 alerts with timestamps.
 * Terminal Noir styling with color-coded alert types.
 */
import { useState } from 'react';
import { useAlerts } from '@/contexts/AlertContext';
import { getAlertColor, getAlertGlow, getAlertLabel } from '@/lib/alertTypes';
import {
  Bell,
  ChevronDown,
  ChevronUp,
  Trash2,
  CheckCheck,
  Zap,
  ShieldAlert,
  Target,
  AlertTriangle,
  Radio,
  ArrowUpDown,
} from 'lucide-react';
import type { AlertEventType } from '@/lib/alertTypes';

function getAlertIcon(type: AlertEventType) {
  switch (type) {
    case 'go_signal':
      return <Zap className="h-3 w-3 text-bullish" />;
    case 'stop_loss_hit':
      return <ShieldAlert className="h-3 w-3 text-destructive" />;
    case 'target_profit_hit':
      return <Target className="h-3 w-3 text-bullish" />;
    case 'module_down':
      return <AlertTriangle className="h-3 w-3 text-destructive" />;
    case 'new_signal':
      return <Radio className="h-3 w-3 text-info-cyan" />;
    case 'position_opened':
    case 'position_closed':
      return <ArrowUpDown className="h-3 w-3 text-warning-amber" />;
  }
}

function formatAlertTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = Date.now();
  const diff = now - timestamp;

  if (diff < 60000) {
    return `${Math.floor(diff / 1000)}s ago`;
  }
  if (diff < 3600000) {
    return `${Math.floor(diff / 60000)}m ago`;
  }
  if (diff < 86400000) {
    return date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

export default function AlertHistory() {
  const { alerts, clearAlerts, unreadCount, markAllRead } = useAlerts();
  const [isExpanded, setIsExpanded] = useState(false);

  const displayAlerts = alerts.slice(0, 20);

  return (
    <div className="border border-border rounded-md bg-card overflow-hidden">
      {/* Header — always visible */}
      <button
        onClick={() => {
          setIsExpanded(!isExpanded);
          if (!isExpanded) markAllRead();
        }}
        className="w-full px-3 py-2 border-b border-border bg-secondary/30 flex items-center justify-between hover:bg-secondary/50 transition-colors"
      >
        <div className="flex items-center gap-1.5">
          <Bell className="h-3 w-3 text-info-cyan" />
          <span className="text-[10px] font-bold text-info-cyan tracking-wider uppercase">
            Alert History
          </span>
          {unreadCount > 0 && (
            <span className="text-[9px] bg-destructive text-destructive-foreground rounded-full px-1.5 py-0.5 font-bold tabular-nums animate-pulse-glow">
              {unreadCount}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[9px] text-muted-foreground tabular-nums">
            {alerts.length} alerts
          </span>
          {isExpanded ? (
            <ChevronUp className="h-3 w-3 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          )}
        </div>
      </button>

      {/* Expanded content */}
      {isExpanded && (
        <div>
          {/* Actions bar */}
          {alerts.length > 0 && (
            <div className="px-3 py-1.5 border-b border-border flex items-center justify-end gap-2">
              <button
                onClick={markAllRead}
                className="text-[9px] text-muted-foreground hover:text-info-cyan flex items-center gap-1 transition-colors"
              >
                <CheckCheck className="h-3 w-3" />
                Mark Read
              </button>
              <button
                onClick={clearAlerts}
                className="text-[9px] text-muted-foreground hover:text-destructive flex items-center gap-1 transition-colors"
              >
                <Trash2 className="h-3 w-3" />
                Clear All
              </button>
            </div>
          )}

          {/* Alert list */}
          <div className="max-h-[300px] overflow-y-auto">
            {displayAlerts.length === 0 ? (
              <div className="px-3 py-6 text-center">
                <Bell className="h-5 w-5 text-muted-foreground mx-auto mb-2 opacity-30" />
                <p className="text-[10px] text-muted-foreground">
                  No alerts yet
                </p>
                <p className="text-[9px] text-muted-foreground mt-0.5">
                  Alerts will appear here when events are detected
                </p>
              </div>
            ) : (
              displayAlerts.map((alert) => (
                <div
                  key={alert.id}
                  className={`px-3 py-2 border-b border-border/50 last:border-b-0 hover:bg-secondary/20 transition-colors ${
                    alert.dismissed ? 'opacity-50' : ''
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <div className="mt-0.5 shrink-0">
                      {getAlertIcon(alert.type)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className={`text-[10px] font-bold ${getAlertColor(alert.type)} truncate`}>
                          {alert.title}
                        </span>
                        <span className="text-[8px] text-muted-foreground tabular-nums shrink-0">
                          {formatAlertTime(alert.timestamp)}
                        </span>
                      </div>
                      <p className="text-[9px] text-muted-foreground mt-0.5 line-clamp-2">
                        {alert.message}
                      </p>
                      <div className="flex items-center gap-2 mt-1">
                        <span className={`text-[8px] px-1 py-0.5 rounded border ${getAlertGlow(alert.type)} bg-secondary/30`}>
                          {getAlertLabel(alert.type)}
                        </span>
                        {alert.instrument && (
                          <span className="text-[8px] text-muted-foreground px-1 py-0.5 bg-secondary rounded">
                            {alert.instrument}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
