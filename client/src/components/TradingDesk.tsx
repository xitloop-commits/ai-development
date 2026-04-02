/**
 * TradingDesk — The central 250-day compounding table with trade management.
 *
 * Features:
 *   - Tab bar: My Trades (LIVE) | AI Trades (PAPER)
 *   - Summary bar: Day X/250, Trade Capital, Available, Profit, Today P&L/Target, Charges, Reserve, Quarterly Proj, Net Worth
 *   - Compounding table: 16 columns, 4 row types (Past/Gift/Today/Future)
 *   - Inline new trade form
 *   - Net/Gross toggle
 *
 * Data: Wired to tRPC capital.* endpoints with mock fallbacks.
 */
import { useState, useMemo, useCallback } from 'react';
import { trpc } from '@/lib/trpc';
import {
  Plus,
  Trophy,
  Gift,
  Star,
  Flag,
  ChevronDown,
  ChevronUp,
  TrendingUp,
  TrendingDown,
  DollarSign,
  Target,
  Shield,
  BarChart3,
  Wallet,
  Loader2,
} from 'lucide-react';
import NewTradeForm from './NewTradeForm';
import { TradingDeskSkeleton, NoTradesEmpty, NoCapitalEmpty, ErrorState } from './LoadingStates';

// ─── Types ───────────────────────────────────────────────────────

type Workspace = 'live' | 'paper';
type DayStatus = 'ACTIVE' | 'COMPLETED' | 'GIFT' | 'FUTURE';
type DayRating = 'trophy' | 'double_trophy' | 'gift' | 'star' | 'future' | 'finish';

interface TradeRecord {
  id: string;
  instrument: string;
  type: string;
  strike: number | null;
  entryPrice: number;
  exitPrice: number | null;
  ltp: number;
  qty: number;
  capitalPercent: number;
  pnl: number;
  unrealizedPnl: number;
  charges: number;
  chargesBreakdown: { name: string; amount: number }[];
  status: string;
  targetPrice: number | null;
  stopLossPrice: number | null;
  openedAt: number;
  closedAt: number | null;
}

interface DayRecord {
  dayIndex: number;
  date: string;
  tradeCapital: number;
  targetPercent: number;
  targetAmount: number;
  projCapital: number;
  originalProjCapital: number;
  actualCapital: number;
  deviation: number;
  trades: TradeRecord[];
  totalPnl: number;
  totalCharges: number;
  totalQty: number;
  instruments: string[];
  status: DayStatus;
  rating: DayRating;
}

interface CapitalState {
  tradingPool: number;
  reservePool: number;
  currentDayIndex: number;
  targetPercent: number;
  availableCapital: number;
  netWorth: number;
  cumulativePnl: number;
  cumulativeCharges: number;
  todayPnl: number;
  todayTarget: number;
  quarterlyProjection: { quarterLabel: string; projectedCapital: number };
}

// ─── Fallback Mock Data ─────────────────────────────────────────

const FALLBACK_CAPITAL: CapitalState = {
  tradingPool: 75000,
  reservePool: 25000,
  currentDayIndex: 1,
  targetPercent: 5,
  availableCapital: 75000,
  netWorth: 100000,
  cumulativePnl: 0,
  cumulativeCharges: 0,
  todayPnl: 0,
  todayTarget: 3750,
  quarterlyProjection: { quarterLabel: 'Q1 FY27', projectedCapital: 0 },
};

// ─── Rating Icon ─────────────────────────────────────────────────

function RatingIcon({ rating }: { rating: DayRating }) {
  switch (rating) {
    case 'double_trophy':
      return <span className="flex gap-0.5"><Trophy className="h-3 w-3 text-warning-amber" /><Trophy className="h-3 w-3 text-warning-amber" /></span>;
    case 'trophy':
      return <Trophy className="h-3 w-3 text-bullish" />;
    case 'gift':
      return <Gift className="h-3 w-3 text-info-cyan" />;
    case 'star':
      return <Star className="h-3 w-3 text-warning-amber animate-pulse" />;
    case 'finish':
      return <Flag className="h-3 w-3 text-primary" />;
    default:
      return <span className="text-[10px] text-muted-foreground">—</span>;
  }
}

// ─── Currency Formatter ──────────────────────────────────────────

function fmt(n: number, compact = false): string {
  if (compact && Math.abs(n) >= 100000) {
    return `₹${(n / 100000).toFixed(2)}L`;
  }
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pnlColor(n: number): string {
  if (n > 0) return 'text-bullish';
  if (n < 0) return 'text-destructive';
  return 'text-muted-foreground';
}

// ─── Main Component ──────────────────────────────────────────────

export default function TradingDesk() {
  const [workspace, setWorkspace] = useState<Workspace>('live');
  const [showNewTrade, setShowNewTrade] = useState(false);
  const [expandedDay, setExpandedDay] = useState<number | null>(null);
  const [showNet, setShowNet] = useState(true);

  const utils = trpc.useUtils();

  // ─── tRPC Queries ───────────────────────────────────────────
  const stateQuery = trpc.capital.state.useQuery(
    { workspace },
    { refetchInterval: 3000, retry: 1 }
  );

  const allDaysQuery = trpc.capital.allDays.useQuery(
    { workspace, futureCount: 10 },
    { refetchInterval: 2000, retry: 1 }
  );

  // ─── tRPC Mutations ─────────────────────────────────────────
  const placeTradeMutation = trpc.capital.placeTrade.useMutation({
    onSuccess: () => {
      utils.capital.state.invalidate();
      utils.capital.allDays.invalidate();
      setShowNewTrade(false);
    },
  });

  const exitTradeMutation = trpc.capital.exitTrade.useMutation({
    onSuccess: () => {
      utils.capital.state.invalidate();
      utils.capital.allDays.invalidate();
    },
  });

  // ─── Derived Data ───────────────────────────────────────────
  const capital: CapitalState = useMemo(() => {
    if (stateQuery.data) {
      return {
        tradingPool: stateQuery.data.tradingPool,
        reservePool: stateQuery.data.reservePool,
        currentDayIndex: stateQuery.data.currentDayIndex,
        targetPercent: stateQuery.data.targetPercent,
        availableCapital: stateQuery.data.availableCapital,
        netWorth: stateQuery.data.netWorth,
        cumulativePnl: stateQuery.data.cumulativePnl,
        cumulativeCharges: stateQuery.data.cumulativeCharges,
        todayPnl: stateQuery.data.todayPnl,
        todayTarget: stateQuery.data.todayTarget,
        quarterlyProjection: stateQuery.data.quarterlyProjection,
      };
    }
    return FALLBACK_CAPITAL;
  }, [stateQuery.data]);

  const allDays: DayRecord[] = useMemo(() => {
    if (allDaysQuery.data) {
      const { pastDays, currentDay, futureDays } = allDaysQuery.data;
      return [...(pastDays as DayRecord[]), currentDay as DayRecord, ...(futureDays as DayRecord[])];
    }
    return [];
  }, [allDaysQuery.data]);

  const isLive = !!stateQuery.data;
  const isLoading = stateQuery.isLoading && !stateQuery.data;

  // ─── Handlers ───────────────────────────────────────────────
  const handlePlaceTrade = useCallback(async (trade: {
    instrument: string;
    type: 'CALL_BUY' | 'CALL_SELL' | 'PUT_BUY' | 'PUT_SELL' | 'BUY' | 'SELL';
    strike: number | null;
    entryPrice: number;
    capitalPercent: number;
  }) => {
    placeTradeMutation.mutate({
      workspace,
      instrument: trade.instrument,
      type: trade.type,
      strike: trade.strike,
      entryPrice: trade.entryPrice,
      capitalPercent: trade.capitalPercent,
    });
  }, [workspace, placeTradeMutation]);

  const handleExitTrade = useCallback(async (tradeId: string) => {
    // Find the trade to get its LTP for exit price
    const currentDay = allDaysQuery.data?.currentDay;
    const trade = currentDay?.trades?.find((t: any) => t.id === tradeId);
    const exitPrice = trade?.ltp ?? trade?.entryPrice ?? 0;

    if (exitPrice <= 0) return;

    exitTradeMutation.mutate({
      workspace,
      tradeId,
      exitPrice,
      reason: 'MANUAL',
    });
  }, [workspace, allDaysQuery.data, exitTradeMutation]);

  // ─── Loading State ──────────────────────────────────────────
  if (isLoading) {
    return <TradingDeskSkeleton />;
  }

  // ─── Error State ────────────────────────────────────────────
  if (stateQuery.isError && !stateQuery.data) {
    return (
      <ErrorState
        message={`Failed to load capital data: ${stateQuery.error?.message ?? 'Unknown error'}`}
        onRetry={() => {
          stateQuery.refetch();
          allDaysQuery.refetch();
        }}
      />
    );
  }

  // ─── Render ──────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full">
      {/* Tab Bar */}
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5 bg-card">
        <div className="flex items-center gap-1">
          {(['live', 'paper'] as const).map((ws) => (
            <button
              key={ws}
              onClick={() => setWorkspace(ws)}
              className={`px-3 py-1 rounded-t text-[10px] font-bold tracking-wider uppercase transition-colors ${
                workspace === ws
                  ? ws === 'live'
                    ? 'bg-bullish/10 text-bullish border-b-2 border-bullish'
                    : 'bg-info-cyan/10 text-info-cyan border-b-2 border-info-cyan'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {ws === 'live' ? 'My Trades' : 'AI Trades'}
              {ws === 'live' && (
                <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-bullish animate-pulse" />
              )}
            </button>
          ))}
          {/* Live data indicator */}
          <span className={`ml-2 text-[8px] tracking-wider uppercase ${isLive ? 'text-bullish' : 'text-warning-amber'}`}>
            {isLive ? 'LIVE' : 'OFFLINE'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowNet(!showNet)}
            className="text-[9px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground transition-colors"
          >
            {showNet ? 'NET' : 'GROSS'}
          </button>
          <button
            onClick={() => setShowNewTrade(true)}
            disabled={showNewTrade || placeTradeMutation.isPending}
            className="flex items-center gap-1 px-2 py-1 rounded bg-primary/10 text-primary text-[10px] font-bold hover:bg-primary/20 disabled:opacity-30 transition-colors"
          >
            {placeTradeMutation.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Plus className="h-3 w-3" />
            )}
            NEW TRADE
          </button>
        </div>
      </div>

      {/* Summary Bar */}
      <div className="grid grid-cols-9 gap-px bg-border border-b border-border">
        <SummaryCell icon={<Target className="h-3 w-3" />} label="Day" value={`${capital.currentDayIndex} / 250`} />
        <SummaryCell icon={<DollarSign className="h-3 w-3" />} label="Trade Capital" value={fmt(capital.tradingPool, true)} />
        <SummaryCell icon={<Wallet className="h-3 w-3" />} label="Available" value={fmt(capital.availableCapital, true)} accent="info-cyan" />
        <SummaryCell icon={<TrendingUp className="h-3 w-3" />} label="Cum. Profit" value={fmt(capital.cumulativePnl)} accent={capital.cumulativePnl >= 0 ? 'bullish' : 'destructive'} />
        <SummaryCell
          icon={<BarChart3 className="h-3 w-3" />}
          label="Today P&L / Target"
          value={`${fmt(capital.todayPnl)} / ${fmt(capital.todayTarget)}`}
          accent={capital.todayPnl >= capital.todayTarget ? 'bullish' : 'warning-amber'}
        />
        <SummaryCell icon={<TrendingDown className="h-3 w-3" />} label="Charges" value={fmt(capital.cumulativeCharges)} accent="destructive" />
        <SummaryCell icon={<Shield className="h-3 w-3" />} label="Reserve" value={fmt(capital.reservePool, true)} accent="info-cyan" />
        <SummaryCell icon={<BarChart3 className="h-3 w-3" />} label={capital.quarterlyProjection.quarterLabel || 'Projection'} value={fmt(capital.quarterlyProjection.projectedCapital, true)} />
        <SummaryCell icon={<DollarSign className="h-3 w-3" />} label="Net Worth" value={fmt(capital.netWorth, true)} accent="bullish" />
      </div>

      {/* Mutation Error */}
      {(placeTradeMutation.isError || exitTradeMutation.isError) && (
        <div className="px-3 py-1.5 bg-destructive/10 border-b border-destructive/20 text-[10px] text-destructive">
          {placeTradeMutation.error?.message || exitTradeMutation.error?.message}
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {allDays.length === 0 && !allDaysQuery.isLoading ? (
          <NoCapitalEmpty onOpenSettings={() => {
            // Trigger Ctrl+S programmatically
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }));
          }} />
        ) : (
          <table className="w-full text-[10px] border-collapse">
            <thead className="sticky top-0 z-10">
              <tr className="bg-secondary/80 backdrop-blur-sm border-b border-border">
                <th className="px-2 py-1.5 text-left font-medium text-muted-foreground tracking-wider uppercase w-12">Day</th>
                <th className="px-2 py-1.5 text-left font-medium text-muted-foreground tracking-wider uppercase w-20">Date</th>
                <th className="px-2 py-1.5 text-right font-medium text-muted-foreground tracking-wider uppercase">Trade Cap.</th>
                <th className="px-2 py-1.5 text-right font-medium text-muted-foreground tracking-wider uppercase">Target</th>
                <th className="px-2 py-1.5 text-right font-medium text-muted-foreground tracking-wider uppercase">Proj. Cap.</th>
                <th className="px-2 py-1.5 text-left font-medium text-muted-foreground tracking-wider uppercase">Instrument</th>
                <th className="px-2 py-1.5 text-left font-medium text-muted-foreground tracking-wider uppercase">Type</th>
                <th className="px-2 py-1.5 text-right font-medium text-muted-foreground tracking-wider uppercase">Strike</th>
                <th className="px-2 py-1.5 text-right font-medium text-muted-foreground tracking-wider uppercase">Entry</th>
                <th className="px-2 py-1.5 text-right font-medium text-muted-foreground tracking-wider uppercase">LTP</th>
                <th className="px-2 py-1.5 text-right font-medium text-muted-foreground tracking-wider uppercase">Qty</th>
                <th className="px-2 py-1.5 text-right font-medium text-muted-foreground tracking-wider uppercase">P&L</th>
                <th className="px-2 py-1.5 text-right font-medium text-muted-foreground tracking-wider uppercase">Charges</th>
                <th className="px-2 py-1.5 text-right font-medium text-muted-foreground tracking-wider uppercase">Actual Cap.</th>
                <th className="px-2 py-1.5 text-right font-medium text-muted-foreground tracking-wider uppercase">Dev.</th>
                <th className="px-2 py-1.5 text-center font-medium text-muted-foreground tracking-wider uppercase w-16">Rating</th>
              </tr>
            </thead>
            <tbody>
              {allDays.map((day) => (
                <DayRow
                  key={day.dayIndex}
                  day={day}
                  isToday={day.dayIndex === capital.currentDayIndex}
                  expanded={expandedDay === day.dayIndex}
                  onToggle={() => setExpandedDay(expandedDay === day.dayIndex ? null : day.dayIndex)}
                  onExitTrade={handleExitTrade}
                  showNet={showNet}
                  exitLoading={exitTradeMutation.isPending}
                />
              ))}
              {showNewTrade && (
                <NewTradeForm
                  workspace={workspace}
                  availableCapital={capital.availableCapital}
                  instruments={['NIFTY 50', 'BANK NIFTY', 'CRUDE OIL', 'NATURAL GAS']}
                  onSubmit={handlePlaceTrade}
                  onCancel={() => setShowNewTrade(false)}
                  loading={placeTradeMutation.isPending}
                />
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ─── Summary Cell ────────────────────────────────────────────────

function SummaryCell({
  icon,
  label,
  value,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  accent?: string;
}) {
  const colorClass = accent
    ? `text-${accent}`
    : 'text-foreground';

  return (
    <div className="bg-card px-2 py-1.5 flex flex-col items-center justify-center">
      <div className="flex items-center gap-1 text-muted-foreground mb-0.5">
        {icon}
        <span className="text-[8px] uppercase tracking-wider">{label}</span>
      </div>
      <span className={`text-[11px] font-bold tabular-nums ${colorClass}`}>{value}</span>
    </div>
  );
}

// ─── Day Row ─────────────────────────────────────────────────────

function DayRow({
  day,
  isToday,
  expanded,
  onToggle,
  onExitTrade,
  showNet,
  exitLoading,
}: {
  day: DayRecord;
  isToday: boolean;
  expanded: boolean;
  onToggle: () => void;
  onExitTrade: (tradeId: string) => void;
  showNet: boolean;
  exitLoading?: boolean;
}) {
  const rowBg = isToday
    ? 'bg-primary/5 border-l-2 border-l-primary'
    : day.status === 'COMPLETED'
    ? 'bg-card hover:bg-secondary/30'
    : day.status === 'GIFT'
    ? 'bg-info-cyan/5'
    : 'bg-card/50 opacity-60';

  const hasTrades = day.trades.length > 0;

  // Summary instrument display
  const instrumentSummary = day.instruments.length > 0
    ? day.instruments.join(', ')
    : '—';

  // Aggregate trade info for the summary row
  const tradeTypeSummary = hasTrades
    ? `${day.trades.length} trade${day.trades.length > 1 ? 's' : ''}`
    : '—';

  return (
    <>
      {/* Main Day Row */}
      <tr
        className={`border-b border-border/50 ${rowBg} transition-colors cursor-pointer`}
        onClick={hasTrades ? onToggle : undefined}
      >
        {/* Day Index */}
        <td className="px-2 py-2">
          <div className="flex items-center gap-1">
            {hasTrades && (
              expanded
                ? <ChevronUp className="h-3 w-3 text-muted-foreground" />
                : <ChevronDown className="h-3 w-3 text-muted-foreground" />
            )}
            <span className={`font-bold tabular-nums ${isToday ? 'text-primary' : 'text-foreground'}`}>
              {day.dayIndex}
            </span>
          </div>
        </td>
        {/* Date */}
        <td className="px-2 py-2 text-muted-foreground tabular-nums">
          {day.date || '—'}
        </td>
        {/* Trade Capital */}
        <td className="px-2 py-2 text-right tabular-nums text-foreground">
          {fmt(day.tradeCapital, true)}
        </td>
        {/* Target */}
        <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
          {fmt(day.targetAmount)}
          <span className="text-[8px] ml-0.5">({day.targetPercent}%)</span>
        </td>
        {/* Proj Capital */}
        <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
          {fmt(day.projCapital, true)}
        </td>
        {/* Instrument */}
        <td className="px-2 py-2 text-foreground">
          {instrumentSummary}
        </td>
        {/* Type */}
        <td className="px-2 py-2 text-muted-foreground">
          {tradeTypeSummary}
        </td>
        {/* Strike */}
        <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">—</td>
        {/* Entry */}
        <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">—</td>
        {/* LTP */}
        <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">—</td>
        {/* Qty */}
        <td className="px-2 py-2 text-right tabular-nums text-foreground">
          {day.totalQty > 0 ? day.totalQty : '—'}
        </td>
        {/* P&L */}
        <td className={`px-2 py-2 text-right tabular-nums font-bold ${pnlColor(day.totalPnl)}`}>
          {day.status !== 'FUTURE' ? fmt(showNet ? day.totalPnl : day.totalPnl + day.totalCharges) : '—'}
        </td>
        {/* Charges */}
        <td className="px-2 py-2 text-right tabular-nums text-destructive/70">
          {day.totalCharges > 0 ? fmt(day.totalCharges) : '—'}
        </td>
        {/* Actual Capital */}
        <td className={`px-2 py-2 text-right tabular-nums font-medium ${
          day.status === 'FUTURE' ? 'text-muted-foreground' : 'text-foreground'
        }`}>
          {day.actualCapital > 0 ? fmt(day.actualCapital, true) : '—'}
        </td>
        {/* Deviation */}
        <td className={`px-2 py-2 text-right tabular-nums ${pnlColor(day.deviation)}`}>
          {day.status !== 'FUTURE' && day.actualCapital > 0
            ? `${day.deviation >= 0 ? '+' : ''}${fmt(day.deviation)}`
            : '—'}
        </td>
        {/* Rating */}
        <td className="px-2 py-2 text-center">
          <RatingIcon rating={day.rating} />
        </td>
      </tr>

      {/* Expanded Trade Rows */}
      {expanded && hasTrades && (
        <>
          {day.trades.map((trade) => (
            <TradeRow
              key={trade.id}
              trade={trade}
              onExit={() => onExitTrade(trade.id)}
              showNet={showNet}
              exitLoading={exitLoading}
            />
          ))}
        </>
      )}
    </>
  );
}

// ─── Trade Row (expanded sub-row) ────────────────────────────────

function TradeRow({
  trade,
  onExit,
  showNet,
  exitLoading,
}: {
  trade: TradeRecord;
  onExit: () => void;
  showNet: boolean;
  exitLoading?: boolean;
}) {
  const isOpen = trade.status === 'OPEN';
  const isBuy = trade.type.includes('BUY');
  const pnl = isOpen ? trade.unrealizedPnl : (showNet ? trade.pnl : trade.pnl + trade.charges);
  const pnlPercent = trade.entryPrice > 0
    ? ((isOpen ? trade.unrealizedPnl : trade.pnl) / (trade.entryPrice * trade.qty) * 100)
    : 0;

  return (
    <tr className="border-b border-border/30 bg-secondary/10 hover:bg-secondary/20 transition-colors">
      {/* Day */}
      <td className="px-2 py-1.5 pl-8">
        <span className="text-[8px] text-muted-foreground">↳</span>
      </td>
      {/* Date */}
      <td className="px-2 py-1.5 text-[9px] text-muted-foreground tabular-nums">
        {new Date(trade.openedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
      </td>
      {/* Trade Capital */}
      <td className="px-2 py-1.5" />
      {/* Target */}
      <td className="px-2 py-1.5" />
      {/* Proj Capital */}
      <td className="px-2 py-1.5" />
      {/* Instrument */}
      <td className="px-2 py-1.5 text-foreground font-medium">{trade.instrument}</td>
      {/* Type */}
      <td className="px-2 py-1.5">
        <span className={`inline-flex items-center gap-0.5 font-bold ${isBuy ? 'text-bullish' : 'text-destructive'}`}>
          {isBuy ? <TrendingUp className="h-2.5 w-2.5" /> : <TrendingDown className="h-2.5 w-2.5" />}
          {trade.type.replace('_', ' ')}
        </span>
      </td>
      {/* Strike */}
      <td className="px-2 py-1.5 text-right tabular-nums text-foreground">
        {trade.strike ?? '—'}
      </td>
      {/* Entry */}
      <td className="px-2 py-1.5 text-right tabular-nums text-foreground">
        {trade.entryPrice.toFixed(2)}
      </td>
      {/* LTP */}
      <td className={`px-2 py-1.5 text-right tabular-nums font-medium ${
        isOpen ? (trade.ltp >= trade.entryPrice ? 'text-bullish' : 'text-destructive') : 'text-muted-foreground'
      }`}>
        {isOpen ? trade.ltp.toFixed(2) : (trade.exitPrice?.toFixed(2) ?? '—')}
      </td>
      {/* Qty */}
      <td className="px-2 py-1.5 text-right tabular-nums text-foreground">{trade.qty}</td>
      {/* P&L */}
      <td className={`px-2 py-1.5 text-right tabular-nums font-bold ${pnlColor(pnl)}`}>
        {fmt(pnl)}
        <span className="text-[8px] ml-0.5">({pnlPercent >= 0 ? '+' : ''}{pnlPercent.toFixed(1)}%)</span>
      </td>
      {/* Charges */}
      <td className="px-2 py-1.5 text-right tabular-nums text-destructive/70">
        {trade.charges > 0 ? fmt(trade.charges) : '—'}
      </td>
      {/* Actual Capital */}
      <td className="px-2 py-1.5" />
      {/* Deviation */}
      <td className="px-2 py-1.5" />
      {/* Rating / Actions */}
      <td className="px-2 py-1.5 text-center">
        {isOpen ? (
          <button
            onClick={(e) => { e.stopPropagation(); onExit(); }}
            disabled={exitLoading}
            className="px-1.5 py-0.5 rounded text-[8px] font-bold bg-destructive/10 text-destructive hover:bg-destructive/20 disabled:opacity-30 transition-colors"
            title="Exit position"
          >
            {exitLoading ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : 'EXIT'}
          </button>
        ) : (
          <span className="text-[8px] text-muted-foreground uppercase">
            {trade.status.replace('CLOSED_', '')}
          </span>
        )}
      </td>
    </tr>
  );
}
