/**
 * InfoDot — a small "i" icon whose explanation appears on hover, floating, with
 * ZERO layout cost.
 *
 * The config menus (AI, My Trades, Settings) were carrying a lot of always-on
 * descriptive prose under their section labels. It was useful the first few
 * times and pure clutter after, and on a dense trading screen the vertical space
 * it cost was real. Moving that text behind this icon reclaims the room while
 * keeping the explanation one hover away.
 *
 * Uses the app-wide Radix TooltipProvider (mounted in App.tsx), so the content
 * floats above the layout instead of pushing siblings down — the whole point.
 * Conditional WARNINGS (a setting that is currently misconfigured) should stay
 * inline; this is for static "what this does" copy.
 */
import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function InfoDot({ text, className = "" }: { text: string; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="More information"
          onClick={(e) => e.stopPropagation()}
          className={`shrink-0 text-muted-foreground/60 hover:text-info-cyan transition-colors ${className}`}
        >
          <Info className="h-3 w-3" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[15rem] text-[0.625rem] leading-snug">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}
