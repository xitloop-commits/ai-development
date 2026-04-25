/**
 * Head-to-Head reporting view.
 *
 * Compares performance side-by-side across channels — primarily AI vs
 * My, paper vs live. Reads from `portfolio.headToHead` which combines:
 *   - PortfolioSnapshot (current capital, exposure)
 *   - PortfolioMetrics (cumulative P&L, win rate, R:R)
 *   - portfolio_metrics rollup with pnlByTriggeredBy /
 *     countByTriggeredBy breakdowns
 *
 * Designed as the source of truth for the AI Live canary 30-day
 * comparison. Default view: ai-paper vs my-paper. URL params can
 * override.
 *
 * Routed via `?view=h2h` (App.tsx). No nav button yet — that lands
 * once the canary launch ships.
 */

import { useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { formatINR as fmt } from "@/lib/formatINR";

type Channel =
  | "ai-live"
  | "ai-paper"
  | "my-live"
  | "my-paper"
  | "testing-live"
  | "testing-sandbox";

const ALL_CHANNELS: Channel[] = [
  "ai-paper",
  "my-paper",
  "ai-live",
  "my-live",
];

function getChannelsFromUrl(): Channel[] {
  if (typeof window === "undefined") return ALL_CHANNELS;
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("channels");
  if (!raw) return ALL_CHANNELS;
  const valid: Channel[] = ["ai-live", "ai-paper", "my-live", "my-paper", "testing-live", "testing-sandbox"];
  return raw.split(",").filter((c): c is Channel => valid.includes(c as Channel));
}

function PnlCell({ value }: { value: number | undefined }) {
  if (value == null) return <span className="text-muted-foreground">—</span>;
  const cls = value > 0 ? "text-bullish" : value < 0 ? "text-bearish" : "text-muted-foreground";
  return <span className={`font-mono tabular-nums ${cls}`}>{value >= 0 ? "+" : ""}{fmt(value)}</span>;
}

function PercentCell({ value }: { value: number | undefined }) {
  if (value == null) return <span className="text-muted-foreground">—</span>;
  const cls = value > 0 ? "text-bullish" : value < 0 ? "text-bearish" : "text-muted-foreground";
  return <span className={`font-mono tabular-nums ${cls}`}>{value.toFixed(2)}%</span>;
}

export default function HeadToHeadPage() {
  const channels = useMemo(getChannelsFromUrl, []);
  const { data, isLoading, refetch } = trpc.portfolio.headToHead.useQuery(
    { channels },
    { refetchInterval: 5000 },
  );

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center">
        <div className="font-mono text-sm text-muted-foreground">Loading Head-to-Head…</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground p-6 font-mono">
      <header className="flex items-baseline justify-between mb-6">
        <h1 className="text-xl font-bold tracking-wide">HEAD-TO-HEAD — Performance Comparison</h1>
        <button
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => refetch()}
        >
          ↻ refresh (auto: 5s)
        </button>
      </header>

      <p className="text-xs text-muted-foreground mb-4">
        Channels:{" "}
        {channels.map((c, i) => (
          <span key={c}>
            <code className="text-info-cyan">{c}</code>
            {i < channels.length - 1 ? " · " : ""}
          </span>
        ))}
        {" "}—{" "}
        Override with <code>?channels=ai-paper,my-paper</code>
      </p>

      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="text-muted-foreground border-b border-border">
              <th className="text-left py-2 px-3 font-normal">Metric</th>
              {data?.map((row) => (
                <th key={row.channel} className="text-right py-2 px-3 font-normal">
                  <span className="text-info-cyan">{row.channel}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <SectionHeader colSpan={(data?.length ?? 0) + 1} label="Capital" />
            <Row label="Current Capital" channels={data}>
              {(r) => <span className="font-mono tabular-nums">{fmt(r.snapshot.currentCapital)}</span>}
            </Row>
            <Row label="Available Capital" channels={data}>
              {(r) => <span className="font-mono tabular-nums">{fmt(r.snapshot.availableCapital)}</span>}
            </Row>
            <Row label="Trading Pool" channels={data}>
              {(r) => <span className="font-mono tabular-nums">{fmt(r.snapshot.tradingPool)}</span>}
            </Row>
            <Row label="Reserve Pool" channels={data}>
              {(r) => <span className="font-mono tabular-nums">{fmt(r.snapshot.reservePool)}</span>}
            </Row>

            <SectionHeader colSpan={(data?.length ?? 0) + 1} label="Today" />
            <Row label="Day Index" channels={data}>
              {(r) => <span className="font-mono tabular-nums">{r.snapshot.currentDayIndex} / 250</span>}
            </Row>
            <Row label="Today P&L" channels={data}>
              {(r) => <PnlCell value={r.snapshot.todayPnl} />}
            </Row>
            <Row label="Today P&L %" channels={data}>
              {(r) => <PercentCell value={r.snapshot.dailyRealizedPnlPercent} />}
            </Row>
            <Row label="Open Positions" channels={data}>
              {(r) => <span className="font-mono tabular-nums">{r.snapshot.openPositionCount}</span>}
            </Row>
            <Row label="Unrealized P&L" channels={data}>
              {(r) => <PnlCell value={r.snapshot.unrealizedPnl} />}
            </Row>

            <SectionHeader colSpan={(data?.length ?? 0) + 1} label="Cumulative" />
            <Row label="Cumulative P&L" channels={data}>
              {(r) => <PnlCell value={r.snapshot.realizedPnl} />}
            </Row>
            <Row label="Trade Count" channels={data}>
              {(r) => <span className="font-mono tabular-nums">{r.metrics.tradeCount}</span>}
            </Row>
            <Row label="Win Rate" channels={data}>
              {(r) => <PercentCell value={r.metrics.winRate * 100} />}
            </Row>
            <Row label="Win / Loss / BE" channels={data}>
              {(r) => (
                <span className="font-mono tabular-nums">
                  <span className="text-bullish">{r.metrics.winCount}</span>
                  {" / "}
                  <span className="text-bearish">{r.metrics.lossCount}</span>
                  {" / "}
                  <span className="text-muted-foreground">{r.metrics.breakevenCount}</span>
                </span>
              )}
            </Row>
            <Row label="Avg R:R" channels={data}>
              {(r) => (
                <span className="font-mono tabular-nums">{r.metrics.averageRr.toFixed(2)}</span>
              )}
            </Row>

            <SectionHeader colSpan={(data?.length ?? 0) + 1} label="P&L by Exit Trigger" />
            {(["USER", "AI", "RCA", "DISCIPLINE", "BROKER", "PA"] as const).map((trig) => (
              <Row key={trig} label={`${trig} P&L`} channels={data}>
                {(r) => {
                  const v = r.rollup?.pnlByTriggeredBy?.[trig] ?? 0;
                  const c = r.rollup?.countByTriggeredBy?.[trig] ?? 0;
                  return (
                    <span>
                      <PnlCell value={v} />
                      <span className="text-muted-foreground"> ({c})</span>
                    </span>
                  );
                }}
              </Row>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground mt-6">
        portfolio_metrics rollup is recomputed on every trade close.
        Rows showing 0 simply mean no closed trades yet for that channel /
        trigger combination.
      </p>
    </div>
  );
}

function SectionHeader({ colSpan, label }: { colSpan: number; label: string }) {
  return (
    <tr>
      <td colSpan={colSpan} className="pt-4 pb-1 px-3 text-[0.6875rem] uppercase tracking-wider text-muted-foreground border-b border-border/50">
        {label}
      </td>
    </tr>
  );
}

interface RowProps {
  label: string;
  channels: any[] | undefined;
  children: (row: any) => React.ReactNode;
}

function Row({ label, channels, children }: RowProps) {
  return (
    <tr className="border-b border-border/30 hover:bg-muted/20">
      <td className="py-1.5 px-3 text-muted-foreground">{label}</td>
      {channels?.map((row) => (
        <td key={row.channel} className="py-1.5 px-3 text-right">
          {children(row)}
        </td>
      ))}
    </tr>
  );
}
