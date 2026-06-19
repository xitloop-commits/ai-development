/**
 * LotPicker — compact lot-count chooser, two styles in one control:
 *   • a −/+ stepper that shows `lots×lotSize=totalUnits` (or just units when
 *     lotSize is 1), and
 *   • a presets popover (quick-pick chips) with a "lots × size = units" footnote.
 *
 * Controlled: the parent owns `lots`. Recovered from the old QuickOrderPopup
 * (removed in 737bca6) and made reusable for the instrument bar.
 */

import { useState } from "react";
import { ChevronDown, ChevronUp, Settings2 } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const QTY_PRESETS = [1, 2, 3, 5, 10, 15, 20, 50];

export interface LotPickerProps {
  lots: number;
  onChange: (lots: number) => void;
  /** Units per lot (scrip-master lot size). 1 = single units, no ×N display. */
  lotSize?: number;
  disabled?: boolean;
}

export function LotPicker({ lots, onChange, lotSize = 1, disabled = false }: LotPickerProps) {
  const [open, setOpen] = useState(false);
  const lotUnits = Math.max(1, lotSize);
  const totalUnits = lots * lotUnits;

  return (
    <div className="flex items-center gap-1">
      {/* − / display / + stepper */}
      <div className="flex items-center border border-border rounded overflow-hidden">
        <button
          type="button"
          onClick={() => onChange(Math.max(1, lots - 1))}
          className="px-1.5 py-1.5 hover:bg-muted transition-colors border-r border-border disabled:opacity-40"
          disabled={disabled || lots <= 1}
          title="One lot fewer"
        >
          <ChevronDown className="h-3 w-3" />
        </button>
        <span
          className="px-2 text-xs font-mono tabular-nums text-center"
          style={{ minWidth: lotUnits > 1 ? "72px" : "40px" }}
        >
          {lotUnits > 1 ? `${lots}×${lotUnits}=${totalUnits}` : String(totalUnits)}
        </span>
        <button
          type="button"
          onClick={() => onChange(lots + 1)}
          className="px-1.5 py-1.5 hover:bg-muted transition-colors border-l border-border disabled:opacity-40"
          disabled={disabled}
          title="One lot more"
        >
          <ChevronUp className="h-3 w-3" />
        </button>
      </div>

      {/* Presets popover */}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="p-1.5 rounded border border-border hover:bg-muted transition-colors text-muted-foreground disabled:opacity-40"
            title="Quantity presets"
            disabled={disabled}
          >
            <Settings2 className="h-3 w-3" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-52 p-3" align="start">
          <div className="space-y-2">
            <div className="text-xs font-medium">Quick Qty (lots)</div>
            <div className="flex gap-1 flex-wrap">
              {QTY_PRESETS.map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => { onChange(v); setOpen(false); }}
                  className={`px-2 py-1 text-xs rounded border transition-colors hover:bg-accent hover:text-accent-foreground ${lots === v ? "border-primary text-primary bg-primary/5" : "border-border"}`}
                >
                  {v}
                </button>
              ))}
            </div>
            {lotUnits > 1 && (
              <p className="text-[0.625rem] text-muted-foreground pt-1 border-t border-border">
                {lots} lot{lots > 1 ? "s" : ""} × {lotUnits} = <strong>{totalUnits}</strong> units
              </p>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

export default LotPicker;
