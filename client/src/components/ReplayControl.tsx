/**
 * ReplayControl — AppBar (right side) live-simulation control.
 *
 * Pick a recorded date + speed and hit Replay: the server streams that day's
 * recorded ticks back through the system as if live, so the exit engine (and,
 * once wired, SEA) run against them. While running it shows a live status +
 * Stop. Backed by the `replay` tRPC router; replay is blocked during live
 * market hours (the server enforces that).
 */
import { useState } from 'react';
import { Play, Square } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { toast } from 'sonner';

const SPEEDS = [1, 10, 30, 60] as const;

export function ReplayControl() {
  const utils = trpc.useUtils();
  const datesQ = trpc.replay.dates.useQuery(undefined, { staleTime: 60_000, refetchOnWindowFocus: false });
  const statusQ = trpc.replay.status.useQuery(undefined, { refetchInterval: 2000 });

  const dates = datesQ.data ?? [];
  const status = statusQ.data;
  const running = !!status?.running;

  const [date, setDate] = useState<string>('');
  const [speed, setSpeed] = useState<number>(1);
  const selectedDate = date || dates[0] || '';

  const refresh = () => void utils.replay.status.invalidate();
  const startMut = trpc.replay.start.useMutation({
    onSuccess: () => { refresh(); toast.success(`Replay started · ${selectedDate} @ ${speed}×`); },
    onError: (e: any) => toast.error(e?.message ?? 'Replay failed to start'),
  });
  const stopMut = trpc.replay.stop.useMutation({
    onSuccess: () => { refresh(); toast.success('Replay stopped'); },
    onError: (e: any) => toast.error(e?.message ?? 'Stop failed'),
  });

  if (running) {
    return (
      <div className="px-2 flex items-center gap-1.5 shrink-0">
        <span className="flex items-center gap-1 text-[0.5625rem] font-bold tabular-nums text-warning-amber" title="Live simulation running">
          <span className="h-1.5 w-1.5 rounded-full bg-warning-amber animate-pulse" />
          REPLAY {status?.date} · {status?.speed}× · {(status?.ticksEmitted ?? 0).toLocaleString('en-IN')}
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
    <div className="px-2 flex items-center gap-1 shrink-0">
      <span className="text-[0.5rem] font-bold uppercase tracking-wider text-muted-foreground">Replay</span>
      <select
        value={selectedDate}
        onChange={(e) => setDate(e.target.value)}
        disabled={dates.length === 0}
        title="Recorded day to replay"
        className="max-w-[7rem] rounded border border-border bg-muted/40 px-1 py-0.5 text-[0.5625rem] font-semibold text-foreground focus:outline-none focus:ring-1 focus:ring-primary/40 disabled:opacity-50"
      >
        {dates.length === 0
          ? <option value="">no recordings</option>
          : dates.map((d) => <option key={d} value={d}>{d}</option>)}
      </select>
      <select
        value={speed}
        onChange={(e) => setSpeed(Number(e.target.value))}
        title="Replay speed (1× = real-time)"
        className="rounded border border-border bg-muted/40 px-1 py-0.5 text-[0.5625rem] font-semibold text-foreground tabular-nums focus:outline-none focus:ring-1 focus:ring-primary/40"
      >
        {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
      </select>
      <button
        type="button"
        onClick={() => selectedDate && startMut.mutate({ date: selectedDate, speed })}
        disabled={!selectedDate || startMut.isPending}
        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[0.5625rem] font-bold text-bullish hover:bg-bullish/15 transition-colors disabled:opacity-40"
        title="Replay this day's recorded ticks as a live simulation (available outside market hours)"
      >
        <Play className="h-2.5 w-2.5" /> Replay
      </button>
    </div>
  );
}
