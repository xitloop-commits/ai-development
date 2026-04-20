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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useCapital } from '@/contexts/CapitalContext';
import { trpc } from '@/lib/trpc';
import { formatINR, formatPrice as fmtPrice } from '@/lib/formatINR';
import {
  TrendingUp,
  TrendingDown,
  Loader2,
  Plus,
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
  contractSecurityId?: string | null;
  entryPrice: number;
  exitPrice: number | null;
  ltp: number;
  qty: number;
  lotSize?: number;
  capitalPercent: number;
  pnl: number;
  unrealizedPnl: number;
  charges: number;
  chargesBreakdown: { name: string; amount: number }[];
  status: string;
  targetPrice: number | null;
  stopLossPrice: number | null;
  trailingStopEnabled?: boolean; // Trade-level trailing stop override
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
      return { label: 'AI PAPER', className: 'bg-violet-pulse/20 text-violet-pulse' };
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
        summaryBg: 'bg-bullish/20',
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
        summaryBg: 'bg-warning-amber/20',
        summaryBorder: 'border-warning-amber/30',
        borderStrong: 'border-l-warning-amber',
        borderSoft: 'border-l-warning-amber/50',
        button: 'bg-warning-amber/15 text-warning-amber hover:bg-warning-amber/25',
        buttonActive: 'bg-warning-amber/20 text-warning-amber',
      };
    default:
      return {
        text: 'text-violet-pulse',
        textSoft: 'text-violet-pulse/80',
        textDim: 'text-violet-pulse/60',
        rowBg: 'bg-violet-pulse/[0.04]',
        rowBgHover: 'hover:bg-violet-pulse/[0.08]',
        todayBg: 'bg-violet-pulse/[0.08]',
        todayAltBg: 'bg-violet-pulse/[0.04]',
        summaryBg: 'bg-violet-pulse/20',
        summaryBorder: 'border-violet-pulse/30',
        borderStrong: 'border-l-violet-pulse',
        borderSoft: 'border-l-violet-pulse/50',
        button: 'bg-violet-pulse/15 text-violet-pulse hover:bg-violet-pulse/25',
        buttonActive: 'bg-violet-pulse/20 text-violet-pulse',
      };
  }
}

// ─── Rating Icon ─────────────────────────────────────────────────

function RatingIcon({ rating }: { rating: DayRating }) {
  switch (rating) {
    case 'jackpot':
      return <span className="text-[0.6875rem]" title="≥50%">👑</span>;
    case 'crown':
      return <span className="text-[0.6875rem]" title="≥20%">🏆</span>;
    case 'double_trophy':
      return <span className="text-[0.6875rem]" title="≥10%">💰</span>;
    case 'trophy':
      return <span className="text-[0.6875rem]" title="≥5% Single Day">👍</span>;
    case 'star':
      return <span className="text-[0.6875rem]" title="≥5% Multi-Day">⭐</span>;
    case 'gift':
      return <span className="text-[0.6875rem]" title="Auto-completed">🎁</span>;
    case 'finish':
      return <span className="text-[0.6875rem]" title="Day 250">🏁</span>;
    default:
      return null;
  }
}

// ─── Currency Formatter ──────────────────────────────────────────

function fmt(n: number, compact = true): string {
  return formatINR(n, { compact, decimals: 2 });
}

function pnlColor(n: number): string {
  if (n > 0) return 'text-bullish/80';
  if (n < 0) return 'text-destructive/80';
  return 'text-foreground';
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

function ordinal(n: number): string {
  if (n >= 11 && n <= 13) return n + 'th';
  switch (n % 10) {
    case 1: return n + 'st';
    case 2: return n + 'nd';
    case 3: return n + 'rd';
    default: return n + 'th';
  }
}

function formatCalendarDay(timestamp: number = Date.now()): string {
  const d = new Date(timestamp);
  const day = d.getDate();
  const month = d.toLocaleDateString('en-IN', { month: 'short' });
  const year = String(d.getFullYear()).slice(2);
  return `${day} ${month} ${year}`;
}

function formatExpiryLabel(expiry?: string | null): string {
  if (!expiry) return '';
  const time = new Date(`${expiry}T00:00:00`).getTime();
  if (Number.isNaN(time)) return expiry;
  return formatCalendarDay(time);
}

function formatDateStr(dateStr: string): string {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr + 'T00:00:00');
    if (isNaN(d.getTime())) return dateStr;
    return formatCalendarDay(d.getTime());
  } catch { return dateStr; }
}

function formatDateAgeLabel(dateLabel: string, openedAt?: number): string {
  const formatted = formatDateStr(dateLabel);
  const age = formatAge(openedAt);
  return age ? `${formatted} | ${age}` : formatted;
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
        <p className="text-[0.6875rem] text-muted-foreground mb-4">{message}</p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1 rounded font-medium bg-secondary text-muted-foreground hover:text-foreground transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-3 py-1 rounded font-bold bg-destructive/20 text-destructive hover:bg-destructive/30 transition-colors"
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
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-bold bg-warning-amber/20 text-warning-amber">
          <span className="h-1.5 w-1.5 rounded-full bg-warning-amber animate-pulse" />
          OPEN
        </span>
      );
    case 'PENDING':
      return (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-bold bg-muted text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-pulse" />
          PENDING
        </span>
      );
    case 'CLOSED_TP':
      return (
        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded font-bold bg-bullish/20 text-bullish">
          ✓ TP
        </span>
      );
    case 'CLOSED_SL':
      return (
        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded font-bold bg-destructive/20 text-destructive">
          ✗ SL
        </span>
      );
    case 'CLOSED_PARTIAL':
      return (
        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded font-bold bg-bullish/20 text-bullish">
          ✓ Partial
        </span>
      );
    case 'CANCELLED':
      return (
        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded font-bold bg-muted text-muted-foreground">
          CANCELLED
        </span>
      );
    case 'REJECTED':
      return (
        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded font-bold bg-destructive/20 text-destructive">
          REJECTED
        </span>
      );
    default:
      return (
        <span className="text-[0.5rem] text-muted-foreground uppercase">
          {status.replace('CLOSED_', '')}
        </span>
      );
  }
}

// ─── Instrument Tag ──────────────────────────────────────────────

function InstrumentTag({ name }: { name: string }) {
  const style = getInstrumentStyle(name);
  return (
    <span className={`inline-flex max-w-full items-center truncate px-1.5 py-0.5 rounded font-bold tracking-wide ${style.bg} ${style.text}`}>
      {name}
    </span>
  );
}

// ─── Capital Pool Popover ────────────────────────────────────────

function CapitalPoolPopover({ capital, fmt }: { capital: CapitalState; fmt: (n: number, compact?: boolean) => string }) {
  const [injectAmount, setInjectAmount] = useState('');
  const [resetAmount, setResetAmount] = useState('');
  const [showReset, setShowReset] = useState(false);
  const { inject: ctxInject, injectPending, resetCapital, resetCapitalPending } = useCapital() as any;

  const handleInject = () => {
    const amount = parseFloat(injectAmount);
    if (isNaN(amount) || amount <= 0) return;
    ctxInject(amount);
    setInjectAmount('');
  };

  return (
    <div className="space-y-3">
      <div className="text-xs font-bold text-foreground">Capital Pools</div>
      <div className="text-xs space-y-1.5">
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">Trading Pool</span>
          <span className="font-bold tabular-nums">{fmt(capital.tradingPool, true)}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">Available</span>
          <span className="font-bold tabular-nums">{fmt(capital.availableCapital, true)}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">Reserve Pool</span>
          <span className="font-bold tabular-nums">{fmt(capital.reservePool, true)}</span>
        </div>
        <div className="flex justify-between gap-4 pt-1.5 border-t border-border/50">
          <span className="text-muted-foreground">Net Worth</span>
          <span className="font-bold tabular-nums">{fmt(capital.netWorth, true)}</span>
        </div>
      </div>
      <div className="pt-2 border-t border-border/50 space-y-2">
        <div className="text-xs font-bold text-foreground">Inject Capital</div>
        <p className="text-[0.6875rem] text-muted-foreground">
          New capital is split 75% Trading / 25% Reserve.
        </p>
        <input
          type="number"
          placeholder="Amount (₹)"
          value={injectAmount}
          onChange={(e) => setInjectAmount(e.target.value)}
          className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm tabular-nums focus:outline-none focus:ring-1 focus:ring-primary"
          min="1"
          step="1000"
        />
        <div className="flex gap-2">
          <button
            onClick={handleInject}
            disabled={injectPending || !injectAmount}
            className="flex-1 flex items-center justify-center gap-1 px-3 py-1.5 rounded-md text-xs font-bold bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 transition-colors"
          >
            {injectPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <><Plus className="h-3 w-3" /> Inject</>
            )}
          </button>
        </div>
        {injectAmount && parseFloat(injectAmount) > 0 && (
          <div className="text-[0.6875rem] text-muted-foreground space-y-0.5">
            <div>Trading Pool: +{fmt(parseFloat(injectAmount) * 0.75)}</div>
            <div>Reserve Pool: +{fmt(parseFloat(injectAmount) * 0.25)}</div>
          </div>
        )}
      </div>
    </div>
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
  const [testingMode, setTestingMode] = useState<'live' | 'paper'>('paper');
  const tableContainerRef = useRef<HTMLDivElement>(null);
  const [highlightedDay, setHighlightedDay] = useState<number | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
  }>({ open: false, title: '', message: '', onConfirm: () => {} });
  const { getTick } = useTickStream(liveTicksEnabled);
  const todayRef = useRef<HTMLTableRowElement>(null);
  const feedSubscribeMutation = trpc.broker.feed.subscribe.useMutation();

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

  const getLiveLtp = useCallback((trade: { instrument: string; contractSecurityId?: string | null }): number | undefined => {
    if (trade.contractSecurityId) {
      const exchange = (trade.instrument.includes('CRUDE') || trade.instrument.includes('NATURAL'))
        ? 'MCX_COMM'
        : 'NSE_FNO';
      return getTick(exchange, trade.contractSecurityId)?.ltp;
    }

    const resolvedName = UI_TO_RESOLVED[trade.instrument] ?? trade.instrument;
    const feed = feedLookup.get(resolvedName);
    if (!feed) return undefined;
    return getTick(feed.exchange, feed.securityId)?.ltp;
  }, [feedLookup, getTick]);

  // ─── Data from global CapitalContext (single source of truth) ──
  const isLive = capitalReady;
  const isLoading = capitalLoading;
  const canManageTrades = supportsManualControls(workspace);


  // ─── Auto-scroll to today on load and on tab switch ────────
  const prevWorkspaceRef = useRef(workspace);
  useEffect(() => {
    if (!capitalReady) return;
    // Use instant scroll on tab switch (no animation flicker)
    const isTabSwitch = prevWorkspaceRef.current !== workspace;
    prevWorkspaceRef.current = workspace;
    const frame = requestAnimationFrame(() => {
      if (todayRef.current) {
        todayRef.current.scrollIntoView({
          behavior: isTabSwitch ? 'instant' : 'smooth',
          block: 'center',
        });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [capitalReady, allDays.length, workspace]);

  // ─── Subscribe option security IDs to live feed ────────────
  const subscribeOptionFeed = useCallback((instrument: string, contractSecurityId: string) => {
    const exchange = (instrument.includes('CRUDE') || instrument.includes('NATURAL'))
      ? 'MCX_COMM'
      : 'NSE_FNO';
    feedSubscribeMutation.mutate({
      instruments: [{ exchange, securityId: contractSecurityId, mode: 'full' }],
    });
  }, [feedSubscribeMutation]);

  // Re-subscribe open option trades on load (handles page reload)
  const subscribedOnLoadRef = useRef(false);
  useEffect(() => {
    if (!capitalReady || subscribedOnLoadRef.current) return;
    subscribedOnLoadRef.current = true;
    const openTrades = ctxCurrentDay?.trades?.filter((t: any) => t.status === 'OPEN' && t.contractSecurityId) ?? [];
    if (openTrades.length === 0) return;
    feedSubscribeMutation.mutate({
      instruments: openTrades.map((t: any) => ({
        exchange: (t.instrument.includes('CRUDE') || t.instrument.includes('NATURAL')) ? 'MCX_COMM' : 'NSE_FNO',
        securityId: t.contractSecurityId,
        mode: 'full',
      })),
    });
  }, [capitalReady, ctxCurrentDay, feedSubscribeMutation]);

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
        const ltp = getLiveLtp(trade);
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
    qty: number;
    lotSize?: number;
    contractSecurityId?: string | null;
    targetPrice?: number | null;
    stopLossPrice?: number | null;
    trailingStopEnabled?: boolean;
  }) => {
    ctxPlaceTrade({
      instrument: trade.instrument,
      type: trade.type,
      strike: trade.strike,
      expiry: trade.expiry,
      entryPrice: trade.entryPrice,
      capitalPercent: trade.capitalPercent,
      qty: trade.qty,
      lotSize: trade.lotSize,
      contractSecurityId: trade.contractSecurityId,
      targetPrice: trade.targetPrice,
      stopLossPrice: trade.stopLossPrice,
      trailingStopEnabled: trade.trailingStopEnabled,
    });
    // Subscribe the option's security ID to the live feed so LTP keeps updating after form closes
    if (trade.contractSecurityId) {
      subscribeOptionFeed(trade.instrument, trade.contractSecurityId);
    }
  }, [ctxPlaceTrade, subscribeOptionFeed]);

  const handleExitTrade = useCallback((tradeId: string, instrument: string) => {
    const trade = ctxCurrentDay?.trades?.find((t: any) => t.id === tradeId);
    const liveLtp = trade ? getLiveLtp(trade) : undefined;
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
          const liveLtp = getLiveLtp(trade);
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

  const clearWorkspaceMutation = trpc.capital.clearWorkspace.useMutation({
    onSuccess: () => refetchAll(),
  });

  const handleClearTesting = useCallback(() => {
    setConfirmDialog({
      open: true,
      title: 'Clear Testing Data',
      message: 'This will delete ALL trades and reset the Testing workspace to zero. This cannot be undone.',
      onConfirm: () => {
        clearWorkspaceMutation.mutate({ workspace: 'paper_manual', initialFunding: capital.tradingPool + capital.reservePool || 100000 });
        setConfirmDialog(prev => ({ ...prev, open: false }));
      },
    });
  }, [capital, clearWorkspaceMutation]);

  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scrollToDay = useCallback((dayIndex: number) => {
    const container = tableContainerRef.current;
    if (!container) return;
    const row = container.querySelector<HTMLElement>(`[data-day="${dayIndex}"]`);
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightedDay(dayIndex);
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => setHighlightedDay(null), 1500);
  }, []);

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
      {/* Tab bar moved to AppBar — workspace tabs are now in the top bar */}

      {/* ─── Summary Bar ──────────────────────────────────────── */}
      <div className="flex items-stretch divide-x divide-border border-b border-border bg-secondary backdrop-blur-sm">
        {/* Available Fund */}
        <div className="px-3 py-1.5 flex flex-col items-center justify-center">
          <span className="text-[0.5rem] text-muted-foreground tracking-widest uppercase">Available</span>
          <span className="text-xs font-bold tabular-nums text-info-cyan">{fmt(capital.availableCapital, true)}</span>
        </div>
        {/* Today P&L — center-zero progress bar with marker */}
        <div className="px-3 py-1.5 flex flex-col justify-center flex-1 min-w-[220px]">
          {(() => {
            const target = capital.todayTarget || 1;
            const maxLoss = target; // symmetric: max loss = target amount
            const pnl = capital.todayPnl;
            const pct = Math.min(Math.max(pnl / target, -1), 1);
            const markerLeft = ((pct + 1) / 2) * 100; // map -1..+1 to 0%..100%
            return (
              <>
                {/* Labels: -MaxLoss | P&L value | Target */}
                <div className="flex items-center justify-between w-full mb-1">
                  <span className="text-[0.5rem] font-bold tabular-nums text-destructive">
                    -{fmt(maxLoss)}
                  </span>
                  <div className="flex items-center gap-1">
                    <span className={`text-xs font-bold tabular-nums ${pnlColor(pnl)}`}>
                      {fmt(pnl)}
                    </span>
                    {canManageTrades && openTradeCount > 0 && (
                      <button
                        onClick={handleExitAll}
                        className="px-1 py-0.5 rounded font-bold bg-destructive/15 text-destructive hover:bg-destructive/25 transition-colors"
                        title="Exit all open positions"
                      >
                        ×
                      </button>
                    )}
                  </div>
                  <span className="text-[0.5rem] font-bold tabular-nums text-warning-amber">
                    +{fmt(target)}
                  </span>
                </div>
                {/* Bar: left edge = -maxLoss, center = 0, right edge = +target */}
                <div className="relative w-full h-2.5 rounded-full bg-muted-foreground/20">
                  {/* Center line (zero) */}
                  <div className="absolute top-0 bottom-0 left-1/2 w-px bg-foreground/30 z-[1]" />
                  {/* Fill from center towards current P&L */}
                  {pnl >= 0 ? (
                    <div
                      className="absolute top-0 bottom-0 left-1/2 rounded-r-full bg-bullish transition-all duration-500"
                      style={{ width: `${pct * 50}%` }}
                    />
                  ) : (
                    <div
                      className="absolute top-0 bottom-0 right-1/2 rounded-l-full bg-destructive transition-all duration-500"
                      style={{ width: `${Math.abs(pct) * 50}%` }}
                    />
                  )}
                  {/* Current position marker */}
                  <div
                    className={`absolute top-1/2 -translate-y-1/2 h-4 w-4 rounded-full border-2 border-background shadow-md z-[2] transition-all duration-500 ${
                      pnl >= 0 ? 'bg-bullish' : 'bg-destructive'
                    }`}
                    style={{ left: `${markerLeft}%`, marginLeft: '-8px' }}
                  />
                </div>
                {/* Bottom label: 0 at center */}
                <div className="flex items-center justify-center w-full mt-0.5">
                  <span className="text-[0.4375rem] text-foreground/40 tabular-nums">0</span>
                </div>
              </>
            );
          })()}
        </div>
        {/* Reserve + Net Worth moved to MainFooter Net Worth popover */}
      </div>

      {/* Mutation Error */}
      {/* Mutation errors are handled by the global CapitalContext */}

      {/* ─── Table ────────────────────────────────────────────── */}
      <div className="flex-1 relative overflow-hidden" style={{ contentVisibility: 'auto' }}>
      <div ref={tableContainerRef} className={`h-full overflow-auto scrollbar-thin transition-opacity duration-150 ${
        workspace === 'live' ? 'scrollbar-bullish' :
        workspace === 'paper_manual' ? 'scrollbar-amber' :
        'scrollbar-violet'
      }`}>
        {allDays.length === 0 && !capitalLoading ? (
          <NoCapitalEmpty onOpenSettings={() => {
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2' }));
          }} />
        ) : (
          <table className="w-full table-fixed border-collapse text-xs [&_td]:align-middle [&_td]:whitespace-nowrap [&_th]:align-middle [&_th]:whitespace-nowrap [&_tbody_tr:nth-child(even)]:bg-background/50 [&_tbody_tr]:hover:bg-muted/30 [&_tbody_tr]:border-b [&_tbody_tr]:border-border">
            <colgroup>
              <col style={{ width: '2.25rem',  maxWidth: '2.25rem' }} />   {/* Day: "250" */}
              <col style={{ width: '5.625rem', maxWidth: '5.625rem' }} />  {/* Date: 90px */}
              <col style={{ width: '4.5rem',   maxWidth: '4.5rem' }} />    {/* Capital */}
              <col style={{ width: '5.625rem', maxWidth: '5.625rem' }} />  {/* Profit+: 90px */}
              <col style={{ width: '4.5rem',   maxWidth: '4.5rem' }} />    {/* Capital+ */}
              <col />                                                       {/* Instrument */}
              <col style={{ width: '4.5rem',   maxWidth: '4.5rem' }} />    {/* Entry */}
              <col style={{ width: '4.5rem',   maxWidth: '4.5rem' }} />    {/* LTP */}
              <col style={{ width: '2.5rem',   maxWidth: '2.5rem' }} />    {/* Lot: 40px */}
              <col style={{ width: '4.5rem',   maxWidth: '4.5rem' }} />    {/* Invested */}
              <col style={{ width: '5.625rem', maxWidth: '5.625rem' }} />  {/* P&L: 90px */}
              <col style={{ width: '3.625rem', maxWidth: '3.625rem' }} />  {/* P&L % */}
              <col style={{ width: '4.5rem',   maxWidth: '4.5rem' }} />    {/* Capital */}
              <col style={{ width: '5.625rem', maxWidth: '5.625rem' }} />  {/* Dev.: 90px */}
              <col style={{ width: '2rem',     maxWidth: '2rem' }} />      {/* Rating */}
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
                <th className="px-2 py-2 text-right font-bold text-muted-foreground border-r border-border">P&amp;L</th>
                <th className="px-2 py-2 text-right font-bold text-muted-foreground border-r border-border">P&amp;L %</th>
                <th className="px-2 py-2 text-right font-bold text-muted-foreground border-r border-border">Capital</th>
                <th className="px-2 py-2 text-right font-bold text-muted-foreground border-r border-border">Dev.</th>
                <th className="px-2 py-2 text-center font-bold text-muted-foreground w-16 border-r border-border">Rating</th>
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
                  // ─── FUTURE: projected row ─────────────────
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

                // ─── PAST / GIFT: single summary row ────────
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

      {/* ─── Quick Jump Overlay ───────────────────────────────── */}
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
  highlighted = false,
}: {
  day: DayRecord;
  showNet: boolean;
  workspace: Workspace;
  highlighted?: boolean;
}) {
  const theme = getWorkspaceThemeMeta(workspace);

  const pnlValue = showNet ? day.totalPnl : day.totalPnl + day.totalCharges;
  const pnlPercent = day.tradeCapital > 0 ? (day.totalPnl / day.tradeCapital * 100).toFixed(1) : '0.0';
  const dateLabel = formatDateAgeLabel(day.date || '', day.openedAt);

  return (
    <tr data-day={day.dayIndex} className={`border-b border-border transition-colors text-muted-foreground ${
      highlighted ? 'bg-warning-amber/20 outline outline-1 outline-warning-amber/60' : 'hover:bg-muted/30'
    }`}>
      {/* Day */}
      <td className="px-2 py-2 text-right border-r border-border">
        <span className="font-bold tabular-nums">{day.dayIndex}</span>
      </td>
      {/* Date + Age */}
      <td className="px-2 py-2 text-right border-r border-border">
        <span className="block truncate tabular-nums">{dateLabel}</span>
      </td>
      {/* Trade Capital */}
      <td className="px-2 py-2 text-right tabular-nums border-r border-border">
        {fmt(day.tradeCapital, true)}
      </td>
      {/* Target */}
      <td className="px-2 py-2 text-right tabular-nums border-r border-border">
        {fmt(day.targetAmount)}
        <span className="text-[0.5rem] ml-0.5">({day.targetPercent}%)</span>
      </td>
      {/* Proj Capital */}
      <td className="px-2 py-2 text-right tabular-nums border-r border-border">
        {fmt(day.projCapital, true)}
      </td>
      {/* Instrument — color-coded tags */}
      <td className="px-2 py-2 text-right border-r border-border">
        <div className="flex max-w-full items-center justify-end gap-1 overflow-hidden whitespace-nowrap">
          {day.instruments.length > 0
            ? day.instruments.map((inst) => <InstrumentTag key={inst} name={inst} />)
            : null
          }
        </div>
      </td>
      {/* Entry */}
      <td className="px-2 py-2 text-right border-r border-border"></td>
      {/* LTP */}
      <td className="px-2 py-2 text-right border-r border-border"></td>
      {/* Qty */}
      <td className="px-2 py-2 text-right tabular-nums border-r border-border">
        {day.totalQty > 0 ? day.totalQty : ''}
      </td>
      {/* Capital */}
      <td className="px-2 py-2 text-right border-r border-border"></td>
      {/* P&L */}
      <td className={`px-2 py-2 text-right tabular-nums font-bold border-r border-border ${pnlColor(pnlValue)}`}>
        {fmt(pnlValue, false)}
      </td>
      {/* P&L % */}
      <td className={`px-2 py-2 text-right tabular-nums border-r border-border ${pnlColor(pnlValue)}`}>
        {pnlPercent}%
      </td>
      {/* Capital */}
      <td className="px-2 py-2 text-right tabular-nums font-medium border-r border-border">
        {day.actualCapital > 0 ? fmt(day.actualCapital, true) : ''}
      </td>
      {/* Deviation */}
      <td className={`px-2 py-2 text-right tabular-nums border-r border-border ${pnlColor(day.deviation)}`}>
        {day.actualCapital > 0
          ? formatDeviation(day.deviation)
          : ''}
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
  allDays,
}: {
  day: DayRecord;
  capital: CapitalState;
  showNet: boolean;
  onExitTrade: (tradeId: string, instrument: string) => void;
  onExitAll: () => void;
  onPlaceTrade: (trade: any) => Promise<void>;
  exitLoading?: boolean;
  placeLoading?: boolean;
  getLiveLtp: (trade: TradeRecord) => number | undefined;
  todayRef: React.RefObject<HTMLTableRowElement | null>;
  workspace: Workspace;
  resolvedInstruments?: ResolvedInstrument[];
  allDays: DayRecord[];
}) {
  const [showNewTradeForm, setShowNewTradeForm] = useState(false);
  const updateTradeMutation = trpc.capital.updateTrade.useMutation();
  const utils = trpc.useUtils();
  const handleUpdateTpSl = useCallback((tradeId: string, patch: { targetPrice?: number; stopLossPrice?: number; trailingStopEnabled?: boolean }) => {
    updateTradeMutation.mutate(
      { workspace, tradeId, ...patch },
      { onSuccess: () => utils.capital.allDays.invalidate() }
    );
  }, [updateTradeMutation, workspace, utils]);

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

  // Find last closed trade for "Repeat Last Order" button
  const getLastClosedTrade = useCallback(() => {
    for (let i = allDays.length - 1; i >= 0; i--) {
      const dayTrades = allDays[i].trades ?? [];
      for (let j = dayTrades.length - 1; j >= 0; j--) {
        const trade = dayTrades[j];
        if (trade.status === 'CLOSED' || trade.status === 'EXITED') {
          return trade;
        }
      }
    }
    return null;
  }, [allDays]);

  const handleRepeatLastOrder = useCallback(() => {
    const lastTrade = getLastClosedTrade();
    if (!lastTrade) return;

    // Get current LTP for the instrument
    const currentLtp = getLiveLtp(lastTrade) ?? lastTrade.ltp ?? lastTrade.entryPrice;
    if (currentLtp <= 0) return;

    // Repeat the trade with current LTP as entry price
    onPlaceTrade({
      instrument: lastTrade.instrument,
      type: lastTrade.type,
      strike: lastTrade.strike,
      expiry: lastTrade.expiry || '',
      entryPrice: currentLtp,
      capitalPercent: lastTrade.capitalPercent,
      qty: lastTrade.qty,
      lotSize: lastTrade.lotSize,
      contractSecurityId: lastTrade.contractSecurityId,
    });
  }, [getLastClosedTrade, getLiveLtp, onPlaceTrade]);

  const lastClosedTrade = getLastClosedTrade();

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
            onUpdateTpSl={handleUpdateTpSl}
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
      <tr data-day={day.dayIndex} className={`border-y font-bold ${theme.summaryBorder} ${theme.summaryBg}`} ref={trades.length === 0 ? todayRef : undefined}>
        <td className="px-2 py-2 border-r border-border" />
        <td className="px-2 py-2 border-r border-border" />
        <td className="px-2 py-2 border-r border-border" />
        <td className="px-2 py-2 border-r border-border" />
        <td className="px-2 py-2 border-r border-border" />
        <td className="px-2 py-2 border-r border-border">
          <div className="flex items-center justify-end gap-2">
            {!canManageTrades && (
              <span className="text-[0.5625rem] italic text-muted-foreground">AI managed</span>
            )}
            {canManageTrades && openTrades.length > 0 && (
              <button
                onClick={onExitAll}
                className="shrink-0 px-1 py-0.5 rounded font-bold bg-destructive/15 text-destructive hover:bg-destructive/25 transition-colors"
                title="Exit all open positions"
              >
                ×
              </button>
            )}
            {canManageTrades && lastClosedTrade && (
              <button
                onClick={handleRepeatLastOrder}
                className="px-1.5 py-0.5 rounded font-bold bg-info-cyan/15 text-info-cyan hover:bg-info-cyan/25 transition-colors"
                title={`Repeat last ${lastClosedTrade.instrument} trade at current LTP`}
              >
                ↻
              </button>
            )}
            {canManageTrades && (
              <button
                onClick={() => setShowNewTradeForm(prev => !prev)}
                className={`px-2 py-0.5 rounded font-bold tracking-wider transition-colors ${
                  showNewTradeForm
                    ? theme.buttonActive
                    : theme.button
                }`}
              >
                {showNewTradeForm ? '- CANCEL' : '+ NEW TRADE'}
              </button>
            )}
          </div>
        </td>
        <td className="px-2 py-2 border-r border-border" />
        <td className="px-2 py-2 border-r border-border" />
        <td className="px-2 py-2 text-right tabular-nums text-foreground border-r border-border">
          {day.totalQty > 0 ? day.totalQty : ''}
        </td>
        <td className="px-2 py-2 text-right tabular-nums text-foreground border-r border-border">
          {trades.length > 0 ? fmt(trades.reduce((s, t) => s + t.entryPrice * t.qty, 0)) : ''}
        </td>
        <td className={`px-2 py-2 text-right tabular-nums border-r border-border ${pnlColor(totalPnl)}`}>
          {fmt(totalPnl, false)}
        </td>
        <td className="px-2 py-2 border-r border-border" />
        <td className="px-2 py-2 text-right tabular-nums font-medium text-foreground border-r border-border">
          {day.actualCapital > 0 ? fmt(day.actualCapital, true) : fmt(day.tradeCapital, true)}
        </td>
        <td className={`px-2 py-2 text-right tabular-nums border-r border-border ${pnlColor(day.deviation)}`}>
          {formatDeviation(day.deviation)}
        </td>
        <td className="px-2 py-2" />
      </tr>
      <tr className="hidden border-y border-warning-amber/30 bg-warning-amber/10 bg-muted/20 font-bold">
        {/* Day */}
        <td className="px-2 py-2 text-warning-amber border-r border-border" colSpan={2}>
          DAY {day.dayIndex} TOTAL
        </td>
        {/* Trade Capital */}
        <td className="px-2 py-2 border-r border-border" />
        {/* Target */}
        <td className="px-2 py-2 border-r border-border" />
        {/* Proj Capital */}
        <td className="px-2 py-2 border-r border-border" />
        {/* Instrument — + NEW TRADE button (manual workspaces only) */}
        <td className="px-2 py-2 border-r border-border" colSpan={3}>
          <div className="flex items-center justify-start gap-2">
            {canManageTrades && lastClosedTrade && (
              <button
                onClick={handleRepeatLastOrder}
                className="px-1.5 py-0.5 rounded font-bold bg-info-cyan/15 text-info-cyan hover:bg-info-cyan/25 transition-colors"
                title={`Repeat last ${lastClosedTrade.instrument} trade at current LTP`}
              >
                ↻
              </button>
            )}
            {canManageTrades ? (
              <button
                onClick={() => setShowNewTradeForm(prev => !prev)}
                className={`px-2 py-0.5 rounded font-bold tracking-wider transition-colors ${
                  showNewTradeForm
                    ? 'bg-warning-amber/20 text-warning-amber'
                    : `${theme.button}`
                }`}
              >
                {showNewTradeForm ? '− CANCEL' : '+ NEW TRADE'}
              </button>
            ) : (
              <span className="text-[0.5625rem] text-muted-foreground/50 italic">AI managed</span>
            )}
          </div>
        </td>
        {/* Qty */}
        <td className="px-2 py-2 text-right tabular-nums text-foreground border-r border-border">
          {day.totalQty > 0 ? day.totalQty : ''}
        </td>
        {/* Capital */}
        <td className="px-2 py-2 text-right tabular-nums text-foreground border-r border-border">
          {trades.length > 0 ? fmt(trades.reduce((s, t) => s + t.entryPrice * t.qty, 0)) : ''}
        </td>
        {/* P&L */}
        <td className={`px-2 py-2 text-right tabular-nums border-r border-border ${pnlColor(totalPnl)}`}>
          {fmt(totalPnl, false)}
        </td>
        {/* P&L % */}
        <td className="px-2 py-2 border-r border-border" />
        {/* Capital */}
        <td className="px-2 py-2 text-right tabular-nums text-warning-amber border-r border-border">
          {day.actualCapital > 0 ? fmt(day.actualCapital, true) : fmt(day.tradeCapital, true)}
        </td>
        {/* Deviation */}
        <td className={`px-2 py-2 text-right tabular-nums border-r border-border ${pnlColor(day.deviation)}`}>
          {formatDeviation(day.deviation)}
        </td>
        {/* Rating */}
        <td className="px-2 py-2" />
      </tr>
    </>
  );
}

// ─── TP/SL helpers (stable — defined outside TodayTradeRow to prevent remount flicker) ──

function pctFromPrice(field: 'sl' | 'tp', isBuy: boolean, entryPrice: number, price: number): number {
  if (!price || !entryPrice) return 0;
  if (field === 'tp') return isBuy ? (price - entryPrice) / entryPrice * 100 : (entryPrice - price) / entryPrice * 100;
  return isBuy ? (entryPrice - price) / entryPrice * 100 : (price - entryPrice) / entryPrice * 100;
}

function TpSlMergedBody({
  isBuy, entryPrice,
  slPrice, setSlPrice,
  tpPrice, setTpPrice,
  trailingStopEnabled, setTrailingStopEnabled,
  onCommit, onCancel,
}: {
  isBuy: boolean;
  entryPrice: number;
  slPrice: string;
  setSlPrice: (v: string) => void;
  tpPrice: string;
  setTpPrice: (v: string) => void;
  trailingStopEnabled: boolean;
  setTrailingStopEnabled: (v: boolean) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const slVal = parseFloat(slPrice);
  const tpVal = parseFloat(tpPrice);
  const slPct = slVal > 0 ? pctFromPrice('sl', isBuy, entryPrice, slVal) : null;
  const tpPct = tpVal > 0 ? pctFromPrice('tp', isBuy, entryPrice, tpVal) : null;

  return (
    <div className="space-y-2">
      {/* SL row */}
      <div className="flex items-center gap-2">
        <span className="text-[0.625rem] font-bold text-destructive w-5 shrink-0">SL</span>
        <input
          autoFocus
          type="number"
          step="0.05"
          min="0"
          value={slPrice}
          onChange={e => setSlPrice(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') onCommit(); if (e.key === 'Escape') onCancel(); }}
          className="flex-1 min-w-0 px-2 py-1 tabular-nums rounded border border-destructive/40 bg-background text-foreground outline-none focus:border-destructive"
          placeholder="price"
        />
        <span className="text-[0.5625rem] text-muted-foreground tabular-nums w-10 text-right shrink-0">
          {slPct != null && isFinite(slPct) ? `${slPct.toFixed(1)}%` : ''}
        </span>
      </div>
      {/* TP row */}
      <div className="flex items-center gap-2">
        <span className="text-[0.625rem] font-bold text-bullish w-5 shrink-0">TP</span>
        <input
          type="number"
          step="0.05"
          min="0"
          value={tpPrice}
          onChange={e => setTpPrice(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') onCommit(); if (e.key === 'Escape') onCancel(); }}
          className="flex-1 min-w-0 px-2 py-1 tabular-nums rounded border border-bullish/40 bg-background text-foreground outline-none focus:border-bullish"
          placeholder="price"
        />
        <span className="text-[0.5625rem] text-muted-foreground tabular-nums w-10 text-right shrink-0">
          {tpPct != null && isFinite(tpPct) ? `${tpPct.toFixed(1)}%` : ''}
        </span>
      </div>
      {/* Trailing Stop Toggle */}
      <div className="flex items-center gap-2 pt-1 border-t border-border/30">
        <span className="text-[0.625rem] font-bold text-muted-foreground flex-1">Trailing SL</span>
        <button
          onClick={() => setTrailingStopEnabled(!trailingStopEnabled)}
          className={`px-2 py-1 rounded font-bold transition-colors ${
            trailingStopEnabled
              ? 'bg-bullish/20 text-bullish'
              : 'bg-muted/30 text-muted-foreground hover:bg-muted/50'
          }`}
        >
          {trailingStopEnabled ? 'ON' : 'OFF'}
        </button>
      </div>
      {/* Buttons */}
      <div className="flex gap-1.5 pt-1">
        <button
          onClick={onCommit}
          className="flex-1 py-1 rounded font-bold bg-primary/15 text-primary hover:bg-primary/25 transition-colors"
        >Apply</button>
        <button
          onClick={onCancel}
          className="flex-1 py-1 rounded text-muted-foreground hover:bg-muted/50 transition-colors"
        >Cancel</button>
      </div>
    </div>
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
  onUpdateTpSl,
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
  onUpdateTpSl: (tradeId: string, patch: { targetPrice?: number; stopLossPrice?: number; trailingStopEnabled?: boolean }) => void;
  getLiveLtp: (trade: TradeRecord) => number | undefined;
  todayRef?: React.RefObject<HTMLTableRowElement | null>;
  canManageTrades: boolean;
  workspace: Workspace;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [slPrice, setSlPrice] = useState('');
  const [tpPrice, setTpPrice] = useState('');
  const [trailingStopEnabled, setTrailingStopEnabled] = useState(trade.trailingStopEnabled ?? false);
  const theme = getWorkspaceThemeMeta(workspace);
  const isOpen = trade.status === 'OPEN';
  const isPending = trade.status === 'PENDING';
  const isBuy = trade.type.includes('BUY');
  const liveLtp = isOpen ? getLiveLtp(trade) : undefined;
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
      className={`border-b border-border transition-colors ${
        isFirst
          ? `${theme.todayBg} border-l-2 ${theme.borderStrong}`
          : `${theme.todayAltBg} border-l-2 ${theme.borderSoft}`
      } ${pnl > 0 ? 'text-bullish/60' : pnl < 0 ? 'text-destructive/60' : 'text-foreground'}`}
    >
      {/* Day */}
      <td className="px-2 py-1.5 text-right border-r border-border">
        {isFirst ? (
          <span className="font-bold tabular-nums text-foreground">{day.dayIndex}</span>
        ) : (
          <span className="tabular-nums">{day.dayIndex}</span>
        )}
      </td>
      {/* Date + Age */}
      <td className="px-2 py-1.5 text-right border-r border-border">
        <span className="block truncate tabular-nums">
          {cycleDateLabel}
        </span>
      </td>
      {/* Trade Capital */}
      <td className="px-2 py-1.5 text-right tabular-nums border-r border-border">
        {fmt(day.tradeCapital, true)}
      </td>
      {/* Target */}
      <td className="px-2 py-1.5 text-right tabular-nums border-r border-border">
        {fmt(day.targetAmount)}
        <span className="text-[0.5rem] ml-0.5">({day.targetPercent}%)</span>
      </td>
      {/* Proj Capital */}
      <td className="px-2 py-1.5 text-right tabular-nums border-r border-border">
        {fmt(day.projCapital, true)}
      </td>
      {/* Instrument — merged with type info: Instrument | Expiry | Strike | CE/PE | B/S | Exit */}
      <td className="px-2 py-1.5 text-right border-r border-border">
        <div className="flex items-center justify-between gap-1.5">
          <div className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap min-w-0">
            <InstrumentTag name={trade.instrument} />
            {expiryLabel && (
              <>
                <span className="text-border">|</span>
                <span className="text-[0.5625rem] tabular-nums">{expiryLabel}</span>
              </>
            )}
            {trade.strike !== null && (
              <>
                <span className="text-border">|</span>
                <span className="text-[0.5625rem] tabular-nums">{trade.strike}</span>
              </>
            )}
            <span className="text-border">|</span>
            <span className={`text-[0.5625rem] font-bold ${theme.buttonActive} rounded px-1 py-0.5`}>{contractLabel}</span>
            <span className="text-border">|</span>
            <span className={`text-[0.5625rem] font-semibold ${isBuy ? 'text-bullish' : 'text-destructive'}`}>{directionLabel}</span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {isOpen && (
              <span className="text-[0.5rem] text-muted-foreground/60 tabular-nums">
                {formatAge(trade.openedAt)}
              </span>
            )}
            {isOpen && canManageTrades && (
              <button
                onClick={(e) => { e.stopPropagation(); onExit(); }}
                disabled={exitLoading}
                className="px-1 py-0.5 rounded font-bold transition-colors bg-destructive/15 text-destructive hover:bg-destructive/25 disabled:opacity-30"
                title="Exit position"
              >
                {exitLoading ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : '×'}
              </button>
            )}
          </div>
        </div>
      </td>
      {/* Entry */}
      <td className="px-2 py-1.5 text-right tabular-nums border-r border-border">
        {trade.entryPrice.toFixed(2)}
      </td>
      {/* LTP — hover shows SL/TP/TSL, click to edit */}
      <td className="px-2 py-1.5 text-right border-r border-border">
        <Popover open={editOpen} onOpenChange={open => { if (!open) setEditOpen(false); }}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <span
                  className={`font-bold tabular-nums cursor-pointer ${isOpen ? (displayLtp >= trade.entryPrice ? 'text-bullish' : 'text-destructive') : pnlColor(pnl)}`}
                  onClick={() => {
                    if (!isOpen || !canManageTrades) return;
                    setSlPrice(trade.stopLossPrice?.toFixed(2) ?? '');
                    setTpPrice(trade.targetPrice?.toFixed(2) ?? '');
                    setTrailingStopEnabled(trade.trailingStopEnabled ?? false);
                    setEditOpen(true);
                  }}
                >
                  {isOpen ? displayLtp.toFixed(2) : (trade.exitPrice?.toFixed(2) ?? '')}
                  {isOpen && liveLtp !== undefined && (
                    <span className="ml-0.5 inline-block h-1 w-1 rounded-full bg-bullish animate-pulse" />
                  )}
                </span>
              </PopoverTrigger>
            </TooltipTrigger>
            {isOpen && (trade.stopLossPrice != null || trade.targetPrice != null) && (
              <TooltipContent side="top">
                <div className="text-[0.625rem] space-y-0.5 tabular-nums">
                  {trade.stopLossPrice != null && (
                    <div className="flex justify-between gap-3">
                      <span className="text-destructive font-bold">{trade.trailingStopEnabled ? 'TSL' : 'SL'}</span>
                      <span className="text-destructive">
                        {trade.stopLossPrice.toFixed(2)}
                        <span className="ml-1 text-destructive/70">
                          ({pctFromPrice('sl', isBuy, trade.entryPrice, trade.stopLossPrice).toFixed(1)}%)
                        </span>
                      </span>
                    </div>
                  )}
                  {trade.targetPrice != null && (
                    <div className="flex justify-between gap-3">
                      <span className="text-bullish font-bold">TP</span>
                      <span className="text-bullish">
                        {trade.targetPrice.toFixed(2)}
                        <span className="ml-1 text-bullish/70">
                          ({pctFromPrice('tp', isBuy, trade.entryPrice, trade.targetPrice).toFixed(1)}%)
                        </span>
                      </span>
                    </div>
                  )}
                </div>
              </TooltipContent>
            )}
          </Tooltip>
          <PopoverContent className="w-56 p-3" align="center" side="top">
            <TpSlMergedBody
              isBuy={isBuy}
              entryPrice={trade.entryPrice}
              slPrice={slPrice}
              setSlPrice={setSlPrice}
              tpPrice={tpPrice}
              setTpPrice={setTpPrice}
              trailingStopEnabled={trailingStopEnabled}
              setTrailingStopEnabled={setTrailingStopEnabled}
              onCommit={() => {
                const sl = parseFloat(slPrice);
                const tp = parseFloat(tpPrice);
                const patch: { stopLossPrice?: number; targetPrice?: number; trailingStopEnabled?: boolean } = {};
                if (sl > 0) patch.stopLossPrice = Math.round(sl * 100) / 100;
                if (tp > 0) patch.targetPrice = Math.round(tp * 100) / 100;
                if (trailingStopEnabled !== (trade.trailingStopEnabled ?? false)) patch.trailingStopEnabled = trailingStopEnabled;
                if (Object.keys(patch).length > 0) onUpdateTpSl(trade.id, patch);
                setEditOpen(false);
              }}
              onCancel={() => setEditOpen(false)}
            />
          </PopoverContent>
        </Popover>
      </td>
      {/* Lot */}
      <td className="px-2 py-1.5 text-right tabular-nums font-medium border-r border-border">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-default">
              {trade.lotSize && trade.lotSize > 1 ? Math.floor(trade.qty / trade.lotSize) : trade.qty}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">
            <div className="text-[0.625rem] space-y-0.5 tabular-nums">
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Lots</span>
                <span className="font-bold">{trade.lotSize && trade.lotSize > 1 ? Math.floor(trade.qty / trade.lotSize) : 1}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Lot Size</span>
                <span className="font-bold">{trade.lotSize || 1}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Total Units</span>
                <span className="font-bold">{trade.qty}</span>
              </div>
            </div>
          </TooltipContent>
        </Tooltip>
      </td>
      {/* Invested */}
      <td className="px-2 py-1.5 text-right tabular-nums border-r border-border">
        {fmt(trade.entryPrice * trade.qty)}
      </td>
      {/* P&L */}
      <td className={`px-2 py-1.5 text-right tabular-nums font-bold border-r border-border ${pnlColor(pnl)}`}>
        {fmt(pnl, false)}
      </td>
      {/* P&L % */}
      <td className={`px-2 py-1.5 text-right tabular-nums border-r border-border ${pnlColor(pnl)}`}>
        {pnlPercent >= 0 ? '+' : ''}{pnlPercent.toFixed(1)}%
      </td>
      {/* Capital */}
      <td className="px-2 py-1.5 border-r border-border" />
      {/* Deviation */}
      <td className="px-2 py-1.5 border-r border-border" />
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
  highlighted = false,
}: {
  day: DayRecord;
  isDay250: boolean;
  workspace: Workspace;
  highlighted?: boolean;
}) {
  return (
    <tr data-day={day.dayIndex} className={`border-b border-border transition-colors ${
      highlighted ? 'bg-warning-amber/20 outline outline-1 outline-warning-amber/60' : 'bg-background/30'
    } ${isDay250 ? 'opacity-90' : 'opacity-[0.55]'}`}>
      {/* Day */}
      <td className="px-2 py-2 text-right border-r border-border">
        <span className="font-bold tabular-nums text-foreground">
          {day.dayIndex}
        </span>
      </td>
      {/* Date */}
      <td className="px-2 py-2 text-right tabular-nums text-foreground border-r border-border">
        {formatDateStr(day.date || '')}
      </td>
      {/* Trade Capital */}
      <td className="px-2 py-2 text-right tabular-nums text-foreground border-r border-border">
        {fmt(day.tradeCapital, true)}
      </td>
      {/* Target */}
      <td className="px-2 py-2 text-right tabular-nums text-foreground border-r border-border">
        {fmt(day.targetAmount)}
        <span className="text-[0.5625rem] ml-0.5">({day.targetPercent}%)</span>
      </td>
      {/* Proj Capital */}
      <td className="px-2 py-2 text-right tabular-nums font-medium text-foreground border-r border-border">
        {fmt(day.projCapital, true)}
      </td>
      <td className="px-2 py-2 border-r border-border"></td>
      <td className="px-2 py-2 border-r border-border"></td>
      <td className="px-2 py-2 border-r border-border"></td>
      <td className="px-2 py-2 border-r border-border"></td>
      <td className="px-2 py-2 border-r border-border"></td>
      <td className="px-2 py-2 border-r border-border"></td>
      <td className="px-2 py-2 border-r border-border"></td>
      <td className="px-2 py-2 border-r border-border"></td>
      <td className="px-2 py-2 border-r border-border"></td>
      {/* Rating */}
      <td className="px-2 py-2 text-center whitespace-nowrap">
        <RatingIcon rating={isDay250 ? 'finish' : 'future'} />
      </td>
    </tr>
  );
}
