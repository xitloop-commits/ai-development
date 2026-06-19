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
  /** Initial placement when no explicit `initial` is given. "bottom-center"
   *  centres the window horizontally and pins it just above the bottom bar
   *  (until the user drags it). */
  placement?: "default" | "bottom-center";
  /** Gap (px) above the bottom of the viewport for "bottom-center" placement —
   *  sized to clear the sticky MainFooter. */
  bottomGap?: number;
  /** Optional fixed width (px). */
  width?: number;
  children: ReactNode;
}

export function MovableWindow({ title, onClose, initial, placement = "default", bottomGap = 56, width = 560, children }: MovableWindowProps) {
  // `pos` is null until the window has an explicit px position: for
  // "bottom-center" we keep it null and anchor via CSS (bottom + centre) so the
  // window stays put above the footer even as its height changes — once the user
  // drags it, we freeze it to px coordinates.
  const [pos, setPos] = useState<{ x: number; y: number } | null>(
    () => initial ?? (placement === "bottom-center" ? null : { x: Math.max(16, window.innerWidth - width - 32), y: 96 }),
  );
  const winRef = useRef<HTMLDivElement>(null);
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
    // Anchor the drag to the window's current on-screen rect — works whether it
    // was px-positioned or still CSS-anchored (bottom-center, pos === null).
    const rect = winRef.current?.getBoundingClientRect();
    const curX = pos?.x ?? rect?.left ?? 0;
    const curY = pos?.y ?? rect?.top ?? 0;
    if (pos == null) setPos({ x: curX, y: curY }); // freeze to px so dragging works
    dragRef.current = { dx: e.clientX - curX, dy: e.clientY - curY };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  // Style: explicit px once positioned/dragged; otherwise CSS-anchored bottom-centre.
  const anchorStyle: React.CSSProperties =
    pos != null
      ? { left: pos.x, top: pos.y, width }
      : { left: "50%", bottom: bottomGap, transform: "translateX(-50%)", width };

  useEffect(
    () => () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    },
    [onPointerMove, onPointerUp],
  );

  return (
    <div
      ref={winRef}
      className="fixed z-50 rounded-lg border border-border bg-card/95 shadow-2xl backdrop-blur-sm"
      style={anchorStyle}
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
