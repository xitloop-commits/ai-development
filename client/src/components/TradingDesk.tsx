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
import { trpc } from '@/lib/trpc';
import { TodayPnlBar } from './TodayPnlBar';
import { TradeFilterBar, EMPTY_TRADE_FILTER, type TradeFilter } from './TradeFilterBar';
import { AiControl } from './AiControl';
import { MyTradesControl } from './MyTradesControl';
import { SettingsMenu } from './SettingsMenu';
import { TradingDeskSkeleton, NoCapitalEmpty, ErrorState } from './LoadingStates';
import type { ResolvedInstrument } from '@/lib/tradeTypes';
import { channelToWorkspace } from '@/lib/tradeTypes';
import { supportsManualControls } from '@/lib/tradeThemes';
import { fmt } from '@/lib/tradeFormatters';
import { ConfirmDialog } from './ConfirmDialog';
import { PastRow } from './PastRow';
import { FutureRow } from './FutureRow';
import { TodaySection } from './TodaySection';
import { useSelectedRunId, setSelectedRunId } from '@/lib/replaySelection';
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

  // ── Replay-run view (T97) ────────────────────────────────────────
  // A selected run replaces the whole day list with ONE synthetic day holding
  // that run's trades, so every existing row/filter/summary component is reused
  // unchanged. Read-only: these trades belong to an experiment, and exiting one
  // would route the call to a real channel.
  const selectedRunId = useSelectedRunId();
  const runQuery = trpc.replay.run.useQuery(
    { runId: selectedRunId ?? '' },
    { enabled: !!selectedRunId, refetchInterval: selectedRunId ? 4000 : false },
  );
  const run = selectedRunId ? runQuery.data : null;

  // CLEAR — wipe this book's pool back to its opening funding. Paper only; it
  // moved off the app bar into the day-jump bar (T130) so a destructive control
  // isn't sitting permanently in the chrome. clearWorkspace resets the channel.
  const utils = trpc.useUtils();
  const clearWorkspaceMutation = trpc.portfolio.clearWorkspace.useMutation({
    onSuccess: () => { void utils.portfolio.allDays.invalidate(); refetchAll?.(); },
  });
  const canClear = channel === 'paper' && !run;

  /**
   * What the table actually renders. Normally the live book; with a run selected,
   * ONE synthetic day carrying that run's trades — so PastRow / TodaySection /
   * the filters / the summary all work unchanged rather than needing a parallel
   * "replay desk".
   */
  const { viewDays, viewCapital } = useMemo(() => {
    if (!run) return { viewDays: allDays, viewCapital: capital };
    const trades = run.trades ?? [];
    const totalPnl = trades.reduce(
      (s: number, t: any) => s + (t.status === 'OPEN' ? (t.unrealizedPnl ?? 0) : (t.pnl ?? 0)),
      0,
    );
    const totalCharges = trades.reduce((s: number, t: any) => s + (t.charges ?? 0), 0);
    const cap = run.openingCapital ?? 100000;
    const day: any = {
      dayIndex: 1,
      date: run.date,
      tradeCapital: cap,
      targetPercent: 0,
      targetAmount: 0,           // a run has no target — it isn't chasing one
      projCapital: cap,
      originalProjCapital: cap,
      actualCapital: cap + totalPnl,
      deviation: 0,
      trades,
      totalPnl,
      totalCharges,
      totalQty: trades.reduce((s: number, t: any) => s + Math.abs(t.qty ?? 0), 0),
      instruments: Array.from(new Set(trades.map((t: any) => t.instrument))),
      status: 'ACTIVE',
      rating: 'future',
      channel,
    };
    return {
      viewDays: [day],
      viewCapital: { ...capital, currentDayIndex: 1, tradingPool: cap, netWorth: cap + totalPnl },
    };
  }, [run, allDays, capital, channel]);

  // Distinct instruments + cohorts traded today — populate the filter's options.
  // MUST stay above the early returns below so hook order never changes.
  const { todayInstruments, todayCohorts, todayStrategies, todayExitReasons } = useMemo(() => {
    const t = allDays.find((d) => d.dayIndex === capital?.currentDayIndex)?.trades ?? [];
    // Only surface the strategy filter once the race is actually running (>1
    // distinct strategy today) — a single-strategy day keeps the bar clean.
    const STRAT_ORDER = ['sprint', 'runway', 'anchor', 'glide'];
    const strats = Array.from(
      new Set(t.map((x) => x.exitStrategy).filter((s): s is string => !!s)),
    ).sort((a, b) => STRAT_ORDER.indexOf(a) - STRAT_ORDER.indexOf(b));
    return {
      todayInstruments: Array.from(new Set(t.map((x) => x.instrument))),
      todayCohorts: Array.from(
        new Set(t.map((x) => x.cohort).filter((c): c is string => !!c)),
      ),
      todayStrategies: strats.length > 1 ? strats : [],
      // Exit reasons actually seen today — ordered most-common first so the
      // reason you're most likely to filter on sits leftmost.
      todayExitReasons: Object.entries(
        t.reduce<Record<string, number>>((acc, x) => {
          if (x.exitReason) acc[x.exitReason] = (acc[x.exitReason] ?? 0) + 1;
          return acc;
        }, {}),
      ).sort((a, b) => b[1] - a[1]).map(([r]) => r),
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
      <div className="relative z-30 flex items-stretch divide-x divide-border border-b border-border bg-secondary backdrop-blur-sm">
        <div className="px-3 py-1.5 flex flex-col items-center justify-center">
          <span className="text-[0.5rem] text-muted-foreground tracking-widest uppercase">Cash</span>
          <span className="text-xs font-bold tabular-nums text-info-cyan">{fmt(capital.availableCapital, true)}</span>
        </div>
        {/* Net/Gross P&L toggle moved to the P&L column header of the table. */}
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
          exitReasons={todayExitReasons}
        />
        {/* T130 — the config menus live beside the filter, on the table they
            govern, rather than up in the app-bar chrome. Pushed to the right so
            they sit at the trailing edge of the header row. */}
        <div className="ml-auto flex items-stretch divide-x divide-border">
          <AiControl />
          <MyTradesControl />
          <SettingsMenu />
        </div>
      </div>

      {/* No `content-visibility: auto` here. It applies containment (size
          containment when the box is off-screen), which collapses the box the
          table resolves its `width: 100%` against — the table then rendered
          narrower than the top bar it sits under, leaving dead space after the
          Rating column. The scroll perf it bought is not worth a table that
          doesn't fill. */}
      {/* Unmissable banner while a run is on the desk. Without it the desk looks
          like the live book showing unfamiliar numbers — the worst possible
          ambiguity on a trading screen. */}
      {run && (
        <div className="shrink-0 flex items-center gap-2 px-3 py-1 bg-info-cyan/15 border-b border-info-cyan/40">
          <span className="text-[0.5625rem] font-bold uppercase tracking-wider text-info-cyan">Replay run</span>
          <span className="text-[0.625rem] font-bold text-foreground">{run.runId}</span>
          <span className="text-[0.5rem] text-muted-foreground">
            {run.date} · {run.tradeCount} trades ·{' '}
            {Object.entries(run.models ?? {}).map(([k, v]) => `${k} ${v}`).join(' · ') || 'model n/a'}
          </span>
          <button
            type="button"
            onClick={() => setSelectedRunId(null)}
            className="ml-auto px-1.5 py-0.5 rounded text-[0.5625rem] font-bold bg-info-cyan/20 text-info-cyan hover:bg-info-cyan/30"
          >
            Back to live book
          </button>
        </div>
      )}

      <div className="flex-1 relative overflow-hidden w-full">
        <div ref={tableContainerRef} className={`h-full w-full overflow-y-auto overflow-x-hidden scrollbar-thin bg-card transition-opacity duration-150 ${
          workspace === 'my' ? 'scrollbar-bullish' :
          'scrollbar-violet'
        }`}>
          {allDays.length === 0 ? (
            <NoCapitalEmpty onOpenSettings={() => {
              window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2' }));
            }} />
          ) : (
            <table className="w-full table-fixed border-collapse text-xs [&_td]:align-middle [&_td]:whitespace-nowrap [&_th]:align-middle [&_th]:whitespace-nowrap [&_tbody_tr:nth-child(even)]:bg-muted/40 [&_tbody_tr]:hover:bg-muted/70 [&_tbody_tr]:border-b [&_tbody_tr]:border-border">
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
                  <th className="px-2 py-2 text-center font-bold text-muted-foreground w-16 border-r border-border">Rating</th>
                </tr>
              </thead>
              <tbody>
                {viewDays.map((day) => {
                  const isToday = day.dayIndex === viewCapital.currentDayIndex;
                  const isDay250 = day.dayIndex === 250;

                  if (isToday) {
                    return (
                      <TodaySection
                        key={`${channel}-${day.dayIndex}`}
                        day={day}
                        capital={viewCapital}
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
                        allDays={viewDays}
                        filter={tradeFilter}
                        readOnly={!!run}
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
          // T130 — hidden until you hover the bottom-centre; it is a navigation
          // aid, not something to look at all day. `opacity-0` elements are still
          // hoverable, and focus-within keeps it up while a button has keyboard
          // focus. CLEAR lives here now (paper only) rather than on the app bar.
          <div className="group absolute bottom-0 left-1/2 -translate-x-1/2 pb-3 pt-6 z-20 flex flex-row gap-1 opacity-0 hover:opacity-100 focus-within:opacity-100 transition-opacity duration-150">
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
            {canClear && (
              <button
                onClick={() => clearWorkspaceMutation.mutate({ channel: channel as any, initialFunding: 100000 })}
                disabled={clearWorkspaceMutation.isPending}
                className="px-2 py-0.5 rounded font-bold bg-card/90 border border-destructive/40 text-destructive hover:bg-destructive/15 transition-colors backdrop-blur-sm disabled:opacity-50"
                title="Reset the paper pool to its opening funding"
              >
                {clearWorkspaceMutation.isPending ? '…' : 'CLEAR'}
              </button>
            )}
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
