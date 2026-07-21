/**
 * CapitalBookDialog — the book of records for a channel's capital.
 *
 * Opened from the "Book" CTA on the Net Worth panel. Applies to paper and live.
 *
 * Exists because on 2026-07-21 a ₹9,00,000 injection meant for paper landed on
 * the live book and sat there for over an hour reading as profit. Nothing had
 * recorded the change, so it had to be reconstructed from arithmetic. Every
 * capital movement now leaves a row here.
 *
 * The reconciliation strip is the point of the screen: it compares the book
 * against the real Dhan balance and REPORTS a difference rather than quietly
 * correcting it. Auto-correcting would have absorbed that 9L and hidden the bug.
 */
import { trpc } from '@/lib/trpc';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const fmt = (n: number) =>
  `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Colour + label per event type. Money IN green, OUT red, neutral moves grey. */
const EVENT_STYLE: Record<string, { label: string; cls: string }> = {
  OPENING: { label: 'Opening balance', cls: 'bg-muted text-muted-foreground' },
  CAPITAL_SEEDED: { label: 'Seeded', cls: 'bg-info-cyan/15 text-info-cyan' },
  CAPITAL_INJECTED: { label: 'Added', cls: 'bg-bullish/15 text-bullish' },
  CAPITAL_WITHDRAWN: { label: 'Withdrawn', cls: 'bg-warning-amber/15 text-warning-amber' },
  CAPITAL_TRANSFERRED: { label: 'Transfer', cls: 'bg-muted text-muted-foreground' },
  DAY_COMPLETED: { label: 'Day close', cls: 'bg-primary/15 text-primary' },
  CLAWBACK: { label: 'Clawback', cls: 'bg-destructive/15 text-destructive' },
  CAPITAL_ADJUSTED: { label: 'Adjustment', cls: 'bg-warning-amber/15 text-warning-amber' },
};

const dayLabel = (day: string) =>
  new Date(`${day}T00:00:00`).toLocaleDateString('en-IN', {
    weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
  });

const timeOnly = (ts: number) =>
  new Date(ts).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });

interface PoolBookDayT {
  day: string;
  closing: number;
  rows: { eventId: string; timestamp: number; type: string; note: string; dr: number; cr: number; balance: number }[];
}

/** One pool's passbook: day-wise Dr / Cr / Balance, like a bank account book. */
function PoolBook({ title, days, emptyHint }: { title: string; days: PoolBookDayT[]; emptyHint: string }) {
  return (
    <div>
      <div className="text-[0.6875rem] font-bold mb-1">{title}</div>
      {days.length === 0 ? (
        <p className="text-[0.625rem] text-muted-foreground">{emptyHint}</p>
      ) : (
        days.map((d) => (
          <div key={d.day} className="mb-2">
            <div className="flex justify-between items-baseline text-[0.625rem] bg-muted/40 rounded px-2 py-1">
              <span className="font-bold">{dayLabel(d.day)}</span>
              <span className="text-muted-foreground">Closing balance <span className="font-bold tabular-nums text-foreground">{fmt(d.closing)}</span></span>
            </div>
            <table className="w-full text-[0.625rem] tabular-nums">
              <thead className="text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="text-left py-1 w-14">Time</th>
                  <th className="text-left">Particulars</th>
                  <th className="text-right w-[4.75rem] px-1">Dr</th>
                  <th className="text-right w-[4.75rem] px-1">Cr</th>
                  <th className="text-right w-24 pl-2">Balance</th>
                </tr>
              </thead>
              <tbody>
                {d.rows.map((r) => {
                  const st = EVENT_STYLE[r.type] ?? { label: r.type, cls: 'bg-muted text-muted-foreground' };
                  return (
                    <tr key={r.eventId} className="border-b border-border/40 align-top">
                      <td className="py-1 whitespace-nowrap">{timeOnly(r.timestamp)}</td>
                      <td>
                        <span className={`rounded px-1 py-0.5 font-bold ${st.cls}`}>{st.label}</span>
                        <div className="text-muted-foreground mt-0.5">{r.note}</div>
                      </td>
                      <td className="text-right whitespace-nowrap px-1 text-loss-red">
                        {r.dr > 0 ? fmt(r.dr) : <span className="text-muted-foreground/40">—</span>}
                      </td>
                      <td className="text-right whitespace-nowrap px-1 text-bullish">
                        {r.cr > 0 ? fmt(r.cr) : <span className="text-muted-foreground/40">—</span>}
                      </td>
                      <td className="text-right whitespace-nowrap pl-2 font-bold">{fmt(r.balance)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))
      )}
    </div>
  );
}

/**
 * The Net Worth panel shows LIVE as my-live + ai-live combined, so the book has
 * to cover both — a book for one account could never reconcile to the figure
 * printed above it. Paper is a single book.
 */
export function CapitalBookDialog({
  open, onClose, channel,
}: { open: boolean; onClose: () => void; channel: string }) {
  const channels = channel === 'paper' ? ['paper'] : ['my-live', 'ai-live'];
  // Combined total for live, matching the Net Worth figure in the footer. The
  // footer adds both books; without this the panel above and the book below
  // would print different numbers for the same thing.
  const myLive = trpc.portfolio.book.useQuery(
    { channel: 'my-live' }, { enabled: open && channel !== 'paper', refetchOnWindowFocus: false },
  );
  const aiLive = trpc.portfolio.book.useQuery(
    { channel: 'ai-live' }, { enabled: open && channel !== 'paper', refetchOnWindowFocus: false },
  );
  const combined = channel === 'paper' ? null : {
    netWorth: (myLive.data?.netWorth ?? 0) + (aiLive.data?.netWorth ?? 0),
    seed: (myLive.data?.seedCapital ?? 0) + (aiLive.data?.seedCapital ?? 0),
    trading: (myLive.data?.tradingPool ?? 0) + (aiLive.data?.tradingPool ?? 0),
    reserve: (myLive.data?.reservePool ?? 0) + (aiLive.data?.reservePool ?? 0),
    ready: !!myLive.data && !!aiLive.data,
  };
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-sm">
            Book of records · {channel === 'paper'
              ? <span className="font-mono">paper</span>
              : <span className="font-mono">my-live + ai-live</span>}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-5">
          {combined?.ready && (
            <div className="rounded-lg border border-primary/40 bg-primary/5 p-3">
              <div className="text-[0.6875rem] font-bold mb-2">
                Both live accounts combined — this is the Net Worth figure in the footer
              </div>
              <div className="grid grid-cols-4 gap-2 text-[0.6875rem]">
                {[
                  ['Seed capital', combined.seed],
                  ['Trading pool', combined.trading],
                  ['Reserve pool', combined.reserve],
                  ['Net worth', combined.netWorth],
                ].map(([label, v]) => (
                  <div key={label as string} className="rounded border border-border bg-background px-2 py-1.5">
                    <div className="text-muted-foreground">{label as string}</div>
                    <div className="font-bold tabular-nums">{fmt(v as number)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {channels.map((ch) => <ChannelBook key={ch} channel={ch} open={open} />)}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ChannelBook({ channel, open }: { channel: string; open: boolean }) {
  const book = trpc.portfolio.book.useQuery(
    { channel: channel as 'paper' | 'ai-live' | 'my-live' },
    { enabled: open, refetchOnWindowFocus: false },
  );
  const d = book.data;

  const rec = d?.reconciliation;
  const recCls =
    rec?.status === 'MATCHED' ? 'border-bullish/40 bg-bullish/10 text-bullish'
    : rec?.status === 'DRIFT' ? 'border-destructive/40 bg-destructive/10 text-destructive'
    : 'border-border bg-muted/40 text-muted-foreground';

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="text-xs font-bold mb-2 font-mono">{channel}</div>
      <>
        {book.isLoading && <p className="text-xs text-muted-foreground">Reading the book…</p>}
        {book.error && <p className="text-xs text-destructive">Could not load: {book.error.message}</p>}

        {d && (
          <div className="space-y-3">
            {/* Reconciliation — the headline. */}
            <div className={`rounded-md border px-3 py-2 text-[0.6875rem] ${recCls}`}>
              <div className="font-bold mb-0.5">
                {rec?.status === 'MATCHED' ? '✓ Book agrees with the broker'
                  : rec?.status === 'DRIFT' ? '⚠ Book does not match the broker'
                  : rec?.status === 'UNAVAILABLE' ? '? Could not reach the broker'
                  : 'Paper book — nothing to reconcile'}
              </div>
              <div className="opacity-90">{rec?.message}</div>
              {rec?.brokerBalance != null && (
                <div className="mt-1 flex gap-4 tabular-nums">
                  <span>Book {fmt(rec.bookBalance)}</span>
                  <span>Broker {fmt(rec.brokerBalance)}</span>
                  <span className="font-bold">
                    Difference {rec.difference! >= 0 ? '+' : ''}{fmt(rec.difference!)}
                  </span>
                </div>
              )}
            </div>

            {/* Where the money stands now. */}
            <div className="grid grid-cols-4 gap-2 text-[0.6875rem]">
              {[
                ['Seed capital', d.seedCapital],
                ['Trading pool', d.tradingPool],
                ['Reserve pool', d.reservePool],
                ['Net worth', d.netWorth],
              ].map(([label, v]) => (
                <div key={label as string} className="rounded border border-border px-2 py-1.5">
                  <div className="text-muted-foreground">{label as string}</div>
                  <div className="font-bold tabular-nums">{fmt(v as number)}</div>
                </div>
              ))}
            </div>

            {/* Reserve pool's own record — one row per completed day. */}
            <div>
              <div className="text-[0.6875rem] font-bold mb-1">Reserve pool · by day</div>
              {d.profitHistory.length === 0 ? (
                <p className="text-[0.625rem] text-muted-foreground">
                  Nothing yet. Profit moves into Reserve only when a day CLOSES — that is why
                  the reserve sits at zero until the first day completes.
                </p>
              ) : (
                <table className="w-full text-[0.625rem] tabular-nums">
                  <thead className="text-muted-foreground">
                    <tr className="border-b border-border">
                      <th className="text-left py-1">Day</th>
                      <th className="text-right">Profit</th>
                      <th className="text-right">→ Trading</th>
                      <th className="text-right">→ Reserve</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.profitHistory.map((p) => (
                      <tr key={p.dayIndex} className="border-b border-border/40">
                        <td className="py-1">{p.dayIndex}</td>
                        <td className={`text-right ${p.totalProfit >= 0 ? 'text-bullish' : 'text-loss-red'}`}>
                          {fmt(p.totalProfit)}
                        </td>
                        <td className="text-right">{fmt(p.tradingPoolShare)}</td>
                        <td className="text-right">{fmt(p.reservePoolShare)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* The two passbooks — every movement lands in the book of the pool
                it touched; a transfer shows in both (Dr one side, Cr the other). */}
            <PoolBook
              title="Trading pool book · newest day first"
              days={d.poolBooks.trading}
              emptyHint="No movements. Recording started 21 Jul 2026 — anything before that was never logged, which is exactly why this book exists."
            />
            <PoolBook
              title="Reserve pool book · newest day first"
              days={d.poolBooks.reserve}
              emptyHint="No movements. Money reaches Reserve only when a day CLOSES, so this book stays empty until the first day completes."
            />
          </div>
        )}
      </>
    </div>
  );
}
