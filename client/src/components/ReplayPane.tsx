/**
 * ReplayPane — the Replay tab in the left drawer (T97).
 *
 * Lists every replay run newest-first with the model it tested, its id and its
 * result. Selecting a run puts the desk into a read-only view of that
 * experiment's trades; selecting it again returns to the live book.
 *
 * Two runs can be ticked for comparison. The comparison deliberately shows more
 * than net P&L: over a single replayed day a model can win on net off one lucky
 * trade while losing on hit rate, and a model that simply fires more often loses
 * more to charges — a real finding, but a different one from predicting worse.
 */
import { useState } from 'react';
import { Trash2, GitCompare, X } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { useSelectedRunId, setSelectedRunId } from '@/lib/replaySelection';

const fmt = (n: number) => (n >= 0 ? '+' : '') + Math.round(n).toLocaleString('en-IN');
const pnlClass = (n: number) => (n > 0 ? 'text-bullish' : n < 0 ? 'text-destructive' : 'text-muted-foreground');

/** "20260718_161937" → "18 Jul 16:19" — a timestamp you can actually read. */
function modelLabel(version: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})/.exec(version);
  if (!m) return version;
  const month = new Date(`${m[1]}-${m[2]}-01T00:00:00`).toLocaleDateString('en-GB', { month: 'short' });
  return `${Number(m[3])} ${month} ${m[4]}:${m[5]}`;
}

function Stat({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[0.5rem] uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className={`text-[0.625rem] font-bold tabular-nums ${cls ?? 'text-foreground'}`}>{value}</span>
    </div>
  );
}

function CompareView({ runA, runB, onClose }: { runA: string; runB: string; onClose: () => void }) {
  const q = trpc.replay.compare.useQuery({ runA, runB });
  const d = q.data;

  return (
    <div className="border-b border-border bg-secondary/40">
      <div className="flex items-center justify-between px-2.5 py-1.5">
        <span className="text-[0.625rem] font-bold uppercase tracking-wider text-info-cyan">Comparison</span>
        <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground" title="Close comparison">
          <X className="h-3 w-3" />
        </button>
      </div>

      {!d ? (
        <div className="px-2.5 pb-2 text-[0.5625rem] text-muted-foreground">Loading…</div>
      ) : (
        <div className="px-2.5 pb-2 space-y-1.5">
          {!d.sameDate && (
            <p className="rounded border border-warning-amber/30 bg-warning-amber/10 px-1.5 py-1 text-[0.5rem] leading-relaxed text-warning-amber">
              These runs replayed DIFFERENT days ({d.a.date} vs {d.b.date}). The difference may be the day, not the model.
            </p>
          )}
          {[d.a, d.b].map((r, i) => (
            <div key={r.runId} className="rounded border border-border p-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[0.5625rem] font-bold text-foreground">{i === 0 ? 'A' : 'B'} · {r.runId}</span>
                <span className={`text-[0.625rem] font-bold tabular-nums ${pnlClass(r.netPnl)}`}>{fmt(r.netPnl)}</span>
              </div>
              <div className="mt-1 grid grid-cols-4 gap-1.5">
                <Stat label="Gross" value={fmt(r.grossPnl)} cls={pnlClass(r.grossPnl)} />
                <Stat label="Charges" value={fmt(-r.charges)} cls="text-muted-foreground" />
                <Stat label="Win%" value={`${r.winRate}%`} />
                <Stat label="Trades" value={String(r.closedCount)} />
              </div>
              <div className="mt-1 text-[0.5rem] text-muted-foreground truncate">
                {Object.entries(r.models).map(([k, v]) => `${k} ${modelLabel(v as string)}`).join(' · ') || 'no model recorded'}
              </div>
            </div>
          ))}

          {/* The actual answer, stated rather than left to be inferred. */}
          <div className="rounded border border-info-cyan/30 bg-info-cyan/5 px-1.5 py-1 text-[0.5rem] leading-relaxed text-muted-foreground">
            {(() => {
              const dn = d.a.netPnl - d.b.netPnl;
              const dw = d.a.winRate - d.b.winRate;
              const better = dn > 0 ? 'A' : dn < 0 ? 'B' : null;
              if (!better) return 'Both runs netted the same.';
              const agree = (dn > 0) === (dw > 0) || dw === 0;
              return agree
                ? `${better} is ahead on net (${fmt(Math.abs(dn))}) and does not contradict on win rate.`
                : `${better} is ahead on net (${fmt(Math.abs(dn))}) but BEHIND on win rate — likely a few large trades, not a better model. Judge on more than one day.`;
            })()}
          </div>
        </div>
      )}
    </div>
  );
}

export function ReplayPane() {
  const selected = useSelectedRunId();
  const [compare, setCompare] = useState<string[]>([]);
  const runsQuery = trpc.replay.runs.useQuery(undefined, { refetchInterval: 5000 });
  const utils = trpc.useUtils();
  const del = trpc.replay.deleteRun.useMutation({
    onSuccess: () => utils.replay.runs.invalidate(),
  });

  const runs = runsQuery.data ?? [];

  const toggleCompare = (runId: string) =>
    setCompare((prev) =>
      prev.includes(runId) ? prev.filter((r) => r !== runId) : [...prev, runId].slice(-2),
    );

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {compare.length === 2 && (
        <CompareView runA={compare[0]} runB={compare[1]} onClose={() => setCompare([])} />
      )}

      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
        {runs.length === 0 ? (
          <p className="px-2.5 py-3 text-[0.5625rem] text-muted-foreground leading-relaxed">
            No replay runs yet. Start one from the AppBar's Replay control — its trades are kept
            here, separate from the paper book.
          </p>
        ) : (
          runs.map((r) => {
            const isSel = selected === r.runId;
            const inCompare = compare.includes(r.runId);
            return (
              <div
                key={r.runId}
                className={`border-b border-border/50 px-2.5 py-1.5 cursor-pointer transition-colors ${
                  isSel ? 'bg-info-cyan/10' : 'hover:bg-muted/30'
                }`}
                onClick={() => setSelectedRunId(r.runId)}
                title={isSel ? 'Showing on the desk — click to return to the live book' : 'Show this run on the desk'}
              >
                <div className="flex items-center gap-1.5">
                  <span className={`text-[0.5625rem] font-bold truncate ${isSel ? 'text-info-cyan' : 'text-foreground'}`}>
                    {r.runId}
                  </span>
                  {r.status === 'RUNNING' && (
                    <span className="shrink-0 text-[0.5rem] font-bold uppercase rounded px-1 bg-warning-amber/20 text-warning-amber">live</span>
                  )}
                  {r.status === 'ABORTED' && (
                    <span className="shrink-0 text-[0.5rem] uppercase rounded px-1 bg-muted text-muted-foreground">stopped</span>
                  )}
                  <span className={`ml-auto shrink-0 text-[0.625rem] font-bold tabular-nums ${pnlClass(r.totalPnl)}`}>
                    {fmt(r.totalPnl)}
                  </span>
                </div>

                <div className="mt-0.5 flex items-center gap-1.5 text-[0.5rem] text-muted-foreground">
                  <span className="tabular-nums">{r.date}</span>
                  <span>·</span>
                  <span className="tabular-nums">{r.tradeCount} trades</span>
                  <span>·</span>
                  <span className="truncate">
                    {Object.entries(r.models ?? {}).map(([k, v]) => `${k.replace('nifty50', 'N').replace('banknifty', 'BN')} ${modelLabel(v as string)}`).join(' · ') || 'model n/a'}
                  </span>
                </div>

                <div className="mt-1 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    onClick={() => toggleCompare(r.runId)}
                    className={`px-1 py-0.5 rounded text-[0.5rem] font-bold border transition-colors ${
                      inCompare
                        ? 'bg-info-cyan/20 text-info-cyan border-info-cyan/40'
                        : 'border-border text-muted-foreground hover:text-foreground'
                    }`}
                    title="Tick two runs to compare them"
                  >
                    <GitCompare className="h-2.5 w-2.5 inline" /> {inCompare ? 'comparing' : 'compare'}
                  </button>
                  <button
                    type="button"
                    onClick={() => del.mutate({ runId: r.runId })}
                    disabled={r.status === 'RUNNING'}
                    className="px-1 py-0.5 rounded text-[0.5rem] text-muted-foreground hover:text-destructive disabled:opacity-30"
                    title={r.status === 'RUNNING' ? 'Stop the replay first' : 'Delete this run'}
                  >
                    <Trash2 className="h-2.5 w-2.5" />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
