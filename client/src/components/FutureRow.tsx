import { memo } from 'react';
import type { Channel, DayRecord } from '@/lib/tradeTypes';
import { fmt, formatDateStr } from '@/lib/tradeFormatters';
import { RatingIcon } from './RatingIcon';

export interface FutureRowProps {
  day: DayRecord;
  isDay250: boolean;
  channel: Channel;
  highlighted?: boolean;
}

function _FutureRow({ day, isDay250, highlighted = false }: FutureRowProps) {
  return (
    <tr data-day={day.dayIndex} className={`border-b border-border transition-colors ${
      highlighted ? 'bg-warning-amber/20 outline outline-1 outline-warning-amber/60' : 'bg-background/30'
    } ${isDay250 ? 'opacity-90' : 'opacity-[0.55]'}`}>
      <td className="px-2 py-2 text-right border-r border-border">
        <span className="font-bold tabular-nums text-foreground">
          {day.dayIndex}
        </span>
      </td>
      <td className="px-2 py-2 text-right tabular-nums text-foreground border-r border-border">
        {formatDateStr(day.date || '')}
      </td>
      <td className="px-2 py-2 text-right tabular-nums text-foreground border-r border-border">
        {fmt(day.tradeCapital, true)}
      </td>
      <td className="px-2 py-2 text-right tabular-nums text-foreground border-r border-border">
        {fmt(day.targetAmount)}
        <span className="text-[0.5625rem] ml-0.5">({day.targetPercent}%)</span>
      </td>
      <td className="px-2 py-2 text-right tabular-nums font-medium text-foreground border-r border-border">
        {fmt(day.projCapital, true)}
      </td>
      <td className="px-2 py-2 border-r border-border"></td>
      <td className="px-2 py-2 border-r border-border"></td>
      <td className="px-2 py-2 border-r border-border"></td>
      <td className="px-2 py-2 border-r border-border"></td>
      <td className="px-2 py-2 border-r border-border"></td>
      <td className="px-2 py-2 border-r border-border"></td>
      <td className="px-2 py-2 border-r border-border"></td>
      <td className="px-2 py-2 border-r border-border"></td>
      <td className="px-2 py-2 border-r border-border"></td>
      <td className="px-2 py-2 border-r border-border"></td>
      <td className="px-1 py-2 text-center whitespace-nowrap">
        <RatingIcon rating={isDay250 ? 'finish' : 'future'} />
      </td>
    </tr>
  );
}

export const FutureRow = memo(_FutureRow, (prev, next) => {
  const d1 = prev.day;
  const d2 = next.day;
  return (
    d1.dayIndex === d2.dayIndex &&
    d1.targetAmount === d2.targetAmount &&
    d1.projCapital === d2.projCapital &&
    d1.tradeCapital === d2.tradeCapital &&
    d1.targetPercent === d2.targetPercent &&
    d1.date === d2.date &&
    prev.isDay250 === next.isDay250 &&
    prev.channel === next.channel &&
    prev.highlighted === next.highlighted
  );
});
