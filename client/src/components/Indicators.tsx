/**
 * Indicators — the AppBar's right-side status cluster.
 *
 * Three cells, three user-questions answered at a glance:
 *
 *   📶 FEED  — "Are positions getting live prices?" (broker WebSocket)
 *   🧪 AI    — "Is the AI generating trade ideas?"  (TFA + SEA + Models)
 *   🛡 Score — "Am I following my own rules?"        (DA composite score)
 *
 * Each cell is its own sub-component below; this file's default export
 * renders them in order with vertical separators. AppBar imports the
 * default and drops it in once — no per-indicator wiring at the AppBar
 * level any more.
 */
import { useState, useRef, useEffect } from 'react';
import { Wifi, Shield, FlaskConical, AlertTriangle } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ConfirmDialog } from './ConfirmDialog';
import { trpc } from '@/lib/trpc';
import { useInstrumentLiveState } from '@/hooks/useInstrumentLiveState';

// ─── Cell separator (matches the AppBar pattern) ────────────────

function Separator() {
  return <div className="w-px self-stretch bg-border shrink-0" />;
}

// ─── 📶 FEED — broker WebSocket liveness ────────────────────────

function FeedIndicator() {
  const feedStateQuery = trpc.broker.feed.state.useQuery(undefined, {
    retry: 1,
  });
  const feedState = feedStateQuery.data as any;

  // Three visual states: connected (green steady) / connecting (amber
  // ping) / disconnected (red ping). The "connecting" branch is for the
  // first few seconds after mount when the query is still in flight and
  // we have no data — without it the indicator flashes red on every reload.
  const status: 'connected' | 'connecting' | 'disconnected' =
    feedState?.wsConnected
      ? 'connected'
      : feedStateQuery.isLoading && !feedState
        ? 'connecting'
        : 'disconnected';
  const wifiCls =
    status === 'connected'    ? 'text-bullish' :
    status === 'connecting'   ? 'text-warning-amber animate-pulse' :
                                'text-destructive animate-pulse';
  const dotCls =
    status === 'connected'    ? 'bg-bullish animate-pulse' :
    status === 'connecting'   ? 'bg-warning-amber animate-ping' :
                                'bg-destructive animate-ping';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="px-3 flex items-center gap-1 shrink-0 cursor-default">
          <Wifi className={`h-3 w-3 ${wifiCls}`} />
          <span className={`h-1.5 w-1.5 rounded-full ${dotCls}`} />
          <span className="text-[0.5625rem] text-muted-foreground tracking-wider">FEED</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <div className="text-[0.625rem] space-y-0.5">
          <div className={`font-bold ${
            status === 'connected'    ? 'text-bullish' :
            status === 'connecting'   ? 'text-warning-amber' :
                                        'text-destructive'
          }`}>
            {status === 'connected'    ? 'Feed Connected'
              : status === 'connecting' ? 'Connecting…'
                                        : 'Feed Disconnected — reconnecting'}
          </div>
          <div className="text-muted-foreground">
            {feedState ? `${feedState.totalSubscriptions} subscriptions` : 'No feed data'}
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

// ─── 🧪 AI Pipeline — TFA + SEA + Models rolled into one ───────

const AI_INSTRUMENTS = ['nifty50', 'banknifty', 'crudeoil', 'naturalgas'] as const;
const AI_INSTRUMENT_LABELS: Record<string, string> = {
  nifty50: 'NIFTY',
  banknifty: 'BNIFTY',
  crudeoil: 'CRUDE',
  naturalgas: 'GAS',
};

// TFA freshness threshold — ndjson should be written every couple of
// seconds during trading. 60s without a row = TFA is stuck or dead.
const TFA_FRESH_THRESHOLD_SEC = 60;

type AiStatus = 'green' | 'amber' | 'red' | 'gray';

interface AiRollup {
  status: AiStatus;
  perInstrument: Array<{
    inst: string;
    label: string;
    tfaAgeSec: number | null;
    tfaFresh: boolean;
    marketOpen: boolean;
    modelLoaded: boolean;
  }>;
  modelsLoadedCount: number;
  anyMarketOpen: boolean;
  lastSignalAgeSec: number | null;
}

export function computeAiRollup(
  queries: Array<{ data: unknown }>,
): AiRollup {
  let modelsLoadedCount = 0;
  let anyMarketOpen = false;
  let mostRecentSignalTs: number | null = null;

  const perInstrument = AI_INSTRUMENTS.map((inst, i) => {
    const data = queries[i].data as
      | { live?: { file_age_sec: number; is_market_open: number } | null;
          signal?: { timestamp_ist?: string } | null;
          model?: unknown }
      | undefined;
    const live = data?.live ?? null;
    const tfaAgeSec = live ? live.file_age_sec : null;
    const marketOpen = !!live && live.is_market_open === 1;
    const modelLoaded = !!data?.model;
    if (modelLoaded) modelsLoadedCount++;
    if (marketOpen) anyMarketOpen = true;
    const tfaFresh = tfaAgeSec !== null && tfaAgeSec < TFA_FRESH_THRESHOLD_SEC;
    const signalTs = data?.signal?.timestamp_ist
      ? Date.parse(String(data.signal.timestamp_ist))
      : NaN;
    if (!Number.isNaN(signalTs) && (mostRecentSignalTs === null || signalTs > mostRecentSignalTs)) {
      mostRecentSignalTs = signalTs;
    }
    return {
      inst,
      label: AI_INSTRUMENT_LABELS[inst] ?? inst.toUpperCase(),
      tfaAgeSec,
      tfaFresh,
      marketOpen,
      modelLoaded,
    };
  });

  // Only "live" instruments (market open) count toward TFA freshness —
  // when market is closed for an instrument, TFA correctly stops
  // emitting; that's idle, not broken.
  const liveInstruments = perInstrument.filter((p) => p.marketOpen);
  const tfaFreshCount = liveInstruments.filter((p) => p.tfaFresh).length;

  let status: AiStatus;
  if (!anyMarketOpen) {
    status = 'gray';
  } else if (modelsLoadedCount === 0) {
    status = 'red';
  } else if (liveInstruments.length > 0 && tfaFreshCount === 0) {
    status = 'red';
  } else if (modelsLoadedCount < 4 || tfaFreshCount < liveInstruments.length) {
    status = 'amber';
  } else {
    status = 'green';
  }

  const lastSignalAgeSec = mostRecentSignalTs !== null
    ? Math.round((Date.now() - mostRecentSignalTs) / 1000)
    : null;

  return { status, perInstrument, modelsLoadedCount, anyMarketOpen, lastSignalAgeSec };
}

function aiDotClass(status: AiStatus): string {
  switch (status) {
    case 'green': return 'bg-bullish animate-pulse';
    case 'amber': return 'bg-warning-amber animate-pulse';
    case 'red':   return 'bg-destructive';                     // no pulse — broken
    case 'gray':  return 'bg-muted-foreground/40';
  }
}

function aiIconClass(status: AiStatus): string {
  switch (status) {
    case 'green': return 'text-bullish';
    case 'amber': return 'text-warning-amber';
    case 'red':   return 'text-destructive';
    case 'gray':  return 'text-muted-foreground';
  }
}

function fmtAge(sec: number | null): string {
  if (sec === null) return '—';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec / 3600)}h`;
}

function AiIndicator() {
  // WS-pushed (no poll). Fixed-length map → stable hook order.
  const queries = AI_INSTRUMENTS.map((inst) => ({ data: useInstrumentLiveState(inst) }));
  const rollup = computeAiRollup(queries);

  // Click toggles a sticky popover (shadcn Tooltip dismisses on
  // mouse-leave — too aggressive for a status panel).
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={containerRef} className="relative px-3 flex items-center shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 cursor-pointer hover:opacity-80 transition-opacity"
        aria-label={`AI pipeline status: ${rollup.status}`}
      >
        <FlaskConical className={`h-3 w-3 ${aiIconClass(rollup.status)}`} />
        <span className="text-[0.5625rem] text-muted-foreground tracking-wider">AI</span>
        <span className={`h-1.5 w-1.5 rounded-full ${aiDotClass(rollup.status)}`} />
      </button>
      {open && (
        <div
          className="absolute top-full mt-1 right-0 z-50 bg-card border border-border rounded-md shadow-xl p-3 min-w-[280px]"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="text-[0.6875rem] font-bold text-info-cyan mb-2">AI Pipeline</div>

          <div className="space-y-1.5 mb-2">
            <div className="flex items-center justify-between text-[0.625rem]">
              <span className="text-muted-foreground">TFA · features</span>
              <span className="tabular-nums">
                {rollup.perInstrument.map((p) => (
                  <span
                    key={p.inst}
                    className={`mr-1 ${
                      !p.marketOpen
                        ? 'text-muted-foreground/60'
                        : p.tfaFresh
                          ? 'text-bullish'
                          : 'text-destructive'
                    }`}
                    title={`${p.label}: ${p.marketOpen ? `${fmtAge(p.tfaAgeSec)} ago` : 'market closed'}`}
                  >
                    {p.label.slice(0, 3)}{p.marketOpen && p.tfaFresh ? '●' : '○'}
                  </span>
                ))}
              </span>
            </div>

            <div className="flex items-center justify-between text-[0.625rem]">
              <span className="text-muted-foreground">SEA · signals</span>
              <span className="text-muted-foreground/70">
                last: {fmtAge(rollup.lastSignalAgeSec)} ago
              </span>
            </div>

            <div className="flex items-center justify-between text-[0.625rem]">
              <span className="text-muted-foreground">Models · MTA output</span>
              <span className={`tabular-nums font-bold ${
                rollup.modelsLoadedCount === 4 ? 'text-bullish'
                  : rollup.modelsLoadedCount > 0 ? 'text-warning-amber'
                  : 'text-destructive'
              }`}>
                {rollup.modelsLoadedCount}/4
              </span>
            </div>
          </div>

          <div className="border-t border-border/50 pt-2">
            <div className="text-[0.5625rem] text-muted-foreground/70 leading-snug">
              {!rollup.anyMarketOpen && '🌙 Market closed — pipeline correctly idle'}
              {rollup.anyMarketOpen && rollup.status === 'green' && '✓ All systems healthy'}
              {rollup.anyMarketOpen && rollup.status === 'amber' && '⚠ Partial degradation — see above'}
              {rollup.anyMarketOpen && rollup.status === 'red' && '✗ Pipeline down — predictions stale'}
            </div>
            <div className="text-[0.5rem] text-muted-foreground/50 mt-1">
              SEA liveness inferred from TFA + models · explicit heartbeat pending
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── 🛡 Discipline Score ────────────────────────────────────────

function DisciplineIndicator() {
  const disciplineQuery = trpc.discipline.getDashboard.useQuery(undefined, {
    retry: 1,
  });
  const data = disciplineQuery.data as any;
  const hasData = !!data;
  const scoreObj = data?.score;
  // H6 — no fake-100-fallback while loading. `--` means "real number
  // not yet known"; a fabricated 100 looked indistinguishable from a
  // real perfect score.
  const score: number | null = !hasData
    ? null
    : typeof scoreObj === 'object' && scoreObj !== null
      ? (scoreObj as any).score ?? null
      : (scoreObj ?? null);
  const scoreColor = score === null
    ? 'text-muted-foreground'
    : score >= 80 ? 'text-info-cyan'
      : score >= 60 ? 'text-warning-amber'
        : 'text-loss-red';
  // Breakdown only renders when real data exists. Pre-fix, this was a
  // hardcoded `{ circuitBreaker: 20, tradeLimits: 15, ... }` fallback
  // that displayed perfect-score numbers indistinguishable from real data.
  const breakdown = hasData
    ? (typeof data?.score === 'object' ? (data.score as any).breakdown : data?.breakdown) ?? null
    : null;

  // Master switches — the same fields the backend gate reads
  // (isDisciplineBypassed). Live OFF lets REAL-money orders skip every limit,
  // so it is guarded by a confirm dialog; paper OFF is harmless.
  const settings = trpc.discipline.getSettings.useQuery(undefined);
  const utils = trpc.useUtils();
  const update = trpc.discipline.updateSettings.useMutation({
    onSuccess: () => { void utils.discipline.getSettings.invalidate(); },
  });
  const liveOn = settings.data?.liveEnforcement?.enabled ?? true;
  const simOn = settings.data?.simulationEnforcement?.enabled ?? true;
  const [confirmLiveOff, setConfirmLiveOff] = useState(false);

  const setLive = (enabled: boolean) => update.mutate({ liveEnforcement: { enabled } });
  const setSim = (enabled: boolean) => update.mutate({ simulationEnforcement: { enabled } });

  // A dot on the shield when EITHER guard is off, so a disabled gate is never
  // silent — the operator sees protection is down without opening the menu.
  const anyOff = !liveOn || !simOn;

  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className="px-3 flex items-center gap-1 shrink-0 cursor-pointer relative">
            <Shield className={`h-3 w-3 ${anyOff ? 'text-loss-red' : scoreColor}`} />
            <span className={`text-[0.625rem] font-bold tabular-nums ${scoreColor}`}>
              {score === null ? '--' : score}
            </span>
            {anyOff && <span className="absolute top-0.5 right-1.5 h-1.5 w-1.5 rounded-full bg-loss-red" />}
          </button>
        </PopoverTrigger>
        <PopoverContent side="bottom" align="end" className="w-64 p-3">
          <div className="space-y-3">
            <div className={`text-xs font-bold ${scoreColor}`}>
              Discipline: {score === null ? '--' : `${score}/100`}
            </div>

            {/* Master toggles */}
            <div className="space-y-2 border-y border-border py-2">
              <EnforcementToggle
                label="Live" sub="my-live · ai-live" on={liveOn}
                onToggle={() => liveOn ? setConfirmLiveOff(true) : setLive(true)}
                danger
              />
              <EnforcementToggle
                label="Paper" sub="paper" on={simOn}
                onToggle={() => setSim(!simOn)}
              />
            </div>

            {!liveOn && (
              <div className="flex items-start gap-1.5 text-[0.625rem] text-loss-red">
                <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
                <span>Live discipline is OFF. Real-money orders skip every limit — no loss cap, no R:R gate, no cooldown.</span>
              </div>
            )}

            {/* Score breakdown */}
            <div className="text-[0.625rem] space-y-0.5 font-mono">
              {breakdown ? (
                <>
                  <div className="text-muted-foreground">Circuit Breaker  {breakdown.circuitBreaker ?? '--'}/20</div>
                  <div className="text-muted-foreground">Trade Limits     {breakdown.tradeLimits ?? '--'}/15</div>
                  <div className="text-muted-foreground">Cooldowns        {breakdown.cooldowns ?? '--'}/15</div>
                  <div className="text-muted-foreground">Time Windows     {breakdown.timeWindows ?? '--'}/10</div>
                  <div className="text-muted-foreground">Position Sizing  {breakdown.positionSizing ?? '--'}/15</div>
                  <div className="text-muted-foreground">Journal          {breakdown.journal ?? '--'}/10</div>
                  <div className="text-muted-foreground">Pre-Trade Gate   {breakdown.preTradeGate ?? '--'}/15</div>
                </>
              ) : (
                <div className="text-muted-foreground/70">Loading discipline state…</div>
              )}
            </div>
          </div>
        </PopoverContent>
      </Popover>

      {confirmLiveOff && (
        <ConfirmDialog
          open
          title="Turn OFF live discipline?"
          message="Real-money orders on my-live and ai-live will skip EVERY limit — daily loss cap, R:R gate, position caps, cooldowns. Nothing will stop a bad trade. Turn it back on the moment you are done."
          onConfirm={() => { setLive(false); setConfirmLiveOff(false); }}
          onCancel={() => setConfirmLiveOff(false)}
        />
      )}
    </>
  );
}

/** One master switch row. `danger` tints the OFF state red so a disabled LIVE
 *  guard reads as a warning, not a neutral setting. */
function EnforcementToggle({
  label, sub, on, onToggle, danger,
}: { label: string; sub: string; on: boolean; onToggle: () => void; danger?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div>
        <div className="text-[0.6875rem] font-bold">{label}</div>
        <div className="text-[0.5625rem] text-muted-foreground font-mono">{sub}</div>
      </div>
      <button
        type="button"
        onClick={onToggle}
        className={`px-2 py-0.5 rounded text-[0.625rem] font-bold transition-colors ${
          on
            ? 'bg-bullish/15 text-bullish'
            : danger ? 'bg-loss-red/20 text-loss-red' : 'bg-muted text-muted-foreground'
        }`}
      >
        {on ? 'ON' : 'OFF'}
      </button>
    </div>
  );
}

// ─── Composite ──────────────────────────────────────────────────

/**
 * Default export — the four-indicator cluster, separator-delimited.
 * AppBar drops this in once on the right side; no per-indicator wiring
 * leaks to the parent.
 */
export function Indicators() {
  return (
    <>
      <FeedIndicator />
      <Separator />
      <AiIndicator />
      <Separator />
      <DisciplineIndicator />
    </>
  );
}

export default Indicators;
