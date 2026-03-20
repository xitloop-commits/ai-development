/**
 * AlertSettingsPanel — Alert configuration UI for the Control Panel.
 * Toggles for notification types, volume slider, DND mode.
 * Terminal Noir styling consistent with ControlPanel.
 */
import { Switch } from '@/components/ui/switch';
import { useAlerts } from '@/contexts/AlertContext';
import {
  Bell,
  BellOff,
  Volume2,
  VolumeX,
  Zap,
  ShieldAlert,
  Target,
  AlertTriangle,
  Radio,
  ArrowUpDown,
  Moon,
} from 'lucide-react';

export default function AlertSettingsPanel() {
  const {
    settings,
    updateSettings,
    notificationPermission,
    requestNotificationPermission,
  } = useAlerts();

  const isDndActive = settings.dndMode;

  return (
    <div className="space-y-3">
      {/* Section Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Bell className="h-3 w-3 text-info-cyan" />
          <span className="text-[9px] font-bold text-info-cyan tracking-wider uppercase">
            Alerts & Notifications
          </span>
        </div>
      </div>

      {/* DND Toggle */}
      <div className={`rounded p-2.5 transition-colors ${
        isDndActive
          ? 'bg-warning-amber/10 border border-warning-amber/30'
          : 'bg-secondary/30'
      }`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <Moon className={`h-3 w-3 ${isDndActive ? 'text-warning-amber' : 'text-muted-foreground'}`} />
            <span className="text-[10px] font-bold tracking-wider uppercase text-foreground">
              Do Not Disturb
            </span>
          </div>
          <Switch
            checked={isDndActive}
            onCheckedChange={(checked) => updateSettings({ dndMode: checked })}
          />
        </div>
        {isDndActive && (
          <p className="text-[9px] text-warning-amber mt-1.5">
            All alerts suppressed
          </p>
        )}
      </div>

      {/* Browser Notifications */}
      <div className="bg-secondary/30 rounded p-2.5">
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-1.5">
            {settings.notificationsEnabled ? (
              <Bell className="h-3 w-3 text-bullish" />
            ) : (
              <BellOff className="h-3 w-3 text-muted-foreground" />
            )}
            <span className="text-[10px] text-foreground">Browser Notifications</span>
          </div>
          <Switch
            checked={settings.notificationsEnabled}
            onCheckedChange={(checked) => updateSettings({ notificationsEnabled: checked })}
          />
        </div>
        {notificationPermission === 'default' && settings.notificationsEnabled && (
          <button
            onClick={requestNotificationPermission}
            className="w-full mt-1 text-[9px] bg-info-cyan/10 text-info-cyan border border-info-cyan/30 rounded px-2 py-1 hover:bg-info-cyan/20 transition-colors tracking-wider uppercase"
          >
            Grant Permission
          </button>
        )}
        {notificationPermission === 'denied' && (
          <p className="text-[9px] text-destructive mt-1">
            Blocked — enable in browser settings
          </p>
        )}
      </div>

      {/* Sound Controls */}
      <div className="bg-secondary/30 rounded p-2.5">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5">
            {settings.soundEnabled ? (
              <Volume2 className="h-3 w-3 text-bullish" />
            ) : (
              <VolumeX className="h-3 w-3 text-muted-foreground" />
            )}
            <span className="text-[10px] text-foreground">Sound Alerts</span>
          </div>
          <Switch
            checked={settings.soundEnabled}
            onCheckedChange={(checked) => updateSettings({ soundEnabled: checked })}
          />
        </div>
        {settings.soundEnabled && (
          <div className="flex items-center gap-2">
            <VolumeX className="h-3 w-3 text-muted-foreground shrink-0" />
            <input
              type="range"
              min={0}
              max={100}
              value={settings.soundVolume}
              onChange={(e) => updateSettings({ soundVolume: Number(e.target.value) })}
              className="w-full h-1 bg-border rounded-full appearance-none cursor-pointer accent-info-cyan"
            />
            <Volume2 className="h-3 w-3 text-muted-foreground shrink-0" />
            <span className="text-[9px] tabular-nums text-muted-foreground w-7 text-right">
              {settings.soundVolume}%
            </span>
          </div>
        )}
      </div>

      {/* Alert Type Toggles */}
      <div className="space-y-1.5">
        <span className="text-[9px] font-bold text-muted-foreground tracking-wider uppercase">
          Alert Types
        </span>

        <AlertToggleRow
          icon={<Zap className="h-3 w-3 text-bullish" />}
          label="GO Signals"
          sublabel="Critical"
          checked={settings.alertGoSignal}
          onChange={(v) => updateSettings({ alertGoSignal: v })}
        />
        <AlertToggleRow
          icon={<ShieldAlert className="h-3 w-3 text-destructive" />}
          label="Stop Loss Hit"
          sublabel="Critical"
          checked={settings.alertSlHit}
          onChange={(v) => updateSettings({ alertSlHit: v })}
        />
        <AlertToggleRow
          icon={<Target className="h-3 w-3 text-bullish" />}
          label="Target Profit"
          sublabel="High"
          checked={settings.alertTpHit}
          onChange={(v) => updateSettings({ alertTpHit: v })}
        />
        <AlertToggleRow
          icon={<AlertTriangle className="h-3 w-3 text-destructive" />}
          label="Module Down"
          sublabel="High"
          checked={settings.alertModuleDown}
          onChange={(v) => updateSettings({ alertModuleDown: v })}
        />
        <AlertToggleRow
          icon={<Radio className="h-3 w-3 text-info-cyan" />}
          label="New Signals"
          sublabel="Low"
          checked={settings.alertNewSignal}
          onChange={(v) => updateSettings({ alertNewSignal: v })}
        />
        <AlertToggleRow
          icon={<ArrowUpDown className="h-3 w-3 text-warning-amber" />}
          label="Position Changes"
          sublabel="Medium"
          checked={settings.alertPositionChange}
          onChange={(v) => updateSettings({ alertPositionChange: v })}
        />
      </div>
    </div>
  );
}

function AlertToggleRow({
  icon,
  label,
  sublabel,
  checked,
  onChange,
}: {
  icon: React.ReactNode;
  label: string;
  sublabel: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <div className="flex items-center gap-1.5">
        {icon}
        <span className="text-[10px] text-foreground">{label}</span>
        <span className="text-[8px] text-muted-foreground px-1 py-0.5 bg-secondary rounded">
          {sublabel}
        </span>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onChange}
      />
    </div>
  );
}
