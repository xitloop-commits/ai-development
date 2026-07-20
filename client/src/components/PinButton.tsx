/**
 * Pin toggle for a drawer header. Pinned = the drawer reopens on next load.
 * Shared by both drawers so they look and behave identically.
 */
import { Pin, PinOff } from 'lucide-react';

export function PinButton({ pinned, onToggle }: { pinned: boolean; onToggle: () => void }) {
  const Icon = pinned ? Pin : PinOff;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={pinned}
      aria-label={pinned ? 'Unpin drawer' : 'Pin drawer open'}
      title={pinned ? 'Pinned — reopens on next load. Click to unpin.' : 'Pin open — reopens on next load.'}
      className={`shrink-0 px-2 flex items-center transition-colors ${
        pinned ? 'text-info-cyan' : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      <Icon className="h-3 w-3" />
    </button>
  );
}
