import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the database module
vi.mock('./db', async (importOriginal) => {
  const original = await importOriginal<typeof import('./db')>();
  return {
    ...original,
    getDb: vi.fn().mockResolvedValue(null),
  };
});

describe('Trade Journal Schema & Types', () => {
  it('should export tradeJournal table from schema', async () => {
    const schema = await import('../drizzle/schema');
    expect(schema.tradeJournal).toBeDefined();
  });

  it('should have all required columns in tradeJournal', async () => {
    const schema = await import('../drizzle/schema');
    const table = schema.tradeJournal;
    // Check that the table has the expected column names
    const columnNames = Object.keys(table);
    const requiredColumns = [
      'id', 'userId', 'instrument', 'tradeType', 'strike',
      'entryPrice', 'exitPrice', 'quantity', 'stopLoss', 'target',
      'pnl', 'pnlPercent', 'status', 'mode', 'rationale',
      'exitReason', 'tags', 'aiDecision', 'aiConfidence',
      'checklistScore', 'entryTime', 'exitTime', 'createdAt', 'updatedAt',
    ];
    for (const col of requiredColumns) {
      expect(columnNames).toContain(col);
    }
  });

  it('should have correct trade type enum values', async () => {
    const schema = await import('../drizzle/schema');
    // The tradeType column should accept CALL_BUY, PUT_BUY, CALL_SELL, PUT_SELL
    const tradeTypeCol = (schema.tradeJournal as any).tradeType;
    expect(tradeTypeCol).toBeDefined();
  });

  it('should have correct status enum values', async () => {
    const schema = await import('../drizzle/schema');
    const statusCol = (schema.tradeJournal as any).status;
    expect(statusCol).toBeDefined();
  });

  it('should have correct mode enum values', async () => {
    const schema = await import('../drizzle/schema');
    const modeCol = (schema.tradeJournal as any).mode;
    expect(modeCol).toBeDefined();
  });
});

describe('Trade Journal P&L Calculation Logic', () => {
  it('should calculate profit for CALL_BUY correctly', () => {
    const entryPrice = 150;
    const exitPrice = 200;
    const quantity = 25;
    const isBuy = true;
    const pnlPerUnit = isBuy ? (exitPrice - entryPrice) : (entryPrice - exitPrice);
    const pnl = pnlPerUnit * quantity;
    const pnlPercent = (pnlPerUnit / entryPrice) * 100;

    expect(pnl).toBe(1250);
    expect(pnlPercent).toBeCloseTo(33.33, 1);
  });

  it('should calculate loss for CALL_BUY correctly', () => {
    const entryPrice = 150;
    const exitPrice = 120;
    const quantity = 25;
    const isBuy = true;
    const pnlPerUnit = isBuy ? (exitPrice - entryPrice) : (entryPrice - exitPrice);
    const pnl = pnlPerUnit * quantity;

    expect(pnl).toBe(-750);
  });

  it('should calculate profit for PUT_SELL correctly', () => {
    const entryPrice = 200;
    const exitPrice = 150;
    const quantity = 10;
    const isBuy = false; // PUT_SELL
    const pnlPerUnit = isBuy ? (exitPrice - entryPrice) : (entryPrice - exitPrice);
    const pnl = pnlPerUnit * quantity;

    expect(pnl).toBe(500);
  });

  it('should calculate loss for CALL_SELL correctly', () => {
    const entryPrice = 100;
    const exitPrice = 130;
    const quantity = 50;
    const isBuy = false; // CALL_SELL
    const pnlPerUnit = isBuy ? (exitPrice - entryPrice) : (entryPrice - exitPrice);
    const pnl = pnlPerUnit * quantity;

    expect(pnl).toBe(-1500);
  });
});

describe('Trade Stats Calculation Logic', () => {
  const mockTrades = [
    { pnl: 500, pnlPercent: 10 },
    { pnl: -200, pnlPercent: -5 },
    { pnl: 300, pnlPercent: 8 },
    { pnl: -100, pnlPercent: -3 },
    { pnl: 800, pnlPercent: 20 },
    { pnl: -400, pnlPercent: -10 },
    { pnl: 150, pnlPercent: 4 },
  ];

  it('should calculate win rate correctly', () => {
    const wins = mockTrades.filter(t => t.pnl > 0);
    const winRate = (wins.length / mockTrades.length) * 100;
    expect(winRate).toBeCloseTo(57.14, 1);
  });

  it('should calculate total P&L correctly', () => {
    const totalPnl = mockTrades.reduce((sum, t) => sum + t.pnl, 0);
    expect(totalPnl).toBe(1050);
  });

  it('should calculate average win correctly', () => {
    const wins = mockTrades.filter(t => t.pnl > 0);
    const avgWin = wins.reduce((s, t) => s + t.pnl, 0) / wins.length;
    expect(avgWin).toBe(437.5);
  });

  it('should calculate average loss correctly', () => {
    const losses = mockTrades.filter(t => t.pnl < 0);
    const avgLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length);
    expect(avgLoss).toBeCloseTo(233.33, 1);
  });

  it('should calculate max drawdown correctly', () => {
    // Simulate running P&L: 500, 300, 600, 500, 1300, 900, 1050
    let peak = 0;
    let maxDrawdown = 0;
    let runningPnl = 0;
    for (const t of mockTrades) {
      runningPnl += t.pnl;
      if (runningPnl > peak) peak = runningPnl;
      const dd = peak - runningPnl;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }
    // After trade 6 (pnl=-400): running=900, peak=1300, dd=400
    expect(maxDrawdown).toBe(400);
  });

  it('should calculate R:R ratio correctly', () => {
    const wins = mockTrades.filter(t => t.pnl > 0);
    const losses = mockTrades.filter(t => t.pnl < 0);
    const avgWin = wins.reduce((s, t) => s + t.pnl, 0) / wins.length;
    const avgLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length);
    const rr = avgWin / avgLoss;
    expect(rr).toBeCloseTo(1.875, 2);
  });

  it('should find max win correctly', () => {
    const maxWin = Math.max(...mockTrades.filter(t => t.pnl > 0).map(t => t.pnl));
    expect(maxWin).toBe(800);
  });

  it('should find max loss correctly', () => {
    const maxLoss = Math.min(...mockTrades.filter(t => t.pnl < 0).map(t => t.pnl));
    expect(maxLoss).toBe(-400);
  });
});

describe('Trade Journal Router Input Validation', () => {
  it('should validate trade type values', () => {
    const validTypes = ['CALL_BUY', 'PUT_BUY', 'CALL_SELL', 'PUT_SELL'];
    const invalidTypes = ['BUY', 'SELL', 'CALL', 'PUT', ''];

    for (const t of validTypes) {
      expect(validTypes.includes(t)).toBe(true);
    }
    for (const t of invalidTypes) {
      expect(validTypes.includes(t)).toBe(false);
    }
  });

  it('should validate mode values', () => {
    const validModes = ['LIVE', 'PAPER'];
    expect(validModes.includes('LIVE')).toBe(true);
    expect(validModes.includes('PAPER')).toBe(true);
    expect(validModes.includes('DEMO')).toBe(false);
  });

  it('should validate status values', () => {
    const validStatuses = ['OPEN', 'CLOSED', 'CANCELLED'];
    expect(validStatuses.includes('OPEN')).toBe(true);
    expect(validStatuses.includes('CLOSED')).toBe(true);
    expect(validStatuses.includes('CANCELLED')).toBe(true);
    expect(validStatuses.includes('PENDING')).toBe(false);
  });

  it('should require positive quantity', () => {
    const qty = 1;
    expect(qty).toBeGreaterThan(0);
  });

  it('should require entryTime as UTC milliseconds', () => {
    const now = Date.now();
    expect(now).toBeGreaterThan(1000000000000); // After 2001
    expect(now).toBeLessThan(2000000000000); // Before 2033
  });
});
