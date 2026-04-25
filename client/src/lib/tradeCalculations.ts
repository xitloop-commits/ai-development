import type { TradeRecord } from './tradeTypes';

export function calculatePotentialPnl(trade: TradeRecord, price: number): number {
  const isBuy = trade.type.includes('BUY');
  return (isBuy ? (price - trade.entryPrice) : (trade.entryPrice - price)) * trade.qty;
}

export function calculateOpenRisk(trades: TradeRecord[]): number {
  return trades.reduce((sum, trade) => {
    if (trade.stopLossPrice === null) return sum;
    return sum + Math.max(0, -calculatePotentialPnl(trade, trade.stopLossPrice));
  }, 0);
}

export function calculateOpenReward(trades: TradeRecord[]): number {
  return trades.reduce((sum, trade) => {
    if (trade.targetPrice === null) return sum;
    return sum + Math.max(0, calculatePotentialPnl(trade, trade.targetPrice));
  }, 0);
}

export function calculateOpenMargin(trades: TradeRecord[]): number {
  return trades.reduce((sum, trade) => {
    if (trade.status !== 'OPEN') return sum;
    return sum + (trade.entryPrice * trade.qty);
  }, 0);
}

export function calculateTotalLots(trades: TradeRecord[]): number {
  return trades.reduce((sum, trade) => {
    const lots = trade.lotSize && trade.lotSize > 1 ? Math.floor(trade.qty / trade.lotSize) : trade.qty;
    return sum + lots;
  }, 0);
}

export function calculateTotalInvested(trades: TradeRecord[]): number {
  return trades.reduce((sum, t) => sum + t.entryPrice * t.qty, 0);
}

export function calculateAvgEntryPrice(trades: TradeRecord[]): number {
  const totalQty = trades.reduce((sum, t) => sum + t.qty, 0);
  if (totalQty === 0) return 0;
  const totalValue = trades.reduce((sum, t) => sum + t.entryPrice * t.qty, 0);
  return totalValue / totalQty;
}

export function calculateAvgExitPrice(trades: TradeRecord[]): number {
  const closed = trades.filter(t => t.exitPrice != null && t.qty > 0);
  const totalQty = closed.reduce((sum, t) => sum + t.qty, 0);
  if (totalQty === 0) return 0;
  const totalValue = closed.reduce((sum, t) => sum + (t.exitPrice ?? 0) * t.qty, 0);
  return totalValue / totalQty;
}

export function tradePoints(trade: { type: string; entryPrice: number }, price: number): number {
  const isBuy = typeof trade.type === 'string' && trade.type.includes('BUY');
  return isBuy ? price - trade.entryPrice : trade.entryPrice - price;
}

export function calculateAvgSignedPoints(trades: TradeRecord[]): number {
  const closed = trades.filter(t => t.exitPrice != null && t.qty > 0);
  const totalQty = closed.reduce((sum, t) => sum + t.qty, 0);
  if (totalQty === 0) return 0;
  const totalPts = closed.reduce(
    (sum, t) => sum + tradePoints(t, t.exitPrice ?? 0) * t.qty,
    0
  );
  return totalPts / totalQty;
}

export function countTradeOutcomes(trades: TradeRecord[]): { wins: number; losses: number } {
  return trades.reduce((acc, trade) => {
    if (trade.status === 'OPEN' || trade.status === 'PENDING' || trade.status === 'CANCELLED') {
      return acc;
    }
    if (trade.pnl > 0) acc.wins += 1;
    else if (trade.pnl < 0) acc.losses += 1;
    return acc;
  }, { wins: 0, losses: 0 });
}
