/**
 * TradingDesk — The central 250-day compounding table with trade management.
 *
 * Features:
 *   - Tab bar: My Trades (LIVE) | Manual Paper (PAPER) | AI Trades (PAPER)
 *   - Summary bar: Day X/250, Trade Capital, Available, Profit, Today P&L/Target + Exit All,
 *                  Charges, Reserve, Quarterly Proj, NET/GROSS toggle, Net Worth
 *   - Compounding table: 15 columns, flat (no expand/collapse)
 *   - Inline new trade form (always visible for today)
 *   - Today summary row (DAY N TOTAL)
 *   - Status badges, TP/SL sub-text, date age, instrument tags, confirmation prompts
 *
 * Data: Wired to tRPC capital.* endpoints with mock fallbacks.
 */
import { Fragment, useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useCapital } from '@/contexts/CapitalContext';
import { formatINR, formatPrice as fmtPrice } from '@/lib/formatINR';
import {
  TrendingUp,
  TrendingDown,
  Loader2,
} from 'lucide-react';
import NewTradeForm from './NewTradeForm';
import { TradingDeskSkeleton, NoCapitalEmpty, ErrorState } from './LoadingStates';
import { useTickStream } from '@/hooks/useTickStream';

// ─── Types ───────────────────────────────────────────────────────

type Workspace = 'live' | 'paper_manual' | 'paper';
type DayStatus = 'ACTIVE' | 'COMPLETED' | 'GIFT' | 'FUTURE';
type DayRating = 'trophy' | 'double_trophy' | 'crown' | 'jackpot' | 'gift' | 'star' | 'future' | 'finish';

interface TradeRecord {
  id: string;
  instrument: string;
  type: string;
  strike: number | null;
  expiry?: string | null;
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
  openedAt?: number;
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
  quarterlyProjection: { quarterLabel: 'Q1', projectedCapital: 0 },
};

// ─── Instrument Colors ──────────────────────────────────────────

const INSTRUMENT_COLORS: Record<string, { bg: string; text: string }> = {
  'NIFTY 50': { bg: 'bg-blue-500/15', text: 'text-blue-400' },
  'BANK NIFTY': { bg: 'bg-purple-500/15', text: 'text-purple-400' },
  'CRUDE OIL': { bg: 'bg-amber-500/15', text: 'text-amber-400' },
  'NATURAL GAS': { bg: 'bg-emerald-500/15', text: 'text-emerald-400' },
};

function getInstrumentStyle(name: string) {
  return INSTRUMENT_COLORS[name] ?? { bg: 'bg-slate-500/15', text: 'text-slate-400' };
}

function supportsManualControls(workspace: Workspace): boolean {
  return workspace === 'live' || workspace === 'paper_manual';
}

function getWorkspaceBadgeMeta(workspace: Workspace): { label: string; className: string } {
  switch (workspace) {
    case 'live':
      return { label: 'LIVE', className: 'bg-bullish/20 text-bullish' };
    case 'paper_manual':
      return { label: 'MANUAL PAPER', className: 'bg-warning-amber/20 text-warning-amber' };
    default:
      return { label: 'AI PAPER', className: 'bg-info-cyan/20 text-info-cyan' };
  }
}

function getWorkspaceThemeMeta(workspace: Workspace): {
  text: string;
  textSoft: string;
  textDim: string;
  rowBg: string;
  rowBgHover: string;
  todayBg: string;
  todayAltBg: string;
  summaryBg: string;
  summaryBorder: string;
  borderStrong: string;
  borderSoft: string;
  button: string;
  buttonActive: string;
} {
  switch (workspace) {
    case 'live':
      return {
        text: 'text-bullish',
        textSoft: 'text-bullish/80',
        textDim: 'text-bullish/60',
        rowBg: 'bg-bullish/[0.04]',
        rowBgHover: 'hover:bg-bullish/[0.08]',
        todayBg: 'bg-bullish/[0.08]',
        todayAltBg: 'bg-bullish/[0.04]',
        summaryBg: 'bg-bullish/10',
        summaryBorder: 'border-bullish/30',
        borderStrong: 'border-l-bullish',
        borderSoft: 'border-l-bullish/50',
        button: 'bg-bullish/15 text-bullish hover:bg-bullish/25',
        buttonActive: 'bg-bullish/20 text-bullish',
      };
    case 'paper_manual':
      return {
        text: 'text-warning-amber',
        textSoft: 'text-warning-amber/80',
        textDim: 'text-warning-amber/60',
        rowBg: 'bg-warning-amber/[0.04]',
        rowBgHover: 'hover:bg-warning-amber/[0.08]',
        todayBg: 'bg-warning-amber/[0.08]',
        todayAltBg: 'bg-warning-amber/[0.04]',
        summaryBg: 'bg-warning-amber/10',
        summaryBorder: 'border-warning-amber/30',
        borderStrong: 'border-l-warning-amber',
        borderSoft: 'border-l-warning-amber/50',
        button: 'bg-warning-amber/15 text-warning-amber hover:bg-warning-amber/25',
        buttonActive: 'bg-warning-amber/20 text-warning-amber',
      };
    default:
      return {
        text: 'text-info-cyan',
        textSoft: 'text-info-cyan/80',
        textDim: 'text-info-cyan/60',
        rowBg: 'bg-info-cyan/[0.04]',
        rowBgHover: 'hover:bg-info-cyan/[0.08]',
        todayBg: 'bg-info-cyan/[0.08]',
        todayAltBg: 'bg-info-cyan/[0.04]',
        summaryBg: 'bg-info-cyan/10',
        summaryBorder: 'border-info-cyan/30',
        borderStrong: 'border-l-info-cyan',
        borderSoft: 'border-l-info-cyan/50',
        button: 'bg-info-cyan/15 text-info-cyan hover:bg-info-cyan/25',
        buttonActive: 'bg-info-cyan/20 text-info-cyan',
      };
  }
}

// ─── Rating Icon ─────────────────────────────────────────────────

function RatingIcon({ rating }: { rating: DayRating }) {
  switch (rating) {
    case 'jackpot':
      return <span className="text-[11px]" title="≥50% Jackpot">🏆🏆👑💰</span>;
    case 'crown':
      return <span className="text-[11px]" title="≥20% Crown">🏆👑</span>;
    case 'double_trophy':
      return <span className="text-[11px]" title="≥10%">🏆🏆</span>;
    case 'trophy':
      return <span className="text-[11px]" title="≥5% Single Day">🏆</span>;
    case 'star':
      return <span className="text-[11px]" title="≥5% Multi-Day">⭐</span>;
    case 'gift':
      return <span className="text-[11px]" title="Auto-completed">🎁</span>;
    case 'finish':
      return <span className="text-[11px]" title="Day 250">🏁</span>;
    default:
      return <span className="text-[11px] opacity-40">⬜</span>;
  }
}

// ─── Currency Formatter ──────────────────────────────────────────

function fmt(n: number, _compact = false): string {
  return formatINR(n);
}

function pnlColor(n: number): string {
  if (n > 0) return 'text-bullish';
  if (n < 0) return 'text-destructive';
  return 'text-muted-foreground';
}

// ─── Age Formatter ───────────────────────────────────────────────

function formatAge(openedAt?: number): string {
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

function formatCalendarDay(timestamp: number = Date.now()): string {
  return new Date(timestamp).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

function formatExpiryLabel(expiry?: string | null): string {
  if (!expiry) return '';
  const time = new Date(`${expiry}T00:00:00`).getTime();
  if (Number.isNaN(time)) return expiry;
  return formatCalendarDay(time);
}

function formatDateAgeLabel(dateLabel: string, openedAt?: number): string {
  const age = formatAge(openedAt);
  return age ? `${dateLabel} | ${age}` : dateLabel;
}

function getTradeDirectionLabel(type: string): 'B' | 'S' | '—' {
  if (type.includes('SELL')) return 'S';
  if (type.includes('BUY')) return 'B';
  return '—';
}

function getTradeContractLabel(type: string): 'CE' | 'PE' | 'DIR' {
  if (type.startsWith('CALL_')) return 'CE';
  if (type.startsWith('PUT_')) return 'PE';
  return 'DIR';
}

// ─── Deviation Formatter ─────────────────────────────────────────

function formatDeviation(deviation: number, daysAhead?: number): string {
  const sign = deviation >= 0 ? '+' : '';
  const daysStr = daysAhead !== undefined ? ` (${daysAhead >= 0 ? '+' : ''}${daysAhead}d)` : '';
  return `${sign}${fmt(deviation)}${daysStr}`;
}

function calculatePotentialPnl(trade: TradeRecord, price: number): number {
  const isBuy = trade.type.includes('BUY');
  return (isBuy ? (price - trade.entryPrice) : (trade.entryPrice - price)) * trade.qty;
}

function calculateOpenRisk(trades: TradeRecord[]): number {
  return trades.reduce((sum, trade) => {
    if (trade.stopLossPrice === null) return sum;
    return sum + Math.max(0, -calculatePotentialPnl(trade, trade.stopLossPrice));
  }, 0);
}

function calculateOpenReward(trades: TradeRecord[]): number {
  return trades.reduce((sum, trade) => {
    if (trade.targetPrice === null) return sum;
    return sum + Math.max(0, calculatePotentialPnl(trade, trade.targetPrice));
  }, 0);
}

function calculateOpenMargin(trades: TradeRecord[]): number {
  return trades.reduce((sum, trade) => {
    if (trade.status !== 'OPEN') return sum;
    return sum + (trade.entryPrice * trade.qty);
  }, 0);
}

function countTradeOutcomes(trades: TradeRecord[]): { wins: number; losses: number } {
  return trades.reduce((acc, trade) => {
    if (trade.status === 'OPEN' || trade.status === 'PENDING' || trade.status === 'CANCELLED') {
      return acc;
    }
    if (trade.pnl > 0) acc.wins += 1;
    else if (trade.pnl < 0) acc.losses += 1;
    return acc;
  }, { wins: 0, losses: 0 });
}

// ─── Instrument Name Mapping ────────────────────────────────────

const UI_TO_RESOLVED: Record<string, string> = {
  'NIFTY 50': 'NIFTY_50',
  'BANK NIFTY': 'BANKNIFTY',
  'CRUDE OIL': 'CRUDEOIL',
  'NATURAL GAS': 'NATURALGAS',
};

export interface ResolvedInstrument {
  name: string;
  securityId: string;
  exchange: string;
  mode: string;
}

// ─── Confirmation Dialog ─────────────────────────────────────────

function ConfirmDialog({
  open,
  title,
  message,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-card border border-border rounded-lg p-4 max-w-sm w-full mx-4 shadow-xl">
        <h3 className="text-sm font-bold text-foreground mb-2">{title}</h3>
        <p className="text-[11px] text-muted-foreground mb-4">{message}</p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1 rounded text-[10px] font-medium bg-secondary text-muted-foreground hover:text-foreground transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-3 py-1 rounded text-[10px] font-bold bg-destructive/20 text-destructive hover:bg-destructive/30 transition-colors"
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Status Badge ────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'OPEN':
      return (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[8px] font-bold bg-warning-amber/20 text-warning-amber">
          <span className="h-1.5 w-1.5 rounded-full bg-warning-amber animate-pulse" />
          OPEN
        </span>
      );
    case 'PENDING':
      return (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[8px] font-bold bg-muted text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-pulse" />
          PENDING
        </span>
      );
    case 'CLOSED_TP':
      return (
        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[8px] font-bold bg-bullish/20 text-bullish">
          ✓ TP
        </span>
      );
    case 'CLOSED_SL':
      return (
        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[8px] font-bold bg-destructive/20 text-destructive">
          ✗ SL
        </span>
      );
    case 'CLOSED_PARTIAL':
      return (
        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[8px] font-bold bg-bullish/20 text-bullish">
          ✓ Partial
        </span>
      );
    case 'CANCELLED':
      return (
        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[8px] font-bold bg-muted text-muted-foreground">
          CANCELLED
        </span>
      );
    case 'REJECTED':
      return (
        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[8px] font-bold bg-destructive/20 text-destructive">
          REJECTED
        </span>
      );
    default:
      return (
        <span className="text-[8px] text-muted-foreground uppercase">
          {status.replace('CLOSED_', '')}
        </span>
      );
  }
}

// ─── Instrument Tag ──────────────────────────────────────────────

function InstrumentTag({ name }: { name: string }) {
  const style = getInstrumentStyle(name);
  return (
    <span className={`inline-flex max-w-full items-center truncate px-1.5 py-0.5 rounded text-[8px] font-bold tracking-wide ${style.bg} ${style.text}`}>
      {name}
    </span>
  );
}

// ─── Main Component ──────────────────────────────────────────────

export default function TradingDesk({
  resolvedInstruments,
  liveTicksEnabled = true,
}: {
  resolvedInstruments?: ResolvedInstrument[];
  liveTicksEnabled?: boolean;
}) {
  const {
    workspace, setWorkspace,
    capital, capitalLoading, capitalReady,
    allDays, currentDay: ctxCurrentDay, allDaysData,
    placeTrade: ctxPlaceTrade, placeTradePending,
    exitTrade: ctxExitTrade, exitTradePending,
    updateLtp: ctxUpdateLtp,
    refetchAll,
  } = useCapital();

  const [showNet, setShowNet] = useState(true);
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
  }>({ open: false, title: '', message: '', onConfirm: () => {} });
  const { getTick } = useTickStream(liveTicksEnabled);
  const todayRef = useRef<HTMLTableRowElement>(null);

  // ─── Instrument → Feed Lookup ──────────────────────────────
  const feedLookup = useMemo(() => {
    const map = new Map<string, { exchange: string; securityId: string }>();
    if (resolvedInstruments) {
      for (const ri of resolvedInstruments) {
        map.set(ri.name, { exchange: ri.exchange, securityId: ri.securityId });
      }
    }
    return map;
  }, [resolvedInstruments]);

  const getLiveLtp = useCallback((uiInstrument: string): number | undefined => {
    const resolvedName = UI_TO_RESOLVED[uiInstrument] ?? uiInstrument;
    const feed = feedLookup.get(resolvedName);
    if (!feed) return undefined;
    return getTick(feed.exchange, feed.securityId)?.ltp;
  }, [feedLookup, getTick]);

  // ─── Data from global CapitalContext (single source of truth) ──
  const isLive = capitalReady;
  const isLoading = capitalLoading;
  const canManageTrades = supportsManualControls(workspace);
  const workspaceBadge = getWorkspaceBadgeMeta(workspace);

  // ─── Auto-scroll to today on load ──────────────────────────
  useEffect(() => {
    if (todayRef.current) {
      todayRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [allDays.length]);

  // ─── Sync LTP to server ────────────────────────────────────
  const ltpSyncRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (ltpSyncRef.current) clearInterval(ltpSyncRef.current);
    ltpSyncRef.current = setInterval(() => {
      if (!ctxCurrentDay?.trades) return;
      const openTrades = ctxCurrentDay.trades.filter((t: any) => t.status === 'OPEN');
      if (openTrades.length === 0) return;
      const prices: Record<string, number> = {};
      for (const trade of openTrades) {
        const ltp = getLiveLtp(trade.instrument);
        if (ltp !== undefined) prices[trade.id] = ltp;
      }
      if (Object.keys(prices).length > 0) {
        ctxUpdateLtp(prices);
      }
    }, 2000);
    return () => {
      if (ltpSyncRef.current) clearInterval(ltpSyncRef.current);
    };
  }, [workspace, ctxCurrentDay, getLiveLtp]);

  // ─── Handlers ───────────────────────────────────────────────
  const handlePlaceTrade = useCallback(async (trade: {
    instrument: string;
    type: 'CALL_BUY' | 'CALL_SELL' | 'PUT_BUY' | 'PUT_SELL' | 'BUY' | 'SELL';
    strike: number | null;
    expiry: string;
    entryPrice: number;
    capitalPercent: number;
  }) => {
    ctxPlaceTrade({
      instrument: trade.instrument,
      type: trade.type,
      strike: trade.strike,
      expiry: trade.expiry,
      entryPrice: trade.entryPrice,
      capitalPercent: trade.capitalPercent,
    });
  }, [ctxPlaceTrade]);

  const handleExitTrade = useCallback((tradeId: string, instrument: string) => {
    const trade = ctxCurrentDay?.trades?.find((t: any) => t.id === tradeId);
    const liveLtp = trade ? getLiveLtp(trade.instrument) : undefined;
    const exitPrice = liveLtp ?? trade?.ltp ?? trade?.entryPrice ?? 0;
    if (exitPrice <= 0) return;

    setConfirmDialog({
      open: true,
      title: 'Exit Position',
      message: `Close ${instrument} position at market price ₹${exitPrice.toFixed(2)}?`,
      onConfirm: () => {
        ctxExitTrade({
          tradeId,
          exitPrice,
          reason: 'MANUAL',
        });
        setConfirmDialog(prev => ({ ...prev, open: false }));
      },
    });
  }, [ctxCurrentDay, ctxExitTrade, getLiveLtp]);

  const handleExitAll = useCallback(() => {
    const openTrades = ctxCurrentDay?.trades?.filter((t: any) => t.status === 'OPEN') ?? [];
    if (openTrades.length === 0) return;

    setConfirmDialog({
      open: true,
      title: 'Exit All Positions',
      message: `Close all ${openTrades.length} open position${openTrades.length > 1 ? 's' : ''} at market?`,
      onConfirm: () => {
        for (const trade of openTrades) {
          const liveLtp = getLiveLtp(trade.instrument);
          const exitPrice = liveLtp ?? trade.ltp ?? trade.entryPrice ?? 0;
          if (exitPrice > 0) {
            ctxExitTrade({
              tradeId: trade.id,
              exitPrice,
              reason: 'MANUAL',
            });
          }
        }
        setConfirmDialog(prev => ({ ...prev, open: false }));
      },
    });
  }, [ctxCurrentDay, ctxExitTrade, getLiveLtp]);

  // ─── Loading State ─────────────────────────────────────────
  if (isLoading) {
    return <TradingDeskSkeleton />;
  }

  // ─── Error State ───────────────────────────────────────────
  if (!capitalReady && !capitalLoading) {
    return (
      <ErrorState
        message="Failed to load capital data"
        onRetry={refetchAll}
      />
    );
  }

  // ─── Identify today's open trades count ────────────────────
  const currentDay = allDays.find(d => d.dayIndex === capital.currentDayIndex);
  const openTradeCount = currentDay?.trades?.filter(t => t.status === 'OPEN').length ?? 0;

  // ─── Render ────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full">
      {/* ─── Tab Bar ──────────────────────────────────────────── */}
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5 bg-card">
        <div className="flex items-center gap-1">
          {/* My Trades tab */}
          <button
            onClick={() => setWorkspace('live')}
            className={`px-3 py-1 rounded-t text-[10px] font-bold tracking-wider uppercase transition-colors ${
              workspace === 'live'
                ? 'bg-bullish/10 text-bullish border-b-2 border-bullish'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            My Trades
            <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-bullish animate-pulse" />
          </button>
          {/* Manual Paper tab */}
          <button
            onClick={() => setWorkspace('paper_manual')}
            className={`px-3 py-1 rounded-t text-[10px] font-bold tracking-wider uppercase transition-colors ${
              workspace === 'paper_manual'
                ? 'bg-warning-amber/10 text-warning-amber border-b-2 border-warning-amber'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Manual Paper
          </button>
          {/* AI Trades tab */}
          <button
            onClick={() => setWorkspace('paper')}
            className={`px-3 py-1 rounded-t text-[10px] font-bold tracking-wider uppercase transition-colors ${
              workspace === 'paper'
                ? 'bg-info-cyan/10 text-info-cyan border-b-2 border-info-cyan'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            AI Trades
          </button>
          {/* Workspace badge */}
          <span className={`ml-2 px-2 py-0.5 rounded text-[8px] font-bold tracking-wider uppercase ${workspaceBadge.className}`}>
            {workspaceBadge.label}
          </span>
        </div>
        {/* NET/GROSS toggle */}
        <div className="flex items-center gap-0.5 border border-border rounded overflow-hidden">
          <button
            onClick={() => setShowNet(true)}
            className={`px-2 py-0.5 text-[9px] font-bold transition-colors ${
              showNet ? 'bg-info-cyan/20 text-info-cyan' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            NET
          </button>
          <button
            onClick={() => setShowNet(false)}
            className={`px-2 py-0.5 text-[9px] font-bold transition-colors ${
              !showNet ? 'bg-info-cyan/20 text-info-cyan' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            GROSS
          </button>
        </div>
      </div>

      {/* ─── Summary Bar ──────────────────────────────────────── */}
      <div className="flex items-stretch divide-x divide-border border-b border-border bg-card">
        {/* Day */}
        <div className="px-3 py-1.5 flex flex-col items-center justify-center min-w-[80px]">
          <span className="text-[8px] text-muted-foreground tracking-widest uppercase">Day</span>
          <span className="text-[12px] font-bold tabular-nums">
            <span className="text-warning-amber">{capital.currentDayIndex}</span>
            <span className="text-muted-foreground"> / 250</span>
          </span>
        </div>
        {/* Trade Capital */}
        <div className="px-3 py-1.5 flex flex-col items-center justify-center">
          <span className="text-[8px] text-muted-foreground tracking-widest uppercase">Trade Capital</span>
          <span className="text-[12px] font-bold tabular-nums text-info-cyan">{fmt(capital.tradingPool, true)}</span>
        </div>
        {/* Available */}
        <div className="px-3 py-1.5 flex flex-col items-center justify-center">
          <span className="text-[8px] text-muted-foreground tracking-widest uppercase">Available</span>
          <span className="text-[12px] font-bold tabular-nums text-info-cyan">{fmt(capital.availableCapital, true)}</span>
        </div>
        {/* Cum. Profit */}
        <div className="px-3 py-1.5 flex flex-col items-center justify-center">
          <span className="text-[8px] text-muted-foreground tracking-widest uppercase">Cum. Profit</span>
          <span className={`text-[12px] font-bold tabular-nums ${pnlColor(capital.cumulativePnl)}`}>
            {capital.cumulativePnl >= 0 ? '+' : ''}{fmt(capital.cumulativePnl)}
          </span>
        </div>
        {/* Today P&L / Target + Exit All */}
        <div className="px-3 py-1.5 flex flex-col items-center justify-center flex-1">
<span className="text-[8px] text-muted-foreground tracking-widest uppercase">Today P&L / Target</span>
          <div className="flex items-center gap-1">
            <span className="text-[12px] font-bold tabular-nums">
              <span className={pnlColor(capital.todayPnl)}>{fmt(capital.todayPnl)}</span>
              <span className="text-muted-foreground"> / </span>
              <span className="text-warning-amber">{fmt(capital.todayTarget)}</span>
            </span>
            {canManageTrades && openTradeCount > 0 && (
              <button
                onClick={handleExitAll}
                className="px-1 py-0.5 rounded text-[8px] font-bold bg-destructive/15 text-destructive hover:bg-destructive/25 transition-colors"
                title="Exit all open positions"
              >
                ×
              </button>
            )}
          </div>
        </div>
        {/* Charges */}
        <div className="px-3 py-1.5 flex flex-col items-center justify-center">
          <span className="text-[8px] text-muted-foreground tracking-widest uppercase">Charges</span>
          <span className="text-[12px] font-bold tabular-nums text-muted-foreground">{fmt(capital.cumulativeCharges)}</span>
        </div>
        {/* Reserve */}
        <div className="px-3 py-1.5 flex flex-col items-center justify-center">
          <span className="text-[8px] text-muted-foreground tracking-widest uppercase">Reserve</span>
          <span className="text-[12px] font-bold tabular-nums text-warning-amber">{fmt(capital.reservePool, true)}</span>
        </div>
        {/* Net Worth */}
        <div className="px-3 py-1.5 flex flex-col items-center justify-center">
          <span className="text-[8px] text-muted-foreground tracking-widest uppercase">Net Worth</span>
          <span className="text-[12px] font-bold tabular-nums text-bullish">{fmt(capital.netWorth, true)}</span>
        </div>
      </div>

      {/* Mutation Error */}
      {/* Mutation errors are handled by the global CapitalContext */}

      {/* ─── Table ────────────────────────────────────────────── */}
      <div className="flex-1 overflow-auto">
        {allDays.length === 0 && !capitalLoading ? (
          <NoCapitalEmpty onOpenSettings={() => {
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2' }));
          }} />
        ) : (
          <table className="min-w-[1440px] w-full table-fixed border-collapse text-[11px] [&_td]:align-middle [&_th]:align-middle [&_th]:whitespace-nowrap">
            <colgroup>
              <col className="w-11" />
              <col className="w-[92px]" />
              <col className="w-[88px]" />
              <col className="w-[88px]" />
              <col className="w-[88px]" />
              <col />
              <col className="w-[72px]" />
              <col className="w-[72px]" />
              <col className="w-[68px]" />
              <col className="w-[116px]" />
              <col className="w-[80px]" />
              <col className="w-[88px]" />
              <col className="w-[88px]" />
              <col className="w-[76px]" />
            </colgroup>
            <thead className="sticky top-0 z-10">
              <tr className="bg-secondary/80 backdrop-blur-sm border-b border-border">
                <th className="px-2 py-1.5 text-left font-medium text-muted-foreground tracking-wider uppercase w-12">Day</th>
                <th className="px-2 py-1.5 text-left font-medium text-muted-foreground tracking-wider uppercase">Date</th>
                <th className="px-2 py-1.5 text-right font-medium text-muted-foreground tracking-wider uppercase">Trade Cap.</th>
                <th className="px-2 py-1.5 text-right font-medium text-muted-foreground tracking-wider uppercase">Target</th>
                <th className="px-2 py-1.5 text-right font-medium text-muted-foreground tracking-wider uppercase">Proj. Cap.</th>
                <th className="px-2 py-1.5 text-left font-medium text-muted-foreground tracking-wider uppercase">Instrument</th>
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
              {allDays.map((day, idx) => {
                const isToday = day.dayIndex === capital.currentDayIndex;
                const isDay250 = day.dayIndex === 250;

                if (isToday) {
                  // ─── TODAY: render individual trade rows ────
                  return (
                    <TodaySection
                      key={day.dayIndex}
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
                    />
                  );
                }

                if (day.status === 'FUTURE') {
                  // ─── FUTURE: projected row ─────────────────
                return (
                  <FutureRow
                    key={day.dayIndex}
                    day={day}
                    isDay250={isDay250}
                    workspace={workspace}
                  />
                );
                }

                // ─── PAST / GIFT: single summary row ────────
                return (
                  <PastRow
                    key={day.dayIndex}
                    day={day}
                    showNet={showNet}
                    workspace={workspace}
                  />
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Confirmation Dialog */}
      <ConfirmDialog
        open={confirmDialog.open}
        title={confirmDialog.title}
        message={confirmDialog.message}
        onConfirm={confirmDialog.onConfirm}
        onCancel={() => setConfirmDialog(prev => ({ ...prev, open: false }))}
      />
    </div>
  );
}

// ─── Past / Gift Row ────────────────────────────────────────────

function PastRow({
  day,
  showNet,
  workspace,
}: {
  day: DayRecord;
  showNet: boolean;
  workspace: Workspace;
}) {
  const theme = getWorkspaceThemeMeta(workspace);

  const pnlValue = showNet ? day.totalPnl : day.totalPnl + day.totalCharges;
  const pnlPercent = day.tradeCapital > 0 ? (day.totalPnl / day.tradeCapital * 100).toFixed(1) : '0.0';
  const dateLabel = formatDateAgeLabel(day.date || '—', day.openedAt);

  return (
    <tr className={`border-b border-border/50 ${theme.rowBg} ${theme.rowBgHover} transition-colors`}>
      {/* Day */}
      <td className="px-2 py-2">
        <span className={`font-bold tabular-nums ${theme.text}`}>{day.dayIndex}</span>
      </td>
      {/* Date + Age */}
      <td className="px-2 py-2">
        <span className={`block truncate text-[10px] tabular-nums ${theme.text}`}>{dateLabel}</span>
        <div className="hidden items-center justify-between">
          <span className="text-muted-foreground tabular-nums">{day.date || '—'}</span>
          {day.openedAt && (
            <span className="text-[8px] text-muted-foreground/60 tabular-nums">{formatAge(day.openedAt)}</span>
          )}
        </div>
      </td>
      {/* Trade Capital */}
      <td className={`px-2 py-2 text-right tabular-nums ${theme.textSoft}`}>
        {fmt(day.tradeCapital, true)}
      </td>
      {/* Target */}
      <td className={`px-2 py-2 text-right tabular-nums ${theme.textSoft}`}>
        {fmt(day.targetAmount)}
        <span className="text-[8px] ml-0.5">({day.targetPercent}%)</span>
      </td>
      {/* Proj Capital */}
      <td className={`px-2 py-2 text-right tabular-nums ${theme.textSoft}`}>
        {fmt(day.projCapital, true)}
      </td>
      {/* Instrument — color-coded tags */}
      <td className="px-2 py-2">
        <div className="flex max-w-full items-center gap-1 overflow-hidden whitespace-nowrap">
          {day.instruments.length > 0
            ? day.instruments.map((inst) => <InstrumentTag key={inst} name={inst} />)
            : <span className={theme.textSoft}>—</span>
          }
        </div>
      </td>
      {/* Entry */}
      <td className={`px-2 py-2 text-right ${theme.textSoft}`}>—</td>
      {/* LTP */}
      <td className={`px-2 py-2 text-right ${theme.textSoft}`}>—</td>
      {/* Qty */}
      <td className="px-2 py-2 text-right tabular-nums text-foreground">
        {day.totalQty > 0 ? day.totalQty : '—'}
      </td>
      {/* P&L */}
      <td className={`px-2 py-2 text-right tabular-nums font-bold ${pnlColor(pnlValue)}`}>
        {pnlValue > 0 ? '▲' : pnlValue < 0 ? '▼' : ''} {fmt(pnlValue)}
        <span className="text-[8px] ml-0.5">({pnlPercent}%)</span>
      </td>
      {/* Charges */}
      <td className={`px-2 py-2 text-right tabular-nums ${theme.textSoft}`}>
        {day.totalCharges > 0 ? fmt(day.totalCharges) : '—'}
      </td>
      {/* Actual Capital */}
      <td className={`px-2 py-2 text-right tabular-nums font-medium ${theme.text}`}>
        {day.actualCapital > 0 ? fmt(day.actualCapital, true) : '—'}
      </td>
      {/* Deviation */}
      <td className={`px-2 py-2 text-right tabular-nums text-[9px] ${pnlColor(day.deviation)}`}>
        {day.actualCapital > 0
          ? formatDeviation(day.deviation)
          : '—'}
      </td>
      {/* Rating */}
      <td className="px-2 py-2 text-center">
        <RatingIcon rating={day.rating} />
      </td>
    </tr>
  );
}

// ─── Today Section ──────────────────────────────────────────────

function TodaySection({
  day,
  capital,
  showNet,
  onExitTrade,
  onExitAll,
  onPlaceTrade,
  exitLoading,
  placeLoading,
  getLiveLtp,
  todayRef,
  workspace,
  resolvedInstruments,
}: {
  day: DayRecord;
  capital: CapitalState;
  showNet: boolean;
  onExitTrade: (tradeId: string, instrument: string) => void;
  onExitAll: () => void;
  onPlaceTrade: (trade: any) => Promise<void>;
  exitLoading?: boolean;
  placeLoading?: boolean;
  getLiveLtp: (instrument: string) => number | undefined;
  todayRef: React.RefObject<HTMLTableRowElement | null>;
  workspace: Workspace;
  resolvedInstruments?: ResolvedInstrument[];
}) {
  const [showNewTradeForm, setShowNewTradeForm] = useState(false);
  const trades = day.trades ?? [];
  const openTrades = trades.filter(t => t.status === 'OPEN');
  const totalPnl = showNet ? day.totalPnl : day.totalPnl + day.totalCharges;
  const canManageTrades = supportsManualControls(workspace);
  const cycleDateLabel = formatDateAgeLabel(formatCalendarDay(), day.openedAt);
  const remainingToTarget = Math.round((day.targetAmount - day.totalPnl) * 100) / 100;
  const openRisk = Math.round(calculateOpenRisk(openTrades) * 100) / 100;
  const openReward = Math.round(calculateOpenReward(openTrades) * 100) / 100;
  const usedCapital = Math.round(calculateOpenMargin(openTrades) * 100) / 100;
  const { wins, losses } = countTradeOutcomes(trades);
  const theme = getWorkspaceThemeMeta(workspace);

  return (
    <>
      {/* Individual trade rows */}
      {trades.map((trade, idx) => {
        const isFirst = idx === 0;
        return (
          <TodayTradeRow
            key={trade.id}
            trade={trade}
            day={day}
            isFirst={isFirst}
            showNet={showNet}
            onExit={() => onExitTrade(trade.id, trade.instrument)}
            exitLoading={exitLoading}
            getLiveLtp={getLiveLtp}
            todayRef={isFirst ? todayRef : undefined}
            canManageTrades={canManageTrades}
            workspace={workspace}
          />
        );
      })}

      {/* New Trade Input Row — only for manual workspaces, shown on + button click */}
      {canManageTrades && showNewTradeForm && (
        <NewTradeForm
          workspace={workspace}
          availableCapital={capital.availableCapital}
          instruments={['NIFTY 50', 'BANK NIFTY', 'CRUDE OIL', 'NATURAL GAS']}
          resolvedInstruments={resolvedInstruments}
          onSubmit={async (trade) => {
            await onPlaceTrade(trade);
            setShowNewTradeForm(false);
          }}
          onCancel={() => setShowNewTradeForm(false)}
          loading={placeLoading}
          dayOpenedAt={day.openedAt}
          dayValues={trades.length === 0 ? {
            dayIndex: day.dayIndex,
            tradeCapital: day.tradeCapital,
            targetAmount: day.targetAmount,
            targetPercent: day.targetPercent,
            projCapital: day.projCapital,
          } : undefined}
        />
      )}

      {/* Today Summary Row */}
      <tr className={`border-b font-bold ${theme.summaryBorder} ${theme.summaryBg}`} ref={trades.length === 0 ? todayRef : undefined}>
        <td className={`px-2 py-2 ${theme.text}`}>DAY {day.dayIndex}</td>
        <td className="px-2 py-2">
          <span className={`block truncate text-[10px] tabular-nums ${theme.text}`}>{cycleDateLabel}</span>
        </td>
        <td className={`px-2 py-2 text-right tabular-nums ${theme.textSoft}`}>
          {fmt(day.tradeCapital, true)}
        </td>
        <td className={`px-2 py-2 text-right tabular-nums ${theme.textSoft}`}>
          {fmt(day.targetAmount)}
          <span className="text-[8px] ml-0.5">({day.targetPercent}%)</span>
        </td>
        <td className={`px-2 py-2 text-right tabular-nums ${theme.textSoft}`}>
          {fmt(day.projCapital, true)}
        </td>
        <td className="px-2 py-2" colSpan={3}>
          <div className="flex items-center justify-between gap-3 overflow-hidden">
            <div className={`min-w-0 truncate text-[9px] ${theme.text}`}>
              <span>{remainingToTarget > 0 ? `To Target ${fmt(remainingToTarget)}` : `Over Target ${fmt(Math.abs(remainingToTarget))}`}</span>
              <span className="mx-1.5 text-border">|</span>
              <span>Risk@SL {fmt(openRisk)}</span>
              <span className="mx-1.5 text-border">|</span>
              <span>Reward@TP {fmt(openReward)}</span>
              <span className="mx-1.5 text-border">|</span>
              <span>Used {fmt(usedCapital, true)} / Avail {fmt(capital.availableCapital, true)}</span>
              <span className="mx-1.5 text-border">|</span>
              <span>Open {openTrades.length}</span>
              <span className="mx-1.5 text-border">|</span>
              <span>W/L {wins}/{losses}</span>
            </div>
            {canManageTrades ? (
              <button
                onClick={() => setShowNewTradeForm(prev => !prev)}
                className={`shrink-0 px-2 py-0.5 rounded text-[9px] font-bold tracking-wider transition-colors ${
                  showNewTradeForm
                    ? theme.buttonActive
                    : theme.button
                }`}
              >
                {showNewTradeForm ? '- CANCEL' : '+ NEW TRADE'}
              </button>
            ) : (
              <span className={`shrink-0 text-[9px] italic ${theme.textSoft}`}>AI managed</span>
            )}
          </div>
        </td>
        <td className={`px-2 py-2 text-right tabular-nums ${theme.textSoft}`}>
          {day.totalQty > 0 ? day.totalQty : '—'}
        </td>
        <td className={`px-2 py-2 text-right tabular-nums ${pnlColor(totalPnl)}`}>
          <div className="flex items-center justify-end gap-1">
            <span>{fmt(totalPnl)}</span>
            {canManageTrades && openTrades.length > 0 && (
              <button
                onClick={onExitAll}
                className="px-1 py-0.5 rounded text-[8px] font-bold bg-destructive/15 text-destructive hover:bg-destructive/25 transition-colors"
                title="Exit all"
              >
                x
              </button>
            )}
          </div>
        </td>
        <td className={`px-2 py-2 text-right tabular-nums ${theme.textSoft}`}>
          {day.totalCharges > 0 ? fmt(day.totalCharges) : '—'}
        </td>
        <td className={`px-2 py-2 text-right tabular-nums ${theme.text}`}>
          {day.actualCapital > 0 ? fmt(day.actualCapital, true) : fmt(day.tradeCapital, true)}
        </td>
        <td className={`px-2 py-2 text-right tabular-nums text-[9px] ${pnlColor(day.deviation)}`}>
          {formatDeviation(day.deviation)}
        </td>
        <td className="px-2 py-2" />
      </tr>
      <tr className="hidden border-b border-warning-amber/30 bg-warning-amber/10 font-bold" ref={trades.length === 0 ? todayRef : undefined}>
        {/* Day */}
        <td className="px-2 py-2 text-warning-amber" colSpan={2}>
          DAY {day.dayIndex} TOTAL
        </td>
        {/* Trade Capital */}
        <td className="px-2 py-2" />
        {/* Target */}
        <td className="px-2 py-2" />
        {/* Proj Capital */}
        <td className="px-2 py-2" />
        {/* Instrument — + NEW TRADE button (manual workspaces only) */}
        <td className="px-2 py-2" colSpan={3}>
          {canManageTrades ? (
            <button
              onClick={() => setShowNewTradeForm(prev => !prev)}
              className={`px-2 py-0.5 rounded text-[9px] font-bold tracking-wider transition-colors ${
                showNewTradeForm
                  ? 'bg-warning-amber/20 text-warning-amber'
                  : 'bg-info-cyan/15 text-info-cyan hover:bg-info-cyan/25'
              }`}
            >
              {showNewTradeForm ? '− CANCEL' : '+ NEW TRADE'}
            </button>
          ) : (
            <span className="text-[9px] text-muted-foreground/50 italic">AI managed</span>
          )}
        </td>
        {/* Qty */}
        <td className="px-2 py-2 text-right tabular-nums text-foreground">
          {day.totalQty > 0 ? day.totalQty : '—'}
        </td>
        {/* P&L + Exit All */}
        <td className={`px-2 py-2 text-right tabular-nums ${pnlColor(totalPnl)}`}>
          <div className="flex items-center justify-end gap-1">
            <span>{fmt(totalPnl)}</span>
            {canManageTrades && openTrades.length > 0 && (
              <button
                onClick={onExitAll}
                className="px-1 py-0.5 rounded text-[8px] font-bold bg-destructive/15 text-destructive hover:bg-destructive/25 transition-colors"
                title="Exit all"
              >
                ×
              </button>
            )}
          </div>
        </td>
        {/* Charges */}
        <td className="px-2 py-2 text-right tabular-nums text-muted-foreground/60">
          {day.totalCharges > 0 ? fmt(day.totalCharges) : '—'}
        </td>
        {/* Actual Capital */}
        <td className="px-2 py-2 text-right tabular-nums text-warning-amber">
          {day.actualCapital > 0 ? fmt(day.actualCapital, true) : fmt(day.tradeCapital, true)}
        </td>
        {/* Deviation */}
        <td className={`px-2 py-2 text-right tabular-nums text-[9px] ${pnlColor(day.deviation)}`}>
          {formatDeviation(day.deviation)}
        </td>
        {/* Rating */}
        <td className="px-2 py-2" />
      </tr>
    </>
  );
}

// ─── Today Trade Row ────────────────────────────────────────────

function TodayTradeRow({
  trade,
  day,
  isFirst,
  showNet,
  onExit,
  exitLoading,
  getLiveLtp,
  todayRef,
  canManageTrades,
  workspace,
}: {
  trade: TradeRecord;
  day: DayRecord;
  isFirst: boolean;
  showNet: boolean;
  onExit: () => void;
  exitLoading?: boolean;
  getLiveLtp: (instrument: string) => number | undefined;
  todayRef?: React.RefObject<HTMLTableRowElement | null>;
  canManageTrades: boolean;
  workspace: Workspace;
}) {
  const theme = getWorkspaceThemeMeta(workspace);
  const isOpen = trade.status === 'OPEN';
  const isPending = trade.status === 'PENDING';
  const isBuy = trade.type.includes('BUY');
  const liveLtp = isOpen ? getLiveLtp(trade.instrument) : undefined;
  const displayLtp = liveLtp ?? trade.ltp;
  const liveUnrealizedPnl = isOpen
    ? (isBuy ? (displayLtp - trade.entryPrice) : (trade.entryPrice - displayLtp)) * trade.qty
    : 0;
  const pnl = isOpen ? liveUnrealizedPnl : (showNet ? trade.pnl : trade.pnl + trade.charges);
  const pnlPercent = trade.entryPrice > 0
    ? ((isOpen ? liveUnrealizedPnl : trade.pnl) / (trade.entryPrice * trade.qty) * 100)
    : 0;
  const cycleDateLabel = formatDateAgeLabel(formatCalendarDay(), day.openedAt);

  const directionLabel = getTradeDirectionLabel(trade.type);
  const contractLabel = getTradeContractLabel(trade.type);
  const expiryLabel = formatExpiryLabel(trade.expiry);
  const contractDetails = [
    expiryLabel ? <span key="expiry" className="shrink-0">{expiryLabel}</span> : null,
    trade.strike !== null ? <span key="strike" className="shrink-0">{trade.strike}</span> : null,
    directionLabel !== '—'
      ? (
        <span
          key="direction"
          className={`shrink-0 font-semibold ${isBuy ? 'text-bullish' : 'text-destructive'}`}
        >
          {directionLabel}
        </span>
      )
      : null,
  ].filter(Boolean);

  return (
    <tr
      ref={todayRef}
      className={`border-b border-border/30 transition-colors ${
        isFirst
          ? `${theme.todayBg} border-l-2 ${theme.borderStrong}`
          : `${theme.todayAltBg} border-l-2 ${theme.borderSoft}`
      }`}
    >
      {/* Day */}
      <td className="px-2 py-1.5">
        {isFirst ? (
          <span className={`font-bold tabular-nums ${theme.text}`}>{day.dayIndex}</span>
        ) : (
          <span className={`tabular-nums ${theme.textSoft}`}>{day.dayIndex}</span>
        )}
      </td>
      {/* Date + Age */}
      <td className="px-2 py-1.5">
        <span className={`block truncate tabular-nums text-[10px] ${theme.text}`}>
          {cycleDateLabel}
        </span>
      </td>
      {/* Trade Capital — dimmed for sub-rows */}
      <td className={`px-2 py-1.5 text-right tabular-nums ${theme.textSoft}`}>
        {fmt(day.tradeCapital, true)}
      </td>
      {/* Target — dimmed for sub-rows */}
      <td className={`px-2 py-1.5 text-right tabular-nums ${theme.textSoft}`}>
        {fmt(day.targetAmount)}
        <span className="text-[8px] ml-0.5">({day.targetPercent}%)</span>
      </td>
      {/* Proj Capital — dimmed for sub-rows */}
      <td className={`px-2 py-1.5 text-right tabular-nums ${theme.textSoft}`}>
        {fmt(day.projCapital, true)}
      </td>
      {/* Instrument — merged with type info: Instrument | Expiry | Strike | CE/PE | B/S */}
      <td className="px-2 py-1.5">
        <div className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap">
          <InstrumentTag name={trade.instrument} />
          {expiryLabel && (
            <>
              <span className="text-border text-[9px]">|</span>
              <span className={`text-[9px] tabular-nums ${theme.textSoft}`}>{expiryLabel}</span>
            </>
          )}
          {trade.strike !== null && (
            <>
              <span className="text-border text-[9px]">|</span>
              <span className={`text-[9px] tabular-nums ${theme.textSoft}`}>{trade.strike}</span>
            </>
          )}
          <span className="text-border text-[9px]">|</span>
          <span className={`text-[9px] font-bold ${theme.buttonActive} rounded px-1 py-0.5`}>{contractLabel}</span>
          <span className="text-border text-[9px]">|</span>
          <span className={`text-[9px] font-semibold ${isBuy ? 'text-bullish' : 'text-destructive'}`}>{directionLabel}</span>
        </div>
      </td>
      {/* Entry */}
      <td className="px-2 py-1.5 text-right tabular-nums text-foreground">
        {trade.entryPrice.toFixed(2)}
      </td>
      {/* LTP + TP/SL sub-text */}
      <td className="px-2 py-1.5 text-right">
        <div className="flex flex-col items-end">
          <span className={`tabular-nums font-medium ${
            isOpen
              ? (displayLtp >= trade.entryPrice ? 'text-bullish' : 'text-destructive')
              : theme.textSoft
          }`}>
            {isOpen ? (
              <>
                {displayLtp.toFixed(2)}
                {liveLtp !== undefined && (
                  <span className="ml-0.5 inline-block h-1 w-1 rounded-full bg-bullish animate-pulse" />
                )}
              </>
            ) : (
              trade.exitPrice?.toFixed(2) ?? '—'
            )}
          </span>
          {/* TP/SL sub-text for open trades */}
          {isOpen && trade.targetPrice && trade.stopLossPrice && (
            <div className="flex flex-col items-end mt-0.5">
              <span className="text-[8px] text-bullish/70">
                TP: {trade.targetPrice.toFixed(2)} <span className="cursor-pointer opacity-50 hover:opacity-100">✎</span>
              </span>
              <span className="text-[8px] text-destructive/70">
                SL: {trade.stopLossPrice.toFixed(2)} <span className="cursor-pointer opacity-50 hover:opacity-100">✎</span>
              </span>
            </div>
          )}
        </div>
      </td>
      {/* Qty */}
      <td className="px-2 py-1.5 text-right tabular-nums text-foreground">{trade.qty}</td>
      {/* P&L + Exit button for open trades */}
      <td className={`px-2 py-1.5 text-right tabular-nums font-bold ${pnlColor(pnl)}`}>
        <div className="flex items-center justify-end gap-1">
          <span>
            {fmt(pnl)}
            <span className="text-[8px] ml-0.5">({pnlPercent >= 0 ? '+' : ''}{pnlPercent.toFixed(1)}%)</span>
          </span>
          {isOpen && canManageTrades && (
            <button
              onClick={(e) => { e.stopPropagation(); onExit(); }}
              disabled={exitLoading}
              className={`px-1 py-0.5 rounded text-[9px] font-bold transition-colors ${
                pnl >= 0
                  ? 'bg-bullish/15 text-bullish hover:bg-bullish/25'
                  : 'bg-destructive/15 text-destructive hover:bg-destructive/25'
              } disabled:opacity-30`}
              title="Exit position"
            >
              {exitLoading ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : '×'}
            </button>
          )}
        </div>
      </td>
      {/* Charges */}
      <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
        {trade.charges > 0 ? fmt(trade.charges) : '—'}
      </td>
      {/* Actual Capital */}
      <td className="px-2 py-1.5" />
      {/* Deviation */}
      <td className="px-2 py-1.5" />
      {/* Status Badge */}
      <td className="px-2 py-1.5 text-center">
        <StatusBadge status={trade.status} />
      </td>
    </tr>
  );
}

// ─── Future Row ─────────────────────────────────────────────────

function FutureRow({
  day,
  isDay250,
  workspace,
}: {
  day: DayRecord;
  isDay250: boolean;
  workspace: Workspace;
}) {
  const theme = getWorkspaceThemeMeta(workspace);
  return (
    <tr className={`border-b border-border/30 bg-card/50 transition-colors ${isDay250 ? 'opacity-90' : 'opacity-[0.6]'}`}>
      {/* Day */}
      <td className="px-2 py-2">
        <span className={`font-bold tabular-nums ${isDay250 ? theme.textSoft : theme.textDim}`}>
          {day.dayIndex}
        </span>
      </td>
      {/* Date */}
      <td className={`px-2 py-2 tabular-nums ${isDay250 ? theme.textSoft : theme.textDim}`}>
        {day.date || '—'}
      </td>
      {/* Trade Capital */}
      <td className={`px-2 py-2 text-right tabular-nums ${isDay250 ? theme.textSoft : theme.textDim}`}>
        {fmt(day.tradeCapital, true)}
      </td>
      {/* Target */}
      <td className={`px-2 py-2 text-right tabular-nums ${isDay250 ? theme.textSoft : theme.textDim}`}>
        {fmt(day.targetAmount)}
        <span className="text-[9px] ml-0.5">({day.targetPercent}%)</span>
      </td>
      {/* Proj Capital */}
      <td className={`px-2 py-2 text-right tabular-nums font-medium ${isDay250 ? theme.textSoft : theme.textDim}`}>
        {fmt(day.projCapital, true)}
      </td>
      {/* Instrument */}
      <td className={`px-2 py-2 ${theme.textDim}`}>—</td>
      {/* Entry */}
      <td className={`px-2 py-2 text-right ${theme.textDim}`}>—</td>
      {/* LTP */}
      <td className={`px-2 py-2 text-right ${theme.textDim}`}>—</td>
      {/* Qty */}
      <td className={`px-2 py-2 text-right ${theme.textDim}`}>—</td>
      {/* P&L */}
      <td className={`px-2 py-2 text-right ${theme.textDim}`}>—</td>
      {/* Charges */}
      <td className={`px-2 py-2 text-right ${theme.textDim}`}>—</td>
      {/* Actual Capital */}
      <td className={`px-2 py-2 text-right ${theme.textDim}`}>—</td>
      {/* Deviation */}
      <td className={`px-2 py-2 text-right ${theme.textDim}`}>—</td>
      {/* Rating */}
      <td className="px-2 py-2 text-center">
        <RatingIcon rating={isDay250 ? 'finish' : 'future'} />
      </td>
    </tr>
  );
}
