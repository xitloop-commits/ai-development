/**
 * Trade Journal Page — Log trades, track P&L, view stats
 */
import { useState, useMemo } from 'react';
import { useAuth } from '@/_core/hooks/useAuth';
import { getLoginUrl } from '@/const';
import { trpc } from '@/lib/trpc';
import { Link } from 'wouter';
import {
  ArrowLeft, Plus, X, TrendingUp, TrendingDown,
  BarChart3, Target, Calendar, Filter, BookOpen,
  CheckCircle2, XCircle, Clock, DollarSign, Percent,
  Award, AlertTriangle, ChevronDown, ChevronUp,
} from 'lucide-react';
import { toast } from 'sonner';

const INSTRUMENTS = ['NIFTY_50', 'BANKNIFTY', 'CRUDEOIL', 'NATURALGAS'];
const TRADE_TYPES = ['CALL_BUY', 'PUT_BUY', 'CALL_SELL', 'PUT_SELL'] as const;

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
  return new Date(ms).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short',
  });
}

// ─── New Trade Form ───

interface NewTradeFormProps {
  onClose: () => void;
  onSuccess: () => void;
}

function NewTradeForm({ onClose, onSuccess }: NewTradeFormProps) {
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
    onSuccess: () => {
      toast.success('Trade logged successfully');
      onSuccess();
    },
    onError: (err) => toast.error(err.message),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!strike || !entryPrice) {
      toast.error('Strike and entry price are required');
      return;
    }
    createMutation.mutate({
      instrument,
      tradeType,
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm animate-fade-in">
      <div className="w-full max-w-md mx-4 bg-card border border-border rounded-lg shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-secondary/20">
          <div className="flex items-center gap-2">
            <Plus className="h-4 w-4 text-info-cyan" />
            <span className="font-display text-sm font-bold tracking-wider text-foreground">NEW TRADE</span>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[9px] text-muted-foreground tracking-wider uppercase block mb-1">Instrument</label>
              <select value={instrument} onChange={e => setInstrument(e.target.value)}
                className="w-full bg-secondary/50 border border-border rounded px-2 py-1.5 text-xs text-foreground">
                {INSTRUMENTS.map(i => <option key={i} value={i}>{i.replace('_', ' ')}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[9px] text-muted-foreground tracking-wider uppercase block mb-1">Type</label>
              <select value={tradeType} onChange={e => setTradeType(e.target.value as any)}
                className="w-full bg-secondary/50 border border-border rounded px-2 py-1.5 text-xs text-foreground">
                {TRADE_TYPES.map(t => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-[9px] text-muted-foreground tracking-wider uppercase block mb-1">Strike</label>
              <input type="number" step="any" value={strike} onChange={e => setStrike(e.target.value)}
                className="w-full bg-secondary/50 border border-border rounded px-2 py-1.5 text-xs text-foreground tabular-nums"
                placeholder="24500" required />
            </div>
            <div>
              <label className="text-[9px] text-muted-foreground tracking-wider uppercase block mb-1">Entry ₹</label>
              <input type="number" step="any" value={entryPrice} onChange={e => setEntryPrice(e.target.value)}
                className="w-full bg-secondary/50 border border-border rounded px-2 py-1.5 text-xs text-foreground tabular-nums"
                placeholder="150.00" required />
            </div>
            <div>
              <label className="text-[9px] text-muted-foreground tracking-wider uppercase block mb-1">Qty</label>
              <input type="number" value={quantity} onChange={e => setQuantity(e.target.value)}
                className="w-full bg-secondary/50 border border-border rounded px-2 py-1.5 text-xs text-foreground tabular-nums"
                placeholder="1" min="1" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[9px] text-muted-foreground tracking-wider uppercase block mb-1">Stop Loss ₹</label>
              <input type="number" step="any" value={stopLoss} onChange={e => setStopLoss(e.target.value)}
                className="w-full bg-secondary/50 border border-border rounded px-2 py-1.5 text-xs text-foreground tabular-nums"
                placeholder="120.00" />
            </div>
            <div>
              <label className="text-[9px] text-muted-foreground tracking-wider uppercase block mb-1">Target ₹</label>
              <input type="number" step="any" value={target} onChange={e => setTarget(e.target.value)}
                className="w-full bg-secondary/50 border border-border rounded px-2 py-1.5 text-xs text-foreground tabular-nums"
                placeholder="200.00" />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <label className="text-[9px] text-muted-foreground tracking-wider uppercase">Mode:</label>
            <button type="button" onClick={() => setMode('PAPER')}
              className={`px-2 py-1 rounded text-[9px] font-bold tracking-wider border ${mode === 'PAPER' ? 'bg-warning-amber/15 border-warning-amber/40 text-warning-amber' : 'bg-secondary/30 border-border text-muted-foreground'}`}>
              PAPER
            </button>
            <button type="button" onClick={() => setMode('LIVE')}
              className={`px-2 py-1 rounded text-[9px] font-bold tracking-wider border ${mode === 'LIVE' ? 'bg-bullish/15 border-bullish/40 text-bullish' : 'bg-secondary/30 border-border text-muted-foreground'}`}>
              LIVE
            </button>
          </div>

          <div>
            <label className="text-[9px] text-muted-foreground tracking-wider uppercase block mb-1">Rationale</label>
            <textarea value={rationale} onChange={e => setRationale(e.target.value)}
              className="w-full bg-secondary/50 border border-border rounded px-2 py-1.5 text-xs text-foreground resize-none"
              rows={2} placeholder="Why are you taking this trade?" />
          </div>

          <div>
            <label className="text-[9px] text-muted-foreground tracking-wider uppercase block mb-1">Tags (comma-separated)</label>
            <input value={tags} onChange={e => setTags(e.target.value)}
              className="w-full bg-secondary/50 border border-border rounded px-2 py-1.5 text-xs text-foreground"
              placeholder="breakout, momentum, scalp" />
          </div>

          <button type="submit" disabled={createMutation.isPending}
            className="w-full py-2 rounded bg-info-cyan/15 border border-info-cyan/40 text-info-cyan text-xs font-bold tracking-wider hover:bg-info-cyan/25 transition-colors disabled:opacity-50">
            {createMutation.isPending ? 'LOGGING...' : 'LOG TRADE'}
          </button>
        </form>
      </div>
    </div>
  );
}

// ─── Close Trade Form ───

function CloseTradeForm({ tradeId, onClose, onSuccess }: { tradeId: number; onClose: () => void; onSuccess: () => void }) {
  const [exitPrice, setExitPrice] = useState('');
  const [exitReason, setExitReason] = useState('');

  const closeMutation = trpc.journal.close.useMutation({
    onSuccess: () => {
      toast.success('Trade closed');
      onSuccess();
    },
    onError: (err) => toast.error(err.message),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-sm mx-4 bg-card border border-border rounded-lg shadow-2xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="font-display text-sm font-bold tracking-wider text-foreground">CLOSE TRADE</span>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
        </div>
        <div>
          <label className="text-[9px] text-muted-foreground tracking-wider uppercase block mb-1">Exit Price ₹</label>
          <input type="number" step="any" value={exitPrice} onChange={e => setExitPrice(e.target.value)}
            className="w-full bg-secondary/50 border border-border rounded px-2 py-1.5 text-xs text-foreground tabular-nums"
            placeholder="180.00" required />
        </div>
        <div>
          <label className="text-[9px] text-muted-foreground tracking-wider uppercase block mb-1">Exit Reason</label>
          <textarea value={exitReason} onChange={e => setExitReason(e.target.value)}
            className="w-full bg-secondary/50 border border-border rounded px-2 py-1.5 text-xs text-foreground resize-none"
            rows={2} placeholder="Target hit / SL hit / Manual exit" />
        </div>
        <button onClick={() => {
          if (!exitPrice) { toast.error('Exit price required'); return; }
          closeMutation.mutate({
            id: tradeId,
            exitPrice: parseFloat(exitPrice),
            exitTime: Date.now(),
            exitReason: exitReason || undefined,
          });
        }} disabled={closeMutation.isPending}
          className="w-full py-2 rounded bg-destructive/15 border border-destructive/40 text-destructive text-xs font-bold tracking-wider hover:bg-destructive/25 transition-colors disabled:opacity-50">
          {closeMutation.isPending ? 'CLOSING...' : 'CLOSE TRADE'}
        </button>
      </div>
    </div>
  );
}

// ─── Stats Card ───

function StatsCard({ label, value, icon: Icon, color = 'text-foreground', suffix = '' }: {
  label: string; value: string | number; icon: React.ElementType; color?: string; suffix?: string;
}) {
  return (
    <div className="bg-secondary/20 border border-border rounded p-3 space-y-1">
      <div className="flex items-center gap-1.5">
        <Icon className={`h-3 w-3 ${color}`} />
        <span className="text-[8px] text-muted-foreground tracking-wider uppercase">{label}</span>
      </div>
      <div className={`text-lg font-bold tabular-nums ${color}`}>
        {value}{suffix}
      </div>
    </div>
  );
}

// ─── Main Page ───

export default function TradeJournal() {
  const { user, loading, isAuthenticated } = useAuth();
  const [showNewTrade, setShowNewTrade] = useState(false);
  const [closingTradeId, setClosingTradeId] = useState<number | null>(null);
  const [filterStatus, setFilterStatus] = useState<'ALL' | 'OPEN' | 'CLOSED'>('ALL');
  const [filterInstrument, setFilterInstrument] = useState<string>('ALL');
  const [expandedTrade, setExpandedTrade] = useState<number | null>(null);

  const utils = trpc.useUtils();

  const tradesQuery = trpc.journal.list.useQuery(
    filterStatus === 'ALL' && filterInstrument === 'ALL'
      ? undefined
      : {
          ...(filterStatus !== 'ALL' ? { status: filterStatus as any } : {}),
          ...(filterInstrument !== 'ALL' ? { instrument: filterInstrument } : {}),
        },
    { enabled: isAuthenticated }
  );

  const statsQuery = trpc.journal.stats.useQuery(undefined, { enabled: isAuthenticated });

  const refreshAll = () => {
    utils.journal.list.invalidate();
    utils.journal.stats.invalidate();
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-muted-foreground text-sm">Loading...</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-4">
          <BookOpen className="h-12 w-12 text-muted-foreground mx-auto" />
          <p className="text-muted-foreground">Please log in to access your Trade Journal</p>
          <a href={getLoginUrl()} className="inline-block px-4 py-2 rounded bg-info-cyan/15 border border-info-cyan/40 text-info-cyan text-xs font-bold tracking-wider hover:bg-info-cyan/25 transition-colors">
            LOG IN
          </a>
        </div>
      </div>
    );
  }

  const trades = tradesQuery.data || [];
  const stats = statsQuery.data;

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-40">
        <div className="container max-w-6xl py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/" className="text-muted-foreground hover:text-foreground transition-colors">
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <BookOpen className="h-5 w-5 text-info-cyan" />
            <h1 className="font-display text-lg font-bold tracking-wider text-foreground">TRADE JOURNAL</h1>
          </div>
          <button onClick={() => setShowNewTrade(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-info-cyan/15 border border-info-cyan/40 text-info-cyan text-[10px] font-bold tracking-wider hover:bg-info-cyan/25 transition-colors">
            <Plus className="h-3 w-3" /> LOG TRADE
          </button>
        </div>
      </div>

      <div className="container max-w-6xl py-6 space-y-6">
        {/* Stats Grid */}
        {stats && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <StatsCard label="Total P&L" value={`₹${formatPrice(stats.totalPnl)}`} icon={DollarSign}
              color={stats.totalPnl >= 0 ? 'text-bullish' : 'text-destructive'} />
            <StatsCard label="Win Rate" value={stats.winRate} icon={Percent}
              color={stats.winRate >= 50 ? 'text-bullish' : 'text-destructive'} suffix="%" />
            <StatsCard label="Total Trades" value={stats.totalTrades} icon={BarChart3} color="text-info-cyan" />
            <StatsCard label="Avg R:R" value={stats.avgRR} icon={Target}
              color={stats.avgRR >= 1.5 ? 'text-bullish' : 'text-warning-amber'} />
            <StatsCard label="Max Win" value={`₹${formatPrice(stats.maxWin)}`} icon={Award} color="text-bullish" />
            <StatsCard label="Max Drawdown" value={`₹${formatPrice(stats.maxDrawdown)}`} icon={AlertTriangle} color="text-destructive" />
          </div>
        )}

        {/* Filters */}
        <div className="flex items-center gap-3 flex-wrap">
          <Filter className="h-3 w-3 text-muted-foreground" />
          <div className="flex gap-1">
            {(['ALL', 'OPEN', 'CLOSED'] as const).map(s => (
              <button key={s} onClick={() => setFilterStatus(s)}
                className={`px-2 py-1 rounded text-[9px] font-bold tracking-wider border ${
                  filterStatus === s
                    ? 'bg-info-cyan/15 border-info-cyan/40 text-info-cyan'
                    : 'bg-secondary/30 border-border text-muted-foreground hover:text-foreground'
                }`}>
                {s}
              </button>
            ))}
          </div>
          <select value={filterInstrument} onChange={e => setFilterInstrument(e.target.value)}
            className="bg-secondary/50 border border-border rounded px-2 py-1 text-[9px] text-foreground">
            <option value="ALL">All Instruments</option>
            {INSTRUMENTS.map(i => <option key={i} value={i}>{i.replace('_', ' ')}</option>)}
          </select>
        </div>

        {/* Trade List */}
        {tradesQuery.isLoading ? (
          <div className="text-center py-12 text-muted-foreground text-sm">Loading trades...</div>
        ) : trades.length === 0 ? (
          <div className="text-center py-12 space-y-3">
            <BookOpen className="h-10 w-10 text-muted-foreground mx-auto" />
            <p className="text-muted-foreground text-sm">No trades logged yet</p>
            <button onClick={() => setShowNewTrade(true)}
              className="text-info-cyan text-xs font-bold tracking-wider hover:underline">
              Log your first trade
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            {trades.map(trade => {
              const isOpen = trade.status === 'OPEN';
              const isWin = (trade.pnl || 0) > 0;
              const isExpanded = expandedTrade === trade.id;
              const isBuy = trade.tradeType === 'CALL_BUY' || trade.tradeType === 'PUT_BUY';

              return (
                <div key={trade.id}
                  className={`rounded border ${isOpen ? 'border-info-cyan/20 bg-info-cyan/5' : isWin ? 'border-bullish/20 bg-bullish/5' : 'border-destructive/20 bg-destructive/5'} overflow-hidden`}>
                  {/* Main row */}
                  <button onClick={() => setExpandedTrade(isExpanded ? null : trade.id)}
                    className="w-full px-3 py-2.5 flex items-center gap-3 text-left">
                    {/* Status icon */}
                    {isOpen ? (
                      <Clock className="h-4 w-4 text-info-cyan shrink-0" />
                    ) : isWin ? (
                      <CheckCircle2 className="h-4 w-4 text-bullish shrink-0" />
                    ) : (
                      <XCircle className="h-4 w-4 text-destructive shrink-0" />
                    )}

                    {/* Instrument + type */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-foreground">{trade.instrument.replace('_', ' ')}</span>
                        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                          isBuy ? 'bg-bullish/10 text-bullish border border-bullish/20' : 'bg-destructive/10 text-destructive border border-destructive/20'
                        }`}>
                          {trade.tradeType.replace('_', ' ')}
                        </span>
                        <span className="text-[9px] text-muted-foreground tabular-nums">{trade.strike}</span>
                        {trade.mode === 'PAPER' && (
                          <span className="text-[8px] px-1 py-0.5 rounded bg-warning-amber/10 text-warning-amber border border-warning-amber/20">PAPER</span>
                        )}
                      </div>
                      <div className="text-[9px] text-muted-foreground mt-0.5">
                        {formatDate(trade.entryTime)} · ₹{formatPrice(trade.entryPrice)} × {trade.quantity}
                      </div>
                    </div>

                    {/* P&L */}
                    <div className="text-right shrink-0">
                      {trade.status === 'CLOSED' && trade.pnl !== null ? (
                        <>
                          <div className={`text-sm font-bold tabular-nums ${isWin ? 'text-bullish' : 'text-destructive'}`}>
                            {isWin ? '+' : ''}₹{formatPrice(trade.pnl)}
                          </div>
                          <div className={`text-[9px] tabular-nums ${isWin ? 'text-bullish/70' : 'text-destructive/70'}`}>
                            {isWin ? '+' : ''}{trade.pnlPercent?.toFixed(1)}%
                          </div>
                        </>
                      ) : (
                        <span className="text-[10px] text-info-cyan font-bold">OPEN</span>
                      )}
                    </div>

                    {isExpanded ? <ChevronUp className="h-3 w-3 text-muted-foreground shrink-0" /> : <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />}
                  </button>

                  {/* Expanded details */}
                  {isExpanded && (
                    <div className="px-3 pb-3 pt-1 border-t border-white/5 space-y-2">
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[9px]">
                        {trade.stopLoss && (
                          <div>
                            <span className="text-muted-foreground">SL:</span>
                            <span className="text-destructive ml-1 font-bold tabular-nums">₹{formatPrice(trade.stopLoss)}</span>
                          </div>
                        )}
                        {trade.target && (
                          <div>
                            <span className="text-muted-foreground">Target:</span>
                            <span className="text-bullish ml-1 font-bold tabular-nums">₹{formatPrice(trade.target)}</span>
                          </div>
                        )}
                        {trade.exitPrice && (
                          <div>
                            <span className="text-muted-foreground">Exit:</span>
                            <span className="text-foreground ml-1 font-bold tabular-nums">₹{formatPrice(trade.exitPrice)}</span>
                          </div>
                        )}
                        {trade.aiDecision && (
                          <div>
                            <span className="text-muted-foreground">AI:</span>
                            <span className="text-info-cyan ml-1 font-bold">{trade.aiDecision}</span>
                            {trade.aiConfidence && <span className="text-muted-foreground ml-1">({(trade.aiConfidence * 100).toFixed(0)}%)</span>}
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
                          <span className="text-[8px] text-muted-foreground tracking-wider uppercase">Rationale:</span>
                          <p className="text-[10px] text-foreground/80 mt-0.5">{trade.rationale}</p>
                        </div>
                      )}
                      {trade.exitReason && (
                        <div>
                          <span className="text-[8px] text-muted-foreground tracking-wider uppercase">Exit Reason:</span>
                          <p className="text-[10px] text-foreground/80 mt-0.5">{trade.exitReason}</p>
                        </div>
                      )}
                      {trade.tags && (
                        <div className="flex gap-1 flex-wrap">
                          {trade.tags.split(',').map((tag, i) => (
                            <span key={i} className="text-[8px] px-1.5 py-0.5 rounded bg-secondary/50 border border-border text-muted-foreground">
                              {tag.trim()}
                            </span>
                          ))}
                        </div>
                      )}

                      {isOpen && (
                        <button onClick={(e) => { e.stopPropagation(); setClosingTradeId(trade.id); }}
                          className="px-3 py-1.5 rounded bg-destructive/15 border border-destructive/40 text-destructive text-[10px] font-bold tracking-wider hover:bg-destructive/25 transition-colors">
                          CLOSE TRADE
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Modals */}
      {showNewTrade && (
        <NewTradeForm onClose={() => setShowNewTrade(false)} onSuccess={() => { setShowNewTrade(false); refreshAll(); }} />
      )}
      {closingTradeId !== null && (
        <CloseTradeForm tradeId={closingTradeId} onClose={() => setClosingTradeId(null)} onSuccess={() => { setClosingTradeId(null); refreshAll(); }} />
      )}
    </div>
  );
}
