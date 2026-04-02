/**
 * JournalOverlay — Trade Journal with 3 tabs: Trades, Analytics, AI Paper.
 * Reuses existing tRPC journal endpoints. Opened via Ctrl+J.
 */
import { useState, useMemo } from 'react';
import { trpc } from '@/lib/trpc';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  BookOpen, Plus, X, TrendingUp, TrendingDown,
  BarChart3, Target, Filter, Clock, DollarSign,
  Percent, Award, AlertTriangle, ChevronDown, ChevronUp,
  CheckCircle2, XCircle, ListChecks, PieChart, Bot,
  Calendar, Tag, MessageSquare, ArrowUpRight, ArrowDownRight,
} from 'lucide-react';
import { toast } from 'sonner';
import AiPaperTab from './AiPaperTab';

// ─── Constants ───────────────────────────────────────────────

const INSTRUMENTS = ['NIFTY_50', 'BANKNIFTY', 'CRUDEOIL', 'NATURALGAS'];
const TRADE_TYPES = ['CALL_BUY', 'PUT_BUY', 'CALL_SELL', 'PUT_SELL'] as const;
type Tab = 'trades' | 'analytics' | 'ai-paper';

// ─── Helpers ─────────────────────────────────────────────────

function formatPrice(v: number): string {
  return v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function formatDateShort(ms: number): string {
  return new Date(ms).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

// ─── Props ───────────────────────────────────────────────────

interface JournalOverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// ─── Inline New Trade Form ───────────────────────────────────

function InlineNewTradeForm({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [instrument, setInstrument] = useState(INSTRUMENTS[0]);
  const [tradeType, setTradeType] = useState<typeof TRADE_TYPES[number]>('CALL_BUY');
  const [strike, setStrike] = useState('');
  const [entryPrice, setEntryPrice] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [stopLoss, setStopLoss] = useState('');
  const [target, setTarget] = useState('');
  const [mode, setMode] = useState<'LIVE' | 'PAPER'>('PAPER');
  const [rationale, setRationale] = useState('');
  const [tags, setTags] = useState('');

  const createMutation = trpc.journal.create.useMutation({
    onSuccess: () => { toast.success('Trade logged'); onSuccess(); },
    onError: (err) => toast.error(err.message),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!strike || !entryPrice) { toast.error('Strike and entry price required'); return; }
    createMutation.mutate({
      instrument, tradeType,
      strike: parseFloat(strike),
      entryPrice: parseFloat(entryPrice),
      quantity: parseInt(quantity) || 1,
      stopLoss: stopLoss ? parseFloat(stopLoss) : undefined,
      target: target ? parseFloat(target) : undefined,
      mode,
      rationale: rationale || undefined,
      tags: tags || undefined,
      entryTime: Date.now(),
    });
  };

  return (
    <div className="border border-info-cyan/20 rounded-md bg-info-cyan/5 p-3 space-y-2.5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-bold tracking-wider text-info-cyan flex items-center gap-1.5">
          <Plus className="h-3 w-3" /> NEW TRADE
        </span>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
          <X className="h-3 w-3" />
        </button>
      </div>
      <form onSubmit={handleSubmit} className="space-y-2">
        <div className="grid grid-cols-4 gap-2">
          <select value={instrument} onChange={e => setInstrument(e.target.value)}
            className="bg-secondary/50 border border-border rounded px-1.5 py-1 text-[10px] text-foreground">
            {INSTRUMENTS.map(i => <option key={i} value={i}>{i.replace('_', ' ')}</option>)}
          </select>
          <select value={tradeType} onChange={e => setTradeType(e.target.value as any)}
            className="bg-secondary/50 border border-border rounded px-1.5 py-1 text-[10px] text-foreground">
            {TRADE_TYPES.map(t => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
          </select>
          <input type="number" step="any" value={strike} onChange={e => setStrike(e.target.value)}
            className="bg-secondary/50 border border-border rounded px-1.5 py-1 text-[10px] text-foreground tabular-nums"
            placeholder="Strike" required />
          <input type="number" step="any" value={entryPrice} onChange={e => setEntryPrice(e.target.value)}
            className="bg-secondary/50 border border-border rounded px-1.5 py-1 text-[10px] text-foreground tabular-nums"
            placeholder="Entry ₹" required />
        </div>
        <div className="grid grid-cols-4 gap-2">
          <input type="number" value={quantity} onChange={e => setQuantity(e.target.value)}
            className="bg-secondary/50 border border-border rounded px-1.5 py-1 text-[10px] text-foreground tabular-nums"
            placeholder="Qty" min="1" />
          <input type="number" step="any" value={stopLoss} onChange={e => setStopLoss(e.target.value)}
            className="bg-secondary/50 border border-border rounded px-1.5 py-1 text-[10px] text-foreground tabular-nums"
            placeholder="SL ₹" />
          <input type="number" step="any" value={target} onChange={e => setTarget(e.target.value)}
            className="bg-secondary/50 border border-border rounded px-1.5 py-1 text-[10px] text-foreground tabular-nums"
            placeholder="Target ₹" />
          <div className="flex gap-1">
            <button type="button" onClick={() => setMode('PAPER')}
              className={`flex-1 px-1 py-1 rounded text-[8px] font-bold tracking-wider border ${mode === 'PAPER' ? 'bg-warning-amber/15 border-warning-amber/40 text-warning-amber' : 'bg-secondary/30 border-border text-muted-foreground'}`}>
              PAPER
            </button>
            <button type="button" onClick={() => setMode('LIVE')}
              className={`flex-1 px-1 py-1 rounded text-[8px] font-bold tracking-wider border ${mode === 'LIVE' ? 'bg-bullish/15 border-bullish/40 text-bullish' : 'bg-secondary/30 border-border text-muted-foreground'}`}>
              LIVE
            </button>
          </div>
        </div>
        <textarea value={rationale} onChange={e => setRationale(e.target.value)}
          className="w-full bg-secondary/50 border border-border rounded px-1.5 py-1 text-[10px] text-foreground resize-none"
          rows={1} placeholder="Rationale — why are you taking this trade?" />
        <div className="flex gap-2">
          <input value={tags} onChange={e => setTags(e.target.value)}
            className="flex-1 bg-secondary/50 border border-border rounded px-1.5 py-1 text-[10px] text-foreground"
            placeholder="Tags: breakout, momentum, scalp" />
          <button type="submit" disabled={createMutation.isPending}
            className="px-3 py-1 rounded bg-info-cyan/15 border border-info-cyan/40 text-info-cyan text-[10px] font-bold tracking-wider hover:bg-info-cyan/25 transition-colors disabled:opacity-50">
            {createMutation.isPending ? 'LOGGING...' : 'LOG'}
          </button>
        </div>
      </form>
    </div>
  );
}

// ─── Inline Close Trade Form ─────────────────────────────────

function InlineCloseForm({ tradeId, onClose, onSuccess }: { tradeId: number; onClose: () => void; onSuccess: () => void }) {
  const [exitPrice, setExitPrice] = useState('');
  const [exitReason, setExitReason] = useState('');

  const closeMutation = trpc.journal.close.useMutation({
    onSuccess: () => { toast.success('Trade closed'); onSuccess(); },
    onError: (err) => toast.error(err.message),
  });

  return (
    <div className="flex items-center gap-2 mt-1.5 p-2 rounded bg-destructive/5 border border-destructive/20">
      <input type="number" step="any" value={exitPrice} onChange={e => setExitPrice(e.target.value)}
        className="w-24 bg-secondary/50 border border-border rounded px-1.5 py-1 text-[10px] text-foreground tabular-nums"
        placeholder="Exit ₹" />
      <input value={exitReason} onChange={e => setExitReason(e.target.value)}
        className="flex-1 bg-secondary/50 border border-border rounded px-1.5 py-1 text-[10px] text-foreground"
        placeholder="Exit reason" />
      <button onClick={() => {
        if (!exitPrice) { toast.error('Exit price required'); return; }
        closeMutation.mutate({ id: tradeId, exitPrice: parseFloat(exitPrice), exitTime: Date.now(), exitReason: exitReason || undefined });
      }} disabled={closeMutation.isPending}
        className="px-2 py-1 rounded bg-destructive/15 border border-destructive/40 text-destructive text-[9px] font-bold tracking-wider hover:bg-destructive/25 disabled:opacity-50">
        {closeMutation.isPending ? '...' : 'CLOSE'}
      </button>
      <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

// ─── Journal Entry Form (post-trade notes) ───────────────────

function JournalEntryForm({ tradeId, existing, onSuccess }: { tradeId: number; existing?: string | null; onSuccess: () => void }) {
  const [notes, setNotes] = useState(existing || '');
  const [editing, setEditing] = useState(!existing);

  const updateMutation = trpc.journal.update.useMutation({
    onSuccess: () => { toast.success('Journal entry saved'); setEditing(false); onSuccess(); },
    onError: (err) => toast.error(err.message),
  });

  if (!editing) {
    return (
      <div className="mt-1">
        <div className="flex items-center gap-1">
          <MessageSquare className="h-2.5 w-2.5 text-warning-amber" />
          <span className="text-[8px] text-muted-foreground tracking-wider uppercase">Journal</span>
          <button onClick={() => setEditing(true)} className="text-[8px] text-info-cyan hover:underline ml-1">edit</button>
        </div>
        <p className="text-[10px] text-foreground/80 mt-0.5">{existing}</p>
      </div>
    );
  }

  return (
    <div className="mt-1.5 space-y-1">
      <div className="flex items-center gap-1">
        <MessageSquare className="h-2.5 w-2.5 text-warning-amber" />
        <span className="text-[8px] text-muted-foreground tracking-wider uppercase">Post-Trade Journal Entry</span>
      </div>
      <textarea value={notes} onChange={e => setNotes(e.target.value)}
        className="w-full bg-secondary/50 border border-border rounded px-1.5 py-1 text-[10px] text-foreground resize-none"
        rows={2} placeholder="What did you learn? What would you do differently? How did you feel?" />
      <div className="flex gap-1">
        <button onClick={() => updateMutation.mutate({ id: tradeId, rationale: notes })}
          disabled={updateMutation.isPending || !notes.trim()}
          className="px-2 py-0.5 rounded bg-warning-amber/15 border border-warning-amber/40 text-warning-amber text-[9px] font-bold tracking-wider hover:bg-warning-amber/25 disabled:opacity-50">
          {updateMutation.isPending ? 'SAVING...' : 'SAVE'}
        </button>
        {existing && (
          <button onClick={() => { setNotes(existing); setEditing(false); }}
            className="px-2 py-0.5 rounded bg-secondary/30 border border-border text-muted-foreground text-[9px] tracking-wider hover:text-foreground">
            CANCEL
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Stats Card ──────────────────────────────────────────────

function StatsCard({ label, value, icon: Icon, color = 'text-foreground', suffix = '' }: {
  label: string; value: string | number; icon: React.ElementType; color?: string; suffix?: string;
}) {
  return (
    <div className="bg-secondary/20 border border-border rounded p-2 space-y-0.5">
      <div className="flex items-center gap-1">
        <Icon className={`h-2.5 w-2.5 ${color}`} />
        <span className="text-[7px] text-muted-foreground tracking-wider uppercase">{label}</span>
      </div>
      <div className={`text-sm font-bold tabular-nums ${color}`}>{value}{suffix}</div>
    </div>
  );
}

// ─── P&L Equity Curve (SVG) ──────────────────────────────────

function EquityCurve({ trades }: { trades: Array<{ pnl: number | null; entryTime: number }> }) {
  const closedTrades = trades
    .filter(t => t.pnl !== null && t.pnl !== undefined)
    .sort((a, b) => a.entryTime - b.entryTime);

  if (closedTrades.length < 2) {
    return (
      <div className="flex items-center justify-center h-24 text-[10px] text-muted-foreground">
        Need at least 2 closed trades for equity curve
      </div>
    );
  }

  // Build cumulative P&L
  let running = 0;
  const points = closedTrades.map(t => {
    running += t.pnl!;
    return running;
  });

  const maxVal = Math.max(...points, 0);
  const minVal = Math.min(...points, 0);
  const range = maxVal - minVal || 1;
  const w = 400;
  const h = 80;
  const pad = 4;

  const pathPoints = points.map((v, i) => {
    const x = pad + (i / (points.length - 1)) * (w - 2 * pad);
    const y = pad + ((maxVal - v) / range) * (h - 2 * pad);
    return `${x},${y}`;
  });

  const zeroY = pad + ((maxVal - 0) / range) * (h - 2 * pad);
  const isPositive = running >= 0;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-[8px] text-muted-foreground tracking-wider uppercase">Equity Curve</span>
        <span className={`text-[10px] font-bold tabular-nums ${isPositive ? 'text-bullish' : 'text-destructive'}`}>
          {isPositive ? '+' : ''}₹{formatPrice(running)}
        </span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-20 rounded border border-border bg-secondary/10">
        {/* Zero line */}
        <line x1={pad} y1={zeroY} x2={w - pad} y2={zeroY} stroke="currentColor" strokeOpacity="0.1" strokeDasharray="4,4" />
        {/* Curve */}
        <polyline
          fill="none"
          stroke={isPositive ? 'rgb(34, 197, 94)' : 'rgb(239, 68, 68)'}
          strokeWidth="1.5"
          points={pathPoints.join(' ')}
        />
        {/* Area fill */}
        <polygon
          fill={isPositive ? 'rgba(34, 197, 94, 0.08)' : 'rgba(239, 68, 68, 0.08)'}
          points={`${pad},${zeroY} ${pathPoints.join(' ')} ${w - pad},${zeroY}`}
        />
      </svg>
    </div>
  );
}

// ─── Win Rate by Instrument ──────────────────────────────────

function WinRateByInstrument({ trades }: { trades: Array<{ instrument: string; pnl: number | null; status: string }> }) {
  const closed = trades.filter(t => t.status === 'CLOSED');
  if (closed.length === 0) return null;

  const byInstrument = INSTRUMENTS.map(inst => {
    const instTrades = closed.filter(t => t.instrument === inst);
    const wins = instTrades.filter(t => (t.pnl || 0) > 0).length;
    const total = instTrades.length;
    const winRate = total > 0 ? (wins / total) * 100 : 0;
    const totalPnl = instTrades.reduce((s, t) => s + (t.pnl || 0), 0);
    return { inst, wins, total, winRate, totalPnl };
  }).filter(x => x.total > 0);

  return (
    <div className="space-y-1.5">
      <span className="text-[8px] text-muted-foreground tracking-wider uppercase">Win Rate by Instrument</span>
      {byInstrument.map(({ inst, wins, total, winRate, totalPnl }) => (
        <div key={inst} className="flex items-center gap-2">
          <span className="text-[9px] text-foreground w-20 truncate">{inst.replace('_', ' ')}</span>
          <div className="flex-1 h-3 bg-secondary/30 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full ${winRate >= 50 ? 'bg-bullish/60' : 'bg-destructive/60'}`}
              style={{ width: `${Math.max(winRate, 2)}%` }}
            />
          </div>
          <span className={`text-[9px] font-bold tabular-nums w-10 text-right ${winRate >= 50 ? 'text-bullish' : 'text-destructive'}`}>
            {winRate.toFixed(0)}%
          </span>
          <span className={`text-[8px] tabular-nums w-16 text-right ${totalPnl >= 0 ? 'text-bullish/70' : 'text-destructive/70'}`}>
            ₹{formatPrice(totalPnl)}
          </span>
          <span className="text-[8px] text-muted-foreground w-8 text-right">{wins}/{total}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Trade Distribution ──────────────────────────────────────

function TradeDistribution({ trades }: { trades: Array<{ tradeType: string; status: string }> }) {
  const closed = trades.filter(t => t.status === 'CLOSED');
  if (closed.length === 0) return null;

  const counts: Record<string, number> = {};
  closed.forEach(t => { counts[t.tradeType] = (counts[t.tradeType] || 0) + 1; });

  const total = closed.length;
  const colors: Record<string, string> = {
    CALL_BUY: 'bg-bullish/60',
    PUT_BUY: 'bg-destructive/60',
    CALL_SELL: 'bg-bullish/30',
    PUT_SELL: 'bg-destructive/30',
  };

  return (
    <div className="space-y-1.5">
      <span className="text-[8px] text-muted-foreground tracking-wider uppercase">Trade Distribution</span>
      <div className="flex h-4 rounded-full overflow-hidden">
        {Object.entries(counts).map(([type, count]) => (
          <div
            key={type}
            className={`${colors[type] || 'bg-secondary/50'} transition-all`}
            style={{ width: `${(count / total) * 100}%` }}
            title={`${type.replace('_', ' ')}: ${count} (${((count / total) * 100).toFixed(0)}%)`}
          />
        ))}
      </div>
      <div className="flex gap-3 flex-wrap">
        {Object.entries(counts).map(([type, count]) => (
          <div key={type} className="flex items-center gap-1">
            <div className={`h-2 w-2 rounded-sm ${colors[type] || 'bg-secondary/50'}`} />
            <span className="text-[8px] text-muted-foreground">{type.replace('_', ' ')}</span>
            <span className="text-[8px] font-bold text-foreground">{count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Trades Tab ──────────────────────────────────────────────

function TradesTab() {
  const [showNewTrade, setShowNewTrade] = useState(false);
  const [closingTradeId, setClosingTradeId] = useState<number | null>(null);
  const [filterStatus, setFilterStatus] = useState<'ALL' | 'OPEN' | 'CLOSED'>('ALL');
  const [filterInstrument, setFilterInstrument] = useState('ALL');
  const [expandedTrade, setExpandedTrade] = useState<number | null>(null);

  const utils = trpc.useUtils();

  const tradesQuery = trpc.journal.list.useQuery(
    filterStatus === 'ALL' && filterInstrument === 'ALL'
      ? undefined
      : {
          ...(filterStatus !== 'ALL' ? { status: filterStatus as any } : {}),
          ...(filterInstrument !== 'ALL' ? { instrument: filterInstrument } : {}),
        },
    { retry: false }
  );

  const refreshAll = () => {
    utils.journal.list.invalidate();
    utils.journal.stats.invalidate();
  };

  const trades = tradesQuery.data || [];

  return (
    <div className="space-y-2.5">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <Filter className="h-3 w-3 text-muted-foreground" />
          <div className="flex gap-0.5">
            {(['ALL', 'OPEN', 'CLOSED'] as const).map(s => (
              <button key={s} onClick={() => setFilterStatus(s)}
                className={`px-1.5 py-0.5 rounded text-[8px] font-bold tracking-wider border ${
                  filterStatus === s
                    ? 'bg-info-cyan/15 border-info-cyan/40 text-info-cyan'
                    : 'bg-secondary/30 border-border text-muted-foreground hover:text-foreground'
                }`}>
                {s}
              </button>
            ))}
          </div>
          <select value={filterInstrument} onChange={e => setFilterInstrument(e.target.value)}
            className="bg-secondary/50 border border-border rounded px-1.5 py-0.5 text-[8px] text-foreground">
            <option value="ALL">All</option>
            {INSTRUMENTS.map(i => <option key={i} value={i}>{i.replace('_', ' ')}</option>)}
          </select>
        </div>
        <button onClick={() => setShowNewTrade(!showNewTrade)}
          className="flex items-center gap-1 px-2 py-1 rounded bg-info-cyan/15 border border-info-cyan/40 text-info-cyan text-[9px] font-bold tracking-wider hover:bg-info-cyan/25 transition-colors">
          <Plus className="h-2.5 w-2.5" /> LOG
        </button>
      </div>

      {/* New Trade Form */}
      {showNewTrade && (
        <InlineNewTradeForm onClose={() => setShowNewTrade(false)} onSuccess={() => { setShowNewTrade(false); refreshAll(); }} />
      )}

      {/* Trade List */}
      {tradesQuery.isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-14 rounded border border-border bg-secondary/10 animate-pulse" />
          ))}
        </div>
      ) : tradesQuery.isError ? (
        <div className="text-center py-8 space-y-2">
          <AlertTriangle className="h-8 w-8 text-warning-amber mx-auto" />
          <p className="text-[10px] text-muted-foreground">
            {tradesQuery.error?.message?.includes('UNAUTHORIZED')
              ? 'Login required to view trades. Journal works in deployed mode.'
              : `Failed to load trades: ${tradesQuery.error?.message}`}
          </p>
        </div>
      ) : trades.length === 0 ? (
        <div className="text-center py-8 space-y-2">
          <BookOpen className="h-8 w-8 text-muted-foreground/40 mx-auto" />
          <p className="text-[10px] text-muted-foreground">No trades logged yet</p>
          <button onClick={() => setShowNewTrade(true)}
            className="text-info-cyan text-[9px] font-bold tracking-wider hover:underline">
            Log your first trade
          </button>
        </div>
      ) : (
        <div className="space-y-1.5 max-h-[45vh] overflow-y-auto pr-1 scrollbar-thin">
          {trades.map(trade => {
            const isOpen = trade.status === 'OPEN';
            const isWin = (trade.pnl || 0) > 0;
            const isExpanded = expandedTrade === trade.id;
            const isBuy = trade.tradeType === 'CALL_BUY' || trade.tradeType === 'PUT_BUY';

            return (
              <div key={trade.id}
                className={`rounded border ${isOpen ? 'border-info-cyan/20 bg-info-cyan/5' : isWin ? 'border-bullish/15 bg-bullish/5' : 'border-destructive/15 bg-destructive/5'} overflow-hidden`}>
                {/* Main row */}
                <button onClick={() => setExpandedTrade(isExpanded ? null : trade.id)}
                  className="w-full px-2.5 py-2 flex items-center gap-2 text-left">
                  {isOpen ? (
                    <Clock className="h-3.5 w-3.5 text-info-cyan shrink-0" />
                  ) : isWin ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-bullish shrink-0" />
                  ) : (
                    <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" />
                  )}

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] font-bold text-foreground">{trade.instrument.replace('_', ' ')}</span>
                      <span className={`text-[8px] font-bold px-1 py-0.5 rounded ${
                        isBuy ? 'bg-bullish/10 text-bullish border border-bullish/20' : 'bg-destructive/10 text-destructive border border-destructive/20'
                      }`}>
                        {trade.tradeType.replace('_', ' ')}
                      </span>
                      <span className="text-[8px] text-muted-foreground tabular-nums">{trade.strike}</span>
                      {trade.mode === 'PAPER' && (
                        <span className="text-[7px] px-1 py-0.5 rounded bg-warning-amber/10 text-warning-amber border border-warning-amber/20">PAPER</span>
                      )}
                    </div>
                    <div className="text-[8px] text-muted-foreground mt-0.5">
                      {formatDateShort(trade.entryTime)} · ₹{formatPrice(trade.entryPrice)} × {trade.quantity}
                    </div>
                  </div>

                  <div className="text-right shrink-0">
                    {trade.status === 'CLOSED' && trade.pnl !== null ? (
                      <>
                        <div className={`text-[11px] font-bold tabular-nums ${isWin ? 'text-bullish' : 'text-destructive'}`}>
                          {isWin ? '+' : ''}₹{formatPrice(trade.pnl)}
                        </div>
                        <div className={`text-[8px] tabular-nums ${isWin ? 'text-bullish/70' : 'text-destructive/70'}`}>
                          {isWin ? '+' : ''}{trade.pnlPercent?.toFixed(1)}%
                        </div>
                      </>
                    ) : (
                      <span className="text-[9px] text-info-cyan font-bold">OPEN</span>
                    )}
                  </div>

                  {isExpanded ? <ChevronUp className="h-2.5 w-2.5 text-muted-foreground shrink-0" /> : <ChevronDown className="h-2.5 w-2.5 text-muted-foreground shrink-0" />}
                </button>

                {/* Expanded details */}
                {isExpanded && (
                  <div className="px-2.5 pb-2.5 pt-1 border-t border-white/5 space-y-1.5">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 text-[8px]">
                      {trade.stopLoss && (
                        <div><span className="text-muted-foreground">SL:</span> <span className="text-destructive font-bold tabular-nums">₹{formatPrice(trade.stopLoss)}</span></div>
                      )}
                      {trade.target && (
                        <div><span className="text-muted-foreground">Target:</span> <span className="text-bullish font-bold tabular-nums">₹{formatPrice(trade.target)}</span></div>
                      )}
                      {trade.exitPrice && (
                        <div><span className="text-muted-foreground">Exit:</span> <span className="text-foreground font-bold tabular-nums">₹{formatPrice(trade.exitPrice)}</span></div>
                      )}
                      {trade.aiDecision && (
                        <div>
                          <span className="text-muted-foreground">AI:</span>
                          <span className="text-info-cyan font-bold ml-1">{trade.aiDecision}</span>
                          {trade.aiConfidence && <span className="text-muted-foreground ml-0.5">({(trade.aiConfidence * 100).toFixed(0)}%)</span>}
                        </div>
                      )}
                      {trade.checklistScore !== null && trade.checklistScore !== undefined && (
                        <div>
                          <span className="text-muted-foreground">Checklist:</span>
                          <span className={`ml-1 font-bold ${trade.checklistScore >= 70 ? 'text-bullish' : trade.checklistScore >= 45 ? 'text-warning-amber' : 'text-destructive'}`}>
                            {trade.checklistScore}%
                          </span>
                        </div>
                      )}
                    </div>

                    {trade.rationale && (
                      <div>
                        <span className="text-[7px] text-muted-foreground tracking-wider uppercase">Rationale:</span>
                        <p className="text-[9px] text-foreground/80 mt-0.5">{trade.rationale}</p>
                      </div>
                    )}
                    {trade.exitReason && (
                      <div>
                        <span className="text-[7px] text-muted-foreground tracking-wider uppercase">Exit Reason:</span>
                        <p className="text-[9px] text-foreground/80 mt-0.5">{trade.exitReason}</p>
                      </div>
                    )}
                    {trade.tags && (
                      <div className="flex gap-1 flex-wrap">
                        {trade.tags.split(',').map((tag, i) => (
                          <span key={i} className="text-[7px] px-1 py-0.5 rounded bg-secondary/50 border border-border text-muted-foreground">
                            {tag.trim()}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Journal entry for closed trades */}
                    {trade.status === 'CLOSED' && (
                      <JournalEntryForm tradeId={trade.id} existing={trade.exitReason} onSuccess={refreshAll} />
                    )}

                    {/* Close button for open trades */}
                    {isOpen && closingTradeId !== trade.id && (
                      <button onClick={(e) => { e.stopPropagation(); setClosingTradeId(trade.id); }}
                        className="px-2 py-1 rounded bg-destructive/15 border border-destructive/40 text-destructive text-[9px] font-bold tracking-wider hover:bg-destructive/25 transition-colors">
                        CLOSE TRADE
                      </button>
                    )}
                    {closingTradeId === trade.id && (
                      <InlineCloseForm tradeId={trade.id} onClose={() => setClosingTradeId(null)} onSuccess={() => { setClosingTradeId(null); refreshAll(); }} />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Analytics Tab ───────────────────────────────────────────

function AnalyticsTab() {
  const statsQuery = trpc.journal.stats.useQuery(undefined, { retry: false });
  const tradesQuery = trpc.journal.list.useQuery(undefined, { retry: false });

  const stats = statsQuery.data;
  const trades = tradesQuery.data || [];

  if (statsQuery.isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map(i => (
          <div key={i} className="h-16 rounded border border-border bg-secondary/10 animate-pulse" />
        ))}
      </div>
    );
  }

  if (statsQuery.isError) {
    return (
      <div className="text-center py-8 space-y-2">
        <AlertTriangle className="h-8 w-8 text-warning-amber mx-auto" />
        <p className="text-[10px] text-muted-foreground">
          {statsQuery.error?.message?.includes('UNAUTHORIZED')
            ? 'Login required to view analytics.'
            : `Failed to load stats: ${statsQuery.error?.message}`}
        </p>
      </div>
    );
  }

  if (!stats || stats.totalTrades === 0) {
    return (
      <div className="text-center py-8 space-y-2">
        <PieChart className="h-8 w-8 text-muted-foreground/40 mx-auto" />
        <p className="text-[10px] text-muted-foreground">No closed trades yet. Analytics will appear after your first completed trade.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Stats Grid */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
        <StatsCard label="Total P&L" value={`₹${formatPrice(stats.totalPnl)}`} icon={DollarSign}
          color={stats.totalPnl >= 0 ? 'text-bullish' : 'text-destructive'} />
        <StatsCard label="Win Rate" value={stats.winRate} icon={Percent}
          color={stats.winRate >= 50 ? 'text-bullish' : 'text-destructive'} suffix="%" />
        <StatsCard label="Trades" value={stats.totalTrades} icon={BarChart3} color="text-info-cyan" />
        <StatsCard label="Avg R:R" value={stats.avgRR} icon={Target}
          color={stats.avgRR >= 1.5 ? 'text-bullish' : 'text-warning-amber'} />
        <StatsCard label="Max Win" value={`₹${formatPrice(stats.maxWin)}`} icon={Award} color="text-bullish" />
        <StatsCard label="Max DD" value={`₹${formatPrice(stats.maxDrawdown)}`} icon={AlertTriangle} color="text-destructive" />
      </div>

      {/* Equity Curve */}
      <EquityCurve trades={trades} />

      {/* Win Rate by Instrument */}
      <WinRateByInstrument trades={trades} />

      {/* Trade Distribution */}
      <TradeDistribution trades={trades} />
    </div>
  );
}

// ─── Main Overlay ────────────────────────────────────────────

export default function JournalOverlay({ open, onOpenChange }: JournalOverlayProps) {
  const [tab, setTab] = useState<Tab>('trades');

  const tabs: Array<{ id: Tab; label: string; icon: React.ElementType }> = [
    { id: 'trades', label: 'Trades', icon: ListChecks },
    { id: 'analytics', label: 'Analytics', icon: PieChart },
    { id: 'ai-paper', label: 'AI Paper', icon: Bot },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl h-[80vh] p-0 gap-0 bg-background border-border overflow-hidden flex flex-col">
        <DialogHeader className="px-5 pt-4 pb-0 border-b border-border shrink-0">
          <DialogTitle className="flex items-center gap-2 text-base font-display font-bold tracking-tight mb-3">
            <BookOpen className="h-4 w-4 text-warning-amber" />
            Trade Journal
            <span className="text-[9px] text-muted-foreground tracking-widest uppercase ml-2">
              Ctrl+J to toggle
            </span>
          </DialogTitle>

          {/* Tab bar */}
          <div className="flex gap-0.5">
            {tabs.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`flex items-center gap-1.5 px-3 py-2 text-[10px] font-bold tracking-wider border-b-2 transition-colors ${
                  tab === id
                    ? 'border-warning-amber text-warning-amber'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                <Icon className="h-3 w-3" />
                {label}
              </button>
            ))}
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto p-5">
          {tab === 'trades' && <TradesTab />}
          {tab === 'analytics' && <AnalyticsTab />}
          {tab === 'ai-paper' && <AiPaperTab />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
