/**
 * MovableWindow — a lightweight draggable floating panel.
 *
 * Fixed-position, drag by the title bar, with a close button. Position is kept
 * in local state (clamped to the viewport). Intentionally dependency-free —
 * pointer events only.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";

export interface MovableWindowProps {
  title: string;
  onClose?: () => void;
  /** Initial top-left position (px). Defaults to a sensible offset. */
  initial?: { x: number; y: number };
  /** Optional fixed width (px). */
  width?: number;
  children: ReactNode;
}

export function MovableWindow({ title, onClose, initial, width = 560, children }: MovableWindowProps) {
  const [pos, setPos] = useState(() => initial ?? { x: Math.max(16, window.innerWidth - width - 32), y: 96 });
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  const onPointerMove = useCallback((e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const x = Math.min(Math.max(0, e.clientX - d.dx), window.innerWidth - 60);
    const y = Math.min(Math.max(0, e.clientY - d.dy), window.innerHeight - 24);
    setPos({ x, y });
  }, []);

  const onPointerUp = useCallback(() => {
    dragRef.current = null;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
  }, [onPointerMove]);

  const startDrag = (e: React.PointerEvent) => {
    dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  useEffect(
    () => () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    },
    [onPointerMove, onPointerUp],
  );

  return (
    <div
      className="fixed z-50 rounded-lg border border-border bg-card/95 shadow-2xl backdrop-blur-sm"
      style={{ left: pos.x, top: pos.y, width }}
      role="dialog"
      aria-label={title}
    >
      <div
        className="flex cursor-move items-center justify-between gap-2 rounded-t-lg border-b border-border bg-secondary px-3 py-1.5 select-none"
        onPointerDown={startDrag}
      >
        <span className="text-[0.6875rem] font-bold uppercase tracking-wider text-muted-foreground">{title}</span>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-destructive transition-colors"
            title="Close"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <div className="p-2">{children}</div>
    </div>
  );
}
