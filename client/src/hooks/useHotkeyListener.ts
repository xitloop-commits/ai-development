import { useEffect, useCallback } from 'react';

export interface HotkeyAction {
  instrumentKey: string;
  instrumentName: string;
  hotkey: string;
}

interface HotkeyMap {
  [hotkey: string]: HotkeyAction;
}

export function useHotkeyListener(hotkeyMap: HotkeyMap, onHotkey: (action: HotkeyAction) => void) {
  const handleKeyPress = useCallback((event: KeyboardEvent) => {
    const key = event.key.toLowerCase();

    // Skip if modifier keys are pressed
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
      return;
    }

    // Skip if in an input/textarea field
    const target = event.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') {
      return;
    }

    if (hotkeyMap[key]) {
      if (import.meta.env.DEV) console.log('[Hotkey] Triggered:', key, hotkeyMap[key]);
      event.preventDefault();
      onHotkey(hotkeyMap[key]);
    }
  }, [hotkeyMap, onHotkey]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, [handleKeyPress]);
}
