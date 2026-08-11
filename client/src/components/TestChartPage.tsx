/**
 * TestChartPage — Partha's angle-experiment window (2026-08-11).
 *
 * Opened by clicking an instrument NAME in the watchlist. One window, an
 * instrument dropdown on top, and below it the full InstrumentChartPage
 * pinned to the SINGLE underlying pane — so every existing control
 * (interval, candle/HA/line, date, indicators, replay follow, MCX polling)
 * comes along unchanged. Switching the dropdown remounts the page on the
 * new instrument. Reached via ?view=testchart&inst=<KEY>.
 */
import { useState } from "react";
import InstrumentChartPage from "./InstrumentChartPage";
import { INSTRUMENT_CHART_META, chartInstrumentFromUrl } from "@/lib/instrumentChart";

const INSTRUMENTS = ["NIFTY_50", "BANKNIFTY", "CRUDEOIL", "NATURALGAS"];

export default function TestChartPage() {
  const [inst, setInst] = useState<string>(() => {
    const fromUrl = chartInstrumentFromUrl();
    return fromUrl && INSTRUMENTS.includes(fromUrl) ? fromUrl : "NIFTY_50";
  });

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs shrink-0">
        <span className="font-bold tracking-wider text-[0.625rem] text-muted-foreground">TEST CHART</span>
        <select
          value={inst}
          onChange={(e) => setInst(e.target.value)}
          className="rounded border border-border bg-secondary px-2 py-0.5 text-xs font-bold"
        >
          {INSTRUMENTS.map((k) => (
            <option key={k} value={k}>{INSTRUMENT_CHART_META[k]?.displayName ?? k}</option>
          ))}
        </select>
        <span className="text-[0.625rem] text-muted-foreground">underlying · single pane</span>
      </div>
      <div className="min-h-0 flex-1">
        {/* key remounts the whole page on instrument switch */}
        <InstrumentChartPage key={inst} instOverride={inst} singlePane />
      </div>
    </div>
  );
}
