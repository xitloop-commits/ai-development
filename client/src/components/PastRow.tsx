import { memo } from 'react';
import type { DayRecord, Workspace } from '@/lib/tradeTypes';
import {
  fmt,
  pnlColor,
  formatDateAgeLabel,
  formatDeviation,
} from '@/lib/tradeFormatters';
import {
  calculateAvgEntryPrice,
  calculateAvgExitPrice,
  calculateAvgSignedPoints,
  calculateTotalInvested,
  calculateTotalLots,
} from '@/lib/tradeCalculations';
import { InstrumentTag } from './InstrumentTag';
import { RatingIcon } from './RatingIcon';

const _seenGiftDays = new Set<number>();

export interface PastRowProps {
  day: DayRecord;
  showNet: boolean;
  workspace: Workspace;
  highlighted?: boolean;
}

function _PastRow({ day, showNet, highlighted = false }: PastRowProps) {
  const pnlValue = showNet ? day.totalPnl : day.totalPnl + day.totalCharges;
  const pnlPercent = day.tradeCapital > 0 ? (day.totalPnl / day.tradeCapital * 100).toFixed(1) : '0.0';
  const dateLabel = formatDateAgeLabel(day.date || '', day.openedAt);
  const isGift = day.rating === 'gift';

  const isFreshGift = isGift && !_seenGiftDays.has(day.dayIndex);
  if (isGift) _seenGiftDays.add(day.dayIndex);

  return (
    <tr data-day={day.dayIndex} className={`border-b border-border transition-colors text-muted-foreground ${
      isFreshGift ? 'animate-gift-celebrate' : ''
    } ${
      highlighted ? 'bg-warning-amber/20 outline outline-1 outline-warning-amber/60' : 'hover:bg-muted/30'
    }`}>
      <td className="px-2 py-2 text-right border-r border-border">
        <span className="font-bold tabular-nums">{day.dayIndex}</span>
      </td>
      <td className="px-2 py-2 text-right border-r border-border">
        <span className="block truncate tabular-nums">{dateLabel}</span>
      </td>
      <td className="px-2 py-2 text-right tabular-nums border-r border-border">
        {fmt(day.tradeCapital, true)}
      </td>
      <td className="px-2 py-2 text-right tabular-nums border-r border-border">
        {fmt(day.targetAmount)}
        <span className="text-[0.5rem] ml-0.5">({day.targetPercent}%)</span>
      </td>
      <td className="px-2 py-2 text-right tabular-nums border-r border-border">
        {fmt(day.projCapital, true)}
      </td>
      <td className="px-2 py-2 text-right border-r border-border">
        <div className="flex max-w-full items-center justify-end gap-1 overflow-hidden whitespace-nowrap">
          {day.instruments.length > 0
            ? day.instruments.map((inst) => <InstrumentTag key={inst} name={inst} />)
            : null
          }
        </div>
      </td>
      <td className="px-2 py-2 text-right tabular-nums border-r border-border">
        {(() => { const avg = calculateAvgEntryPrice(day.trades ?? []); return avg > 0 ? avg.toFixed(2) : ''; })()}
      </td>
      <td className="px-2 py-2 text-right tabular-nums border-r border-border">
        {(() => { const avg = calculateAvgExitPrice(day.trades ?? []); return avg > 0 ? avg.toFixed(2) : ''; })()}
      </td>
      <td className="px-2 py-2 text-right tabular-nums border-r border-border">
        {(() => { const lots = calculateTotalLots(day.trades ?? []); return lots > 0 ? lots : ''; })()}
      </td>
      <td className="px-2 py-2 text-right tabular-nums border-r border-border">
        {(() => { const inv = calculateTotalInvested(day.trades ?? []); return inv > 0 ? fmt(inv) : ''; })()}
      </td>
      <td className="px-2 py-2 text-right tabular-nums border-r border-border">
        {(() => {
          const pts = calculateAvgSignedPoints(day.trades ?? []);
          if (pts === 0) return '';
          return <span className={pnlColor(pts)}>{pts >= 0 ? '+' : ''}{pts.toFixed(2)}</span>;
        })()}
      </td>
      <td className={`px-2 py-2 text-right tabular-nums font-bold border-r border-border ${pnlColor(pnlValue)}`}>
        {fmt(Math.round(pnlValue), false)}
      </td>
      <td className={`px-2 py-2 text-right tabular-nums border-r border-border ${pnlColor(pnlValue)}`}>
        {pnlPercent}%
      </td>
      <td className="px-2 py-2 text-right tabular-nums font-medium border-r border-border">
        {day.actualCapital > 0 ? fmt(day.actualCapital, true) : ''}
      </td>
      <td className={`px-2 py-2 text-right tabular-nums border-r border-border ${pnlColor(day.deviation)}`}>
        {day.actualCapital > 0 ? formatDeviation(day.deviation) : ''}
      </td>
      <td className="px-1 py-2 text-center">
        <span className={isFreshGift ? 'animate-gift-bounce' : ''}>
          <RatingIcon rating={day.rating} />
        </span>
      </td>
    </tr>
  );
}

export const PastRow = memo(_PastRow, (prev, next) => {
  const d1 = prev.day;
  const d2 = next.day;
  return (
    d1.dayIndex === d2.dayIndex &&
    d1.totalPnl === d2.totalPnl &&
    d1.totalCharges === d2.totalCharges &&
    d1.rating === d2.rating &&
    d1.actualCapital === d2.actualCapital &&
    d1.deviation === d2.deviation &&
    d1.instruments === d2.instruments &&
    d1.trades === d2.trades &&
    prev.showNet === next.showNet &&
    prev.workspace === next.workspace &&
    prev.highlighted === next.highlighted
  );
});
