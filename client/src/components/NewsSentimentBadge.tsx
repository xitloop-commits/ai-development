/**
 * Terminal Noir — NewsSentimentBadge Component
 * Compact inline display of enhanced news sentiment data.
 * Shows sentiment, confidence, article count, event flags, and top articles on expand.
 */
import { useState } from 'react';
import { Newspaper, ChevronDown, ChevronUp, Zap, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import type { NewsDetail } from '@/lib/types';

interface NewsSentimentBadgeProps {
  newsDetail: NewsDetail;
  eventFlags?: string[];
}

function getSentimentConfig(sentiment: string) {
  switch (sentiment) {
    case 'Bullish':
      return { color: 'text-bullish', bg: 'bg-bullish/10', border: 'border-bullish/20', icon: TrendingUp };
    case 'Bearish':
      return { color: 'text-destructive', bg: 'bg-destructive/10', border: 'border-destructive/20', icon: TrendingDown };
    default:
      return { color: 'text-info-cyan', bg: 'bg-info-cyan/10', border: 'border-info-cyan/20', icon: Minus };
  }
}

function ConfidenceBar({ confidence }: { confidence: number }) {
  const width = Math.min(100, Math.max(0, confidence));
  const color = confidence >= 60 ? 'bg-bullish/60' : confidence >= 30 ? 'bg-warning-amber/60' : 'bg-muted-foreground/40';
  return (
    <div className="w-12 h-1 rounded-full bg-secondary/40 overflow-hidden">
      <div className={`h-full rounded-full transition-all duration-500 ${color}`} style={{ width: `${width}%` }} />
    </div>
  );
}

export default function NewsSentimentBadge({ newsDetail, eventFlags }: NewsSentimentBadgeProps) {
  const [expanded, setExpanded] = useState(false);
  const cfg = getSentimentConfig(newsDetail.sentiment);
  const SentIcon = cfg.icon;

  return (
    <div className="space-y-1">
      {/* Compact row */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1.5 hover:opacity-80 transition-opacity"
        >
          <Newspaper className="h-3 w-3 text-muted-foreground" />
          <span className="text-[0.5625rem] text-muted-foreground">News:</span>
          <SentIcon className={`h-3 w-3 ${cfg.color}`} />
          <span className={`text-[0.5625rem] font-bold ${cfg.color}`}>
            {newsDetail.sentiment}
          </span>
          <span className="text-[0.5rem] text-muted-foreground">
            ({newsDetail.strength})
          </span>
          <ConfidenceBar confidence={newsDetail.confidence} />
          <span className="text-[0.5rem] text-muted-foreground tabular-nums">
            {newsDetail.confidence}%
          </span>
          <span className="text-[0.5rem] text-muted-foreground">
            {newsDetail.total_articles} articles
          </span>
          {expanded ? <ChevronUp className="h-3 w-3 text-muted-foreground" /> : <ChevronDown className="h-3 w-3 text-muted-foreground" />}
        </button>

        {/* Event flags inline */}
        {eventFlags && eventFlags.length > 0 && (
          <div className="flex items-center gap-1 flex-wrap">
            {eventFlags.slice(0, 2).map((flag, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-0.5 text-[0.4375rem] px-1.5 py-0.5 rounded bg-warning-amber/10 text-warning-amber border border-warning-amber/20 font-bold"
              >
                <Zap className="h-2.5 w-2.5" />
                {flag}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="ml-4 space-y-1.5 animate-fade-in-up">
          {/* Bull/Bear score bar */}
          <div className="flex items-center gap-2">
            <span className="text-[0.5rem] text-bullish tabular-nums font-bold">
              Bull: {newsDetail.bull_score}
            </span>
            <div className="flex-1 h-1 rounded-full bg-secondary/30 overflow-hidden flex">
              {(() => {
                const total = newsDetail.bull_score + newsDetail.bear_score;
                const bullPct = total > 0 ? (newsDetail.bull_score / total) * 100 : 50;
                return (
                  <>
                    <div className="h-full bg-bullish/50" style={{ width: `${bullPct}%` }} />
                    <div className="h-full bg-destructive/50" style={{ width: `${100 - bullPct}%` }} />
                  </>
                );
              })()}
            </div>
            <span className="text-[0.5rem] text-destructive tabular-nums font-bold">
              Bear: {newsDetail.bear_score}
            </span>
            <span className="text-[0.5rem] text-muted-foreground tabular-nums">
              Net: <span className={newsDetail.net_score > 0 ? 'text-bullish' : newsDetail.net_score < 0 ? 'text-destructive' : 'text-muted-foreground'}>
                {newsDetail.net_score > 0 ? '+' : ''}{newsDetail.net_score}
              </span>
            </span>
          </div>

          {/* Top articles */}
          {newsDetail.top_articles && newsDetail.top_articles.length > 0 && (
            <div className="space-y-0.5">
              <span className="text-[0.4375rem] text-muted-foreground tracking-wider uppercase font-bold">
                Top Headlines ({newsDetail.queries_used} queries)
              </span>
              {newsDetail.top_articles.slice(0, 3).map((article, i) => (
                <div key={i} className="flex items-start gap-1.5">
                  <span className={`text-[0.4375rem] font-bold tabular-nums shrink-0 mt-0.5 ${
                    article.score > 0 ? 'text-bullish' : article.score < 0 ? 'text-destructive' : 'text-muted-foreground'
                  }`}>
                    {article.score > 0 ? '+' : ''}{article.score}
                  </span>
                  <span className="text-[0.5rem] text-muted-foreground leading-tight line-clamp-1">
                    {article.title}
                  </span>
                  <span className="text-[0.4375rem] text-muted-foreground/50 shrink-0">
                    {article.source}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
