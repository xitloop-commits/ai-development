/**
 * Indicators — the AppBar's right-side status cluster.
 *
 * Four cells, four user-questions answered at a glance:
 *
 *   🌐 API   — "Can I place an order right now?"   (broker REST)
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
import { Globe, Wifi, Shield, FlaskConical } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { trpc } from '@/lib/trpc';

// ─── Cell separator (matches the AppBar pattern) ────────────────

function Separator() {
  return <div className="w-px self-stretch bg-border shrink-0" />;
}

// ─── 🌐 API — broker REST liveness ──────────────────────────────
// Reads `getBrokerServiceStatus()`'s real shape:
//   { activeBrokerId, activeBrokerName, tokenStatus, apiStatus,
//     wsStatus, killSwitchActive, registeredAdapters }
//
// The pre-consolidation version of this indicator read non-existent
// fields (`connected`, `activeBroker`, `mode`) — so the icon stayed
// green even when the broker was offline, the tooltip always said
// "None Connected", and the "Mode: Paper Trading" line was hardcoded.
// Fixed here against the actual `BrokerServiceStatus` shape.

interface BrokerServiceStatusShape {
  activeBrokerId: string | null;
  activeBrokerName: string | null;
  tokenStatus: 'valid' | 'expired' | 'unknown';
  apiStatus: 'connected' | 'disconnected' | 'error' | string;
  wsStatus: 'connected' | 'disconnected' | 'error' | string;
  killSwitchActive: boolean;
  registeredAdapters: string[];
}

function ApiIndicator() {
  const brokerStatusQuery = trpc.broker.status.useQuery(undefined, {
    refetchInterval: 5000,
    retry: 1,
  });
  const status = brokerStatusQuery.data as BrokerServiceStatusShape | undefined;

  // "Connected" = REST is up AND auth is valid. Either failure means
  // orders won't go through, so we don't show green for half-up state.
  const connected = status?.apiStatus === 'connected' && status?.tokenStatus === 'valid';
  const brokerName = status?.activeBrokerName ?? 'No broker';
  const apiState = status?.apiStatus ?? 'disconnected';
  const tokenState = status?.tokenStatus ?? 'unknown';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="px-3 flex items-center gap-1 shrink-0 cursor-default">
          <Globe className={`h-3 w-3 ${connected ? 'text-bullish' : 'text-muted-foreground'}`} />
          <span className="text-[0.5625rem] text-muted-foreground tracking-wider">API</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <div className="text-[0.625rem] space-y-0.5">
          <div className={`font-bold ${connected ? 'text-bullish' : 'text-muted-foreground'}`}>
            {brokerName}
          </div>
          <div className="text-muted-foreground">
            API: <span className={apiState === 'connected' ? 'text-bullish' : 'text-destructive'}>{apiState}</span>
            {' · '}
            Token: <span className={
              tokenState === 'valid' ? 'text-bullish'
                : tokenState === 'expired' ? 'text-destructive'
                : 'text-warning-amber'
            }>{tokenState}</span>
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

// ─── 📶 FEED — broker WebSocket liveness ────────────────────────

function FeedIndicator() {
  const feedStateQuery = trpc.broker.feed.state.useQuery(undefined, {
    refetchInterval: 10000,
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
  queries: ReturnType<typeof trpc.trading.instrumentLiveState.useQuery>[],
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
  const queries = AI_INSTRUMENTS.map((inst) =>
    trpc.trading.instrumentLiveState.useQuery(
      { instrument: inst },
      { refetchInterval: 30_000, retry: 1 },
    ),
  );
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
    refetchInterval: 30000,
    retry: 1,
  });
  const data = disciplineQuery.data as any;
  const scoreObj = data?.score;
  const score = typeof scoreObj === 'object' && scoreObj !== null
    ? (scoreObj as any).score ?? 100
    : (scoreObj ?? 100);
  const scoreColor = score >= 80 ? 'text-info-cyan'
    : score >= 60 ? 'text-warning-amber'
    : 'text-loss-red';
  const breakdown = (typeof data?.score === 'object' ? (data.score as any).breakdown : data?.breakdown) ?? {
    circuitBreaker: 20, tradeLimits: 15, cooldowns: 15, timeWindows: 10,
    positionSizing: 15, journal: 10, preTradeGate: 15,
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="px-3 flex items-center gap-1 shrink-0 cursor-default">
          <Shield className={`h-3 w-3 ${scoreColor}`} />
          <span className={`text-[0.625rem] font-bold tabular-nums ${scoreColor}`}>
            {score}
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <div className="text-[0.625rem] space-y-0.5 font-mono">
          <div className={`font-bold mb-1 ${scoreColor}`}>Discipline: {score}/100</div>
          <div className="text-muted-foreground">Circuit Breaker  {breakdown.circuitBreaker}/20</div>
          <div className="text-muted-foreground">Trade Limits     {breakdown.tradeLimits}/15</div>
          <div className="text-muted-foreground">Cooldowns        {breakdown.cooldowns}/15</div>
          <div className="text-muted-foreground">Time Windows     {breakdown.timeWindows}/10</div>
          <div className="text-muted-foreground">Position Sizing  {breakdown.positionSizing}/15</div>
          <div className="text-muted-foreground">Journal          {breakdown.journal}/10</div>
          <div className="text-muted-foreground">Pre-Trade Gate   {breakdown.preTradeGate}/15</div>
        </div>
      </TooltipContent>
    </Tooltip>
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
      <ApiIndicator />
      <Separator />
      <FeedIndicator />
      <Separator />
      <AiIndicator />
      <Separator />
      <DisciplineIndicator />
    </>
  );
}

export default Indicators;
