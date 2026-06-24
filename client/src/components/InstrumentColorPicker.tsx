/**
 * InstrumentColorPicker — per-instrument colour swatch + popover.
 *
 * A curated preset palette plus a custom-hex escape hatch. Saving writes the
 * colour to the instrument (instruments.setColor) and invalidates the cached
 * instruments list, so every instrument-specific surface re-colours at once.
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { trpc } from '@/lib/trpc';
import { INSTRUMENT_PALETTE } from '@/lib/tradeThemes';

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

interface InstrumentColorPickerProps {
  instrumentKey: string;
  color: string;
}

export function InstrumentColorPicker({ instrumentKey, color }: InstrumentColorPickerProps) {
  const [open, setOpen] = useState(false);
  const [hex, setHex] = useState(color);
  const utils = trpc.useUtils();
  const setColor = trpc.instruments.setColor.useMutation();

  const apply = async (c: string) => {
    if (!HEX_RE.test(c)) {
      toast.error('Use a hex colour like #3B82F6');
      return;
    }
    try {
      await setColor.mutateAsync({ key: instrumentKey, color: c });
      await utils.instruments.list.invalidate();
      toast.success('Colour updated');
      setOpen(false);
    } catch (err: any) {
      toast.error(err?.message ?? 'Failed to update colour');
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => {
          setHex(color);
          setOpen((o) => !o);
        }}
        className="w-5 h-5 rounded border border-border shrink-0 hover:scale-110 transition-transform"
        style={{ backgroundColor: color }}
        title="Change colour"
      />
      {open && (
        <>
          {/* click-away backdrop */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-1 p-2 w-44 rounded-md border border-border bg-card shadow-lg space-y-2">
            <div className="grid grid-cols-6 gap-1">
              {INSTRUMENT_PALETTE.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => apply(c)}
                  className="w-5 h-5 rounded border border-border/60 hover:scale-110 transition-transform"
                  style={{ backgroundColor: c }}
                  title={c}
                />
              ))}
            </div>
            <div className="flex items-center gap-1.5 pt-1 border-t border-border/40">
              <input
                type="color"
                value={HEX_RE.test(hex) ? hex : color}
                onChange={(e) => setHex(e.target.value)}
                className="w-6 h-6 rounded bg-transparent border border-border cursor-pointer p-0"
                title="Custom colour"
              />
              <input
                value={hex}
                onChange={(e) => setHex(e.target.value)}
                placeholder="#3B82F6"
                className="flex-1 min-w-0 px-1.5 py-0.5 text-[0.625rem] font-mono bg-background border border-border rounded text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <button
                type="button"
                onClick={() => apply(hex)}
                disabled={setColor.isPending}
                className="px-1.5 py-0.5 text-[0.5625rem] font-bold rounded border border-primary/30 text-primary hover:bg-primary/5 disabled:opacity-50"
              >
                OK
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
