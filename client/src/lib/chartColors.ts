/**
 * chartColors — theme-aware palette for the lightweight-charts views.
 *
 * lightweight-charts can't read CSS variables, so it needs concrete colors. The
 * DARK values match the long-standing `CHART_*` constants in `instrumentChart.ts`
 * (so the default dark theme is byte-identical); the LIGHT values keep charts
 * legible on a white page instead of rendering a dark box.
 */
export type ChartTheme = 'light' | 'dark';

export interface ChartColors {
  /** Chart canvas background. */
  background: string;
  /** Axis / label text. */
  text: string;
  /** Grid lines. */
  grid: string;
  /** Axis + price-scale borders. */
  border: string;
  /** Up candle / bullish series. */
  up: string;
  /** Down candle / bearish series. */
  down: string;
}

export function chartColors(theme: ChartTheme): ChartColors {
  return theme === 'light'
    ? {
        background: '#ffffff',
        text: '#475569',
        grid: 'rgba(100,116,139,0.10)',
        border: 'rgba(100,116,139,0.22)',
        up: '#15803d',
        down: '#dc2626',
      }
    : {
        background: '#131722',
        text: '#94a3b8',
        grid: 'rgba(148,163,184,0.06)',
        border: 'rgba(148,163,184,0.2)',
        up: '#089981',
        down: '#f23645',
      };
}
