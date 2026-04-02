/**
 * TradingDesk — The central 250-day compounding table with trade management.
 *
 * Features:
 *   - Tab bar: My Trades (LIVE) | AI Trades (PAPER)
 *   - Summary bar: Day X/250, Trade Capital, Available, Profit, Today P&L/Target, Charges, Reserve, Quarterly Proj, Net Worth
 *   - Compounding table: 16 columns, 4 row types (Past/Gift/Today/Future)
 *   - Inline new trade form
 *   - Net/Gross toggle
 */
import { useState, useMemo, useCallback } from 'react';
import {
  Plus,
  Trophy,
  Gift,
  Star,
  Flag,
  ChevronDown,
  ChevronUp,
  X,
  TrendingUp,
  TrendingDown,
  DollarSign,
  Target,
  Shield,
  BarChart3,
  Wallet,
} from 'lucide-react';
import NewTradeForm from './NewTradeForm';

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

// ─── Mock Data for UI Development ────────────────────────────────

const MOCK_CAPITAL: CapitalState = {
  tradingPool: 75000,
  reservePool: 25000,
  currentDayIndex: 4,
  targetPercent: 5,
  availableCapital: 62500,
  netWorth: 103750,
  cumulativePnl: 3750,
  cumulativeCharges: 245.60,
  todayPnl: 1250,
  todayTarget: 3750,
  quarterlyProjection: { quarterLabel: 'Q1 FY27', projectedCapital: 285000 },
};

function generateMockDays(): { pastDays: DayRecord[]; currentDay: DayRecord; futureDays: DayRecord[] } {
  const pastDays: DayRecord[] = [
    {
      dayIndex: 1, date: '2026-03-30', tradeCapital: 75000, targetPercent: 5,
      targetAmount: 3750, projCapital: 78750, originalProjCapital: 78750,
      actualCapital: 79200, deviation: 450, trades: [], totalPnl: 4200,
      totalCharges: 82.50, totalQty: 100, instruments: ['NIFTY 50'],
      status: 'COMPLETED', rating: 'double_trophy',
    },
    {
      dayIndex: 2, date: '2026-03-31', tradeCapital: 78150, targetPercent: 5,
      targetAmount: 3907.50, projCapital: 82057.50, originalProjCapital: 82687.50,
      actualCapital: 81900, deviation: -787.50, trades: [], totalPnl: 3750,
      totalCharges: 78.20, totalQty: 75, instruments: ['BANK NIFTY'],
      status: 'COMPLETED', rating: 'trophy',
    },
    {
      dayIndex: 3, date: '2026-04-01', tradeCapital: 80962.50, targetPercent: 5,
      targetAmount: 4048.13, projCapital: 85010.63, originalProjCapital: 86821.88,
      actualCapital: 85010.63, deviation: -1811.25, trades: [], totalPnl: 4048.13,
      totalCharges: 85.00, totalQty: 50, instruments: ['NIFTY 50', 'CRUDE OIL'],
      status: 'COMPLETED', rating: 'trophy',
    },
  ];

  const currentDay: DayRecord = {
    dayIndex: 4, date: '2026-04-02', tradeCapital: 84048.13, targetPercent: 5,
    targetAmount: 4202.41, projCapital: 88250.54, originalProjCapital: 91162.97,
    actualCapital: 85298.13, deviation: -5864.84,
    trades: [
      {
        id: 'T1-demo', instrument: 'NIFTY 50', type: 'CALL_BUY', strike: 23500,
        entryPrice: 185.50, exitPrice: null, ltp: 198.25, qty: 50,
        capitalPercent: 15, pnl: 0, unrealizedPnl: 637.50, charges: 0,
        chargesBreakdown: [], status: 'OPEN', targetPrice: 210,
        stopLossPrice: 175, openedAt: Date.now() - 3600000, closedAt: null,
      },
      {
        id: 'T2-demo', instrument: 'BANK NIFTY', type: 'PUT_SELL', strike: 51000,
        entryPrice: 120.00, exitPrice: 95.50, ltp: 95.50, qty: 25,
        capitalPercent: 10, pnl: 530.40, unrealizedPnl: 0, charges: 82.10,
        chargesBreakdown: [
          { name: 'Brokerage', amount: 40 },
          { name: 'STT', amount: 1.49 },
          { name: 'Exchange', amount: 2.86 },
          { name: 'GST', amount: 7.71 },
          { name: 'SEBI', amount: 0.05 },
          { name: 'Stamp', amount: 0.09 },
        ],
        status: 'CLOSED_TP', targetPrice: 96, stopLossPrice: 140,
        openedAt: Date.now() - 7200000, closedAt: Date.now() - 1800000,
      },
    ],
    totalPnl: 1250, totalCharges: 82.10, totalQty: 75,
    instruments: ['NIFTY 50', 'BANK NIFTY'], status: 'ACTIVE', rating: 'star',
  };

  const futureDays: DayRecord[] = [];
  let pool = 84048.13;
  for (let i = 5; i <= 12; i++) {
    const target = Math.round(pool * 5 / 100 * 100) / 100;
    futureDays.push({
      dayIndex: i, date: '', tradeCapital: Math.round(pool * 100) / 100,
      targetPercent: 5, targetAmount: target,
      projCapital: Math.round((pool + target) * 100) / 100,
      originalProjCapital: Math.round((pool + target) * 100) / 100,
      actualCapital: 0, deviation: 0, trades: [], totalPnl: 0,
      totalCharges: 0, totalQty: 0, instruments: [],
      status: 'FUTURE', rating: i === 250 ? 'finish' : 'future',
    });
    pool = pool + target * 0.75;
  }

  return { pastDays, currentDay, futureDays };
}

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
  const [loading, setLoading] = useState(false);

  // TODO: Replace with tRPC queries when backend is wired
  const capital = MOCK_CAPITAL;
  const { pastDays, currentDay, futureDays } = useMemo(generateMockDays, []);

  const allDays = useMemo(() => {
    return [...pastDays, currentDay, ...futureDays];
  }, [pastDays, currentDay, futureDays]);

  const handlePlaceTrade = useCallback(async (trade: {
    instrument: string;
    type: 'CALL_BUY' | 'CALL_SELL' | 'PUT_BUY' | 'PUT_SELL' | 'BUY' | 'SELL';
    strike: number | null;
    entryPrice: number;
    capitalPercent: number;
  }) => {
    setLoading(true);
    try {
      // TODO: Call tRPC mutation capital.placeTrade
      console.log('Place trade:', trade);
      await new Promise((r) => setTimeout(r, 500));
      setShowNewTrade(false);
    } finally {
      setLoading(false);
    }
  }, [workspace]);

  const handleExitTrade = useCallback(async (tradeId: string) => {
    // TODO: Call tRPC mutation capital.exitTrade
    console.log('Exit trade:', tradeId);
  }, [workspace]);

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
            disabled={showNewTrade}
            className="flex items-center gap-1 px-2 py-1 rounded bg-primary/10 text-primary text-[10px] font-bold hover:bg-primary/20 disabled:opacity-30 transition-colors"
          >
            <Plus className="h-3 w-3" />
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
        <SummaryCell icon={<BarChart3 className="h-3 w-3" />} label={capital.quarterlyProjection.quarterLabel} value={fmt(capital.quarterlyProjection.projectedCapital, true)} />
        <SummaryCell icon={<DollarSign className="h-3 w-3" />} label="Net Worth" value={fmt(capital.netWorth, true)} accent="bullish" />
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
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
              />
            ))}
            {showNewTrade && (
              <NewTradeForm
                workspace={workspace}
                availableCapital={capital.availableCapital}
                instruments={['NIFTY 50', 'BANK NIFTY', 'CRUDE OIL', 'NATURAL GAS']}
                onSubmit={handlePlaceTrade}
                onCancel={() => setShowNewTrade(false)}
                loading={loading}
              />
            )}
          </tbody>
        </table>
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
}: {
  day: DayRecord;
  isToday: boolean;
  expanded: boolean;
  onToggle: () => void;
  onExitTrade: (tradeId: string) => void;
  showNet: boolean;
}) {
  const rowBg = isToday
    ? 'bg-primary/5 border-l-2 border-l-primary'
    : day.status === 'COMPLETED'
    ? 'bg-card hover:bg-secondary/30'
    : day.status === 'GIFT'
    ? 'bg-info-cyan/5'
    : 'bg-card/50 opacity-60';

  const hasTrades = day.trades.length > 0;
  const openTrades = day.trades.filter((t) => t.status === 'OPEN');
  const closedTrades = day.trades.filter((t) => t.status !== 'OPEN');

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
}: {
  trade: TradeRecord;
  onExit: () => void;
  showNet: boolean;
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
            className="px-1.5 py-0.5 rounded text-[8px] font-bold bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors"
            title="Exit position"
          >
            EXIT
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
