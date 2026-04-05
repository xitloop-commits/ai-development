/**
 * AlertContext — Global alert state management.
 * Manages notification permissions, alert settings, alert history,
 * and dispatches browser notifications + sounds.
 */
import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';
import {
  type AlertEvent,
  type AlertEventType,
  type AlertSettings,
  loadAlertSettings,
  saveAlertSettings,
  DEFAULT_ALERT_SETTINGS,
  getAlertPriority,
  getAlertLabel,
  generateAlertId,
} from '@/lib/alertTypes';
import { playAlertSound, unlockAudio, type AlertSoundType } from '@/lib/soundEngine';
import { toast } from 'sonner';

const MAX_ALERT_HISTORY = 50;

type NotificationPermission = 'default' | 'granted' | 'denied';

interface AlertContextValue {
  // Settings
  settings: AlertSettings;
  updateSettings: (partial: Partial<AlertSettings>) => void;
  resetSettings: () => void;

  // Notification permission
  notificationPermission: NotificationPermission;
  requestNotificationPermission: () => Promise<void>;

  // Alert history
  alerts: AlertEvent[];
  clearAlerts: () => void;
  dismissAlert: (id: string) => void;
  unreadCount: number;
  markAllRead: () => void;

  // Dispatch a new alert
  dispatchAlert: (type: AlertEventType, title: string, message: string, instrument?: string) => void;

  // Audio unlock state
  audioUnlocked: boolean;
}

const AlertContext = createContext<AlertContextValue | null>(null);

export function AlertProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AlertSettings>(loadAlertSettings);
  const [alerts, setAlerts] = useState<AlertEvent[]>([]);
  const [notificationPermission, setNotificationPermission] =
    useState<NotificationPermission>('default');
  const [audioUnlocked, setAudioUnlocked] = useState(false);
  const lastReadTimestamp = useRef<number>(Date.now());

  // Check notification permission on mount
  useEffect(() => {
    if (typeof Notification !== 'undefined') {
      setNotificationPermission(Notification.permission as NotificationPermission);
    }
  }, []);

  // Unlock audio on first user interaction
  useEffect(() => {
    const handleInteraction = () => {
      unlockAudio();
      setAudioUnlocked(true);
      document.removeEventListener('click', handleInteraction);
      document.removeEventListener('keydown', handleInteraction);
    };
    document.addEventListener('click', handleInteraction);
    document.addEventListener('keydown', handleInteraction);
    return () => {
      document.removeEventListener('click', handleInteraction);
      document.removeEventListener('keydown', handleInteraction);
    };
  }, []);

  // Persist settings whenever they change
  useEffect(() => {
    saveAlertSettings(settings);
  }, [settings]);

  const updateSettings = useCallback((partial: Partial<AlertSettings>) => {
    setSettings((prev) => ({ ...prev, ...partial }));
  }, []);

  const resetSettings = useCallback(() => {
    setSettings({ ...DEFAULT_ALERT_SETTINGS });
  }, []);

  const requestNotificationPermission = useCallback(async () => {
    if (typeof Notification === 'undefined') return;
    try {
      const result = await Notification.requestPermission();
      setNotificationPermission(result as NotificationPermission);
    } catch {
      // Permission request failed
    }
  }, []);

  const clearAlerts = useCallback(() => {
    setAlerts([]);
  }, []);

  const dismissAlert = useCallback((id: string) => {
    setAlerts((prev) =>
      prev.map((a) => (a.id === id ? { ...a, dismissed: true } : a)),
    );
  }, []);

  const markAllRead = useCallback(() => {
    lastReadTimestamp.current = Date.now();
    // Force re-render by updating alerts
    setAlerts((prev) => [...prev]);
  }, []);

  // Compute unread count
  const unreadCount = alerts.filter(
    (a) => !a.dismissed && a.timestamp > lastReadTimestamp.current,
  ).length;

  /**
   * Check if a specific alert type is enabled in settings.
   */
  const isAlertEnabled = useCallback(
    (type: AlertEventType): boolean => {
      if (settings.dndMode) return false;
      switch (type) {
        case 'go_signal':
          return settings.alertGoSignal;
        case 'stop_loss_hit':
          return settings.alertSlHit;
        case 'target_profit_hit':
          return settings.alertTpHit;
        case 'module_down':
          return settings.alertModuleDown;
        case 'new_signal':
          return settings.alertNewSignal;
        case 'position_opened':
        case 'position_closed':
          return settings.alertPositionChange;
      }
    },
    [settings],
  );

  /**
   * Map alert event type to sound type.
   */
  const getSoundType = (type: AlertEventType): AlertSoundType => {
    switch (type) {
      case 'go_signal':
        return 'go_signal';
      case 'stop_loss_hit':
        return 'stop_loss';
      case 'target_profit_hit':
        return 'target_profit';
      case 'module_down':
        return 'module_down';
      case 'new_signal':
        return 'new_signal';
      case 'position_opened':
      case 'position_closed':
        return 'position_change';
    }
  };

  /**
   * Dispatch a new alert — adds to history, plays sound, shows browser notification.
   */
  const dispatchAlert = useCallback(
    (type: AlertEventType, title: string, message: string, instrument?: string) => {
      if (!isAlertEnabled(type)) return;

      const alert: AlertEvent = {
        id: generateAlertId(),
        type,
        priority: getAlertPriority(type),
        title,
        message,
        instrument,
        timestamp: Date.now(),
        dismissed: false,
      };

      // Add to history
      setAlerts((prev) => {
        const next = [alert, ...prev];
        return next.slice(0, MAX_ALERT_HISTORY);
      });

      // Play sound
      if (settings.soundEnabled) {
        const soundType = getSoundType(type);
        playAlertSound(soundType, settings.soundVolume / 100);
      }

      // In-app toast popup (top-right, auto-dismiss with close button)
      const toastType = alert.priority === 'critical' ? 'error'
        : alert.priority === 'high' ? 'warning'
        : 'info';
      if (toastType === 'error') {
        toast.error(title, { description: message, duration: 10000 });
      } else if (toastType === 'warning') {
        toast.warning(title, { description: message, duration: 8000 });
      } else {
        toast.info(title, { description: message, duration: 6000 });
      }

      // Browser notification
      if (
        settings.notificationsEnabled &&
        typeof Notification !== 'undefined' &&
        Notification.permission === 'granted'
      ) {
        try {
          const label = getAlertLabel(type);
          const notif = new Notification(`ATS: ${label}`, {
            body: `${title}\n${message}`,
            icon: '/favicon.ico',
            tag: alert.id,
            requireInteraction: alert.priority === 'critical',
          });
          // Focus window when clicked
          notif.onclick = () => {
            window.focus();
            notif.close();
          };
          // Auto-close non-critical after 8 seconds
          if (alert.priority !== 'critical') {
            setTimeout(() => notif.close(), 8000);
          }
        } catch {
          // Notification creation failed
        }
      }
    },
    [isAlertEnabled, settings.soundEnabled, settings.soundVolume, settings.notificationsEnabled],
  );

  return (
    <AlertContext.Provider
      value={{
        settings,
        updateSettings,
        resetSettings,
        notificationPermission,
        requestNotificationPermission,
        alerts,
        clearAlerts,
        dismissAlert,
        unreadCount,
        markAllRead,
        dispatchAlert,
        audioUnlocked,
      }}
    >
      {children}
    </AlertContext.Provider>
  );
}

export function useAlerts(): AlertContextValue {
  const ctx = useContext(AlertContext);
  if (!ctx) {
    throw new Error('useAlerts must be used within an AlertProvider');
  }
  return ctx;
}
