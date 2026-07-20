/**
 * Drawer pinning — persisted across reloads.
 *
 * A pinned drawer reopens on the next load; an unpinned one starts closed so the
 * chart and desk get the full width. Pinning is a PREFERENCE, so it survives;
 * open/closed is SESSION state, so a drawer you toggle shut this session doesn't
 * silently unpin itself.
 *
 * localStorage rather than the server: this is per-machine screen layout, and it
 * has to be readable synchronously during the first render or the drawers would
 * flash open then closed.
 */
import { useCallback, useState } from "react";

export type DrawerSide = "left" | "right";

const keyFor = (side: DrawerSide) => `lubas.drawer.${side}.pinned`;

/** Read the persisted pin. Defaults to false (closed) and never throws — a
 *  browser with storage disabled just gets the unpinned default. */
export function readPinned(side: DrawerSide): boolean {
  try {
    return localStorage.getItem(keyFor(side)) === "1";
  } catch {
    return false;
  }
}

/**
 * Pin state for one drawer, plus the initial visibility it implies.
 *
 * `pinned` is persisted; the caller owns `visible` so the AppBar toggle can still
 * open/close within a session without touching the pin.
 */
export function useDrawerPin(side: DrawerSide): {
  pinned: boolean;
  togglePin: () => void;
} {
  const [pinned, setPinned] = useState(() => readPinned(side));

  const togglePin = useCallback(() => {
    setPinned((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(keyFor(side), next ? "1" : "0");
      } catch {
        /* storage unavailable — the pin just won't survive a reload */
      }
      return next;
    });
  }, [side]);

  return { pinned, togglePin };
}
