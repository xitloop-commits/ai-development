/**
 * Market holidays data for NSE and MCX (2026).
 * Includes trading holidays, settlement/clearing holidays, and session details.
 */
import type { MarketHoliday } from '../shared/tradingTypes';

// NSE Trading Holidays 2026
const NSE_TRADING_HOLIDAYS_2026: MarketHoliday[] = [
  { date: '2026-01-15', day: 'Thursday', description: 'Municipal Corporation Election - Maharashtra', exchange: 'NSE', type: 'trading' },
  { date: '2026-01-26', day: 'Monday', description: 'Republic Day', exchange: 'NSE', type: 'both' },
  { date: '2026-03-03', day: 'Tuesday', description: 'Holi', exchange: 'NSE', type: 'both' },
  { date: '2026-03-26', day: 'Thursday', description: 'Shri Ram Navami', exchange: 'NSE', type: 'both' },
  { date: '2026-03-31', day: 'Tuesday', description: 'Shri Mahavir Jayanti', exchange: 'NSE', type: 'both' },
  { date: '2026-04-03', day: 'Friday', description: 'Good Friday', exchange: 'NSE', type: 'both' },
  { date: '2026-04-14', day: 'Tuesday', description: 'Dr. Baba Saheb Ambedkar Jayanti', exchange: 'NSE', type: 'both' },
  { date: '2026-05-01', day: 'Friday', description: 'Maharashtra Day', exchange: 'NSE', type: 'both' },
  { date: '2026-05-28', day: 'Thursday', description: 'Bakri Id', exchange: 'NSE', type: 'both' },
  { date: '2026-06-26', day: 'Friday', description: 'Muharram', exchange: 'NSE', type: 'both' },
  { date: '2026-09-14', day: 'Monday', description: 'Ganesh Chaturthi', exchange: 'NSE', type: 'both' },
  { date: '2026-10-02', day: 'Friday', description: 'Mahatma Gandhi Jayanti', exchange: 'NSE', type: 'both' },
  { date: '2026-10-20', day: 'Tuesday', description: 'Dussehra', exchange: 'NSE', type: 'both' },
  { date: '2026-11-10', day: 'Tuesday', description: 'Diwali-Balipratipada', exchange: 'NSE', type: 'both' },
  { date: '2026-11-24', day: 'Tuesday', description: 'Prakash Gurpurb Sri Guru Nanak Dev', exchange: 'NSE', type: 'both' },
  { date: '2026-12-25', day: 'Friday', description: 'Christmas', exchange: 'NSE', type: 'both' },
];

// NSE Settlement-only Holidays 2026 (not trading holidays)
const NSE_SETTLEMENT_ONLY_2026: MarketHoliday[] = [
  { date: '2026-02-19', day: 'Thursday', description: 'Chhatrapati Shivaji Maharaj Jayanti', exchange: 'NSE', type: 'settlement' },
  { date: '2026-03-19', day: 'Thursday', description: 'Gudhi Padwa', exchange: 'NSE', type: 'settlement' },
  { date: '2026-04-01', day: 'Wednesday', description: 'Annual Bank Closing', exchange: 'NSE', type: 'settlement' },
  { date: '2026-08-26', day: 'Wednesday', description: 'Id-E-Milad', exchange: 'NSE', type: 'settlement' },
  { date: '2026-11-08', day: 'Sunday', description: 'Diwali Laxmi Pujan', exchange: 'NSE', type: 'settlement', special: 'Muhurat Trading' },
];

// MCX Trading Holidays 2026
const MCX_TRADING_HOLIDAYS_2026: MarketHoliday[] = [
  { date: '2026-01-01', day: 'Thursday', description: "New Year's Day", exchange: 'MCX', type: 'trading', morningSession: 'open', eveningSession: 'closed' },
  { date: '2026-01-15', day: 'Thursday', description: 'Municipal Corporation Election - Maharashtra', exchange: 'MCX', type: 'trading', morningSession: 'closed', eveningSession: 'open' },
  { date: '2026-01-26', day: 'Monday', description: 'Republic Day', exchange: 'MCX', type: 'trading', morningSession: 'closed', eveningSession: 'closed' },
  { date: '2026-03-03', day: 'Tuesday', description: 'Holi', exchange: 'MCX', type: 'trading', morningSession: 'closed', eveningSession: 'open' },
  { date: '2026-03-26', day: 'Thursday', description: 'Shri Ram Navami', exchange: 'MCX', type: 'trading', morningSession: 'closed', eveningSession: 'open' },
  { date: '2026-03-31', day: 'Tuesday', description: 'Shri Mahavir Jayanti', exchange: 'MCX', type: 'trading', morningSession: 'closed', eveningSession: 'open' },
  { date: '2026-04-03', day: 'Friday', description: 'Good Friday', exchange: 'MCX', type: 'trading', morningSession: 'closed', eveningSession: 'closed' },
  { date: '2026-04-14', day: 'Tuesday', description: 'Dr. Baba Saheb Ambedkar Jayanti', exchange: 'MCX', type: 'trading', morningSession: 'closed', eveningSession: 'open' },
  { date: '2026-05-01', day: 'Friday', description: 'Maharashtra Day', exchange: 'MCX', type: 'trading', morningSession: 'closed', eveningSession: 'open' },
  { date: '2026-05-28', day: 'Thursday', description: 'Bakri Id', exchange: 'MCX', type: 'trading', morningSession: 'closed', eveningSession: 'open' },
  { date: '2026-06-26', day: 'Friday', description: 'Muharram', exchange: 'MCX', type: 'trading', morningSession: 'closed', eveningSession: 'open' },
  { date: '2026-09-14', day: 'Monday', description: 'Ganesh Chaturthi', exchange: 'MCX', type: 'trading', morningSession: 'closed', eveningSession: 'open' },
  { date: '2026-10-02', day: 'Friday', description: 'Mahatma Gandhi Jayanti', exchange: 'MCX', type: 'trading', morningSession: 'closed', eveningSession: 'closed' },
  { date: '2026-10-20', day: 'Tuesday', description: 'Dussehra', exchange: 'MCX', type: 'trading', morningSession: 'closed', eveningSession: 'open' },
  { date: '2026-11-10', day: 'Tuesday', description: 'Diwali Balipratipada', exchange: 'MCX', type: 'trading', morningSession: 'closed', eveningSession: 'open' },
  { date: '2026-11-24', day: 'Tuesday', description: 'Guru Nanak Jayanti', exchange: 'MCX', type: 'trading', morningSession: 'closed', eveningSession: 'open' },
  { date: '2026-12-25', day: 'Friday', description: 'Christmas', exchange: 'MCX', type: 'trading', morningSession: 'closed', eveningSession: 'closed' },
];

// All holidays combined
const ALL_HOLIDAYS: MarketHoliday[] = [
  ...NSE_TRADING_HOLIDAYS_2026,
  ...NSE_SETTLEMENT_ONLY_2026,
  ...MCX_TRADING_HOLIDAYS_2026,
].sort((a, b) => a.date.localeCompare(b.date));

/**
 * Get upcoming holidays for a given exchange within N days.
 * @param exchange - 'NSE', 'MCX', or 'ALL'
 * @param daysAhead - number of days to look ahead (default 30)
 */
export function getUpcomingHolidays(
  exchange: 'NSE' | 'MCX' | 'ALL' = 'ALL',
  daysAhead: number = 60
): MarketHoliday[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() + daysAhead);

  return ALL_HOLIDAYS.filter(h => {
    const hDate = new Date(h.date + 'T00:00:00');
    if (hDate < today || hDate > cutoff) return false;
    if (exchange === 'ALL') return true;
    return h.exchange === exchange || h.exchange === 'BOTH';
  });
}

/**
 * Check if today is a holiday for a given exchange.
 */
export function isTodayHoliday(exchange: 'NSE' | 'MCX'): { isHoliday: boolean; holiday?: MarketHoliday } {
  const todayStr = new Date().toISOString().split('T')[0];
  const holiday = ALL_HOLIDAYS.find(h =>
    h.date === todayStr && (h.exchange === exchange || h.exchange === 'BOTH')
  );
  return holiday ? { isHoliday: true, holiday } : { isHoliday: false };
}

/**
 * Get the next trading day for a given exchange.
 */
export function getNextTradingDay(exchange: 'NSE' | 'MCX'): { date: string; daysAway: number } {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const holidayDates = new Set(
    ALL_HOLIDAYS
      .filter(h => h.exchange === exchange || h.exchange === 'BOTH')
      .filter(h => h.type === 'trading' || h.type === 'both')
      .map(h => h.date)
  );

  const checkDate = new Date(today);
  checkDate.setDate(checkDate.getDate() + 1);

  for (let i = 1; i <= 30; i++) {
    const dayOfWeek = checkDate.getDay();
    // Local-time YYYY-MM-DD. `toISOString()` would shift to UTC and
    // give the wrong date string for any positive-offset timezone
    // (in IST, midnight local = previous day 18:30 UTC).
    const dateStr =
      `${checkDate.getFullYear()}-` +
      `${String(checkDate.getMonth() + 1).padStart(2, "0")}-` +
      `${String(checkDate.getDate()).padStart(2, "0")}`;

    // Skip weekends and holidays
    if (dayOfWeek !== 0 && dayOfWeek !== 6 && !holidayDates.has(dateStr)) {
      return { date: dateStr, daysAway: i };
    }

    checkDate.setDate(checkDate.getDate() + 1);
  }

  return { date: '', daysAway: -1 };
}

/**
 * Get all holidays data for the full calendar view.
 */
export function getAllHolidays(): MarketHoliday[] {
  return ALL_HOLIDAYS;
}
