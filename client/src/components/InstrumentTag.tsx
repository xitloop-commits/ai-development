import { useInstrumentColors } from '@/lib/useInstrumentColors';

export interface InstrumentTagProps {
  name: string;
  /** Drop the filled background (e.g. for closed trades) — keep just the label. */
  muted?: boolean;
}

export function InstrumentTag({ name, muted }: InstrumentTagProps) {
  const { styleOf } = useInstrumentColors();
  const style = styleOf(name);
  return (
    <span
      className="inline-flex max-w-full items-center truncate px-1.5 py-0.5 rounded text-[0.625rem] font-semibold"
      style={muted ? style.text : style.pill}
    >
      {name}
    </span>
  );
}
