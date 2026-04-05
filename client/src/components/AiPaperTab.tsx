/**
 * AiPaperTab — Compare AI decisions vs your trades.
 * Fetches AI decision JSON files from the REST endpoint and shows
 * a side-by-side comparison with user trade outcomes.
 */
import { useState, useEffect, useMemo } from 'react';
import { trpc } from '@/lib/trpc';
import { formatINR } from '@/lib/formatINR';
import {
  Bot, TrendingUp, TrendingDown, Minus, RefreshCw,
  AlertTriangle, ArrowUpRight, ArrowDownRight, Clock,
  CheckCircle2, XCircle, Zap, Shield, Eye,
} from 'lucide-react';

// ─── Types ───────────────────────────────────────────────────

interface AiDecision {
  instrument: string;
  timestamp: string;
  decision: string; // GO, WAIT, NO-GO
  trade_type: string; // CALL_BUY, PUT_BUY, NONE
  confidence_score: number;
  rationale: string;
  trade_direction: string; // GO_CALL, GO_PUT, WAIT
  ltp: number;
  atm_strike: number;
  pcr_ratio: number;
  trade_setup?: {
    strike: number;
    entry_price: number;
    stop_loss: number;
    target: number;
    risk_reward: number;
  } | null;
  risk_flags: string[];
  market_bias_oc: string;
  market_bias_news: string;
  support_analysis?: { level: number; strength: string };
  resistance_analysis?: { level: number; strength: string };
  iv_assessment?: { level: string; percentile: number };
  news_detail?: {
    sentiment: string;
    strength: string;
    confidence: number;
    total_articles: number;
  };
}

interface AiDecisionResponse {
  instrument: string;
  decision: AiDecision | null;
  error?: string;
}

const INSTRUMENTS = ['NIFTY_50', 'BANKNIFTY', 'CRUDEOIL', 'NATURALGAS'];

// ─── Helpers ─────────────────────────────────────────────────

function formatPrice(v: number): string {
  return v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function confidenceColor(c: number): string {
  if (c >= 70) return 'text-bullish';
  if (c >= 45) return 'text-warning-amber';
  return 'text-destructive';
}

function directionIcon(dir: string) {
  if (dir === 'GO_CALL') return <ArrowUpRight className="h-3.5 w-3.5 text-bullish" />;
  if (dir === 'GO_PUT') return <ArrowDownRight className="h-3.5 w-3.5 text-destructive" />;
  return <Minus className="h-3.5 w-3.5 text-muted-foreground" />;
}

function directionLabel(dir: string): string {
  if (dir === 'GO_CALL') return 'CALL';
  if (dir === 'GO_PUT') return 'PUT';
  return 'WAIT';
}

function directionBg(dir: string): string {
  if (dir === 'GO_CALL') return 'bg-bullish/10 border-bullish/20 text-bullish';
  if (dir === 'GO_PUT') return 'bg-destructive/10 border-destructive/20 text-destructive';
  return 'bg-secondary/30 border-border text-muted-foreground';
}

// ─── AI Decision Card ────────────────────────────────────────

function AiDecisionCard({ data }: { data: AiDecision }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border border-border rounded-md bg-card overflow-hidden">
      {/* Header */}
      <button onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-2.5 flex items-center gap-2.5 text-left hover:bg-secondary/10 transition-colors">
        {directionIcon(data.trade_direction)}

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold text-foreground">{data.instrument.replace('_', ' ')}</span>
            <span className={`text-[8px] font-bold px-1.5 py-0.5 rounded border ${directionBg(data.trade_direction)}`}>
              {directionLabel(data.trade_direction)}
            </span>
            <span className={`text-[9px] font-bold tabular-nums ${confidenceColor(data.confidence_score)}`}>
              {data.confidence_score.toFixed(0)}%
            </span>
          </div>
          <div className="text-[8px] text-muted-foreground mt-0.5 truncate">
            {data.rationale}
          </div>
        </div>

        <div className="text-right shrink-0">
          <div className="text-[9px] text-foreground tabular-nums">₹{formatPrice(data.ltp)}</div>
          <div className="text-[7px] text-muted-foreground">ATM {data.atm_strike}</div>
        </div>
      </button>

      {/* Expanded Details */}
      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-border/50 space-y-2">
          {/* Market Analysis */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[8px]">
            <div>
              <span className="text-muted-foreground">OC Bias:</span>
              <span className={`ml-1 font-bold ${data.market_bias_oc === 'Bullish' ? 'text-bullish' : data.market_bias_oc === 'Bearish' ? 'text-destructive' : 'text-muted-foreground'}`}>
                {data.market_bias_oc}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">News:</span>
              <span className={`ml-1 font-bold ${data.market_bias_news === 'Bullish' ? 'text-bullish' : data.market_bias_news === 'Bearish' ? 'text-destructive' : 'text-muted-foreground'}`}>
                {data.market_bias_news}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">PCR:</span>
              <span className="ml-1 font-bold text-foreground tabular-nums">{data.pcr_ratio}</span>
            </div>
            {data.iv_assessment && (
              <div>
                <span className="text-muted-foreground">IV:</span>
                <span className={`ml-1 font-bold ${data.iv_assessment.level === 'High' ? 'text-destructive' : data.iv_assessment.level === 'Low' ? 'text-bullish' : 'text-foreground'}`}>
                  {data.iv_assessment.level} ({data.iv_assessment.percentile}%)
                </span>
              </div>
            )}
          </div>

          {/* Trade Setup */}
          {data.trade_setup && (
            <div className="bg-secondary/10 rounded p-2 space-y-1">
              <span className="text-[7px] text-muted-foreground tracking-wider uppercase">Suggested Trade Setup</span>
              <div className="grid grid-cols-5 gap-2 text-[8px]">
                <div><span className="text-muted-foreground">Strike:</span> <span className="font-bold text-foreground tabular-nums">{data.trade_setup.strike}</span></div>
                <div><span className="text-muted-foreground">Entry:</span> <span className="font-bold text-foreground tabular-nums">₹{formatPrice(data.trade_setup.entry_price)}</span></div>
                <div><span className="text-muted-foreground">SL:</span> <span className="font-bold text-destructive tabular-nums">₹{formatPrice(data.trade_setup.stop_loss)}</span></div>
                <div><span className="text-muted-foreground">Target:</span> <span className="font-bold text-bullish tabular-nums">₹{formatPrice(data.trade_setup.target)}</span></div>
                <div><span className="text-muted-foreground">R:R:</span> <span className="font-bold text-violet-pulse tabular-nums">{data.trade_setup.risk_reward.toFixed(1)}</span></div>
              </div>
            </div>
          )}

          {/* Risk Flags */}
          {data.risk_flags && data.risk_flags.length > 0 && (
            <div className="flex gap-1 flex-wrap">
              <Shield className="h-2.5 w-2.5 text-warning-amber" />
              {data.risk_flags.map((flag, i) => (
                <span key={i} className="text-[7px] px-1 py-0.5 rounded bg-warning-amber/10 border border-warning-amber/20 text-warning-amber">
                  {flag}
                </span>
              ))}
            </div>
          )}

          {/* News Detail */}
          {data.news_detail && (
            <div className="text-[8px] text-muted-foreground">
              News: {data.news_detail.sentiment} ({data.news_detail.strength}) — {data.news_detail.confidence}% confidence from {data.news_detail.total_articles} articles
            </div>
          )}

          <div className="text-[7px] text-muted-foreground/60">
            Generated: {data.timestamp}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Comparison Row ──────────────────────────────────────────

function ComparisonRow({ aiDecision, userTrades }: {
  aiDecision: AiDecision;
  userTrades: Array<{ tradeType: string; pnl: number | null; status: string; entryPrice: number; strike: number }>;
}) {
  const aiDir = aiDecision.trade_direction;
  const aiSuggested = aiDir === 'GO_CALL' || aiDir === 'GO_PUT';

  // Find matching user trades (same instrument, same direction)
  const matchingTrades = userTrades.filter(t => {
    if (aiDir === 'GO_CALL') return t.tradeType === 'CALL_BUY';
    if (aiDir === 'GO_PUT') return t.tradeType === 'PUT_BUY';
    return false;
  });

  const userFollowed = matchingTrades.length > 0;
  const userPnl = matchingTrades.reduce((s, t) => s + (t.pnl || 0), 0);
  const userClosed = matchingTrades.filter(t => t.status === 'CLOSED');

  let outcome: 'aligned-win' | 'aligned-loss' | 'missed' | 'ignored' | 'wait';
  if (!aiSuggested) {
    outcome = 'wait';
  } else if (userFollowed && userClosed.length > 0) {
    outcome = userPnl >= 0 ? 'aligned-win' : 'aligned-loss';
  } else if (userFollowed) {
    outcome = 'aligned-win'; // still open, assume aligned
  } else {
    outcome = 'missed';
  }

  const outcomeStyles: Record<string, { bg: string; text: string; label: string }> = {
    'aligned-win': { bg: 'bg-bullish/5 border-bullish/20', text: 'text-bullish', label: 'ALIGNED WIN' },
    'aligned-loss': { bg: 'bg-destructive/5 border-destructive/20', text: 'text-destructive', label: 'ALIGNED LOSS' },
    'missed': { bg: 'bg-warning-amber/5 border-warning-amber/20', text: 'text-warning-amber', label: 'MISSED' },
    'ignored': { bg: 'bg-secondary/20 border-border', text: 'text-muted-foreground', label: 'IGNORED' },
    'wait': { bg: 'bg-secondary/10 border-border', text: 'text-muted-foreground', label: 'AI WAIT' },
  };

  const style = outcomeStyles[outcome];

  return (
    <div className={`flex items-center gap-3 px-2.5 py-2 rounded border ${style.bg}`}>
      <div className="w-20">
        <span className="text-[9px] font-bold text-foreground">{aiDecision.instrument.replace('_', ' ')}</span>
      </div>

      {/* AI said */}
      <div className="flex items-center gap-1 w-20">
        {directionIcon(aiDir)}
        <span className={`text-[8px] font-bold ${aiSuggested ? (aiDir === 'GO_CALL' ? 'text-bullish' : 'text-destructive') : 'text-muted-foreground'}`}>
          {directionLabel(aiDir)}
        </span>
        <span className={`text-[8px] tabular-nums ${confidenceColor(aiDecision.confidence_score)}`}>
          {aiDecision.confidence_score.toFixed(0)}%
        </span>
      </div>

      {/* You did */}
      <div className="flex items-center gap-1 w-24">
        {userFollowed ? (
          <>
            <CheckCircle2 className="h-3 w-3 text-bullish" />
            <span className="text-[8px] text-foreground">{matchingTrades.length} trade{matchingTrades.length > 1 ? 's' : ''}</span>
          </>
        ) : aiSuggested ? (
          <>
            <XCircle className="h-3 w-3 text-warning-amber" />
            <span className="text-[8px] text-muted-foreground">No trade</span>
          </>
        ) : (
          <span className="text-[8px] text-muted-foreground">—</span>
        )}
      </div>

      {/* P&L */}
      <div className="w-20 text-right">
        {userClosed.length > 0 ? (
          <span className={`text-[9px] font-bold tabular-nums ${userPnl >= 0 ? 'text-bullish' : 'text-destructive'}`}>
            {formatINR(userPnl, { sign: true })}
          </span>
        ) : userFollowed ? (
          <span className="text-[8px] text-violet-pulse">OPEN</span>
        ) : (
          <span className="text-[8px] text-muted-foreground">—</span>
        )}
      </div>

      {/* Outcome badge */}
      <div className="flex-1 text-right">
        <span className={`text-[7px] font-bold tracking-wider px-1.5 py-0.5 rounded ${style.text}`}>
          {style.label}
        </span>
      </div>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────

export default function AiPaperTab() {
  const [decisions, setDecisions] = useState<AiDecisionResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const tradesQuery = trpc.journal.list.useQuery(undefined, { retry: false });

  const fetchDecisions = async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch('/api/ai-decisions');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      setDecisions(data);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch AI decisions');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchDecisions(); }, []);

  const validDecisions = decisions.filter(d => d.decision !== null);
  const trades = tradesQuery.data || [];

  // Group trades by instrument for comparison
  const tradesByInstrument = useMemo(() => {
    const map: Record<string, typeof trades> = {};
    trades.forEach(t => {
      if (!map[t.instrument]) map[t.instrument] = [];
      map[t.instrument].push(t);
    });
    return map;
  }, [trades]);

  // Summary stats
  const summary = useMemo(() => {
    let aiCalls = 0, aiPuts = 0, aiWaits = 0;
    let followed = 0, missed = 0;
    validDecisions.forEach(d => {
      const dir = d.decision!.trade_direction;
      if (dir === 'GO_CALL') aiCalls++;
      else if (dir === 'GO_PUT') aiPuts++;
      else aiWaits++;

      if (dir === 'GO_CALL' || dir === 'GO_PUT') {
        const instTrades = tradesByInstrument[d.instrument] || [];
        const matching = instTrades.filter(t => {
          if (dir === 'GO_CALL') return t.tradeType === 'CALL_BUY';
          if (dir === 'GO_PUT') return t.tradeType === 'PUT_BUY';
          return false;
        });
        if (matching.length > 0) followed++;
        else missed++;
      }
    });
    return { aiCalls, aiPuts, aiWaits, followed, missed, total: validDecisions.length };
  }, [validDecisions, tradesByInstrument]);

  if (loading) {
    return (
      <div className="space-y-3">
        <div className="h-10 rounded bg-secondary/10 animate-pulse" />
        {[1, 2, 3, 4].map(i => (
          <div key={i} className="h-16 rounded border border-border bg-secondary/10 animate-pulse" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-8 space-y-2">
        <AlertTriangle className="h-8 w-8 text-warning-amber mx-auto" />
        <p className="text-[10px] text-muted-foreground">{error}</p>
        <button onClick={fetchDecisions}
          className="text-violet-pulse text-[9px] font-bold tracking-wider hover:underline flex items-center gap-1 mx-auto">
          <RefreshCw className="h-3 w-3" /> Retry
        </button>
      </div>
    );
  }

  if (validDecisions.length === 0) {
    return (
      <div className="text-center py-8 space-y-2">
        <Bot className="h-8 w-8 text-muted-foreground/40 mx-auto" />
        <p className="text-[10px] text-muted-foreground">
          No AI decisions available. Start the AI Decision Engine to generate signals.
        </p>
        <p className="text-[8px] text-muted-foreground/60">
          Run: <code className="bg-secondary/50 px-1 py-0.5 rounded">python3 python_modules/ai_decision_engine.py</code>
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Summary Bar */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-secondary/20 border border-border">
          <Bot className="h-3 w-3 text-violet-pulse" />
          <span className="text-[8px] text-muted-foreground">{summary.total} signals</span>
        </div>
        <div className="flex items-center gap-1 px-2 py-1 rounded bg-bullish/5 border border-bullish/20">
          <ArrowUpRight className="h-2.5 w-2.5 text-bullish" />
          <span className="text-[8px] text-bullish font-bold">{summary.aiCalls} CALL</span>
        </div>
        <div className="flex items-center gap-1 px-2 py-1 rounded bg-destructive/5 border border-destructive/20">
          <ArrowDownRight className="h-2.5 w-2.5 text-destructive" />
          <span className="text-[8px] text-destructive font-bold">{summary.aiPuts} PUT</span>
        </div>
        <div className="flex items-center gap-1 px-2 py-1 rounded bg-secondary/20 border border-border">
          <Clock className="h-2.5 w-2.5 text-muted-foreground" />
          <span className="text-[8px] text-muted-foreground">{summary.aiWaits} WAIT</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[8px] text-bullish">Followed: {summary.followed}</span>
          <span className="text-[8px] text-warning-amber">Missed: {summary.missed}</span>
        </div>
        <button onClick={fetchDecisions}
          className="p-1 rounded hover:bg-secondary/30 text-muted-foreground hover:text-foreground transition-colors">
          <RefreshCw className="h-3 w-3" />
        </button>
      </div>

      {/* Comparison Table */}
      <div className="space-y-1">
        <div className="flex items-center gap-3 px-2.5 py-1 text-[7px] text-muted-foreground tracking-wider uppercase">
          <div className="w-20">Instrument</div>
          <div className="w-20">AI Said</div>
          <div className="w-24">You Did</div>
          <div className="w-20 text-right">P&L</div>
          <div className="flex-1 text-right">Outcome</div>
        </div>
        {validDecisions.map(d => (
          <ComparisonRow
            key={d.instrument}
            aiDecision={d.decision!}
            userTrades={tradesByInstrument[d.instrument] || []}
          />
        ))}
      </div>

      {/* Individual AI Decision Cards */}
      <div className="space-y-1.5">
        <span className="text-[8px] text-muted-foreground tracking-wider uppercase">Latest AI Decisions (click to expand)</span>
        {validDecisions.map(d => (
          <AiDecisionCard key={d.instrument} data={d.decision!} />
        ))}
      </div>
    </div>
  );
}
