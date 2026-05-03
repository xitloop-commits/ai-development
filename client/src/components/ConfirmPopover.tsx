/**
 * Anchor-positioned confirm dialog. Drops below the trigger element
 * without blocking the rest of the UI — used by ChannelTabs +
 * ChannelModeToggle for the (frequent) channel-switch confirms where a
 * fullscreen ConfirmDialog feels heavy.
 *
 * Extracted from AppBar.tsx during UI-119 so ChannelTabs can live in
 * its own file with its own test surface.
 */
import { useEffect } from 'react';

export interface ConfirmPopoverProps {
  open: boolean;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  anchor?: 'left' | 'center' | 'right';
}

export function ConfirmPopover({
  open,
  message,
  onConfirm,
  onCancel,
  anchor = 'center',
}: ConfirmPopoverProps) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onCancel]);

  if (!open) return null;

  const positionClass =
    anchor === 'left'   ? 'left-0' :
    anchor === 'right'  ? 'right-0' :
                          'left-1/2 -translate-x-1/2';

  return (
    <div
      className={`absolute top-full mt-1 ${positionClass} z-50 bg-card border border-border rounded-md shadow-xl p-3 min-w-[260px] max-w-sm`}
      onClick={(e) => e.stopPropagation()}
    >
      <p className="text-[0.6875rem] text-foreground mb-2 leading-snug">{message}</p>
      <div className="flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="px-2.5 py-1 rounded text-[0.625rem] font-medium bg-secondary text-muted-foreground hover:text-foreground transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          className="px-2.5 py-1 rounded text-[0.625rem] font-bold bg-primary/20 text-primary hover:bg-primary/30 transition-colors"
        >
          Confirm
        </button>
      </div>
    </div>
  );
}