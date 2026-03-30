/*
 * Terminal Noir — Position Tracker Page (Placeholder)
 * Full-width 150-day compounding challenge tracker.
 * Will be implemented in Feature 5 (Core Table) and Feature 6 (Trade Input & Exit).
 */
import { Table2, Plus, ArrowDown } from 'lucide-react';

export default function PositionTracker() {
  return (
    <div className="container py-6">
      {/* Page Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="font-display text-xl sm:text-2xl font-bold tracking-tight text-foreground">
            Position Tracker
          </h1>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            150-day compounding challenge — 5% daily target
          </p>
        </div>
      </div>

      {/* Tabs: My Trades LIVE / AI Trades PAPER */}
      <div className="flex gap-0 border-b border-border mb-0">
        <button className="px-6 py-2.5 text-[12px] font-bold tracking-wider text-primary border-b-2 border-primary">
          My Trades
          <span className="ml-1.5 text-[9px] px-1.5 py-0.5 rounded-full bg-bullish/15 text-bullish font-bold">LIVE</span>
        </button>
        <button className="px-6 py-2.5 text-[12px] font-bold tracking-wider text-muted-foreground border-b-2 border-transparent hover:text-foreground transition-colors">
          AI Trades
          <span className="ml-1.5 text-[9px] px-1.5 py-0.5 rounded-full bg-warning-amber/15 text-warning-amber font-bold">PAPER</span>
        </button>
      </div>

      {/* Summary Bar */}
      <div className="flex items-center justify-between px-4 py-3 bg-card border border-border border-t-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">Current Day</span>
          <span className="text-[13px] font-bold tabular-nums text-warning-amber">7</span>
          <span className="text-[11px] text-muted-foreground">of 150</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">Capital</span>
          <span className="text-[13px] font-bold tabular-nums text-info-cyan">₹1,34,128</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">Profit</span>
          <span className="text-[13px] font-bold tabular-nums text-bullish">+₹34,128 (34.1%)</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">Today's P&L</span>
          <span className="text-[13px] font-bold tabular-nums text-bullish">+₹950</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">Target Remaining</span>
          <span className="text-[13px] font-bold tabular-nums text-warning-amber">₹5,750</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">Schedule</span>
          <span className="text-[13px] font-bold tabular-nums text-bullish">+₹6,500 (+1d)</span>
        </div>
      </div>

      {/* Placeholder Table */}
      <div className="border border-border border-t-0 rounded-b-md overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="bg-card border-b border-border">
                {['Day', 'Date', 'Open Capital', 'Target (5%)', 'Proj Capital', 'Instrument', 'Type', 'Strike', 'Entry', 'LTP', 'Qty', 'P&L', 'Actual Capital', 'Deviation', 'Rating'].map((col) => (
                  <th
                    key={col}
                    className="px-3 py-2.5 text-[9px] font-bold text-muted-foreground tracking-wider uppercase text-right first:text-left [&:nth-child(2)]:text-left [&:nth-child(6)]:text-left [&:nth-child(7)]:text-left"
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {/* Sample past row */}
              <tr className="border-b border-white/[0.02] bg-bullish/[0.04] hover:bg-white/[0.04] transition-colors">
                <td className="px-3 py-2 text-left font-bold text-muted-foreground">1</td>
                <td className="px-3 py-2 text-left text-muted-foreground">01-Apr</td>
                <td className="px-3 py-2 text-right tabular-nums">₹1,00,000</td>
                <td className="px-3 py-2 text-right tabular-nums">₹5,000</td>
                <td className="px-3 py-2 text-right tabular-nums">₹1,05,000</td>
                <td className="px-3 py-2 text-left">
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-[rgba(59,130,246,0.12)] text-[#60a5fa]">NIFTY 50</span>
                </td>
                <td className="px-3 py-2 text-left text-muted-foreground/20">—</td>
                <td className="px-3 py-2 text-right text-muted-foreground/20">—</td>
                <td className="px-3 py-2 text-right text-muted-foreground/20">—</td>
                <td className="px-3 py-2 text-right text-muted-foreground/20">—</td>
                <td className="px-3 py-2 text-right tabular-nums">75</td>
                <td className="px-3 py-2 text-right tabular-nums text-bullish">▲ ₹5,200 (5.2%)</td>
                <td className="px-3 py-2 text-right tabular-nums text-bullish">₹1,05,200</td>
                <td className="px-3 py-2 text-right tabular-nums text-bullish">+₹200 (0d)</td>
                <td className="px-3 py-2 text-center text-sm">🏆</td>
              </tr>

              {/* Sample today row */}
              <tr className="border-b border-white/[0.02] bg-warning-amber/[0.08] border-l-[3px] border-l-warning-amber hover:bg-white/[0.04] transition-colors">
                <td className="px-3 py-2 text-left font-bold text-warning-amber">7</td>
                <td className="px-3 py-2 text-left text-warning-amber">07-Apr</td>
                <td className="px-3 py-2 text-right tabular-nums text-warning-amber">₹1,34,009</td>
                <td className="px-3 py-2 text-right tabular-nums text-warning-amber">₹6,700</td>
                <td className="px-3 py-2 text-right tabular-nums text-warning-amber">₹1,40,710</td>
                <td className="px-3 py-2 text-left">
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-[rgba(59,130,246,0.12)] text-[#60a5fa]">NIFTY 50</span>
                </td>
                <td className="px-3 py-2 text-left text-bullish font-bold">B CE</td>
                <td className="px-3 py-2 text-right tabular-nums">24400</td>
                <td className="px-3 py-2 text-right tabular-nums">185.50</td>
                <td className="px-3 py-2 text-right tabular-nums text-bullish font-bold">198.30</td>
                <td className="px-3 py-2 text-right tabular-nums">50</td>
                <td className="px-3 py-2 text-right tabular-nums text-bullish">▲ ₹640 (0.5%)</td>
                <td className="px-3 py-2 text-right text-muted-foreground/20">—</td>
                <td className="px-3 py-2 text-right text-muted-foreground/20">—</td>
                <td className="px-3 py-2 text-center">
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-bold bg-bullish/12 text-bullish">✓ TP</span>
                </td>
              </tr>

              {/* Sample future row */}
              <tr className="border-b border-white/[0.02] bg-white/[0.01] opacity-45">
                <td className="px-3 py-2 text-left font-bold text-muted-foreground">8</td>
                <td className="px-3 py-2 text-left text-muted-foreground">08-Apr</td>
                <td className="px-3 py-2 text-right tabular-nums">₹1,40,710</td>
                <td className="px-3 py-2 text-right tabular-nums">₹7,035</td>
                <td className="px-3 py-2 text-right tabular-nums">₹1,47,745</td>
                <td className="px-3 py-2 text-left text-muted-foreground/20">—</td>
                <td className="px-3 py-2 text-left text-muted-foreground/20">—</td>
                <td className="px-3 py-2 text-right text-muted-foreground/20">—</td>
                <td className="px-3 py-2 text-right text-muted-foreground/20">—</td>
                <td className="px-3 py-2 text-right text-muted-foreground/20">—</td>
                <td className="px-3 py-2 text-right text-muted-foreground/20">—</td>
                <td className="px-3 py-2 text-right text-muted-foreground/20">—</td>
                <td className="px-3 py-2 text-right text-muted-foreground/20">—</td>
                <td className="px-3 py-2 text-right text-muted-foreground/20">—</td>
                <td className="px-3 py-2 text-center text-muted-foreground/20">⬜</td>
              </tr>

              {/* Placeholder message */}
              <tr>
                <td colSpan={15} className="px-3 py-8 text-center">
                  <div className="flex flex-col items-center gap-3">
                    <Table2 className="h-8 w-8 text-muted-foreground/30" />
                    <div>
                      <p className="text-[12px] text-muted-foreground font-bold">Position Tracker — Coming Soon</p>
                      <p className="text-[10px] text-muted-foreground/60 mt-1">
                        Full 150-day compounding table with live trade management, inline trade input,
                        gift days, multi-day support, and MongoDB persistence.
                      </p>
                    </div>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
