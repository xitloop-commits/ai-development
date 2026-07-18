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
import { useState, useRef, useCallback, useMemo } from 'react';
import { useCapital } from '@/contexts/CapitalContext';
import { TodayPnlBar } from './TodayPnlBar';
import { TradeFilterBar, EMPTY_TRADE_FILTER, type TradeFilter } from './TradeFilterBar';
import { TradingDeskSkeleton, NoCapitalEmpty, ErrorState } from './LoadingStates';
import type { ResolvedInstrument } from '@/lib/tradeTypes';
import { channelToWorkspace } from '@/lib/tradeTypes';
import { supportsManualControls } from '@/lib/tradeThemes';
import { fmt } from '@/lib/tradeFormatters';
import { ConfirmDialog } from './ConfirmDialog';
import { PastRow } from './PastRow';
import { FutureRow } from './FutureRow';
import { TodaySection } from './TodaySection';
import { InstrumentBarsPanel } from './InstrumentBarsPanel';
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
    channel,
    capital, capitalLoading, capitalReady,
    allDays, currentDay: ctxCurrentDay,
    placeTrade: ctxPlaceTrade, placeTradePending,
    exitTrade: ctxExitTrade, exitTradePending,
    updateLtp: ctxUpdateLtp,
    refetchAll,
  } = useCapital();
  const workspace = channelToWorkspace(channel);

  const [showNet, setShowNet] = useState(true);
  // Client-only view filter for today's trade rows (right of the P&L bar).
  const [tradeFilter, setTradeFilter] = useState<TradeFilter>(EMPTY_TRADE_FILTER);
  // The always-on instrument bars now live in a draggable floating window.
  const [barsPanelOpen, setBarsPanelOpen] = useState(true);
  const [expandedDays, setExpandedDays] = useState<Set<number>>(() => new Set());
  const toggleExpand = useCallback((dayIndex: number) => {
    setExpandedDays((prev) => {
      const next = new Set(prev);
      if (next.has(dayIndex)) next.delete(dayIndex);
      else next.add(dayIndex);
      return next;
    });
  }, []);
  const tableContainerRef = useRef<HTMLDivElement>(null);
  const todayRef = useRef<HTMLTableRowElement>(null);
  const canManageTrades = supportsManualControls(channel);

  const { getLiveLtp, subscribeOptionFeed } = useTradingDeskData({
    resolvedInstruments,
    liveTicksEnabled,
    channel,
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
    exitingTradeId,
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
    channel,
  });

  // Distinct instruments + cohorts traded today — populate the filter's options.
  // MUST stay above the early returns below so hook order never changes.
  const { todayInstruments, todayCohorts, todayStrategies } = useMemo(() => {
    const t = allDays.find((d) => d.dayIndex === capital?.currentDayIndex)?.trades ?? [];
    // Only surface the strategy filter once the race is actually running (>1
    // distinct strategy today) — a single-strategy day keeps the bar clean.
    const STRAT_ORDER = ['sprint', 'runway', 'anchor'];
    const strats = Array.from(
      new Set(t.map((x) => x.exitStrategy).filter((s): s is string => !!s)),
    ).sort((a, b) => STRAT_ORDER.indexOf(a) - STRAT_ORDER.indexOf(b));
    return {
      todayInstruments: Array.from(new Set(t.map((x) => x.instrument))),
      todayCohorts: Array.from(
        new Set(t.map((x) => x.cohort).filter((c): c is string => !!c)),
      ),
      todayStrategies: strats.length > 1 ? strats : [],
    };
  }, [allDays, capital?.currentDayIndex]);

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
        {/* Net/Gross P&L toggle moved to the P&L column header of the table. */}
        {canManageTrades && (
          <button
            type="button"
            onClick={() => setBarsPanelOpen((v) => !v)}
            className="px-3 py-1.5 flex flex-col items-center justify-center hover:bg-muted/40 transition-colors"
            title="Toggle the movable instrument-bars window"
          >
            <span className="text-[0.5rem] text-muted-foreground tracking-widest uppercase">Bars</span>
            <span className="text-xs font-bold tabular-nums text-foreground">{barsPanelOpen ? 'On' : 'Off'}</span>
          </button>
        )}
        <TodayPnlBar
          pnl={capital.todayPnl}
          tradingPool={capital.tradingPool}
          exitAllEnabled={canManageTrades}
          openTradeCount={openTradeCount}
          onExitAll={handleExitAll}
        />
        <TradeFilterBar
          value={tradeFilter}
          onChange={setTradeFilter}
          instruments={todayInstruments}
          cohorts={todayCohorts}
          strategies={todayStrategies}
        />
      </div>

      <div className="flex-1 relative overflow-hidden" style={{ contentVisibility: 'auto' }}>
        <div ref={tableContainerRef} className={`h-full overflow-y-auto overflow-x-hidden scrollbar-thin transition-opacity duration-150 ${
          workspace === 'my' ? 'scrollbar-bullish' :
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
                <col style={{ width: '4rem', maxWidth: '4rem' }} />
                <col style={{ width: '4.5rem', maxWidth: '4.5rem' }} />
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
                  <th className="px-2 py-2 text-right font-bold text-muted-foreground border-r border-border">Charges</th>
                  <th className="px-2 py-2 text-right font-bold text-muted-foreground border-r border-border">Points</th>
                  <th className="px-2 py-2 text-right font-bold text-muted-foreground border-r border-border">
                    <button
                      type="button"
                      onClick={() => setShowNet((v) => !v)}
                      className="inline-flex items-center gap-1 font-bold uppercase hover:text-foreground transition-colors cursor-pointer"
                      title={showNet ? 'P&L is NET of charges — click for gross' : 'P&L is GROSS (before charges) — click for net'}
                    >
                      <span className={`text-[0.5rem] normal-case rounded px-1 py-0.5 ${showNet ? 'bg-bullish/20 text-bullish' : 'bg-warning-amber/20 text-warning-amber'}`}>
                        {showNet ? 'Net' : 'Gross'}
                      </span>
                      P&amp;L
                    </button>
                  </th>
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
                        key={`${channel}-${day.dayIndex}`}
                        day={day}
                        capital={capital}
                        showNet={showNet}
                        onExitTrade={handleExitTrade}
                        onExitAll={handleExitAll}
                        onPlaceTrade={handlePlaceTrade}
                        exitLoading={exitTradePending}
                        exitingTradeId={exitingTradeId}
                        placeLoading={placeTradePending}
                        getLiveLtp={getLiveLtp}
                        todayRef={todayRef}
                        channel={channel}
                        allDays={allDays}
                        filter={tradeFilter}
                      />
                    );
                  }

                  if (day.status === 'FUTURE') {
                    return (
                      <FutureRow
                        key={day.dayIndex}
                        day={day}
                        isDay250={isDay250}
                        channel={channel}
                        highlighted={highlightedDay === day.dayIndex}
                      />
                    );
                  }

                  return (
                    <PastRow
                      key={day.dayIndex}
                      day={day}
                      showNet={showNet}
                      channel={channel}
                      highlighted={highlightedDay === day.dayIndex}
                      expanded={expandedDays.has(day.dayIndex)}
                      onToggleExpand={toggleExpand}
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

      {/* Always-on instrument bars — draggable floating window (moved out of the table). */}
      {canManageTrades && barsPanelOpen && (
        <InstrumentBarsPanel
          resolvedInstruments={resolvedInstruments}
          trades={ctxCurrentDay?.trades ?? []}
          onPlaceTrade={handlePlaceTrade}
          onClose={() => setBarsPanelOpen(false)}
        />
      )}
    </div>
  );
}
