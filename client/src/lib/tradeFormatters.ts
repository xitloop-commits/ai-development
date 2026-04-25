import { formatINR } from '@/lib/formatINR';

export function fmt(n: number, compact = true): string {
  return formatINR(n, { compact, decimals: 2 });
}

export function pnlColor(n: number): string {
  if (n > 0) return 'text-bullish/80';
  if (n < 0) return 'text-destructive/80';
  return 'text-foreground';
}

export function formatAge(openedAt?: number): string {
  if (!openedAt) return '';
  const now = Date.now();
  const diffMs = now - openedAt;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  const diffDays = Math.floor(diffHr / 24);
  return `${diffDays}d`;
}

export function ordinal(n: number): string {
  if (n >= 11 && n <= 13) return n + 'th';
  switch (n % 10) {
    case 1: return n + 'st';
    case 2: return n + 'nd';
    case 3: return n + 'rd';
    default: return n + 'th';
  }
}

export function formatCalendarDay(timestamp: number = Date.now()): string {
  const d = new Date(timestamp);
  const day = d.getDate();
  const month = d.toLocaleDateString('en-IN', { month: 'short' });
  const year = String(d.getFullYear()).slice(2);
  return `${day} ${month} ${year}`;
}

export function formatExpiryLabel(expiry?: string | null): string {
  if (!expiry) return '';
  const time = new Date(`${expiry}T00:00:00`).getTime();
  if (Number.isNaN(time)) return expiry;
  return formatCalendarDay(time);
}

export function formatDateStr(dateStr: string): string {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr + 'T00:00:00');
    if (isNaN(d.getTime())) return dateStr;
    return formatCalendarDay(d.getTime());
  } catch { return dateStr; }
}

export function formatDateAgeLabel(dateLabel: string, openedAt?: number): string {
  const formatted = formatDateStr(dateLabel);
  const age = formatAge(openedAt);
  return age ? `${formatted} | ${age}` : formatted;
}

export function getTradeDirectionLabel(type: string): 'B' | 'S' | '—' {
  if (type.includes('SELL')) return 'S';
  if (type.includes('BUY')) return 'B';
  return '—';
}

export function getTradeContractLabel(type: string): 'CE' | 'PE' | 'DIR' {
  if (type.startsWith('CALL_')) return 'CE';
  if (type.startsWith('PUT_')) return 'PE';
  return 'DIR';
}

export function formatDeviation(deviation: number, daysAhead?: number): string {
  const sign = deviation >= 0 ? '+' : '';
  const daysStr = daysAhead !== undefined ? ` (${daysAhead >= 0 ? '+' : ''}${daysAhead}d)` : '';
  return `${sign}${fmt(deviation)}${daysStr}`;
}
