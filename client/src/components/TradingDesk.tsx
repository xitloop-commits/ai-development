/**
 * TradingDesk — 250-day compounding workspace.
 *
 * Slim container: composes sub-components and wires two hooks.
 *   - useTradingDeskData: live LTP lookup + feed subscription + auto-scroll + 2s sync
 *   - useTradingDeskHandlers: place/exit trade + confirm dialog + quick-jump scroll
 *
 * Presentational children: PastRow, TodaySection, FutureRow, TodayPnlBar, ConfirmDialog.
 * Shared helpers: @/lib/tradeTypes, @/lib/tradeFormatters, @/lib/tradeCalculations, @/lib/tradeThemes.
 */
import { useState, useRef } from 'react';
import { useCapital } from '@/contexts/CapitalContext';
import { TodayPnlBar } from './TodayPnlBar';
import { TradingDeskSkeleton, NoCapitalEmpty, ErrorState } from './LoadingStates';
import type { ResolvedInstrument } from '@/lib/tradeTypes';
import { supportsManualControls } from '@/lib/tradeThemes';
import { fmt } from '@/lib/tradeFormatters';
import { ConfirmDialog } from './ConfirmDialog';
import { PastRow } from './PastRow';
import { FutureRow } from './FutureRow';
import { TodaySection } from './TodaySection';
import { useTradingDeskData } from '@/hooks/useTradingDeskData';
import { useTradingDeskHandlers } from '@/hooks/useTradingDeskHandlers';

export type { ResolvedInstrument } from '@/lib/tradeTypes';

export default function TradingDesk({
  resolvedInstruments,
  liveTicksEnabled = true,
}: {
  resolvedInstruments?: ResolvedInstrument[];
  liveTicksEnabled?: boolean;
}) {
  const {
    workspace,
    capital, capitalLoading, capitalReady,
    allDays, currentDay: ctxCurrentDay,
    placeTrade: ctxPlaceTrade, placeTradePending,
    exitTrade: ctxExitTrade, exitTradePending,
    updateLtp: ctxUpdateLtp,
    refetchAll,
  } = useCapital();

  const [showNet] = useState(true);
  const tableContainerRef = useRef<HTMLDivElement>(null);
  const todayRef = useRef<HTMLTableRowElement>(null);
  const canManageTrades = supportsManualControls(workspace);

  const { getLiveLtp, subscribeOptionFeed } = useTradingDeskData({
    resolvedInstruments,
    liveTicksEnabled,
    workspace,
    capitalReady,
    allDaysLength: allDays.length,
    currentDay: ctxCurrentDay,
    updateLtp: ctxUpdateLtp,
    todayRef,
  });

  const {
    confirmDialog,
    closeConfirmDialog,
    highlightedDay,
    handlePlaceTrade,
    handleExitTrade,
    handleExitAll,
    scrollToDay,
  } = useTradingDeskHandlers({
    currentDay: ctxCurrentDay,
    ctxPlaceTrade,
    ctxExitTrade,
    subscribeOptionFeed,
    getLiveLtp,
    tableContainerRef,
  });

  if (capitalLoading) {
    return <TradingDeskSkeleton />;
  }

  if (!capitalReady) {
    return <ErrorState message="Failed to load capital data" onRetry={refetchAll} />;
  }

  const openTradeCount = allDays.find(d => d.dayIndex === capital.currentDayIndex)?.trades?.filter(t => t.status === 'OPEN').length ?? 0;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-stretch divide-x divide-border border-b border-border bg-secondary backdrop-blur-sm">
        <div className="px-3 py-1.5 flex flex-col items-center justify-center">
          <span className="text-[0.5rem] text-muted-foreground tracking-widest uppercase">Cash</span>
          <span className="text-xs font-bold tabular-nums text-info-cyan">{fmt(capital.availableCapital, true)}</span>
        </div>
        <TodayPnlBar
          pnl={capital.todayPnl}
          tradingPool={capital.tradingPool}
          exitAllEnabled={canManageTrades}
          openTradeCount={openTradeCount}
          onExitAll={handleExitAll}
        />
      </div>

      <div className="flex-1 relative overflow-hidden" style={{ contentVisibility: 'auto' }}>
        <div ref={tableContainerRef} className={`h-full overflow-y-auto overflow-x-hidden scrollbar-thin transition-opacity duration-150 ${
          workspace === 'live' ? 'scrollbar-bullish' :
          workspace === 'paper_manual' ? 'scrollbar-amber' :
          'scrollbar-violet'
        }`}>
          {allDays.length === 0 ? (
            <NoCapitalEmpty onOpenSettings={() => {
              window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2' }));
            }} />
          ) : (
            <table className="w-full table-fixed border-collapse text-xs [&_td]:align-middle [&_td]:whitespace-nowrap [&_th]:align-middle [&_th]:whitespace-nowrap [&_tbody_tr:nth-child(even)]:bg-background/50 [&_tbody_tr]:hover:bg-muted/30 [&_tbody_tr]:border-b [&_tbody_tr]:border-border">
              <colgroup>
                <col style={{ width: '2.25rem', maxWidth: '2.25rem' }} />
                <col style={{ width: '5.625rem', maxWidth: '5.625rem' }} />
                <col style={{ width: '4.5rem', maxWidth: '4.5rem' }} />
                <col style={{ width: '5.625rem', maxWidth: '5.625rem' }} />
                <col style={{ width: '4.5rem', maxWidth: '4.5rem' }} />
                <col />
                <col style={{ width: '4.5rem', maxWidth: '4.5rem' }} />
                <col style={{ width: '4.5rem', maxWidth: '4.5rem' }} />
                <col style={{ width: '2.5rem', maxWidth: '2.5rem' }} />
                <col style={{ width: '4.5rem', maxWidth: '4.5rem' }} />
                <col style={{ width: '3.625rem', maxWidth: '3.625rem' }} />
                <col style={{ width: '5.625rem', maxWidth: '5.625rem' }} />
                <col style={{ width: '3.625rem', maxWidth: '3.625rem' }} />
                <col style={{ width: '4.5rem', maxWidth: '4.5rem' }} />
                <col style={{ width: '5.625rem', maxWidth: '5.625rem' }} />
                <col style={{ width: '4rem', maxWidth: '4rem' }} />
              </colgroup>
              <thead className="sticky top-0 z-10">
                <tr className="bg-card border-b border-border uppercase">
                  <th className="px-2 py-2 text-right font-bold text-muted-foreground w-12 border-r border-border">Day</th>
                  <th className="px-2 py-2 text-right font-bold text-muted-foreground border-r border-border">Date</th>
                  <th className="px-2 py-2 text-right font-bold text-muted-foreground border-r border-border">Capital</th>
                  <th className="px-2 py-2 text-right font-bold text-muted-foreground border-r border-border">Profit+</th>
                  <th className="px-2 py-2 text-right font-bold text-muted-foreground border-r border-border">Capital+</th>
                  <th className="px-2 py-2 text-right font-bold text-muted-foreground border-r border-border">Instrument</th>
                  <th className="px-2 py-2 text-right font-bold text-muted-foreground border-r border-border">Entry</th>
                  <th className="px-2 py-2 text-right font-bold text-muted-foreground border-r border-border">LTP</th>
                  <th className="px-2 py-2 text-right font-bold text-muted-foreground border-r border-border">Lot</th>
                  <th className="px-2 py-2 text-right font-bold text-muted-foreground border-r border-border">Invested</th>
                  <th className="px-2 py-2 text-right font-bold text-muted-foreground border-r border-border">Points</th>
                  <th className="px-2 py-2 text-right font-bold text-muted-foreground border-r border-border">P&amp;L</th>
                  <th className="px-2 py-2 text-right font-bold text-muted-foreground border-r border-border">P&amp;L %</th>
                  <th className="px-2 py-2 text-right font-bold text-muted-foreground border-r border-border">Capital</th>
                  <th className="px-2 py-2 text-right font-bold text-muted-foreground border-r border-border">Dev.</th>
                  <th className="px-2 py-2 text-center font-bold text-muted-foreground w-16 border-r border-border">Rating</th>
                </tr>
              </thead>
              <tbody>
                {allDays.map((day) => {
                  const isToday = day.dayIndex === capital.currentDayIndex;
                  const isDay250 = day.dayIndex === 250;

                  if (isToday) {
                    return (
                      <TodaySection
                        key={`${workspace}-${day.dayIndex}`}
                        day={day}
                        capital={capital}
                        showNet={showNet}
                        onExitTrade={handleExitTrade}
                        onExitAll={handleExitAll}
                        onPlaceTrade={handlePlaceTrade}
                        exitLoading={exitTradePending}
                        placeLoading={placeTradePending}
                        getLiveLtp={getLiveLtp}
                        todayRef={todayRef}
                        workspace={workspace}
                        resolvedInstruments={resolvedInstruments}
                        allDays={allDays}
                      />
                    );
                  }

                  if (day.status === 'FUTURE') {
                    return (
                      <FutureRow
                        key={day.dayIndex}
                        day={day}
                        isDay250={isDay250}
                        workspace={workspace}
                        highlighted={highlightedDay === day.dayIndex}
                      />
                    );
                  }

                  return (
                    <PastRow
                      key={day.dayIndex}
                      day={day}
                      showNet={showNet}
                      workspace={workspace}
                      highlighted={highlightedDay === day.dayIndex}
                    />
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {allDays.length > 0 && (
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex flex-row gap-1 z-20">
            <button
              onClick={() => scrollToDay(capital.currentDayIndex)}
              className="px-2 py-0.5 rounded font-bold bg-card/90 border border-border/60 text-info-cyan hover:bg-info-cyan/20 hover:border-info-cyan/50 transition-colors backdrop-blur-sm"
            >
              Today
            </button>
            {[50, 100, 150, 200, 250].map((d) => (
              <button
                key={d}
                onClick={() => scrollToDay(d)}
                className="px-2 py-0.5 rounded font-bold tabular-nums bg-card/90 border border-border/60 text-muted-foreground hover:bg-warning-amber/20 hover:text-warning-amber hover:border-warning-amber/50 transition-colors backdrop-blur-sm"
              >
                {d}
              </button>
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmDialog.open}
        title={confirmDialog.title}
        message={confirmDialog.message}
        onConfirm={confirmDialog.onConfirm}
        onCancel={closeConfirmDialog}
      />
    </div>
  );
}
