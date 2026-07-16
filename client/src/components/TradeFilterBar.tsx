/**
 * TradeFilterBar — a compact, client-only view filter that sits on the right of
 * the today P&L bar and narrows the trade ROWS shown in the today cycle. It does
 * not touch the day's P&L / summary figures (those stay on the full day).
 *
 * Instrument is a single-select dropdown (there can be several); Status, Side and
 * Outcome are single-select toggle pills — click to activate, click again to
 * clear. An empty axis means "no filter on that axis"; active axes are AND-ed.
 */
import { memo } from 'react';
import { Filter, X } from 'lucide-react';
import type { TradeRecord } from '@/lib/tradeTypes';
import { cohortLabel, cohortPillStyle } from '@/lib/tradeThemes';

export type StatusFilter = 'OPEN' | 'CLOSED';
export type SideFilter = 'CE' | 'PE';
export type OutcomeFilter = 'WIN' | 'LOSS';

export interface TradeFilter {
  /** Exact `trade.instrument` value, or null = all instruments. */
  instrument: string | null;
  status: StatusFilter | null;
  side: SideFilter | null;
  outcome: OutcomeFilter | null;
  /** Strategy cohort (scalp | trend | swing | multi_day_swing | ma_signal), or null = all. */
  cohort: string | null;
}

export const EMPTY_TRADE_FILTER: TradeFilter = {
  instrument: null,
  status: null,
  side: null,
  outcome: null,
  cohort: null,
};

/** True when no axis is active (used to hide the reset button). */
export function isEmptyTradeFilter(f: TradeFilter): boolean {
  return !f.instrument && !f.status && !f.side && !f.outcome && !f.cohort;
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

  if (f.outcome) {
    // Outcome is only meaningful for a settled trade; open trades have no result.
    if (f.outcome === 'WIN' && !(t.pnl > 0)) return false;
    if (f.outcome === 'LOSS' && !(t.pnl < 0)) return false;
  }

  if (f.cohort && t.cohort !== f.cohort) return false;

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

function Divider() {
  return <span className="w-px h-3 bg-border shrink-0" aria-hidden />;
}

export interface TradeFilterBarProps {
  value: TradeFilter;
  onChange: (next: TradeFilter) => void;
  /** Distinct `trade.instrument` values present in the current day (dropdown options). */
  instruments: string[];
  /** Distinct `trade.cohort` values present in the current day (toggle pills);
   *  empty (e.g. manual-only workspaces) hides the cohort group. */
  cohorts: string[];
}

function _TradeFilterBar({ value, onChange, instruments, cohorts }: TradeFilterBarProps) {
  // Single-select toggle: click an active value clears it, else it becomes active.
  const toggle = <K extends 'status' | 'side' | 'outcome' | 'cohort'>(axis: K, v: TradeFilter[K]) =>
    onChange({ ...value, [axis]: value[axis] === v ? null : v });

  const dirty = !isEmptyTradeFilter(value);

  return (
    <div className="px-2 py-1.5 flex items-center gap-1.5 shrink-0">
      {/* Instrument — dropdown (options come from today's trades) */}
      <select
        value={value.instrument ?? ''}
        onChange={(e) => onChange({ ...value, instrument: e.target.value || null })}
        title="Filter by instrument"
        className="bg-muted/40 text-foreground text-[0.5625rem] font-semibold rounded px-1 py-0.5 border border-border max-w-[7rem] focus:outline-none focus:ring-1 focus:ring-primary/40"
      >
        <option value="">All instr.</option>
        {instruments.map((i) => (
          <option key={i} value={i}>
            {i}
          </option>
        ))}
      </select>

      <Divider />

      {/* Status */}
      <Pill active={value.status === 'OPEN'} activeClass="bg-info-cyan/20 text-info-cyan" onClick={() => toggle('status', 'OPEN')} title="Show only open trades">
        Open
      </Pill>
      <Pill active={value.status === 'CLOSED'} activeClass="bg-foreground/15 text-foreground" onClick={() => toggle('status', 'CLOSED')} title="Show only closed trades">
        Closed
      </Pill>

      <Divider />

      {/* Side */}
      <Pill active={value.side === 'CE'} activeClass="bg-bullish/20 text-bullish" onClick={() => toggle('side', 'CE')} title="Show only CALL (CE) trades">
        CE
      </Pill>
      <Pill active={value.side === 'PE'} activeClass="bg-destructive/20 text-destructive" onClick={() => toggle('side', 'PE')} title="Show only PUT (PE) trades">
        PE
      </Pill>

      <Divider />

      {/* Outcome */}
      <Pill active={value.outcome === 'WIN'} activeClass="bg-bullish/20 text-bullish" onClick={() => toggle('outcome', 'WIN')} title="Show only winning trades">
        Win
      </Pill>
      <Pill active={value.outcome === 'LOSS'} activeClass="bg-destructive/20 text-destructive" onClick={() => toggle('outcome', 'LOSS')} title="Show only losing trades">
        Loss
      </Pill>

      {/* Cohort — colour-coded toggle pills, only for cohorts present today. */}
      {cohorts.length > 0 && (
        <>
          <Divider />
          {cohorts.map((c) => (
            <Pill
              key={c}
              active={value.cohort === c}
              activeStyle={cohortPillStyle(c)}
              onClick={() => toggle('cohort', c)}
              title={`Show only ${cohortLabel(c)} trades`}
            >
              {cohortLabel(c)}
            </Pill>
          ))}
        </>
      )}

      <Divider />

      {/* Trailing icon slot — fixed width so the pills never shift. Shows a clear
          (×) button when a filter is active, else the (decorative) funnel icon. */}
      {dirty ? (
        <button
          type="button"
          onClick={() => onChange(EMPTY_TRADE_FILTER)}
          title="Clear filter"
          aria-label="Clear filter"
          className="p-0.5 rounded text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors shrink-0"
        >
          <X className="w-3 h-3" />
        </button>
      ) : (
        <span className="p-0.5 shrink-0" aria-hidden>
          <Filter className="w-3 h-3 text-muted-foreground" />
        </span>
      )}
    </div>
  );
}

export const TradeFilterBar = memo(_TradeFilterBar);
