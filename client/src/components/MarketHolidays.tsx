/**
 * Terminal Noir — MarketHolidays Component
 * Displays upcoming NSE and MCX trading + settlement holidays.
 * Compact card with exchange tabs and color-coded holiday types.
 */
import { useState, useMemo } from 'react';
import { Calendar, AlertCircle, Clock } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import type { MarketHoliday } from '@/lib/types';

type ExchangeTab = 'ALL' | 'NSE' | 'MCX';

function formatDateShort(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

function getDaysUntil(dateStr: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr + 'T00:00:00');
  return Math.ceil((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

function getDaysLabel(days: number): string {
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  return `In ${days}d`;
}

function getTypeColor(holiday: MarketHoliday): string {
  if (holiday.type === 'settlement') return 'text-warning-amber';
  if (holiday.special) return 'text-info-cyan';
  return 'text-foreground';
}

function getTypeBadge(holiday: MarketHoliday): { label: string; className: string } | null {
  if (holiday.type === 'settlement') {
    return {
      label: 'SETTLEMENT',
      className: 'bg-warning-amber/10 text-warning-amber border-warning-amber/20',
    };
  }
  if (holiday.special) {
    return {
      label: holiday.special.toUpperCase(),
      className: 'bg-info-cyan/10 text-info-cyan border-info-cyan/20',
    };
  }
  return null;
}

function SessionBadge({ morning, evening }: { morning?: string; evening?: string }) {
  if (!morning && !evening) return null;
  return (
    <div className="flex items-center gap-1">
      {morning && (
        <span className={`text-[7px] px-1 py-0 rounded border ${
          morning === 'closed'
            ? 'bg-destructive/10 text-destructive border-destructive/20'
            : 'bg-bullish/10 text-bullish border-bullish/20'
        }`}>
          AM:{morning === 'closed' ? 'OFF' : 'ON'}
        </span>
      )}
      {evening && (
        <span className={`text-[7px] px-1 py-0 rounded border ${
          evening === 'closed'
            ? 'bg-destructive/10 text-destructive border-destructive/20'
            : 'bg-bullish/10 text-bullish border-bullish/20'
        }`}>
          PM:{evening === 'closed' ? 'OFF' : 'ON'}
        </span>
      )}
    </div>
  );
}

export default function MarketHolidays() {
  const [tab, setTab] = useState<ExchangeTab>('ALL');
  const [showAll, setShowAll] = useState(false);

  const holidaysQuery = trpc.holidays.upcoming.useQuery(
    { exchange: tab, daysAhead: 90 },
    { refetchInterval: 60000 } // Refresh every minute
  );

  const holidays = holidaysQuery.data ?? [];

  // Deduplicate holidays that appear on both exchanges on the same date
  const deduped = useMemo(() => {
    if (tab !== 'ALL') return holidays;
    const seen = new Map<string, MarketHoliday>();
    for (const h of holidays) {
      const key = `${h.date}-${h.description}-${h.type}`;
      if (!seen.has(key)) {
        seen.set(key, h);
      } else {
        // Merge: mark as BOTH
        const existing = seen.get(key)!;
        if (existing.exchange !== h.exchange) {
          seen.set(key, { ...existing, exchange: 'BOTH' as any });
        }
      }
    }
    return Array.from(seen.values()).sort((a, b) => a.date.localeCompare(b.date));
  }, [holidays, tab]);

  const displayHolidays = showAll ? deduped : deduped.slice(0, 5);

  // Find the next immediate holiday
  const nextHoliday = deduped.find(h => getDaysUntil(h.date) >= 0);
  const nextDays = nextHoliday ? getDaysUntil(nextHoliday.date) : -1;

  return (
    <div className="rounded border border-border bg-card/80 backdrop-blur-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <div className="flex items-center gap-1.5">
          <Calendar className="h-3.5 w-3.5 text-info-cyan" />
          <span className="text-[10px] font-bold tracking-wider text-foreground uppercase">
            Market Holidays
          </span>
          {nextHoliday && nextDays <= 3 && (
            <span className="text-[8px] px-1.5 py-0.5 rounded bg-warning-amber/10 text-warning-amber border border-warning-amber/20 font-bold animate-pulse-glow">
              {getDaysLabel(nextDays)}: {nextHoliday.description}
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          {(['ALL', 'NSE', 'MCX'] as ExchangeTab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`text-[8px] px-1.5 py-0.5 rounded font-bold tracking-wider transition-colors ${
                tab === t
                  ? 'bg-info-cyan/15 text-info-cyan border border-info-cyan/30'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* Holiday List */}
      <div className="divide-y divide-border/50">
        {displayHolidays.length === 0 ? (
          <div className="px-3 py-4 text-center">
            <span className="text-[10px] text-muted-foreground">No upcoming holidays in the next 90 days</span>
          </div>
        ) : (
          displayHolidays.map((h, i) => {
            const days = getDaysUntil(h.date);
            const isImminent = days <= 3;
            const badge = getTypeBadge(h);

            return (
              <div
                key={`${h.date}-${h.description}-${h.exchange}-${i}`}
                className={`flex items-center gap-2 px-3 py-1.5 ${
                  isImminent ? 'bg-warning-amber/5' : ''
                }`}
              >
                {/* Date */}
                <div className="w-[52px] shrink-0">
                  <div className="text-[10px] font-bold tabular-nums text-foreground">
                    {formatDateShort(h.date)}
                  </div>
                  <div className="text-[8px] text-muted-foreground">{h.day.slice(0, 3)}</div>
                </div>

                {/* Description */}
                <div className="flex-1 min-w-0">
                  <div className={`text-[10px] leading-tight truncate ${getTypeColor(h)}`}>
                    {h.description}
                  </div>
                  <div className="flex items-center gap-1 mt-0.5">
                    {/* Exchange badge */}
                    <span className={`text-[7px] px-1 py-0 rounded border font-bold ${
                      h.exchange === 'NSE' ? 'bg-info-cyan/10 text-info-cyan border-info-cyan/20' :
                      h.exchange === 'MCX' ? 'bg-warning-amber/10 text-warning-amber border-warning-amber/20' :
                      'bg-muted/30 text-muted-foreground border-border'
                    }`}>
                      {h.exchange}
                    </span>
                    {/* Type badge */}
                    {badge && (
                      <span className={`text-[7px] px-1 py-0 rounded border font-bold ${badge.className}`}>
                        {badge.label}
                      </span>
                    )}
                    {/* MCX session info */}
                    {h.exchange === 'MCX' && (
                      <SessionBadge morning={h.morningSession} evening={h.eveningSession} />
                    )}
                  </div>
                </div>

                {/* Days until */}
                <div className="shrink-0 text-right">
                  <span className={`text-[9px] font-bold tabular-nums ${
                    isImminent ? 'text-warning-amber' : 'text-muted-foreground'
                  }`}>
                    {getDaysLabel(days)}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Show more / less */}
      {deduped.length > 5 && (
        <div className="px-3 py-1.5 border-t border-border/50">
          <button
            onClick={() => setShowAll(!showAll)}
            className="text-[9px] text-info-cyan hover:text-info-cyan/80 font-bold tracking-wider transition-colors"
          >
            {showAll ? 'Show Less' : `Show All (${deduped.length})`}
          </button>
        </div>
      )}
    </div>
  );
}
