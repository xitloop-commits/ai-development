import { describe, it, expect } from 'vitest';
import { getUpcomingHolidays, isTodayHoliday, getNextTradingDay, getAllHolidays } from './holidays';

describe('holidays module', () => {
  describe('getAllHolidays', () => {
    it('returns all holidays sorted by date', () => {
      const all = getAllHolidays();
      expect(all.length).toBeGreaterThan(0);
      // Check sorted
      for (let i = 1; i < all.length; i++) {
        expect(all[i].date >= all[i - 1].date).toBe(true);
      }
    });

    it('each holiday has required fields', () => {
      const all = getAllHolidays();
      for (const h of all) {
        expect(h.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(h.day).toBeTruthy();
        expect(h.description).toBeTruthy();
        expect(['NSE', 'MCX']).toContain(h.exchange);
        expect(['trading', 'settlement', 'both']).toContain(h.type);
      }
    });

    it('includes both NSE and MCX holidays', () => {
      const all = getAllHolidays();
      const nse = all.filter(h => h.exchange === 'NSE');
      const mcx = all.filter(h => h.exchange === 'MCX');
      expect(nse.length).toBeGreaterThan(0);
      expect(mcx.length).toBeGreaterThan(0);
    });

    it('includes settlement-only holidays for NSE', () => {
      const all = getAllHolidays();
      const settlement = all.filter(h => h.exchange === 'NSE' && h.type === 'settlement');
      expect(settlement.length).toBeGreaterThan(0);
    });
  });

  describe('getUpcomingHolidays', () => {
    it('returns holidays within the specified days ahead', () => {
      const holidays = getUpcomingHolidays('ALL', 365);
      expect(holidays.length).toBeGreaterThanOrEqual(0);
      // All returned holidays should be in the future (or today)
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      for (const h of holidays) {
        const hDate = new Date(h.date + 'T00:00:00');
        expect(hDate.getTime()).toBeGreaterThanOrEqual(today.getTime());
      }
    });

    it('filters by exchange when specified', () => {
      const nse = getUpcomingHolidays('NSE', 365);
      for (const h of nse) {
        expect(h.exchange === 'NSE' || h.exchange === 'BOTH').toBe(true);
      }
      const mcx = getUpcomingHolidays('MCX', 365);
      for (const h of mcx) {
        expect(h.exchange === 'MCX' || h.exchange === 'BOTH').toBe(true);
      }
    });

    it('returns fewer holidays with shorter daysAhead', () => {
      const short = getUpcomingHolidays('ALL', 30);
      const long = getUpcomingHolidays('ALL', 365);
      expect(long.length).toBeGreaterThanOrEqual(short.length);
    });
  });

  describe('isTodayHoliday', () => {
    it('returns an object with isHoliday boolean', () => {
      const nse = isTodayHoliday('NSE');
      expect(typeof nse.isHoliday).toBe('boolean');
      const mcx = isTodayHoliday('MCX');
      expect(typeof mcx.isHoliday).toBe('boolean');
    });

    it('returns holiday details when isHoliday is true', () => {
      const result = isTodayHoliday('NSE');
      if (result.isHoliday) {
        expect(result.holiday).toBeDefined();
        expect(result.holiday!.description).toBeTruthy();
      } else {
        expect(result.holiday).toBeUndefined();
      }
    });
  });

  describe('getNextTradingDay', () => {
    it('returns a valid date and daysAway for NSE', () => {
      const result = getNextTradingDay('NSE');
      expect(result.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(result.daysAway).toBeGreaterThan(0);
    });

    it('returns a valid date and daysAway for MCX', () => {
      const result = getNextTradingDay('MCX');
      expect(result.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(result.daysAway).toBeGreaterThan(0);
    });

    it('next trading day is not a weekend', () => {
      const result = getNextTradingDay('NSE');
      const d = new Date(result.date + 'T00:00:00');
      const day = d.getDay();
      expect(day).not.toBe(0); // Not Sunday
      expect(day).not.toBe(6); // Not Saturday
    });
  });

  describe('MCX session details', () => {
    it('MCX holidays have session info', () => {
      const all = getAllHolidays();
      const mcxWithSessions = all.filter(
        h => h.exchange === 'MCX' && (h.morningSession || h.eveningSession)
      );
      expect(mcxWithSessions.length).toBeGreaterThan(0);
      for (const h of mcxWithSessions) {
        if (h.morningSession) {
          expect(['open', 'closed']).toContain(h.morningSession);
        }
        if (h.eveningSession) {
          expect(['open', 'closed']).toContain(h.eveningSession);
        }
      }
    });
  });
});
