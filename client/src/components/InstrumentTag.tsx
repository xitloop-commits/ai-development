import { getInstrumentStyle } from '@/lib/tradeThemes';

export interface InstrumentTagProps {
  name: string;
  /** Drop the filled background (e.g. for closed trades) — keep just the label. */
  muted?: boolean;
}

export function InstrumentTag({ name, muted }: InstrumentTagProps) {
  const style = getInstrumentStyle(name);
  return (
    <span className={`inline-flex max-w-full items-center truncate px-1.5 py-0.5 rounded font-semibold ${muted ? '' : style.bg} ${style.text}`}>
      {name}
    </span>
  );
}
