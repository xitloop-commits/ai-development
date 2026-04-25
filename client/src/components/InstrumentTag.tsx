import { getInstrumentStyle } from '@/lib/tradeThemes';

export interface InstrumentTagProps {
  name: string;
}

export function InstrumentTag({ name }: InstrumentTagProps) {
  const style = getInstrumentStyle(name);
  return (
    <span className={`inline-flex max-w-full items-center truncate px-1.5 py-0.5 rounded font-bold tracking-wide ${style.bg} ${style.text}`}>
      {name}
    </span>
  );
}
