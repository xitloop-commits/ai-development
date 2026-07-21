/**
 * MainFooter — Sticky bottom bar for the single-screen command center.
 *
 * Layout (left → right):
 *   1. Quarterly Projections (Q boxes)
 *   2. Monthly Growth (Prev + Curr month, hover → pool breakup)
 *   3. Holiday indicator (click → dialog)
 *   4. Discipline score (hover → 7-category breakup)
 *   5. Capital Pools horizontal (Trading + Reserve bars, hover → Add Fund dialog)
 *   6. Net Worth + growth%
 *
 * Data: Wired to global CapitalContext (single source of truth).
 */
import { useState, useMemo } from 'react';
import {
  Plus,
  Minus,
  BookOpen,
  Loader2,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useCapital } from '@/contexts/CapitalContext';
import { CapitalBookDialog } from './CapitalBookDialog';
import { formatINR } from '@/lib/formatINR';
import { trpc } from '@/lib/trpc';

// ─── Holiday Helpers ────────────────────────────────────────
function _getDaysUntil(dateStr: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr + 'T00:00:00');
  return Math.ceil((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

function _getDaysLabel(days: number): string {
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  return `In ${days} days`;
}

function _formatDateShort(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

function _isHolidayThisMonth(dateStr: string): boolean {
  const now = new Date();
  const d = new Date(dateStr + 'T00:00:00');
  return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
}

// ─── Component ──────────────────────────────────────────────
// ─── Net Worth Popover (Add Fund / Withdraw / Transfer) ─────

function NetWorthPopover({
  netWorth, tradingPool, reservePool, growthPercent,
  tradingPoolGrowth, reservePoolGrowth, fmt, mode,
}: {
  netWorth: number; tradingPool: number; reservePool: number;
  growthPercent: string; tradingPoolGrowth: string; reservePoolGrowth: string;
  fmt: (n: number) => string; mode: 'PAPER' | 'LIVE';
}) {
  const [tab, setTab] = useState<'overview' | 'inject' | 'withdraw' | 'transfer'>('overview');
  const [amount, setAmount] = useState('');
  const [withdrawFrom, setWithdrawFrom] = useState<'trading' | 'reserve'>('trading');
  const [bookOpen, setBookOpen] = useState(false);
  const [transferDir, setTransferDir] = useState<'reserve-to-trading' | 'trading-to-reserve'>('reserve-to-trading');
  const {
    inject: ctxInject, injectPending, withdraw: ctxWithdraw, withdrawPending,
    transferFunds, transferFundsPending, channel,
  } = useCapital() as any;

  // Every funding action lands on the channel being VIEWED. Naming it on the
  // button is the guard: these were all hardcoded to 'my-live', so funding while
  // looking at Paper silently moved money in the real book with nothing on
  // screen to say so.
  const book = String(channel);
  const isLiveBook = book !== 'paper';

  /** Live books are seeded once from the real Dhan balance. Moving money by hand
   *  makes the app's figure disagree with the broker's, and nothing reconciles
   *  them — so say it plainly before it happens, as live orders already do. */
  const confirmLive = (verb: string, v: number) =>
    !isLiveBook ||
    window.confirm(
      `${verb} ${fmt(v)} on ${book}?

` +
      `This is a LIVE book seeded from your Dhan balance. Changing it here does ` +
      `NOT move money at the broker, and the two figures will no longer agree.`,
    );

  const handleInject = () => {
    const v = parseFloat(amount);
    if (isNaN(v) || v <= 0) return;
    if (!confirmLive('Add', v)) return;
    ctxInject(v);
    setAmount('');
    setTab('overview');
  };

  const handleWithdraw = () => {
    const v = parseFloat(amount);
    if (isNaN(v) || v <= 0) return;
    const pool = withdrawFrom === 'trading' ? tradingPool : reservePool;
    if (v > pool) {
      window.alert(`${withdrawFrom} pool holds ${fmt(pool)} — cannot withdraw ${fmt(v)}.`);
      return;
    }
    if (!confirmLive('Withdraw', v)) return;
    ctxWithdraw(v, withdrawFrom);
    setAmount('');
    setTab('overview');
  };

  const handleTransfer = () => {
    const v = parseFloat(amount);
    if (isNaN(v) || v <= 0) return;
    const from = transferDir === 'reserve-to-trading' ? 'reserve' : 'trading';
    const to = transferDir === 'reserve-to-trading' ? 'trading' : 'reserve';
    if (!confirmLive(`Move ${from} → ${to}`, v)) return;
    transferFunds(from, to, v);
    setAmount('');
    setTab('overview');
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <div className="flex flex-col items-end cursor-pointer shrink-0 hover:opacity-80 transition-opacity">
          <span className="text-[0.625rem] text-muted-foreground tracking-widest uppercase flex items-center gap-1">
            Net Worth
            <span className={`px-1 rounded text-[0.5rem] font-bold leading-tight ${
              mode === 'LIVE' ? 'bg-bullish/20 text-bullish' : 'bg-warning-amber/20 text-warning-amber'
            }`}>
              {mode}
            </span>
          </span>
          <span className="text-sm font-bold tabular-nums text-foreground">
            {fmt(netWorth)}{' '}
            <span className={`text-xs ${Number(growthPercent) >= 0 ? 'text-bullish' : 'text-loss-red'}`}>
              {Number(growthPercent) >= 0 ? '+' : ''}{growthPercent}%
            </span>
          </span>
        </div>
      </PopoverTrigger>
      <PopoverContent side="top" className="w-72 p-3">
        <div className="space-y-3">
          {/* Pool breakdown */}
          <div className="text-xs space-y-1.5">
            <div className="font-bold text-foreground">Capital Pools</div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Trading Pool</span>
              <span className="font-bold tabular-nums">
                {fmt(tradingPool)}{' '}
                <span className={`text-[0.625rem] ${Number(tradingPoolGrowth) >= 0 ? 'text-bullish' : 'text-loss-red'}`}>
                  {Number(tradingPoolGrowth) >= 0 ? '+' : ''}{tradingPoolGrowth}%
                </span>
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Reserve Pool</span>
              <span className="font-bold tabular-nums">
                {fmt(reservePool)}{' '}
                <span className={`text-[0.625rem] ${Number(reservePoolGrowth) >= 0 ? 'text-bullish' : 'text-loss-red'}`}>
                  {Number(reservePoolGrowth) >= 0 ? '+' : ''}{reservePoolGrowth}%
                </span>
              </span>
            </div>
            <div className="flex justify-between pt-1 border-t border-border/50">
              <span className="text-muted-foreground">Net Worth</span>
              <span className="font-bold tabular-nums">{fmt(netWorth)}</span>
            </div>
          </div>

          {/* Tab buttons */}
          <div className="flex gap-1 border-t border-border/50 pt-2">
            <button
              onClick={() => { setTab('inject'); setAmount(''); }}
              className={`flex-1 px-2 py-1 rounded text-[0.625rem] font-bold transition-colors ${
                tab === 'inject' ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Plus className="inline h-2.5 w-2.5 mr-0.5" />Add Fund
            </button>
            <button
              onClick={() => setBookOpen(true)}
              className="flex-1 px-2 py-1 rounded text-[0.625rem] font-bold text-muted-foreground hover:text-foreground transition-colors"
              title={`Book of records for ${book}`}
            >
              <BookOpen className="inline h-2.5 w-2.5 mr-0.5" />Book
            </button>
            <button
              onClick={() => { setTab('withdraw'); setAmount(''); }}
              className={`flex-1 px-2 py-1 rounded text-[0.625rem] font-bold transition-colors ${
                tab === 'withdraw' ? 'bg-warning-amber/15 text-warning-amber' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Minus className="inline h-2.5 w-2.5 mr-0.5" />Withdraw
            </button>
            <button
              onClick={() => { setTab('transfer'); setAmount(''); }}
              className={`flex-1 px-2 py-1 rounded text-[0.625rem] font-bold transition-colors ${
                tab === 'transfer' ? 'bg-info-cyan/15 text-info-cyan' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Transfer
            </button>
          </div>

          {/* Add Fund form */}
          {tab === 'inject' && (
            <div className="space-y-2">
              {/*
                This used to promise "Split 75% Trading / 25% Reserve" and
                preview both lines. injectCapital() has only ever added to
                Trading and left Reserve untouched — all three books sit at
                reserve 0. The Reserve pool fills from PROFITS via the daily
                split, not from injections.
              */}
              <p className="text-[0.6875rem] text-muted-foreground">
                Added to the <span className="font-bold text-foreground">Trading</span> pool
                of <span className="font-bold text-foreground">{book}</span>.
                Reserve fills from profits, not from funding.
              </p>
              <input
                type="number" placeholder="Amount (₹)" value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm tabular-nums focus:outline-none focus:ring-1 focus:ring-primary"
                min="1" step="1000"
              />
              <button
                onClick={handleInject}
                disabled={injectPending || !amount}
                className="w-full flex items-center justify-center gap-1 px-3 py-1.5 rounded-md text-xs font-bold bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 transition-colors"
              >
                {injectPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <><Plus className="h-3 w-3" /> Add to {book}</>}
              </button>
              {amount && parseFloat(amount) > 0 && (
                <div className="text-[0.6875rem] text-muted-foreground">
                  Trading {fmt(tradingPool)} → {fmt(tradingPool + parseFloat(amount))}
                </div>
              )}
            </div>
          )}

          {/* Withdraw form */}
          {tab === 'withdraw' && (
            <div className="space-y-2">
              <div className="flex gap-1">
                {(['trading', 'reserve'] as const).map((p) => (
                  <button
                    key={p}
                    onClick={() => setWithdrawFrom(p)}
                    className={`flex-1 px-2 py-1 rounded text-[0.625rem] font-bold capitalize transition-colors ${
                      withdrawFrom === p
                        ? 'bg-warning-amber/15 text-warning-amber border border-warning-amber/30'
                        : 'text-muted-foreground border border-transparent'
                    }`}
                  >
                    From {p}
                  </button>
                ))}
              </div>
              <input
                type="number" placeholder="Amount (₹)" value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm tabular-nums focus:outline-none focus:ring-1 focus:ring-warning-amber"
                min="1" step="1000"
                max={withdrawFrom === 'trading' ? tradingPool : reservePool}
              />
              <button
                onClick={handleWithdraw}
                disabled={withdrawPending || !amount}
                className="w-full flex items-center justify-center gap-1 px-3 py-1.5 rounded-md text-xs font-bold bg-warning-amber text-background hover:bg-warning-amber/90 disabled:opacity-40 transition-colors"
              >
                {withdrawPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <><Minus className="h-3 w-3" /> Take from {book}</>}
              </button>
              {amount && parseFloat(amount) > 0 && (
                <div className="text-[0.6875rem] text-muted-foreground">
                  {(() => {
                    const pool = withdrawFrom === 'trading' ? tradingPool : reservePool;
                    const v = parseFloat(amount);
                    return v > pool
                      ? <span className="text-loss-red font-bold">Only {fmt(pool)} in {withdrawFrom}.</span>
                      : <>{withdrawFrom} {fmt(pool)} → {fmt(pool - v)}</>;
                  })()}
                </div>
              )}
            </div>
          )}

          {/* Transfer form */}
          {tab === 'transfer' && (
            <div className="space-y-2">
              <div className="flex gap-1">
                <button
                  onClick={() => setTransferDir('reserve-to-trading')}
                  className={`flex-1 px-2 py-1 rounded text-[0.625rem] font-bold transition-colors ${
                    transferDir === 'reserve-to-trading' ? 'bg-bullish/15 text-bullish border border-bullish/30' : 'text-muted-foreground border border-transparent'
                  }`}
                >
                  Reserve → Trading
                </button>
                <button
                  onClick={() => setTransferDir('trading-to-reserve')}
                  className={`flex-1 px-2 py-1 rounded text-[0.625rem] font-bold transition-colors ${
                    transferDir === 'trading-to-reserve' ? 'bg-info-cyan/15 text-info-cyan border border-info-cyan/30' : 'text-muted-foreground border border-transparent'
                  }`}
                >
                  Trading → Reserve
                </button>
              </div>
              <input
                type="number" placeholder="Amount (₹)" value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm tabular-nums focus:outline-none focus:ring-1 focus:ring-info-cyan"
                min="1" step="1000"
                max={transferDir === 'reserve-to-trading' ? reservePool : tradingPool}
              />
              <button
                onClick={handleTransfer}
                disabled={transferFundsPending || !amount}
                className="w-full flex items-center justify-center gap-1 px-3 py-1.5 rounded-md text-xs font-bold bg-info-cyan text-background hover:bg-info-cyan/90 disabled:opacity-40 transition-colors"
              >
                {transferFundsPending ? <Loader2 className="h-3 w-3 animate-spin" /> : `Transfer within ${book}`}
              </button>
              {amount && parseFloat(amount) > 0 && (
                <div className="text-[0.6875rem] text-muted-foreground">
                  {transferDir === 'reserve-to-trading'
                    ? `Reserve ${fmt(reservePool)} → ${fmt(reservePool - parseFloat(amount))} | Trading ${fmt(tradingPool)} → ${fmt(tradingPool + parseFloat(amount))}`
                    : `Trading ${fmt(tradingPool)} → ${fmt(tradingPool - parseFloat(amount))} | Reserve ${fmt(reservePool)} → ${fmt(reservePool + parseFloat(amount))}`
                  }
                </div>
              )}
            </div>
          )}
        </div>
      </PopoverContent>
      <CapitalBookDialog open={bookOpen} onClose={() => setBookOpen(false)} channel={book} />
    </Popover>
  );
}

export default function MainFooter() {
  // Holiday moved to AppBar

  // ─── Global Capital Context (single source of truth) ────────
  const { capital, channel, stateData, allDays, inject: ctxInject, injectPending: _injectPending } = useCapital() as any;

  // Net worth follows the mode (T87 point 18): PAPER shows the one shared paper
  // pool; LIVE shows ai-live + my-live combined (two separate real accounts, but
  // one total figure). In live mode `capital` is my-live (the active channel), so
  // we fetch ai-live and add it. Paper mode needs no extra fetch.
  const isLive = channel !== 'paper';
  // BOTH live books are fetched explicitly rather than "the current one plus
  // ai-live". `isLive` is true for ai-live too, so the old form added ai-live to
  // ITSELF whenever that workspace was open — the footer showed double.
  const myLiveQuery = trpc.portfolio.state.useQuery(
    { channel: 'my-live' },
    { enabled: isLive, refetchInterval: 5000 },
  );
  const aiLiveQuery = trpc.portfolio.state.useQuery(
    { channel: 'ai-live' },
    { enabled: isLive, refetchInterval: 5000 },
  );
  const myLive = myLiveQuery.data as any;
  const aiLive = aiLiveQuery.data as any;
  const add = (a: number | undefined, b: number | undefined) => (a ?? 0) + (b ?? 0);

  // ─── Capital Data (mode-aware; combined across both live accounts) ──
  const _capitalData = stateData as any;
  const tradingPool = isLive ? add(myLive?.tradingPool, aiLive?.tradingPool) : capital.tradingPool;
  const reservePool = isLive ? add(myLive?.reservePool, aiLive?.reservePool) : capital.reservePool;
  const netWorth = isLive ? add(myLive?.netWorth, aiLive?.netWorth) : capital.netWorth;
  const initialFunding = isLive ? add(myLive?.initialFunding, aiLive?.initialFunding) : capital.initialFunding;
  const growthPercent = initialFunding > 0
    ? (((netWorth - initialFunding) / initialFunding) * 100).toFixed(1)
    : '0.0';

  // Monthly P&L (profit only, excludes injected funds) computed from day records
  const now = new Date();
  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const currMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const prevMonthName = prevMonthStart.toLocaleDateString('en-IN', { month: 'short' }).toUpperCase() + "'" + String(prevMonthStart.getFullYear()).slice(2);
  const currMonthName = currMonthStart.toLocaleDateString('en-IN', { month: 'short' }).toUpperCase() + "'" + String(currMonthStart.getFullYear()).slice(2);

  const monthlyPnl = useMemo(() => {
    const days = allDays ?? [];
    let prevPnl = 0, prevCharges = 0, prevTrades = 0;
    let currPnl = 0, currCharges = 0, currTrades = 0;
    for (const d of days) {
      if (!d.date || d.status === 'FUTURE') continue;
      const dayDate = new Date(d.date + 'T00:00:00');
      if (dayDate >= prevMonthStart && dayDate < currMonthStart) {
        prevPnl += d.totalPnl || 0;
        prevCharges += d.totalCharges || 0;
        prevTrades += (d.trades?.length ?? 0);
      } else if (dayDate >= currMonthStart) {
        currPnl += d.totalPnl || 0;
        currCharges += d.totalCharges || 0;
        currTrades += (d.trades?.length ?? 0);
      }
    }
    return { prevPnl, prevCharges, prevTrades, currPnl, currCharges, currTrades };
  }, [allDays, prevMonthStart.getTime(), currMonthStart.getTime()]);

  // Net Worth pool growth since inception
  const tradingPoolGrowth = initialFunding > 0
    ? (((tradingPool - initialFunding * 0.75) / (initialFunding * 0.75)) * 100).toFixed(1)
    : '0.0';
  const reservePoolGrowth = initialFunding > 0
    ? (((reservePool - initialFunding * 0.25) / (initialFunding * 0.25)) * 100).toFixed(1)
    : '0.0';

  // Pool percentages
  const _tradingPoolPct = netWorth > 0 ? ((tradingPool / netWorth) * 100).toFixed(1) : '0.0';
  const _reservePoolPct = netWorth > 0 ? ((reservePool / netWorth) * 100).toFixed(1) : '0.0';

  // H6 — discipline score + breakdown previously fetched here (and
  // never displayed; the live discipline UI lives in the AppBar
  // Indicators component now). Whole block dropped.

  const fmt = (n: number) => formatINR(n);

  // ─── Quarterly Projections (from global context) ────────────
  // (was `_allQuarters` — orphan dead var dropped in H6.)

  return (
    <div className="sticky bottom-0 z-40 border-t border-border bg-gradient-footer backdrop-blur-md">
      <div className="flex items-center px-3 py-2 gap-4">

        {/* ─── Prev Month P&L ─── */}
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex flex-col cursor-default shrink-0">
              <span className="text-[0.625rem] text-muted-foreground tracking-widest uppercase">{prevMonthName}</span>
              <span className={`text-[0.8125rem] font-bold tabular-nums ${monthlyPnl.prevPnl >= 0 ? 'text-bullish' : 'text-destructive'}`}>
                {monthlyPnl.prevPnl >= 0 ? '+' : ''}{fmt(monthlyPnl.prevPnl)}
              </span>
            </div>
          </TooltipTrigger>
            <TooltipContent side="top">
              <div className="text-xs space-y-0.5">
                <div className="font-bold">{prevMonthName}</div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">P&L</span>
                  <span className={`font-bold ${monthlyPnl.prevPnl >= 0 ? 'text-bullish' : 'text-destructive'}`}>
                    {monthlyPnl.prevPnl >= 0 ? '+' : ''}{fmt(monthlyPnl.prevPnl)}
                  </span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Charges</span>
                  <span className="font-bold">{fmt(monthlyPnl.prevCharges)}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Net</span>
                  <span className={`font-bold ${(monthlyPnl.prevPnl - monthlyPnl.prevCharges) >= 0 ? 'text-bullish' : 'text-destructive'}`}>
                    {fmt(monthlyPnl.prevPnl - monthlyPnl.prevCharges)}
                  </span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Trades</span>
                  <span className="font-bold">{monthlyPnl.prevTrades}</span>
                </div>
              </div>
            </TooltipContent>
        </Tooltip>

        {/* Separator */}
        <div className="w-px self-stretch -my-2 bg-border shrink-0" />

        {/* ─── Curr Month P&L ─── */}
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex flex-col cursor-default shrink-0">
              <span className="text-[0.625rem] text-muted-foreground tracking-widest uppercase">{currMonthName}</span>
                <span className={`text-[0.8125rem] font-bold tabular-nums ${monthlyPnl.currPnl >= 0 ? 'text-bullish' : 'text-destructive'}`}>
                  {monthlyPnl.currPnl >= 0 ? '+' : ''}{fmt(monthlyPnl.currPnl)}
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="top">
              <div className="text-xs space-y-0.5">
                <div className="font-bold">{currMonthName}</div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">P&L</span>
                  <span className={`font-bold ${monthlyPnl.currPnl >= 0 ? 'text-bullish' : 'text-destructive'}`}>
                    {monthlyPnl.currPnl >= 0 ? '+' : ''}{fmt(monthlyPnl.currPnl)}
                  </span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Charges</span>
                  <span className="font-bold">{fmt(monthlyPnl.currCharges)}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Net</span>
                  <span className={`font-bold ${(monthlyPnl.currPnl - monthlyPnl.currCharges) >= 0 ? 'text-bullish' : 'text-destructive'}`}>
                    {fmt(monthlyPnl.currPnl - monthlyPnl.currCharges)}
                  </span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Trades</span>
                  <span className="font-bold">{monthlyPnl.currTrades}</span>
                </div>
              </div>
            </TooltipContent>
        </Tooltip>

        {/* Spacer — pushes Net Worth to the right edge (was the milestone bar) */}
        <div className="flex-1" />

        {/* Separator */}
        <div className="w-px self-stretch -my-2 bg-border shrink-0" />

        {/* ─── Net Worth — popover with inject + transfer ─── */}
        <NetWorthPopover
          netWorth={netWorth}
          tradingPool={tradingPool}
          reservePool={reservePool}
          growthPercent={growthPercent}
          tradingPoolGrowth={tradingPoolGrowth}
          reservePoolGrowth={reservePoolGrowth}
          fmt={fmt}
          mode={isLive ? 'LIVE' : 'PAPER'}
        />
      </div>
    </div>
  );
}
