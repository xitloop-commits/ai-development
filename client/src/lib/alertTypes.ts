/**
 * Alert system types and settings.
 * Defines alert events, priorities, and user-configurable settings.
 */

export type AlertEventType =
  | 'go_signal'
  | 'stop_loss_hit'
  | 'target_profit_hit'
  | 'module_down'
  | 'new_signal'
  | 'position_opened'
  | 'position_closed';

export type AlertPriority = 'critical' | 'high' | 'medium' | 'low';

export interface AlertEvent {
  id: string;
  type: AlertEventType;
  priority: AlertPriority;
  title: string;
  message: string;
  instrument?: string;
  timestamp: number; // Unix ms
  dismissed: boolean;
}

export interface AlertSettings {
  notificationsEnabled: boolean;
  soundEnabled: boolean;
  soundVolume: number; // 0–100
  alertGoSignal: boolean;
  alertSlHit: boolean;
  alertTpHit: boolean;
  alertModuleDown: boolean;
  alertNewSignal: boolean;
  alertPositionChange: boolean;
  dndMode: boolean;
}

export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  notificationsEnabled: true,
  soundEnabled: true,
  soundVolume: 70,
  alertGoSignal: true,
  alertSlHit: true,
  alertTpHit: true,
  alertModuleDown: true,
  alertNewSignal: false,
  alertPositionChange: true,
  dndMode: false,
};

const STORAGE_KEY = 'ats_alert_settings';

export function loadAlertSettings(): AlertSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_ALERT_SETTINGS, ...parsed };
    }
  } catch {
    // Corrupt data — reset
  }
  return { ...DEFAULT_ALERT_SETTINGS };
}

export function saveAlertSettings(settings: AlertSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage full or unavailable
  }
}

/**
 * Map alert event type to its priority level.
 */
export function getAlertPriority(type: AlertEventType): AlertPriority {
  switch (type) {
    case 'go_signal':
    case 'stop_loss_hit':
      return 'critical';
    case 'target_profit_hit':
    case 'module_down':
      return 'high';
    case 'position_opened':
    case 'position_closed':
      return 'medium';
    case 'new_signal':
      return 'low';
  }
}

/**
 * Map alert event type to a human-readable label.
 */
export function getAlertLabel(type: AlertEventType): string {
  switch (type) {
    case 'go_signal': return 'GO Signal';
    case 'stop_loss_hit': return 'Stop Loss Hit';
    case 'target_profit_hit': return 'Target Profit Hit';
    case 'module_down': return 'Module Down';
    case 'new_signal': return 'New Signal';
    case 'position_opened': return 'Position Opened';
    case 'position_closed': return 'Position Closed';
  }
}

/**
 * Map alert event type to a color class for the Terminal Noir theme.
 */
export function getAlertColor(type: AlertEventType): string {
  switch (type) {
    case 'go_signal':
    case 'target_profit_hit':
      return 'text-bullish';
    case 'stop_loss_hit':
    case 'module_down':
      return 'text-destructive';
    case 'new_signal':
      return 'text-info-cyan';
    case 'position_opened':
    case 'position_closed':
      return 'text-warning-amber';
  }
}

/**
 * Map alert event type to a border glow class.
 */
export function getAlertGlow(type: AlertEventType): string {
  switch (type) {
    case 'go_signal':
    case 'target_profit_hit':
      return 'border-bullish/40';
    case 'stop_loss_hit':
    case 'module_down':
      return 'border-destructive/40';
    case 'new_signal':
      return 'border-info-cyan/40';
    case 'position_opened':
    case 'position_closed':
      return 'border-warning-amber/40';
  }
}

let alertIdCounter = 0;

export function generateAlertId(): string {
  alertIdCounter++;
  return `alert-${Date.now()}-${alertIdCounter}`;
}
