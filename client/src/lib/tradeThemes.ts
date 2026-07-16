import type { Channel, Workspace } from './tradeTypes';
import { channelToWorkspace, isLiveChannel } from './tradeTypes';

// ─── Instrument colour system ──────────────────────────────────────────────
// Each instrument has ONE base colour (hex), stored per-instrument in the DB
// (InstrumentConfig.color) and editable in Settings → Instruments. Every
// instrument-specific UI surface (pill, instrument cards, signal cards, expiry
// cards) derives all its shades from that one hex via alpha, so contrast stays
// consistent on the dark theme.
//
// IMPORTANT: colours are applied as inline styles (NOT Tailwind classes).
// Tailwind purges classes that aren't present in source at build time, so a
// colour the user picks at runtime would silently fail to render as a class.

/** Curated preset palette shown as swatches in the colour picker.
 *  Mirrors INSTRUMENT_PALETTE in server/instruments.ts — keep in sync.
 *  First four match the legacy default pill colours. */
export const INSTRUMENT_PALETTE: readonly string[] = [
  '#3B82F6', // blue
  '#A855F7', // purple
  '#F59E0B', // amber
  '#10B981', // emerald
  '#EF4444', // red
  '#06B6D4', // cyan
  '#EC4899', // pink
  '#84CC16', // lime
  '#F97316', // orange
  '#8B5CF6', // violet
  '#14B8A6', // teal
  '#F43F5E', // rose
] as const;

/** Day-one defaults — match the legacy hard-coded pill colours exactly, keyed
 *  by canonical DB key. Used as a fallback when the live colour hasn't loaded. */
export const DEFAULT_INSTRUMENT_COLORS: Record<string, string> = {
  NIFTY_50: '#3B82F6', // was blue-500
  BANKNIFTY: '#A855F7', // was purple-500
  CRUDEOIL: '#F59E0B', // was amber-500
  NATURALGAS: '#10B981', // was emerald-500
};

const FALLBACK_INSTRUMENT_COLOR = '#64748B'; // slate-500

/** Normalise any instrument label form to one canonical lookup key. Handles
 *  the DB key ('NIFTY_50'), display name ('NIFTY 50'), live-state key
 *  ('nifty50') and SEA short form ('NIFTY'). */
export function normalizeInstrumentKey(raw: string): string {
  const u = (raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (u === 'NIFTY' || u === 'NIFTY50') return 'NIFTY50';
  return u;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  let h = (hex || FALLBACK_INSTRUMENT_COLOR).replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** hex + alpha → an rgba() string for inline styles. */
export function withAlpha(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export interface InstrumentStyle {
  /** the resolved base hex */
  hex: string;
  /** vivid text in the instrument colour */
  text: { color: string };
  /** pill: light tint background + vivid text */
  pill: { backgroundColor: string; color: string };
  /** card / row: very light tint background */
  cardBg: { backgroundColor: string };
  /** subtle border in the instrument colour */
  border: { borderColor: string };
  /** left accent strip */
  borderLeft: { borderLeftColor: string };
}

/** Derive every UI shade from one base hex. Pure — no lookups. */
export function instrumentStyleFromHex(hex: string): InstrumentStyle {
  const base = hex || FALLBACK_INSTRUMENT_COLOR;
  return {
    hex: base,
    text: { color: base },
    pill: { backgroundColor: withAlpha(base, 0.15), color: base },
    cardBg: { backgroundColor: withAlpha(base, 0.12) },
    border: { borderColor: withAlpha(base, 0.3) },
    borderLeft: { borderLeftColor: base },
  };
}

/** Resolve an instrument's base hex from a colour map keyed by normalized key,
 *  falling back to the built-in default for the core instruments, then slate. */
export function resolveInstrumentHex(
  raw: string,
  colorMap: Record<string, string>,
): string {
  const norm = normalizeInstrumentKey(raw);
  if (colorMap[norm]) return colorMap[norm];
  for (const [k, v] of Object.entries(DEFAULT_INSTRUMENT_COLORS)) {
    if (normalizeInstrumentKey(k) === norm) return v;
  }
  return FALLBACK_INSTRUMENT_COLOR;
}

// ─── Cohort colour system ──────────────────────────────────────────────────
// Each signal cohort (model-head horizon) has ONE bright colour, used
// consistently wherever a cohort pill appears (trade rows, signal cards, …).
// Reuses instrumentStyleFromHex so the pill/text shades match the instrument
// pills on the dark theme. Kept distinct from the core instrument hues.
export const COHORT_COLORS: Record<string, string> = {
  scalp: '#22D3EE',           // bright cyan  — <= 5 min
  trend: '#4ADE80',           // bright green — 15-30 min
  swing: '#FBBF24',           // bright amber — 1-2 hr
  multi_day_swing: '#C084FC', // bright violet — overnight+
  ma_signal: '#F472B6',       // bright pink — 20-EMA slope legs (signal-only)
};

const FALLBACK_COHORT_COLOR = '#94A3B8'; // slate-400

/** Resolve a cohort's bright hex (case-insensitive); slate for unknown / null. */
export function resolveCohortHex(cohort: string | null | undefined): string {
  if (!cohort) return FALLBACK_COHORT_COLOR;
  return COHORT_COLORS[cohort.toLowerCase()] ?? FALLBACK_COHORT_COLOR;
}

/** Short display label for a cohort pill (keeps the long one compact). */
export function cohortLabel(cohort: string): string {
  if (cohort === 'multi_day_swing') return 'multiday';
  if (cohort === 'ma_signal') return 'MA-Signal';
  return cohort;
}

/** Cohort pill style (bright text + tint bg) — matches the instrument pill so
 *  cohort colours stay consistent across every surface that shows them. */
export function cohortPillStyle(cohort: string | null | undefined) {
  return instrumentStyleFromHex(resolveCohortHex(cohort)).pill;
}

// ─── Exit-strategy colour system ───────────────────────────────────────────
// The T84 multi-strategy race: every ai-paper signal spawns one full-size
// trade per strategy so they compete on identical entries. Each strategy has
// ONE bright colour, used wherever a strategy pill/tag appears (trade rows,
// filter bar, trade bar). Kept distinct from the cohort hues above.
export const STRATEGY_COLORS: Record<string, string> = {
  sprint: '#38BDF8', // sky blue   — the legacy TP/SL/TSL engine (default)
  runway: '#34D399', // emerald    — staged stops then ride the winner
  anchor: '#F59E0B', // amber      — staged stops, bank at fixed target
};

const FALLBACK_STRATEGY_COLOR = '#94A3B8'; // slate-400

/** Resolve a strategy's bright hex (case-insensitive); slate for unknown / null. */
export function resolveStrategyHex(strategy: string | null | undefined): string {
  if (!strategy) return FALLBACK_STRATEGY_COLOR;
  return STRATEGY_COLORS[strategy.toLowerCase()] ?? FALLBACK_STRATEGY_COLOR;
}

/** Title-case display label for a strategy pill (Sprint / Runway / Anchor). */
export function strategyLabel(strategy: string): string {
  return strategy.charAt(0).toUpperCase() + strategy.slice(1);
}

/** Strategy pill style (bright text + tint bg) — matches the cohort/instrument
 *  pills so strategy colours stay consistent across every surface. */
export function strategyPillStyle(strategy: string | null | undefined) {
  return instrumentStyleFromHex(resolveStrategyHex(strategy)).pill;
}

/** Manual order controls allowed on My-* and Testing-* channels (not on AI channels). */
export function supportsManualControls(channel: Channel): boolean {
  const ws = channelToWorkspace(channel);
  return ws === 'my' || ws === 'testing';
}

/** Manual EXIT is allowed wherever full manual controls are (my/testing) AND in
 *  the AI workspace — the operator can square off an AI-managed position by hand
 *  without enabling manual entry. Stocks are handled separately (isEquityTrade). */
export function canExitTrades(channel: Channel): boolean {
  const ws = channelToWorkspace(channel);
  return ws === 'my' || ws === 'testing' || ws === 'ai';
}

/** Badge label + classes for a channel (workspace × mode). */
export function getChannelBadgeMeta(channel: Channel): { label: string; className: string } {
  const ws = channelToWorkspace(channel);
  const live = isLiveChannel(channel);
  switch (ws) {
    case 'my':
      return live
        ? { label: 'MY LIVE', className: 'bg-bullish/20 text-bullish' }
        : { label: 'MY PAPER', className: 'bg-bullish/15 text-bullish/80' };
    case 'ai':
      return live
        ? { label: 'AI LIVE', className: 'bg-violet-pulse/20 text-violet-pulse' }
        : { label: 'AI PAPER', className: 'bg-violet-pulse/15 text-violet-pulse/80' };
    case 'testing':
      return live
        ? { label: 'TEST LIVE', className: 'bg-warning-amber/20 text-warning-amber' }
        : { label: 'TEST', className: 'bg-warning-amber/15 text-warning-amber/80' };
    case 'stocks':
      return live
        ? { label: 'STOCKS LIVE', className: 'bg-info-cyan/20 text-info-cyan' }
        : { label: 'STOCKS PAPER', className: 'bg-info-cyan/15 text-info-cyan/80' };
  }
}

export interface WorkspaceThemeMeta {
  text: string;
  textSoft: string;
  textDim: string;
  rowBg: string;
  rowBgHover: string;
  todayBg: string;
  todayAltBg: string;
  summaryBg: string;
  summaryBorder: string;
  borderStrong: string;
  borderSoft: string;
  button: string;
  buttonActive: string;
}

/** Theme is keyed by workspace (color identity), not channel — Live and Paper share a tone. */
export function getWorkspaceThemeMeta(workspace: Workspace): WorkspaceThemeMeta {
  switch (workspace) {
    case 'my':
      return {
        text: 'text-bullish',
        textSoft: 'text-bullish/80',
        textDim: 'text-bullish/60',
        rowBg: 'bg-bullish/[0.04]',
        rowBgHover: 'hover:bg-bullish/[0.08]',
        todayBg: 'bg-bullish/[0.08]',
        todayAltBg: 'bg-bullish/[0.04]',
        summaryBg: 'bg-bullish/20',
        summaryBorder: 'border-bullish/30',
        borderStrong: 'border-l-bullish',
        borderSoft: 'border-l-bullish/50',
        button: 'bg-bullish/15 text-bullish hover:bg-bullish/25',
        buttonActive: 'bg-bullish/20 text-bullish',
      };
    case 'testing':
      return {
        text: 'text-warning-amber',
        textSoft: 'text-warning-amber/80',
        textDim: 'text-warning-amber/60',
        rowBg: 'bg-warning-amber/[0.04]',
        rowBgHover: 'hover:bg-warning-amber/[0.08]',
        todayBg: 'bg-warning-amber/[0.08]',
        todayAltBg: 'bg-warning-amber/[0.04]',
        summaryBg: 'bg-warning-amber/20',
        summaryBorder: 'border-warning-amber/30',
        borderStrong: 'border-l-warning-amber',
        borderSoft: 'border-l-warning-amber/50',
        button: 'bg-warning-amber/15 text-warning-amber hover:bg-warning-amber/25',
        buttonActive: 'bg-warning-amber/20 text-warning-amber',
      };
    case 'stocks':
      return {
        text: 'text-info-cyan',
        textSoft: 'text-info-cyan/80',
        textDim: 'text-info-cyan/60',
        rowBg: 'bg-info-cyan/[0.04]',
        rowBgHover: 'hover:bg-info-cyan/[0.08]',
        todayBg: 'bg-info-cyan/[0.08]',
        todayAltBg: 'bg-info-cyan/[0.04]',
        summaryBg: 'bg-info-cyan/20',
        summaryBorder: 'border-info-cyan/30',
        borderStrong: 'border-l-info-cyan',
        borderSoft: 'border-l-info-cyan/50',
        button: 'bg-info-cyan/15 text-info-cyan hover:bg-info-cyan/25',
        buttonActive: 'bg-info-cyan/20 text-info-cyan',
      };
    case 'ai':
    default:
      return {
        text: 'text-violet-pulse',
        textSoft: 'text-violet-pulse/80',
        textDim: 'text-violet-pulse/60',
        rowBg: 'bg-violet-pulse/[0.04]',
        rowBgHover: 'hover:bg-violet-pulse/[0.08]',
        todayBg: 'bg-violet-pulse/[0.08]',
        todayAltBg: 'bg-violet-pulse/[0.04]',
        summaryBg: 'bg-violet-pulse/20',
        summaryBorder: 'border-violet-pulse/30',
        borderStrong: 'border-l-violet-pulse',
        borderSoft: 'border-l-violet-pulse/50',
        button: 'bg-violet-pulse/15 text-violet-pulse hover:bg-violet-pulse/25',
        buttonActive: 'bg-violet-pulse/20 text-violet-pulse',
      };
  }
}

/** Convenience: theme directly from a channel. */
export function getChannelThemeMeta(channel: Channel): WorkspaceThemeMeta {
  return getWorkspaceThemeMeta(channelToWorkspace(channel));
}
