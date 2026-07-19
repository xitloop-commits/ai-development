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

/** Format a hold duration (ms) with seconds precision — for how long a trade was
 *  sustained (scalps last seconds–minutes). e.g. 45s, 3m 12s, 1h 4m. */
export function formatDuration(ms?: number | null): string {
  if (ms == null || ms < 0 || !Number.isFinite(ms)) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) {
    const rem = s % 60;
    return rem ? `${m}m ${rem}s` : `${m}m`;
  }
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
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

/** Exchange symbol (as on NSE/MCX) for an instrument key — used for copy/search. */
export function exchangeSymbol(instrument: string): string | null {
  const u = (instrument || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (u.includes('BANK')) return 'BANKNIFTY';
  if (u.startsWith('NIFTY')) return 'NIFTY';
  if (u.includes('CRUDE')) return 'CRUDEOIL';
  if (u.includes('NATURAL') || u.includes('GAS')) return 'NATURALGAS';
  return null;
}

const COPY_MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** Exchange contract string for clicking the instrument pill to copy, e.g.
 *  "BANKNIFTY 28 JUL 58000 PUT". Null if any part is missing (expiry/strike/side). */
export function contractCopyText(
  instrument: string,
  expiry: string | null | undefined,
  strike: number | null | undefined,
  contractLabel: 'CE' | 'PE' | 'DIR',
): string | null {
  const sym = exchangeSymbol(instrument);
  const side = contractLabel === 'CE' ? 'CALL' : contractLabel === 'PE' ? 'PUT' : null;
  const m = expiry ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(expiry) : null;
  if (!sym || !side || strike == null || !m) return null;
  return `${sym} ${parseInt(m[3], 10)} ${COPY_MONTHS[parseInt(m[2], 10) - 1]} ${Math.round(strike)} ${side}`;
}

export function formatDateStr(dateStr: string): string {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr + 'T00:00:00');
    if (isNaN(d.getTime())) return dateStr;
    return formatCalendarDay(d.getTime());
  } catch { return dateStr; }
}

/** Clock time of an epoch-ms timestamp, in IST, 24h "HH:MM" (e.g. "09:18"). */
export function formatIstClock(ts: number): string {
  if (!ts || Number.isNaN(ts)) return '';
  return new Date(ts).toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata',
  });
}

/** Full IST date + time for tooltips, e.g. "17 Jul 2026, 09:18:23". */
export function formatIstDateTime(ts: number): string {
  if (!ts || Number.isNaN(ts)) return '';
  return new Date(ts).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    timeZone: 'Asia/Kolkata',
  });
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
