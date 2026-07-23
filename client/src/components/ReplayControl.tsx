/**
 * ReplayControl — AppBar (right side) live-simulation control.
 *
 * Pick a recorded date + speed and hit Replay: the server streams that day's
 * recorded ticks back through the system as if live, so the exit engine (and,
 * once wired, SEA) run against them. While running it shows a live status +
 * Stop. Backed by the `replay` tRPC router; replay is blocked during live
 * market hours (the server enforces that).
 */
import { useState, useEffect, useRef } from 'react';
import { Play, Square, Rewind } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { setSelectedRunId, openReplayTab } from '@/lib/replaySelection';
import { toast } from 'sonner';

const SPEEDS = [1, 3, 5, 10, 30, 60] as const;

export function ReplayControl() {
  const utils = trpc.useUtils();
  const datesQ = trpc.replay.dates.useQuery(undefined, { staleTime: 60_000, refetchOnWindowFocus: false });
  const statusQ = trpc.replay.status.useQuery(undefined, { refetchInterval: 2000 });

  const dates = datesQ.data ?? [];
  const status = statusQ.data;
  const running = !!status?.running;

  // Collapsed into a popover to give the AppBar its space back — the controls
  // are only touched when starting a run, but they occupied the bar always.
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const [date, setDate] = useState<string>('');
  const [speed, setSpeed] = useState<number>(1);
  const selectedDate = date || dates[0] || '';

  // Model under test (T97). One picker PER INSTRUMENT: the two books are trained
  // separately and their version strings differ (nifty50 20260718_161937 vs
  // banknifty 20260718_204202), so a single shared value would be invalid for
  // one of them. Defaults to whatever SEA is already on, so starting a replay
  // without touching these still records the model that actually ran.
  const modelsQ = trpc.trading.modelVersions.useQuery(undefined, { staleTime: Infinity });
  const seaQ = trpc.trading.seaCohortState.useQuery(undefined, { refetchInterval: 10_000 });
  const [models, setModels] = useState<Record<string, string>>({});
  const pickFor = (inst: string) => {
    const list = modelsQ.data?.[inst] ?? [];
    // Never DEFAULT to something that can't run, even if LATEST points at it.
    const usable = list.filter((m) => m.compatible);
    const fromSea = seaQ.data?.models?.[inst];
    const seaOk = fromSea && usable.some((m) => m.version === fromSea) ? fromSea : null;
    const current = seaOk ?? usable.find((m) => m.isLatest)?.version ?? usable[0]?.version ?? '';
    return { list, selected: models[inst] || current };
  };
  const chosenModels = Object.fromEntries(
    (['nifty50', 'banknifty'] as const)
      .map((i) => [i, pickFor(i).selected])
      .filter(([, v]) => !!v),
  ) as Record<string, string>;

  const refresh = () => void utils.replay.status.invalidate();
  const startMut = trpc.replay.start.useMutation({
    onSuccess: (res: any) => {
      refresh();
      void utils.replay.runs.invalidate();
      // Jump straight to the run: switch the left drawer to Replay and select
      // the new run, so the desk shows the experiment as it fills rather than
      // leaving you to go and find it.
      setOpen(false);
      if (res?.runId) {
        openReplayTab();
        setSelectedRunId(res.runId);
      }
      toast.success(`Replay started · ${selectedDate} @ ${speed}×`);
    },
    onError: (e: any) => toast.error(e?.message ?? 'Replay failed to start'),
  });
  const stopMut = trpc.replay.stop.useMutation({
    onSuccess: () => { refresh(); toast.success('Replay stopped'); },
    onError: (e: any) => toast.error(e?.message ?? 'Stop failed'),
  });

  // A RUNNING replay stays visible on the bar rather than hiding in the menu:
  // every tick the desk shows is simulated while it runs, so that must never be
  // one click away from being noticed.
  if (running) {
    return (
      <div className="px-2 flex items-center gap-1.5 shrink-0">
        <span
          className="flex items-center gap-1 text-[0.5625rem] font-bold tabular-nums text-warning-amber"
          title={`Live simulation running — ${status?.date} at ${status?.speed}x, ${(status?.ticksEmitted ?? 0).toLocaleString('en-IN')} ticks emitted`}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-warning-amber animate-pulse" />
          REPLAY {status?.speed}×
        </span>
        <button
          type="button"
          onClick={() => stopMut.mutate()}
          disabled={stopMut.isPending}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[0.5625rem] font-bold text-destructive hover:bg-destructive/15 transition-colors disabled:opacity-40"
          title="Stop the replay"
        >
          <Square className="h-2.5 w-2.5" /> Stop
        </button>
      </div>
    );
  }

  return (
    <div className="relative shrink-0 self-stretch flex" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="px-2.5 flex items-center gap-1.5 hover:bg-accent transition-colors"
        title="Replay — re-run a recorded day as a live simulation"
      >
        <Rewind className="h-3.5 w-3.5 text-primary" />
        <span className="font-display text-[0.625rem] font-bold tracking-wider text-primary">REPLAY</span>
      </button>

      {open && (
      <div className="absolute right-0 top-full mt-1 z-50 w-64 rounded-md border border-border bg-popover text-popover-foreground shadow-xl p-3 flex flex-col gap-2">
      <span className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">Replay a recorded day</span>
      <select
        value={selectedDate}
        onChange={(e) => setDate(e.target.value)}
        disabled={dates.length === 0}
        title="Recorded day to replay"
        className="w-full rounded border border-border bg-muted/40 px-1.5 py-1 text-[0.625rem] font-semibold text-foreground focus:outline-none focus:ring-1 focus:ring-primary/40 disabled:opacity-50"
      >
        {dates.length === 0
          ? <option value="">no recordings</option>
          : dates.map((d) => <option key={d} value={d}>{d}</option>)}
      </select>
      <select
        value={speed}
        onChange={(e) => setSpeed(Number(e.target.value))}
        title="Replay speed (1× = real-time)"
        className="w-full rounded border border-border bg-muted/40 px-1.5 py-1 text-[0.625rem] font-semibold text-foreground tabular-nums focus:outline-none focus:ring-1 focus:ring-primary/40"
      >
        {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
      </select>
      {/* Model under test, one picker per instrument (their version strings
          differ — see the comment above). SEA hot-swaps to these before the
          replay starts, and the run records them so results are attributable. */}
      {(['nifty50', 'banknifty'] as const).map((inst) => {
        const { list, selected } = pickFor(inst);
        if (list.length === 0) return null;
        return (
          <select
            key={inst}
            value={selected}
            onChange={(e) => setModels((p) => ({ ...p, [inst]: e.target.value }))}
            title={`${inst} model version for this run — SEA hot-swaps to it before the replay starts`}
            className="w-full rounded border border-border bg-muted/40 px-1.5 py-1 text-[0.625rem] font-semibold text-foreground tabular-nums focus:outline-none focus:ring-1 focus:ring-primary/40"
          >
            {list.map((m) => (
              <option key={m.version} value={m.version} disabled={!m.compatible}>
                {inst === 'nifty50' ? 'N' : 'BN'} {m.version.slice(0, 8)}
                {m.auc != null ? ` · ${m.auc}` : ''}
                {/* Pre-retrain models can NEVER load — the feature config is
                    shared, so their column count no longer matches. Showing them
                    greyed is honest; hiding them would look like data loss. */}
                {m.compatible ? '' : ' · incompatible'}
              </option>
            ))}
          </select>
        );
      })}
      <button
        type="button"
        onClick={() =>
          selectedDate &&
          startMut.mutate({
            date: selectedDate,
            speed,
            models: Object.keys(chosenModels).length ? chosenModels : undefined,
          })
        }
        disabled={!selectedDate || startMut.isPending}
        className="w-full flex items-center justify-center gap-1 rounded px-2 py-1.5 mt-1 text-[0.6875rem] font-bold bg-bullish/15 text-bullish hover:bg-bullish/25 transition-colors disabled:opacity-40"
        title="Replay this day's recorded ticks as a live simulation (available outside market hours)"
      >
        <Play className="h-3 w-3" /> Start replay
      </button>
      </div>
      )}
    </div>
  );
}
