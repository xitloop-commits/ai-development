/**
 * TradeFilterBar — a client-only view filter on the right of the today P&L bar.
 * It narrows the trade ROWS shown in the today cycle; it does NOT touch the day's
 * P&L / summary figures (those stay on the full day).
 *
 * Collapsed to a single funnel icon: clicking it opens a panel holding every
 * axis. Instrument is a dropdown; Status, Side, Outcome, Source, Cohort and Exit
 * are single-select toggle pills — click to activate, click again to clear. An
 * empty axis means "no filter on that axis"; active axes are AND-ed. The icon
 * lights up with a count badge while any axis is active.
 */
import { memo, useState, useRef, useEffect } from 'react';
import { Filter, X } from 'lucide-react';
import type { TradeRecord } from '@/lib/tradeTypes';
import { cohortLabel, cohortPillStyle, strategyLabel, strategyPillStyle } from '@/lib/tradeThemes';

export type StatusFilter = 'OPEN' | 'CLOSED';
export type SideFilter = 'CE' | 'PE';
/** Long = bought the option, Short = sold it. Independent of CE/PE. */
export type DirectionFilter = 'LONG' | 'SHORT';
export type OutcomeFilter = 'WIN' | 'LOSS';
export type SourceFilter = 'ai' | 'my';

export interface TradeFilter {
  /** Exact `trade.instrument` value, or null = all instruments. */
  instrument: string | null;
  status: StatusFilter | null;
  side: SideFilter | null;
  /** Bought vs sold — orthogonal to CE/PE, so "Short(PE)" is side=PE + direction=SHORT. */
  direction: DirectionFilter | null;
  outcome: OutcomeFilter | null;
  /** Exit reason (SL_HIT / TSL_HIT / TP_HIT / AGE_EXIT / EOD_SQUAREOFF / …), or null = all. */
  exitReason: string | null;
  /** Strategy cohort (scalp | trend | swing | multi_day_swing | ma_signal), or null = all. */
  cohort: string | null;
  /** Exit strategy (sprint | runway | anchor) from the T84 race, or null = all. */
  exitStrategy: string | null;
  /** Trade source — AI engine vs My (manual), or null = all (T87). */
  source: SourceFilter | null;
}

export const EMPTY_TRADE_FILTER: TradeFilter = {
  instrument: null,
  status: null,
  side: null,
  direction: null,
  outcome: null,
  exitReason: null,
  cohort: null,
  exitStrategy: null,
  source: null,
};

/** True when no axis is active (used to hide the reset button). */
export function isEmptyTradeFilter(f: TradeFilter): boolean {
  return !f.instrument && !f.status && !f.side && !f.direction && !f.outcome
    && !f.exitReason && !f.cohort && !f.exitStrategy && !f.source;
}

/** Does a trade pass the active filter? Empty axes are ignored. */
export function tradeMatchesFilter(t: TradeRecord, f: TradeFilter): boolean {
  if (f.instrument && t.instrument !== f.instrument) return false;

  if (f.status) {
    const isOpen = t.status === 'OPEN';
    const isClosed = t.status === 'CLOSED' || t.status === 'EXITED';
    if (f.status === 'OPEN' && !isOpen) return false;
    if (f.status === 'CLOSED' && !isClosed) return false;
  }

  if (f.side) {
    // CE/PE is an option concept — a stock (BUY/SELL) has neither, so a side
    // filter naturally excludes stocks.
    const isCE = t.type.includes('CALL');
    const isPE = t.type.includes('PUT');
    if (f.side === 'CE' && !isCE) return false;
    if (f.side === 'PE' && !isPE) return false;
  }

  if (f.direction) {
    // BUY on an option = long it; SELL = short it. Equity BUY/SELL reads the same.
    const isLong = t.type.includes('BUY');
    if (f.direction === 'LONG' && !isLong) return false;
    if (f.direction === 'SHORT' && isLong) return false;
  }

  if (f.exitReason && t.exitReason !== f.exitReason) return false;

  if (f.outcome) {
    // Outcome is only meaningful for a settled trade; open trades have no result.
    if (f.outcome === 'WIN' && !(t.pnl > 0)) return false;
    if (f.outcome === 'LOSS' && !(t.pnl < 0)) return false;
  }

  if (f.cohort && t.cohort !== f.cohort) return false;

  // exitStrategy defaults to "sprint" when a trade predates the T84 race.
  if (f.exitStrategy && (t.exitStrategy ?? 'sprint') !== f.exitStrategy) return false;

  // Source defaults to "my" (manual) when a trade predates the T87 source tag.
  if (f.source && (t.source ?? 'my') !== f.source) return false;

  return true;
}

interface PillProps {
  active: boolean;
  /** Active-state Tailwind classes (used by the fixed status/side/outcome pills). */
  activeClass?: string;
  /** Active-state inline style — used by cohort pills, which are colour-coded by
   *  the shared cohortPillStyle (hex-derived, not a Tailwind class). */
  activeStyle?: React.CSSProperties;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}

function Pill({ active, activeClass, activeStyle, onClick, title, children }: PillProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      style={active ? activeStyle : undefined}
      className={`px-1.5 py-0.5 rounded text-[0.5625rem] font-semibold leading-none transition-colors ${
        active ? (activeClass ?? '') : 'text-muted-foreground hover:bg-muted/50'
      }`}
    >
      {children}
    </button>
  );
}

/** One labelled row in the filter panel: a fixed-width caption + its controls. */
function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span className="w-12 shrink-0 pt-1 text-[0.5rem] font-bold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <div className="flex items-center gap-1 flex-wrap">{children}</div>
    </div>
  );
}

export interface TradeFilterBarProps {
  value: TradeFilter;
  onChange: (next: TradeFilter) => void;
  /** Distinct `trade.instrument` values present in the current day (dropdown options). */
  instruments: string[];
  /** Distinct `trade.cohort` values present in the current day (toggle pills);
   *  empty (e.g. manual-only workspaces) hides the cohort group. */
  cohorts: string[];
  /** Distinct `trade.exitStrategy` values present today (T84 race); empty hides
   *  the strategy group so single-strategy days stay uncluttered. */
  strategies: string[];
  /** Distinct `trade.exitReason` values present today; empty hides the group. */
  exitReasons: string[];
}

/** Short labels for the exit-reason pills — the raw codes are shouty and wide. */
const EXIT_REASON_LABEL: Record<string, string> = {
  TP_HIT: 'TP',
  SL_HIT: 'SL',
  TSL_HIT: 'TSL',
  AGE_EXIT: 'Age',
  EOD_SQUAREOFF: 'EOD',
  EOD: 'EOD',
  STALE_PRICE_EXIT: 'Stale',
  MOMENTUM_EXIT: 'Momentum',
  VOLATILITY_EXIT: 'Volatility',
  DISCIPLINE_EXIT: 'Discipline',
  AI_EXIT: 'AI exit',
  MANUAL: 'Manual',
  EXPIRY: 'Expiry',
};

function _TradeFilterBar({ value, onChange, instruments, cohorts, strategies, exitReasons }: TradeFilterBarProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close the panel on an outside click or Esc.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Single-select toggle: click an active value clears it, else it becomes active.
  const toggle = <K extends 'status' | 'side' | 'direction' | 'outcome' | 'exitReason' | 'cohort' | 'exitStrategy' | 'source'>(axis: K, v: TradeFilter[K]) =>
    onChange({ ...value, [axis]: value[axis] === v ? null : v });

  const dirty = !isEmptyTradeFilter(value);
  const activeCount =
    (value.instrument ? 1 : 0) + (value.status ? 1 : 0) + (value.side ? 1 : 0) +
    (value.outcome ? 1 : 0) + (value.source ? 1 : 0) + (value.cohort ? 1 : 0) +
    (value.exitStrategy ? 1 : 0);

  return (
    <div ref={ref} className="relative flex items-center px-2 shrink-0">
      {/* Trigger — the funnel icon. When any axis is active it lights up and shows
          a count badge; clicking opens the full filter panel below. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={dirty ? `${activeCount} filter${activeCount === 1 ? '' : 's'} active` : 'Filter trades'}
        aria-label="Filter trades"
        aria-expanded={open}
        className={`relative p-1.5 rounded transition-colors ${
          dirty ? 'text-primary bg-primary/10' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
        }`}
      >
        <Filter className="w-3.5 h-3.5" />
        {dirty && (
          <span className="absolute -top-0.5 -right-0.5 flex h-3 min-w-[0.75rem] items-center justify-center rounded-full bg-primary px-0.5 text-[0.5rem] font-bold leading-none text-primary-foreground">
            {activeCount}
          </span>
        )}
      </button>

      {/* Panel — every filter axis, one labelled row each. */}
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 min-w-[15rem] space-y-2 rounded-md border border-border bg-card p-3 shadow-xl">
          <div className="flex items-center justify-between border-b border-border/50 pb-1.5">
            <span className="text-[0.6875rem] font-bold uppercase tracking-wider text-foreground">Filters</span>
            {dirty && (
              <button
                type="button"
                onClick={() => onChange(EMPTY_TRADE_FILTER)}
                title="Clear all filters"
                className="flex items-center gap-1 text-[0.5625rem] font-semibold text-muted-foreground transition-colors hover:text-foreground"
              >
                <X className="h-3 w-3" /> Clear all
              </button>
            )}
          </div>

          <Group label="Instr.">
            <select
              value={value.instrument ?? ''}
              onChange={(e) => onChange({ ...value, instrument: e.target.value || null })}
              title="Filter by instrument"
              className="max-w-[8rem] rounded border border-border bg-muted/40 px-1 py-0.5 text-[0.5625rem] font-semibold text-foreground focus:outline-none focus:ring-1 focus:ring-primary/40"
            >
              <option value="">All instruments</option>
              {instruments.map((i) => (
                <option key={i} value={i}>{i}</option>
              ))}
            </select>
          </Group>

          <Group label="Status">
            <Pill active={value.status === 'OPEN'} activeClass="bg-info-cyan/20 text-info-cyan" onClick={() => toggle('status', 'OPEN')} title="Show only open trades">Open</Pill>
            <Pill active={value.status === 'CLOSED'} activeClass="bg-foreground/15 text-foreground" onClick={() => toggle('status', 'CLOSED')} title="Show only closed trades">Closed</Pill>
          </Group>

          <Group label="Side">
            <Pill active={value.side === 'CE'} activeClass="bg-bullish/20 text-bullish" onClick={() => toggle('side', 'CE')} title="Show only CALL (CE) trades">CE</Pill>
            <Pill active={value.side === 'PE'} activeClass="bg-destructive/20 text-destructive" onClick={() => toggle('side', 'PE')} title="Show only PUT (PE) trades">PE</Pill>
          </Group>

          <Group label="Direction">
            <Pill active={value.direction === 'LONG'} activeClass="bg-bullish/20 text-bullish" onClick={() => toggle('direction', 'LONG')} title="Show only bought (long) trades">Long</Pill>
            <Pill active={value.direction === 'SHORT'} activeClass="bg-destructive/20 text-destructive" onClick={() => toggle('direction', 'SHORT')} title="Show only sold (short) trades">Short</Pill>
          </Group>

          <Group label="Outcome">
            <Pill active={value.outcome === 'WIN'} activeClass="bg-bullish/20 text-bullish" onClick={() => toggle('outcome', 'WIN')} title="Show only winning trades">Win</Pill>
            <Pill active={value.outcome === 'LOSS'} activeClass="bg-destructive/20 text-destructive" onClick={() => toggle('outcome', 'LOSS')} title="Show only losing trades">Loss</Pill>
          </Group>

          {/* Source — AI engine vs My (manual). The paper book holds both (T87). */}
          <Group label="Source">
            <Pill active={value.source === 'ai'} activeClass="bg-violet-pulse/20 text-violet-pulse" onClick={() => toggle('source', 'ai')} title="Show only AI trades">AI</Pill>
            <Pill active={value.source === 'my'} activeClass="bg-info-cyan/20 text-info-cyan" onClick={() => toggle('source', 'my')} title="Show only My (manual) trades">My</Pill>
          </Group>

          {/* Cohort — colour-coded, only for cohorts present today. */}
          {cohorts.length > 0 && (
            <Group label="Cohort">
              {cohorts.map((c) => (
                <Pill key={c} active={value.cohort === c} activeStyle={cohortPillStyle(c)} onClick={() => toggle('cohort', c)} title={`Show only ${cohortLabel(c)} trades`}>
                  {cohortLabel(c)}
                </Pill>
              ))}
            </Group>
          )}

          {/* Exit reason — only the reasons actually present today, so the row
              doesn't list a dozen states that never occur. */}
          {exitReasons.length > 0 && (
            <Group label="Exit reason">
              {exitReasons.map((r) => (
                <Pill key={r} active={value.exitReason === r} activeClass="bg-warning-amber/20 text-warning-amber" onClick={() => toggle('exitReason', r)} title={`Show only trades that exited via ${r}`}>
                  {EXIT_REASON_LABEL[r] ?? r}
                </Pill>
              ))}
            </Group>
          )}

          {/* Exit strategy (T84 race) — only when present today. */}
          {strategies.length > 0 && (
            <Group label="Exit">
              {strategies.map((s) => (
                <Pill key={s} active={value.exitStrategy === s} activeStyle={strategyPillStyle(s)} onClick={() => toggle('exitStrategy', s)} title={`Show only ${strategyLabel(s)}-strategy trades`}>
                  {strategyLabel(s)}
                </Pill>
              ))}
            </Group>
          )}
        </div>
      )}
    </div>
  );
}

export const TradeFilterBar = memo(_TradeFilterBar);
