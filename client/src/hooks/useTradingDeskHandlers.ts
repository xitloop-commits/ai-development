import { useCallback, useRef, useState } from 'react';
import type { TradeRecord } from '@/lib/tradeTypes';

type PlaceTradeInput = {
  instrument: string;
  type: 'CALL_BUY' | 'CALL_SELL' | 'PUT_BUY' | 'PUT_SELL' | 'BUY' | 'SELL';
  strike: number | null;
  expiry: string;
  entryPrice: number;
  capitalPercent: number;
  qty: number;
  lotSize?: number;
  contractSecurityId?: string | null;
  targetPrice?: number | null;
  stopLossPrice?: number | null;
  trailingStopEnabled?: boolean;
};

type ExitTradeInput = {
  tradeId: string;
  exitPrice: number;
  reason: string;
};

export interface ConfirmDialogState {
  open: boolean;
  title: string;
  message: string;
  onConfirm: () => void;
}

interface UseTradingDeskHandlersParams {
  currentDay: { trades?: TradeRecord[] } | null | undefined;
  ctxPlaceTrade: (input: PlaceTradeInput) => void;
  ctxExitTrade: (input: ExitTradeInput) => void;
  subscribeOptionFeed: (instrument: string, contractSecurityId: string) => void;
  getLiveLtp: (trade: { id?: string; instrument: string; contractSecurityId?: string | null; ltp?: number; entryPrice?: number }) => number | undefined;
  tableContainerRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * Owns TradingDesk's trade-operation handlers plus the confirm-dialog + highlight-day state.
 * `confirmDialog` + `closeConfirmDialog` are exposed so the container can still render
 * the dialog at the root.
 */
export function useTradingDeskHandlers({
  currentDay,
  ctxPlaceTrade,
  ctxExitTrade,
  subscribeOptionFeed,
  getLiveLtp,
  tableContainerRef,
}: UseTradingDeskHandlersParams) {
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>({
    open: false,
    title: '',
    message: '',
    onConfirm: () => {},
  });
  const [highlightedDay, setHighlightedDay] = useState<number | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const closeConfirmDialog = useCallback(
    () => setConfirmDialog((prev) => ({ ...prev, open: false })),
    [],
  );

  const handlePlaceTrade = useCallback(async (trade: PlaceTradeInput) => {
    ctxPlaceTrade(trade);
    if (trade.contractSecurityId) {
      subscribeOptionFeed(trade.instrument, trade.contractSecurityId);
    }
  }, [ctxPlaceTrade, subscribeOptionFeed]);

  const handleExitTrade = useCallback((tradeId: string, instrument: string) => {
    const trade = currentDay?.trades?.find((t) => t.id === tradeId);
    const liveLtp = trade ? getLiveLtp(trade) : undefined;
    const exitPrice = liveLtp ?? trade?.ltp ?? trade?.entryPrice ?? 0;
    if (exitPrice <= 0) return;

    setConfirmDialog({
      open: true,
      title: 'Exit Position',
      message: `Close ${instrument} position at market price ₹${exitPrice.toFixed(2)}?`,
      onConfirm: () => {
        ctxExitTrade({ tradeId, exitPrice, reason: 'MANUAL' });
        setConfirmDialog((prev) => ({ ...prev, open: false }));
      },
    });
  }, [currentDay, ctxExitTrade, getLiveLtp]);

  const handleExitAll = useCallback(() => {
    const openTrades = currentDay?.trades?.filter((t) => t.status === 'OPEN') ?? [];
    if (openTrades.length === 0) return;

    setConfirmDialog({
      open: true,
      title: 'Exit All Positions',
      message: `Close all ${openTrades.length} open position${openTrades.length > 1 ? 's' : ''} at market?`,
      onConfirm: () => {
        for (const trade of openTrades) {
          const liveLtp = getLiveLtp(trade);
          const exitPrice = liveLtp ?? trade.ltp ?? trade.entryPrice ?? 0;
          if (exitPrice > 0) {
            ctxExitTrade({ tradeId: trade.id, exitPrice, reason: 'MANUAL' });
          }
        }
        setConfirmDialog((prev) => ({ ...prev, open: false }));
      },
    });
  }, [currentDay, ctxExitTrade, getLiveLtp]);

  const scrollToDay = useCallback((dayIndex: number) => {
    const container = tableContainerRef.current;
    if (!container) return;
    const row = container.querySelector<HTMLElement>(`[data-day="${dayIndex}"]`);
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightedDay(dayIndex);
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => setHighlightedDay(null), 1500);
  }, [tableContainerRef]);

  return {
    confirmDialog,
    closeConfirmDialog,
    highlightedDay,
    handlePlaceTrade,
    handleExitTrade,
    handleExitAll,
    scrollToDay,
  };
}
