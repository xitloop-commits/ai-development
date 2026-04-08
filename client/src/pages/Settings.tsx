/**
 * Settings Page — Feature 4: Settings Foundation (Spec v1.2)
 * Terminal Noir themed settings page with sidebar navigation and 6 sections:
 * 1. Broker Config
 * 2. Order Execution (+ daily target, trailing stop)
 * 3. Discipline (new backend: trpc.discipline.getSettings/updateSettings)
 * 4. Time Windows (with enabled toggles)
 * 5. Expiry Controls
 * 6. Charges
 */
import { useState, useEffect, useMemo } from 'react';
import { useAuth } from '@/_core/hooks/useAuth';
import { getLoginUrl } from '@/const';
import { trpc } from '@/lib/trpc';
import { useCapital } from '@/contexts/CapitalContext';
import { Link } from 'wouter';
import { toast } from 'sonner';
import {
  ArrowLeft,
  Settings as SettingsIcon,
  Wallet,
  ShieldCheck,
  Clock,
  CalendarClock,
  Receipt,
  Zap,
  Save,
  RotateCcw,
  ChevronRight,
  Wifi,
  WifiOff,
  Key,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Info,
  Loader2,
  Landmark,
} from 'lucide-react';
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';

// ─── Types ───────────────────────────────────────────────────────

type SettingsSection =
  | 'broker'
  | 'execution'
  | 'discipline'
  | 'timeWindows'
  | 'expiry'
  | 'charges'
  | 'capital'
  | 'instruments';

interface SectionItem {
  id: SettingsSection;
  label: string;
  icon: React.ElementType;
  description: string;
}

const SECTIONS: SectionItem[] = [
  { id: 'instruments', label: 'Instruments', icon: SettingsIcon, description: 'Configure tradable instruments' },
  { id: 'broker', label: 'Broker Config', icon: Wallet, description: 'Active broker, credentials, connection status' },
  { id: 'execution', label: 'Order Execution', icon: Zap, description: 'Entry offset, SL/TP, targets, trailing stop' },
  { id: 'discipline', label: 'Discipline', icon: ShieldCheck, description: 'Circuit breaker, trade limits, pre-trade gate, streaks' },
  { id: 'timeWindows', label: 'Time Windows', icon: Clock, description: 'NSE & MCX trading time restrictions' },
  { id: 'expiry', label: 'Expiry Controls', icon: CalendarClock, description: 'Per-instrument expiry day rules' },
  { id: 'charges', label: 'Charges', icon: Receipt, description: 'Brokerage, STT, GST, and other charge rates' },
  { id: 'capital', label: 'Capital Management', icon: Landmark, description: 'Reset initial capital, pool allocation' },
];

// ─── Helper Components ───────────────────────────────────────────

function FieldLabel({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <label className="text-[11px] font-bold tracking-wider uppercase text-muted-foreground">
        {children}
      </label>
      {hint && (
        <span className="text-[9px] text-muted-foreground/70">{hint}</span>
      )}
    </div>
  );
}

function SettingsCard({ title, children, className = '' }: { title?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`border border-border rounded-md bg-card p-4 ${className}`}>
      {title && (
        <h3 className="text-[11px] font-bold tracking-wider uppercase text-muted-foreground mb-3 pb-2 border-b border-border">
          {title}
        </h3>
      )}
      {children}
    </div>
  );
}

function ToggleSwitch({ checked, onChange, disabled = false }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        checked
          ? 'bg-primary border-primary'
          : 'bg-muted border-border'
      } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <span
        className={`pointer-events-none block h-3.5 w-3.5 rounded-full bg-background shadow-sm transition-transform ${
          checked ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix = '',
  className = '',
  disabled = false,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <div className={`flex items-center gap-1.5 ${className}`}>
      <input
        type="number"
        value={value}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (!isNaN(v)) {
            if (min !== undefined && v < min) return;
            if (max !== undefined && v > max) return;
            onChange(v);
          }
        }}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        className="w-20 h-8 px-2 text-[11px] bg-background border border-border rounded text-foreground tabular-nums focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed"
      />
      {suffix && (
        <span className="text-[10px] text-muted-foreground">{suffix}</span>
      )}
    </div>
  );
}

function SelectInput({
  value,
  onChange,
  options,
  disabled = false,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className="h-8 px-2 text-[11px] bg-background border border-border rounded text-foreground focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

function TimeInput({ value, onChange, disabled = false }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <input
      type="time"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className="h-8 px-2 text-[11px] bg-background border border-border rounded text-foreground focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed"
    />
  );
}

function StatusBadge({ status, label }: { status: 'connected' | 'disconnected' | 'error' | 'valid' | 'expired' | 'unknown'; label: string }) {
  const colors: Record<string, string> = {
    connected: 'bg-bullish/10 text-bullish border-bullish/20',
    valid: 'bg-bullish/10 text-bullish border-bullish/20',
    disconnected: 'bg-muted text-muted-foreground border-border',
    error: 'bg-destructive/10 text-destructive border-destructive/20',
    expired: 'bg-destructive/10 text-destructive border-destructive/20',
    unknown: 'bg-warning-amber/10 text-warning-amber border-warning-amber/20',
  };
  const dotColors: Record<string, string> = {
    connected: 'bg-bullish',
    valid: 'bg-bullish',
    disconnected: 'bg-muted-foreground',
    error: 'bg-destructive',
    expired: 'bg-destructive',
    unknown: 'bg-warning-amber',
  };
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[9px] font-bold tracking-wider border ${colors[status] ?? colors.unknown}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dotColors[status] ?? dotColors.unknown} ${status === 'connected' || status === 'valid' ? 'animate-pulse-glow' : ''}`} />
      {label}
    </span>
  );
}

function SaveButton({ onClick, loading, disabled }: { onClick: () => void; loading: boolean; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={loading || disabled}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[10px] font-bold tracking-wider uppercase bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
      {loading ? 'SAVING...' : 'SAVE'}
    </button>
  );
}

function ResetButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[10px] font-bold tracking-wider uppercase border border-border text-muted-foreground hover:bg-accent transition-colors"
    >
      <RotateCcw className="h-3 w-3" />
      RESET
    </button>
  );
}

/** Discipline rule row with enabled toggle + configurable value */
function DisciplineRow({
  label,
  hint,
  enabled,
  onToggle,
  children,
}: {
  label: string;
  hint: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  children?: React.ReactNode;
}) {
  return (
    <div className={`space-y-2 ${!enabled ? 'opacity-60' : ''}`}>
      <div className="flex items-center justify-between">
        <FieldLabel hint={hint}>{label}</FieldLabel>
        <ToggleSwitch checked={enabled} onChange={onToggle} />
      </div>
      {enabled && children && (
        <div className="pl-4 border-l-2 border-primary/20 space-y-3">
          {children}
        </div>
      )}
    </div>
  );
}

// ─── Section Components ──────────────────────────────────────────

export function BrokerConfigSection() {
  const configQuery = trpc.broker.config.get.useQuery();
  const allConfigsQuery = trpc.broker.config.list.useQuery();
  const adaptersQuery = trpc.broker.adapters.list.useQuery();
  const statusQuery = trpc.broker.status.useQuery();
  const tokenQuery = trpc.broker.token.status.useQuery();
  const switchMutation = trpc.broker.config.switchBroker.useMutation({
    onSuccess: () => {
      toast.success('Broker switched successfully');
      configQuery.refetch();
      allConfigsQuery.refetch();
      statusQuery.refetch();
    },
    onError: (err) => toast.error(err.message),
  });
  const setupMutation = trpc.broker.setup.useMutation({
    onSuccess: () => {
      toast.success('Broker configured and connected');
      configQuery.refetch();
      allConfigsQuery.refetch();
      statusQuery.refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  const [tokenInput, setTokenInput] = useState('');
  const tokenMutation = trpc.broker.token.update.useMutation({
    onSuccess: () => {
      toast.success('Token updated successfully');
      setTokenInput('');
      tokenQuery.refetch();
      configQuery.refetch();
      statusQuery.refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  const config = configQuery.data;
  const allConfigs = allConfigsQuery.data ?? [];
  const adapters = adaptersQuery.data ?? [];
  const status = statusQuery.data;
  const token = tokenQuery.data;

  // Use registered adapters for dropdown (always populated), fall back to DB configs
  const brokerOptions = adapters.length > 0
    ? adapters.map((a) => ({ value: a.brokerId, label: a.displayName }))
    : allConfigs.map((c) => ({ value: c.brokerId, label: c.displayName }));

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
      {/* Active Broker */}
      <SettingsCard title="Active Broker">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <FieldLabel hint="Select the broker to use for trading">Active Broker</FieldLabel>
            <SelectInput
              value={status?.activeBrokerId ?? ''}
              onChange={(v) => {
                const hasConfig = allConfigs.some((c) => c.brokerId === v);
                if (hasConfig) {
                  switchMutation.mutate({ brokerId: v });
                } else {
                  setupMutation.mutate({ brokerId: v });
                }
              }}
              options={brokerOptions}
            />
          </div>
          {config && (
            <div className="flex items-center gap-3 flex-wrap">
              <StatusBadge
                status={config.isPaperBroker ? 'connected' : (status?.apiStatus ?? 'disconnected')}
                label={config.isPaperBroker ? 'PAPER MODE' : (status?.apiStatus?.toUpperCase() ?? 'DISCONNECTED')}
              />
              {!config.isPaperBroker && (
                <>
                  <StatusBadge
                    status={status?.wsStatus ?? 'disconnected'}
                    label={`WS: ${status?.wsStatus?.toUpperCase() ?? 'DISCONNECTED'}`}
                  />
                  <StatusBadge
                    status={status?.tokenStatus ?? 'unknown'}
                    label={`TOKEN: ${status?.tokenStatus?.toUpperCase() ?? 'UNKNOWN'}`}
                  />
                </>
              )}
              {status?.killSwitchActive && (
                <StatusBadge status="error" label="KILL SWITCH ACTIVE" />
              )}
            </div>
          )}
        </div>
      </SettingsCard>

      {/* Credentials */}
      <SettingsCard title="Credentials">
        {config ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <FieldLabel>Client ID</FieldLabel>
              {config.credentials.clientId ? (
                <span className="text-[11px] text-foreground tabular-nums">
                  {config.credentials.clientId}
                </span>
              ) : (
                <span className="text-[11px] text-loss-red">
                  Not set — enter below
                </span>
              )}
            </div>
            <div className="flex items-center justify-between">
              <FieldLabel>Access Token</FieldLabel>
              <span className="text-[11px] text-foreground tabular-nums">
                {config.credentials.accessToken || '—'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <FieldLabel>Token Status</FieldLabel>
              <StatusBadge
                status={status?.tokenStatus ?? config.credentials.status}
                label={(status?.tokenStatus ?? config.credentials.status).toUpperCase()}
              />
            </div>
            {config.credentials.updatedAt > 0 && (
              <div className="flex items-center justify-between">
                <FieldLabel>Last Updated</FieldLabel>
                <span className="text-[10px] text-muted-foreground">
                  {new Date(config.credentials.updatedAt).toLocaleString('en-IN')}
                </span>
              </div>
            )}
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">No broker configured</p>
        )}
      </SettingsCard>

      {/* Token Update */}
      {config && !config.isPaperBroker && (
        <SettingsCard title="Update Token">
          <div className="space-y-3">
            <div className="flex items-center gap-2 p-2 rounded bg-warning-amber/5 border border-warning-amber/20">
              <AlertTriangle className="h-3.5 w-3.5 text-warning-amber shrink-0" />
              <span className="text-[10px] text-warning-amber">
                Paste a new access token from your Dhan dashboard. Tokens expire every 24 hours.
              </span>
            </div>
            <div className="flex gap-2">
              <input
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="Paste new access token..."
                className="flex-1 h-8 px-3 text-[11px] bg-background border border-border rounded text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <button
                onClick={() => {
                  if (!tokenInput.trim()) {
                    toast.error('Access token is required');
                    return;
                  }
                  tokenMutation.mutate({
                    token: tokenInput.trim(),
                    clientId: config.credentials.clientId,
                  });
                }}
                disabled={!tokenInput.trim() || tokenMutation.isPending}
                className="flex items-center gap-1.5 px-3 h-8 rounded text-[10px] font-bold tracking-wider uppercase bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                {tokenMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Key className="h-3 w-3" />}
                UPDATE
              </button>
            </div>
          </div>
        </SettingsCard>
      )}

      {/* Connection Details */}
      {config && !config.isPaperBroker && (
        <SettingsCard title="Connection Details">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <FieldLabel>API Status</FieldLabel>
              <StatusBadge status={config.connection.apiStatus} label={config.connection.apiStatus.toUpperCase()} />
            </div>
            <div className="flex items-center justify-between">
              <FieldLabel>WebSocket Status</FieldLabel>
              <StatusBadge status={config.connection.wsStatus} label={config.connection.wsStatus.toUpperCase()} />
            </div>
            {config.connection.latencyMs !== null && (
              <div className="flex items-center justify-between">
                <FieldLabel>API Latency</FieldLabel>
                <span className="text-[11px] text-foreground tabular-nums">{config.connection.latencyMs}ms</span>
              </div>
            )}
            {config.connection.lastApiCall && (
              <div className="flex items-center justify-between">
                <FieldLabel>Last API Call</FieldLabel>
                <span className="text-[10px] text-muted-foreground">
                  {new Date(config.connection.lastApiCall).toLocaleString('en-IN')}
                </span>
              </div>
            )}
          </div>
        </SettingsCard>
      )}

      {/* Capabilities */}
      {config && (
        <SettingsCard title="Capabilities">
          <div className="grid grid-cols-2 gap-2">
            {Object.entries(config.capabilities).map(([key, val]) => (
              <div key={key} className="flex items-center gap-2">
                {val ? (
                  <CheckCircle2 className="h-3 w-3 text-bullish" />
                ) : (
                  <XCircle className="h-3 w-3 text-muted-foreground" />
                )}
                <span className="text-[10px] text-foreground uppercase tracking-wider">
                  {key.replace(/([A-Z])/g, ' $1').trim()}
                </span>
              </div>
            ))}
          </div>
        </SettingsCard>
      )}
    </div>
  );
}

export function OrderExecutionSection() {
  const configQuery = trpc.broker.config.get.useQuery();
  const config = configQuery.data;

  const [settings, setSettings] = useState({
    orderEntryOffset: 1.0,
    defaultSL: 2.0,
    defaultTP: 5.0,
    orderType: 'LIMIT' as string,
    productType: 'INTRADAY' as string,
    // Daily target
    dailyTargetPercent: 5,
    // Per-instrument trade targets
    tradeTargetOptions: 30,
    tradeTargetOther: 2,
    // Trailing stop (moved from Discipline per spec v1.2)
    trailingStopEnabled: false,
    trailingStopPercent: 1.5,
  });

  useEffect(() => {
    if (config?.settings) {
      setSettings((prev) => ({
        ...prev,
        orderEntryOffset: config.settings.orderEntryOffset,
        defaultSL: config.settings.defaultSL,
        defaultTP: config.settings.defaultTP,
        orderType: config.settings.orderType,
        productType: config.settings.productType,
        // These may not exist yet in broker config, use defaults
        dailyTargetPercent: (config.settings as any).dailyTargetPercent ?? prev.dailyTargetPercent,
        tradeTargetOptions: (config.settings as any).tradeTargetOptions ?? prev.tradeTargetOptions,
        tradeTargetOther: (config.settings as any).tradeTargetOther ?? prev.tradeTargetOther,
        trailingStopEnabled: (config.settings as any).trailingStopEnabled ?? prev.trailingStopEnabled,
        trailingStopPercent: (config.settings as any).trailingStopPercent ?? prev.trailingStopPercent,
      }));
    }
  }, [config]);

  const { syncDailyTarget, refetchAll } = useCapital();

  const updateMutation = trpc.broker.config.updateSettings.useMutation({
    onSuccess: () => {
      toast.success('Order execution settings saved');
      configQuery.refetch();
      // Immediately sync dailyTargetPercent to capital state + current day record
      syncDailyTarget(settings.dailyTargetPercent);
      refetchAll();
    },
    onError: (err) => toast.error(err.message),
  });

  const handleSave = () => {
    if (!config) return;
    updateMutation.mutate({
      brokerId: config.brokerId,
      settings: {
        orderEntryOffset: settings.orderEntryOffset,
        defaultSL: settings.defaultSL,
        defaultTP: settings.defaultTP,
        orderType: settings.orderType as any,
        productType: settings.productType as any,
        dailyTargetPercent: settings.dailyTargetPercent,
        tradeTargetOptions: settings.tradeTargetOptions,
        tradeTargetOther: settings.tradeTargetOther,
        trailingStopEnabled: settings.trailingStopEnabled,
        trailingStopPercent: settings.trailingStopPercent,
      } as any,
    });
  };

  const handleReset = () => {
    if (config?.settings) {
      setSettings({
        orderEntryOffset: config.settings.orderEntryOffset,
        defaultSL: config.settings.defaultSL,
        defaultTP: config.settings.defaultTP,
        orderType: config.settings.orderType,
        productType: config.settings.productType,
        dailyTargetPercent: (config.settings as any).dailyTargetPercent ?? 5,
        tradeTargetOptions: (config.settings as any).tradeTargetOptions ?? 30,
        tradeTargetOther: (config.settings as any).tradeTargetOther ?? 2,
        trailingStopEnabled: (config.settings as any).trailingStopEnabled ?? false,
        trailingStopPercent: (config.settings as any).trailingStopPercent ?? 1.5,
      });
    }
  };

  if (!config) {
    return (
      <SettingsCard>
        <p className="text-[11px] text-muted-foreground">No broker configured. Set up a broker first.</p>
      </SettingsCard>
    );
  }

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
      {/* Daily Target */}
      <SettingsCard title="Daily Target">
        <div className="space-y-1 mb-3">
          <span className="text-[10px] text-muted-foreground">
            Target profit per Day Index cycle on Trading Capital. Used by the capital compounding system.
          </span>
        </div>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <FieldLabel hint="Target profit % per Day Index cycle (default 5%)">
              Daily Target
            </FieldLabel>
            <NumberInput
              value={settings.dailyTargetPercent}
              onChange={(v) => setSettings((s) => ({ ...s, dailyTargetPercent: v }))}
              min={1}
              max={20}
              step={0.5}
              suffix="%"
            />
          </div>
        </div>
      </SettingsCard>

      {/* Order Entry */}
      <SettingsCard title="Order Entry">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <FieldLabel hint="Place limit orders at this % below current LTP">
              Entry Offset
            </FieldLabel>
            <NumberInput
              value={settings.orderEntryOffset}
              onChange={(v) => setSettings((s) => ({ ...s, orderEntryOffset: v }))}
              min={0}
              max={10}
              step={0.1}
              suffix="%"
            />
          </div>
          <div className="flex items-center justify-between">
            <FieldLabel hint="Default order type for new trades">
              Order Type
            </FieldLabel>
            <SelectInput
              value={settings.orderType}
              onChange={(v) => setSettings((s) => ({ ...s, orderType: v }))}
              options={[
                { value: 'LIMIT', label: 'LIMIT' },
                { value: 'MARKET', label: 'MARKET' },
                { value: 'SL', label: 'SL' },
                { value: 'SL-M', label: 'SL-M' },
              ]}
            />
          </div>
          <div className="flex items-center justify-between">
            <FieldLabel hint="Default product type for new trades">
              Product Type
            </FieldLabel>
            <SelectInput
              value={settings.productType}
              onChange={(v) => setSettings((s) => ({ ...s, productType: v }))}
              options={[
                { value: 'INTRADAY', label: 'INTRADAY' },
                { value: 'CNC', label: 'CNC' },
                { value: 'MARGIN', label: 'MARGIN' },
              ]}
            />
          </div>
        </div>
      </SettingsCard>

      {/* Risk Management */}
      <SettingsCard title="Risk Management">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <FieldLabel hint="Default stop loss percentage from entry price">
              Default Stop Loss
            </FieldLabel>
            <NumberInput
              value={settings.defaultSL}
              onChange={(v) => setSettings((s) => ({ ...s, defaultSL: v }))}
              min={0}
              max={50}
              step={0.5}
              suffix="%"
            />
          </div>
          <div className="flex items-center justify-between">
            <FieldLabel hint="Default per-trade target for Options">
              Trade Target (Options)
            </FieldLabel>
            <NumberInput
              value={settings.tradeTargetOptions}
              onChange={(v) => setSettings((s) => ({ ...s, tradeTargetOptions: v }))}
              min={5}
              max={100}
              step={1}
              suffix="%"
            />
          </div>
          <div className="flex items-center justify-between">
            <FieldLabel hint="Default per-trade target for Equities/Futures">
              Trade Target (Other)
            </FieldLabel>
            <NumberInput
              value={settings.tradeTargetOther}
              onChange={(v) => setSettings((s) => ({ ...s, tradeTargetOther: v }))}
              min={0.5}
              max={20}
              step={0.5}
              suffix="%"
            />
          </div>
        </div>
      </SettingsCard>

      {/* Trailing Stop */}
      <SettingsCard title="Trailing Stop">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <FieldLabel hint="Enable automatic trailing stop loss">
              Trailing Stop
            </FieldLabel>
            <ToggleSwitch
              checked={settings.trailingStopEnabled}
              onChange={(v) => setSettings((s) => ({ ...s, trailingStopEnabled: v }))}
            />
          </div>
          {settings.trailingStopEnabled && (
            <div className="flex items-center justify-between">
              <FieldLabel hint="Trailing SL distance from peak price">
                Trailing SL
              </FieldLabel>
              <NumberInput
                value={settings.trailingStopPercent}
                onChange={(v) => setSettings((s) => ({ ...s, trailingStopPercent: v }))}
                min={0.1}
                max={50}
                step={0.1}
                suffix="%"
              />
            </div>
          )}
        </div>
      </SettingsCard>

      <div className="col-span-full flex items-center gap-2 justify-end">
        <ResetButton onClick={handleReset} />
        <SaveButton onClick={handleSave} loading={updateMutation.isPending} />
      </div>

    </div>
  );
}

export function CapitalManagementSection() {
  const { capital, resetCapital, resetCapitalPending, refetchAll } = useCapital();
  const [resetOpen, setResetOpen] = useState(false);
  const [newFunding, setNewFunding] = useState(100000);
  const [confirmText, setConfirmText] = useState('');

  // Format number for display
  const fmt = (n: number) => {
    if (n >= 10000000) return `${(n / 10000000).toFixed(2)} Cr`;
    if (n >= 100000) return `${(n / 100000).toFixed(2)}L`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return n.toFixed(0);
  };

  // Reset is only allowed when no day cycle has started
  const hasCycleStarted = capital.currentDayIndex > 1;

  const handleReset = () => {
    if (confirmText !== 'RESET') return;
    resetCapital(newFunding);
    setResetOpen(false);
    setConfirmText('');
    toast.success(`Capital reset to ${fmt(newFunding)}. All day records cleared.`);
    setTimeout(() => refetchAll(), 500);
  };

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
      {/* Current Capital Overview */}
      <SettingsCard title="Current Capital" className="col-span-full">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-background border border-border rounded p-2.5 text-center">
            <div className="text-[9px] text-muted-foreground uppercase tracking-wider">Initial Funding</div>
            <div className="text-[13px] font-mono text-foreground mt-1 font-bold">{fmt(capital.initialFunding)}</div>
          </div>
          <div className="bg-background border border-border rounded p-2.5 text-center">
            <div className="text-[9px] text-muted-foreground uppercase tracking-wider">Trading Pool</div>
            <div className="text-[13px] font-mono text-primary mt-1 font-bold">{fmt(capital.tradingPool)}</div>
          </div>
          <div className="bg-background border border-border rounded p-2.5 text-center">
            <div className="text-[9px] text-muted-foreground uppercase tracking-wider">Reserve Pool</div>
            <div className="text-[13px] font-mono text-foreground mt-1 font-bold">{fmt(capital.reservePool)}</div>
          </div>
          <div className="bg-background border border-border rounded p-2.5 text-center">
            <div className="text-[9px] text-muted-foreground uppercase tracking-wider">Net Worth</div>
            <div className="text-[13px] font-mono text-foreground mt-1 font-bold">{fmt(capital.netWorth)}</div>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-3">
          <div className="bg-background border border-border rounded p-2.5 text-center">
            <div className="text-[9px] text-muted-foreground uppercase tracking-wider">Day Index</div>
            <div className="text-[13px] font-mono text-foreground mt-1 font-bold">{capital.currentDayIndex}</div>
          </div>
          <div className="bg-background border border-border rounded p-2.5 text-center">
            <div className="text-[9px] text-muted-foreground uppercase tracking-wider">Cumulative P&L</div>
            <div className={`text-[13px] font-mono mt-1 font-bold ${capital.cumulativePnl >= 0 ? 'text-bullish' : 'text-bearish'}`}>
              {capital.cumulativePnl >= 0 ? '+' : ''}{fmt(capital.cumulativePnl)}
            </div>
          </div>
          <div className="bg-background border border-border rounded p-2.5 text-center">
            <div className="text-[9px] text-muted-foreground uppercase tracking-wider">Total Charges</div>
            <div className="text-[13px] font-mono text-muted-foreground mt-1 font-bold">{fmt(capital.cumulativeCharges)}</div>
          </div>
        </div>
      </SettingsCard>

      {/* Pool Allocation Info */}
      <SettingsCard title="Pool Allocation">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground">Trading Pool share</span>
            <span className="text-[11px] font-mono text-foreground font-bold">75%</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground">Reserve Pool share</span>
            <span className="text-[11px] font-mono text-foreground font-bold">25%</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground">Daily Target</span>
            <span className="text-[11px] font-mono text-primary font-bold">{capital.targetPercent}%</span>
          </div>
        </div>
        <div className="mt-3 pt-2 border-t border-border">
          <span className="text-[9px] text-muted-foreground">
            New capital injections and profit distributions follow the 75/25 split.
            Losses are absorbed entirely by the Trading Pool.
          </span>
        </div>
      </SettingsCard>

      {/* Reset Initial Capital */}
      <SettingsCard title="Reset Initial Capital" className={hasCycleStarted ? 'opacity-60' : 'border-destructive/30'}>
        <div className="space-y-3">
          {hasCycleStarted ? (
            <div className="flex items-center gap-2 p-2 rounded bg-muted/50 border border-border">
              <Info className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="text-[10px] text-muted-foreground">
                Reset is only available before any day cycle has started.
                You are currently on Day {capital.currentDayIndex}.
              </span>
            </div>
          ) : (
            <>
              <div className="space-y-1">
                <span className="text-[10px] text-muted-foreground">
                  Reset all capital pools, day records, and projections back to Day 1.
                  This is a <span className="text-destructive font-bold">destructive</span> action and cannot be undone.
                </span>
              </div>

              {/* New initial funding input */}
              <div className="flex items-center justify-between">
                <FieldLabel hint="New initial capital amount for the fresh start">
                  New Initial Capital
                </FieldLabel>
                <NumberInput
                  value={newFunding}
                  onChange={setNewFunding}
                  min={10000}
                  max={100000000}
                  step={10000}
                  suffix="\u20B9"
                />
              </div>

              {/* Preview of what reset will create */}
              <div className="flex items-center gap-2 text-[9px] text-muted-foreground">
                <AlertTriangle className="h-3 w-3 text-warning-amber shrink-0" />
                <span>
                  After reset: Trading Pool = {fmt(newFunding * 0.75)}, Reserve Pool = {fmt(newFunding * 0.25)}, Day Index = 1
                </span>
              </div>

              {/* Reset button triggers confirmation dialog */}
              <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
                <AlertDialogTrigger asChild>
                  <button
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[10px] font-bold tracking-wider uppercase border border-destructive/40 text-destructive hover:bg-destructive/10 transition-colors"
                  >
                    <AlertTriangle className="h-3 w-3" />
                    RESET INITIAL CAPITAL
                  </button>
                </AlertDialogTrigger>
                <AlertDialogContent className="bg-card border-destructive/30">
                  <AlertDialogHeader>
                    <AlertDialogTitle className="text-destructive flex items-center gap-2 text-sm">
                      <AlertTriangle className="h-4 w-4" />
                      Reset Initial Capital
                    </AlertDialogTitle>
                    <AlertDialogDescription className="text-[11px] text-muted-foreground space-y-2">
                      <p>
                        This will permanently delete all day records, trade history, profit history,
                        and reset capital pools to a fresh state with <strong className="text-foreground">{fmt(newFunding)}</strong> initial funding.
                      </p>
                      <p>
                        Trading Pool will be set to <strong className="text-foreground">{fmt(newFunding * 0.75)}</strong> and
                        Reserve Pool to <strong className="text-foreground">{fmt(newFunding * 0.25)}</strong>.
                      </p>
                      <p className="text-destructive font-bold">
                        This action cannot be undone. Both live and paper workspaces will be reset.
                      </p>
                    </AlertDialogDescription>
                  </AlertDialogHeader>

                  {/* Type RESET to confirm */}
                  <div className="space-y-2">
                    <label className="text-[10px] font-bold tracking-wider uppercase text-muted-foreground">
                      Type <span className="text-destructive">RESET</span> to confirm
                    </label>
                    <input
                      type="text"
                      value={confirmText}
                      onChange={(e) => setConfirmText(e.target.value)}
                      placeholder="RESET"
                      className="w-full h-8 px-2 text-[11px] bg-background border border-border rounded text-foreground font-mono tracking-widest focus:outline-none focus:ring-1 focus:ring-destructive"
                      autoFocus
                    />
                  </div>

                  <AlertDialogFooter>
                    <AlertDialogCancel
                      onClick={() => setConfirmText('')}
                      className="text-[10px] h-8"
                    >
                      Cancel
                    </AlertDialogCancel>
                    <button
                      onClick={handleReset}
                      disabled={confirmText !== 'RESET' || resetCapitalPending}
                      className="flex items-center gap-1.5 px-4 py-1.5 rounded text-[10px] font-bold tracking-wider uppercase bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed h-8"
                    >
                      {resetCapitalPending ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <AlertTriangle className="h-3 w-3" />
                      )}
                      {resetCapitalPending ? 'RESETTING...' : 'CONFIRM RESET'}
                    </button>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          )}
        </div>
      </SettingsCard>
    </div>
  );
}

export function DisciplineSection() {
  // Use the NEW discipline backend (trpc.discipline.getSettings/updateSettings)
  const settingsQuery = trpc.discipline.getSettings.useQuery();
  const [ds, setDs] = useState<any>(null);

  useEffect(() => {
    if (settingsQuery.data) {
      setDs(JSON.parse(JSON.stringify(settingsQuery.data)));
    }
  }, [settingsQuery.data]);

  const updateMutation = trpc.discipline.updateSettings.useMutation({
    onSuccess: () => {
      toast.success('Discipline settings saved');
      settingsQuery.refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  const handleSave = () => {
    if (!ds) return;
    // Send only the settings fields, not userId/updatedAt/history
    const { userId, updatedAt, history, _id, __v, ...settingsOnly } = ds;
    updateMutation.mutate(settingsOnly);
  };

  const handleReset = () => {
    if (settingsQuery.data) {
      setDs(JSON.parse(JSON.stringify(settingsQuery.data)));
    }
  };

  if (!ds) {
    return (
      <SettingsCard>
        <div className="flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          <span className="text-[11px] text-muted-foreground">Loading discipline settings...</span>
        </div>
      </SettingsCard>
    );
  }

  // Helper to update nested discipline state
  const upd = (path: string, value: any) => {
    setDs((prev: any) => {
      const next = JSON.parse(JSON.stringify(prev));
      const parts = path.split('.');
      let obj = next;
      for (let i = 0; i < parts.length - 1; i++) {
        obj = obj[parts[i]];
      }
      obj[parts[parts.length - 1]] = value;
      return next;
    });
  };

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
      {/* Circuit Breaker */}
      <SettingsCard title="Circuit Breaker">
        <div className="space-y-4">
          <DisciplineRow
            label="Daily Loss Limit"
            hint="Stop all trading when daily loss reaches this % of capital"
            enabled={ds.dailyLossLimit?.enabled ?? true}
            onToggle={(v) => upd('dailyLossLimit.enabled', v)}
          >
            <div className="flex items-center justify-between">
              <FieldLabel hint="% of opening capital (combined NSE + MCX)">Threshold</FieldLabel>
              <NumberInput
                value={ds.dailyLossLimit?.thresholdPercent ?? 3}
                onChange={(v) => upd('dailyLossLimit.thresholdPercent', v)}
                min={1}
                max={20}
                step={0.5}
                suffix="%"
              />
            </div>
          </DisciplineRow>

          <DisciplineRow
            label="Max Consecutive Losses"
            hint="Force cooldown after N consecutive losing trades"
            enabled={ds.maxConsecutiveLosses?.enabled ?? true}
            onToggle={(v) => upd('maxConsecutiveLosses.enabled', v)}
          >
            <div className="flex items-center justify-between">
              <FieldLabel hint="Number of consecutive losses to trigger">Max Losses</FieldLabel>
              <NumberInput
                value={ds.maxConsecutiveLosses?.maxLosses ?? 3}
                onChange={(v) => upd('maxConsecutiveLosses.maxLosses', v)}
                min={1}
                max={10}
              />
            </div>
            <div className="flex items-center justify-between">
              <FieldLabel hint="Cooldown duration after trigger">Cooldown</FieldLabel>
              <NumberInput
                value={ds.maxConsecutiveLosses?.cooldownMinutes ?? 30}
                onChange={(v) => upd('maxConsecutiveLosses.cooldownMinutes', v)}
                min={5}
                max={120}
                suffix="min"
              />
            </div>
          </DisciplineRow>
        </div>
      </SettingsCard>

      {/* Trade Limits */}
      <SettingsCard title="Trade Limits">
        <div className="space-y-4">
          <DisciplineRow
            label="Max Trades / Day"
            hint="Hard limit on total trades per day (combined NSE + MCX)"
            enabled={ds.maxTradesPerDay?.enabled ?? true}
            onToggle={(v) => upd('maxTradesPerDay.enabled', v)}
          >
            <div className="flex items-center justify-between">
              <FieldLabel hint="Maximum number of trades">Limit</FieldLabel>
              <NumberInput
                value={ds.maxTradesPerDay?.limit ?? 5}
                onChange={(v) => upd('maxTradesPerDay.limit', v)}
                min={1}
                max={50}
              />
            </div>
          </DisciplineRow>

          <DisciplineRow
            label="Max Open Positions"
            hint="Hard limit on simultaneously open positions"
            enabled={ds.maxOpenPositions?.enabled ?? true}
            onToggle={(v) => upd('maxOpenPositions.enabled', v)}
          >
            <div className="flex items-center justify-between">
              <FieldLabel hint="Maximum concurrent positions">Limit</FieldLabel>
              <NumberInput
                value={ds.maxOpenPositions?.limit ?? 3}
                onChange={(v) => upd('maxOpenPositions.limit', v)}
                min={1}
                max={20}
              />
            </div>
          </DisciplineRow>

          <DisciplineRow
            label="Revenge Trade Cooldown"
            hint="Mandatory cooldown after a stop-loss hit"
            enabled={ds.revengeCooldown?.enabled ?? true}
            onToggle={(v) => upd('revengeCooldown.enabled', v)}
          >
            <div className="flex items-center justify-between">
              <FieldLabel hint="Cooldown duration">Duration</FieldLabel>
              <SelectInput
                value={String(ds.revengeCooldown?.durationMinutes ?? 15)}
                onChange={(v) => upd('revengeCooldown.durationMinutes', parseInt(v))}
                options={[
                  { value: '10', label: '10 min' },
                  { value: '15', label: '15 min' },
                  { value: '30', label: '30 min' },
                ]}
              />
            </div>
            <div className="flex items-center justify-between">
              <FieldLabel hint="Require typing 'I accept the loss' before cooldown starts">
                Require Acknowledgment
              </FieldLabel>
              <ToggleSwitch
                checked={ds.revengeCooldown?.requireAcknowledgment ?? true}
                onChange={(v) => upd('revengeCooldown.requireAcknowledgment', v)}
              />
            </div>
          </DisciplineRow>
        </div>
      </SettingsCard>

      {/* Pre-Trade Gate */}
      <SettingsCard title="Pre-Trade Gate">
        <div className="space-y-4">
          <div className="flex items-center justify-between mb-2">
            <FieldLabel hint="Master toggle for all pre-trade checks">Pre-Trade Gate</FieldLabel>
            <ToggleSwitch
              checked={ds.preTradeGate?.enabled ?? true}
              onChange={(v) => upd('preTradeGate.enabled', v)}
            />
          </div>

          {ds.preTradeGate?.enabled && (
            <div className="pl-4 border-l-2 border-primary/20 space-y-4">
              <DisciplineRow
                label="Min Risk:Reward"
                hint="Block trades below this R:R ratio"
                enabled={ds.preTradeGate?.minRiskReward?.enabled ?? true}
                onToggle={(v) => upd('preTradeGate.minRiskReward.enabled', v)}
              >
                <div className="flex items-center justify-between">
                  <FieldLabel hint="Minimum R:R ratio (e.g. 1.5 = 1:1.5)">Ratio</FieldLabel>
                  <NumberInput
                    value={ds.preTradeGate?.minRiskReward?.ratio ?? 1.5}
                    onChange={(v) => upd('preTradeGate.minRiskReward.ratio', v)}
                    min={0.5}
                    max={10}
                    step={0.1}
                    suffix=":1"
                  />
                </div>
              </DisciplineRow>

              <DisciplineRow
                label="Emotional State Check"
                hint="Block trades when in dangerous emotional states"
                enabled={ds.preTradeGate?.emotionalStateCheck?.enabled ?? true}
                onToggle={(v) => upd('preTradeGate.emotionalStateCheck.enabled', v)}
              >
                <div className="space-y-2">
                  <FieldLabel hint="Select emotional states that block trading">Block States</FieldLabel>
                  <div className="flex flex-wrap gap-2">
                    {['revenge', 'fomo', 'greedy', 'anxious'].map((state) => {
                      const active = (ds.preTradeGate?.emotionalStateCheck?.blockStates ?? []).includes(state);
                      return (
                        <button
                          key={state}
                          onClick={() => {
                            const current = ds.preTradeGate?.emotionalStateCheck?.blockStates ?? [];
                            const next = active
                              ? current.filter((s: string) => s !== state)
                              : [...current, state];
                            upd('preTradeGate.emotionalStateCheck.blockStates', next);
                          }}
                          className={`px-2.5 py-1 rounded text-[10px] font-bold tracking-wider uppercase border transition-colors ${
                            active
                              ? 'bg-destructive/10 text-destructive border-destructive/30'
                              : 'bg-muted text-muted-foreground border-border hover:bg-accent'
                          }`}
                        >
                          {state}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </DisciplineRow>
            </div>
          )}
        </div>
      </SettingsCard>

      {/* Position Sizing */}
      <SettingsCard title="Position Sizing">
        <div className="space-y-4">
          <DisciplineRow
            label="Max Position Size"
            hint="Maximum single position as % of capital"
            enabled={ds.maxPositionSize?.enabled ?? true}
            onToggle={(v) => upd('maxPositionSize.enabled', v)}
          >
            <div className="flex items-center justify-between">
              <FieldLabel hint="% of capital per position">Max %</FieldLabel>
              <NumberInput
                value={ds.maxPositionSize?.percentOfCapital ?? 40}
                onChange={(v) => upd('maxPositionSize.percentOfCapital', v)}
                min={5}
                max={100}
                step={5}
                suffix="%"
              />
            </div>
          </DisciplineRow>

          <DisciplineRow
            label="Max Total Exposure"
            hint="Maximum total exposure across all open positions"
            enabled={ds.maxTotalExposure?.enabled ?? true}
            onToggle={(v) => upd('maxTotalExposure.enabled', v)}
          >
            <div className="flex items-center justify-between">
              <FieldLabel hint="% of capital across all positions">Max %</FieldLabel>
              <NumberInput
                value={ds.maxTotalExposure?.percentOfCapital ?? 80}
                onChange={(v) => upd('maxTotalExposure.percentOfCapital', v)}
                min={10}
                max={200}
                step={5}
                suffix="%"
              />
            </div>
          </DisciplineRow>
        </div>
      </SettingsCard>

      {/* Journal & Review */}
      <SettingsCard title="Journal & Review">
        <div className="space-y-4">
          <DisciplineRow
            label="Journal Enforcement"
            hint="Block new trades when too many trades are unjournaled"
            enabled={ds.journalEnforcement?.enabled ?? true}
            onToggle={(v) => upd('journalEnforcement.enabled', v)}
          >
            <div className="flex items-center justify-between">
              <FieldLabel hint="Max unjournaled trades before blocking">Max Unjournaled</FieldLabel>
              <NumberInput
                value={ds.journalEnforcement?.maxUnjournaled ?? 3}
                onChange={(v) => upd('journalEnforcement.maxUnjournaled', v)}
                min={1}
                max={20}
              />
            </div>
          </DisciplineRow>

          <DisciplineRow
            label="Weekly Review"
            hint="Enforce weekly performance review"
            enabled={ds.weeklyReview?.enabled ?? true}
            onToggle={(v) => upd('weeklyReview.enabled', v)}
          >
            <div className="flex items-center justify-between">
              <FieldLabel hint="Show warning when discipline score drops below this">Score Warning</FieldLabel>
              <NumberInput
                value={ds.weeklyReview?.disciplineScoreWarning ?? 70}
                onChange={(v) => upd('weeklyReview.disciplineScoreWarning', v)}
                min={0}
                max={100}
                suffix="/100"
              />
            </div>
            <div className="flex items-center justify-between">
              <FieldLabel hint="Reduce limits after N consecutive red weeks">Red Week Trigger</FieldLabel>
              <NumberInput
                value={ds.weeklyReview?.redWeekReduction ?? 3}
                onChange={(v) => upd('weeklyReview.redWeekReduction', v)}
                min={1}
                max={10}
                suffix="weeks"
              />
            </div>
          </DisciplineRow>
        </div>
      </SettingsCard>

      {/* Streaks */}
      <SettingsCard title="Streaks">
        <div className="space-y-4">
          <DisciplineRow
            label="Winning Streak Reminder"
            hint="Show overconfidence reminder after N winning days"
            enabled={ds.winningStreakReminder?.enabled ?? true}
            onToggle={(v) => upd('winningStreakReminder.enabled', v)}
          >
            <div className="flex items-center justify-between">
              <FieldLabel hint="Trigger after N consecutive winning days">After Days</FieldLabel>
              <NumberInput
                value={ds.winningStreakReminder?.triggerAfterDays ?? 5}
                onChange={(v) => upd('winningStreakReminder.triggerAfterDays', v)}
                min={2}
                max={20}
                suffix="days"
              />
            </div>
          </DisciplineRow>

          <DisciplineRow
            label="Losing Streak Auto-Reduce"
            hint="Automatically reduce trade limits after consecutive losing days"
            enabled={ds.losingStreakAutoReduce?.enabled ?? true}
            onToggle={(v) => upd('losingStreakAutoReduce.enabled', v)}
          >
            <div className="flex items-center justify-between">
              <FieldLabel hint="Trigger after N consecutive losing days">After Days</FieldLabel>
              <NumberInput
                value={ds.losingStreakAutoReduce?.triggerAfterDays ?? 3}
                onChange={(v) => upd('losingStreakAutoReduce.triggerAfterDays', v)}
                min={1}
                max={10}
                suffix="days"
              />
            </div>
            <div className="flex items-center justify-between">
              <FieldLabel hint="Reduce limits by this percentage">Reduce By</FieldLabel>
              <NumberInput
                value={ds.losingStreakAutoReduce?.reduceByPercent ?? 50}
                onChange={(v) => upd('losingStreakAutoReduce.reduceByPercent', v)}
                min={10}
                max={90}
                step={10}
                suffix="%"
              />
            </div>
          </DisciplineRow>
        </div>
      </SettingsCard>

      <div className="col-span-full flex items-center gap-2 justify-end">
        <ResetButton onClick={handleReset} />
        <SaveButton onClick={handleSave} loading={updateMutation.isPending} />
      </div>
    </div>
  );
}

export function TimeWindowsSection() {
  // Use the NEW discipline backend for time windows (they live in discipline_settings now)
  const settingsQuery = trpc.discipline.getSettings.useQuery();
  const [tw, setTw] = useState<any>(null);

  useEffect(() => {
    if (settingsQuery.data) {
      setTw({
        noTradingAfterOpen: JSON.parse(JSON.stringify(settingsQuery.data.noTradingAfterOpen)),
        noTradingBeforeClose: JSON.parse(JSON.stringify(settingsQuery.data.noTradingBeforeClose)),
        lunchBreakPause: JSON.parse(JSON.stringify(settingsQuery.data.lunchBreakPause)),
      });
    }
  }, [settingsQuery.data]);

  const updateMutation = trpc.discipline.updateSettings.useMutation({
    onSuccess: () => {
      toast.success('Time window settings saved');
      settingsQuery.refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  const handleSave = () => {
    if (!tw) return;
    updateMutation.mutate(tw);
  };

  const handleReset = () => {
    if (settingsQuery.data) {
      setTw({
        noTradingAfterOpen: JSON.parse(JSON.stringify(settingsQuery.data.noTradingAfterOpen)),
        noTradingBeforeClose: JSON.parse(JSON.stringify(settingsQuery.data.noTradingBeforeClose)),
        lunchBreakPause: JSON.parse(JSON.stringify(settingsQuery.data.lunchBreakPause)),
      });
    }
  };

  if (!tw) {
    return (
      <SettingsCard>
        <div className="flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          <span className="text-[11px] text-muted-foreground">Loading time window settings...</span>
        </div>
      </SettingsCard>
    );
  }

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
      {/* No Trading After Open */}
      <SettingsCard title="No Trading After Market Open">
        <DisciplineRow
          label="Block After Open"
          hint="No trading for first N minutes after market open"
          enabled={tw.noTradingAfterOpen?.enabled ?? true}
          onToggle={(v) => setTw((p: any) => ({ ...p, noTradingAfterOpen: { ...p.noTradingAfterOpen, enabled: v } }))}
        >
          <div className="flex items-center justify-between">
            <FieldLabel hint="NSE: First N minutes after 9:15 AM">NSE</FieldLabel>
            <NumberInput
              value={tw.noTradingAfterOpen?.nseMinutes ?? 15}
              onChange={(v) => setTw((p: any) => ({ ...p, noTradingAfterOpen: { ...p.noTradingAfterOpen, nseMinutes: v } }))}
              min={0}
              max={120}
              suffix="min"
            />
          </div>
          <div className="flex items-center justify-between">
            <FieldLabel hint="MCX: First N minutes after 9:00 AM">MCX</FieldLabel>
            <NumberInput
              value={tw.noTradingAfterOpen?.mcxMinutes ?? 15}
              onChange={(v) => setTw((p: any) => ({ ...p, noTradingAfterOpen: { ...p.noTradingAfterOpen, mcxMinutes: v } }))}
              min={0}
              max={120}
              suffix="min"
            />
          </div>
        </DisciplineRow>
      </SettingsCard>

      {/* No Trading Before Close */}
      <SettingsCard title="No Trading Before Market Close">
        <DisciplineRow
          label="Block Before Close"
          hint="No trading for last N minutes before market close"
          enabled={tw.noTradingBeforeClose?.enabled ?? true}
          onToggle={(v) => setTw((p: any) => ({ ...p, noTradingBeforeClose: { ...p.noTradingBeforeClose, enabled: v } }))}
        >
          <div className="flex items-center justify-between">
            <FieldLabel hint="NSE: Last N minutes before 3:30 PM">NSE</FieldLabel>
            <NumberInput
              value={tw.noTradingBeforeClose?.nseMinutes ?? 15}
              onChange={(v) => setTw((p: any) => ({ ...p, noTradingBeforeClose: { ...p.noTradingBeforeClose, nseMinutes: v } }))}
              min={0}
              max={120}
              suffix="min"
            />
          </div>
          <div className="flex items-center justify-between">
            <FieldLabel hint="MCX: Last N minutes before 11:30 PM">MCX</FieldLabel>
            <NumberInput
              value={tw.noTradingBeforeClose?.mcxMinutes ?? 15}
              onChange={(v) => setTw((p: any) => ({ ...p, noTradingBeforeClose: { ...p.noTradingBeforeClose, mcxMinutes: v } }))}
              min={0}
              max={120}
              suffix="min"
            />
          </div>
        </DisciplineRow>
      </SettingsCard>

      {/* Lunch Break Pause */}
      <SettingsCard title="Lunch Break Pause">
        <DisciplineRow
          label="Lunch Break"
          hint="Pause trading during lunch break (NSE only)"
          enabled={tw.lunchBreakPause?.enabled ?? false}
          onToggle={(v) => setTw((p: any) => ({ ...p, lunchBreakPause: { ...p.lunchBreakPause, enabled: v } }))}
        >
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <FieldLabel>Start</FieldLabel>
              <TimeInput
                value={tw.lunchBreakPause?.startTime ?? '12:30'}
                onChange={(v) => setTw((p: any) => ({ ...p, lunchBreakPause: { ...p.lunchBreakPause, startTime: v } }))}
              />
            </div>
            <div className="flex items-center gap-2">
              <FieldLabel>End</FieldLabel>
              <TimeInput
                value={tw.lunchBreakPause?.endTime ?? '13:30'}
                onChange={(v) => setTw((p: any) => ({ ...p, lunchBreakPause: { ...p.lunchBreakPause, endTime: v } }))}
              />
            </div>
          </div>
        </DisciplineRow>
      </SettingsCard>

      <div className="col-span-full flex items-center gap-2 p-2 rounded bg-info-cyan/5 border border-info-cyan/20">
        <Info className="h-3.5 w-3.5 text-info-cyan shrink-0" />
        <span className="text-[10px] text-info-cyan">
          Time windows are enforced by the Discipline Engine. Lunch break pause applies only to NSE. MCX has no scheduled lunch break.
        </span>
      </div>

      <div className="col-span-full flex items-center gap-2 justify-end">
        <ResetButton onClick={handleReset} />
        <SaveButton onClick={handleSave} loading={updateMutation.isPending} />
      </div>
    </div>
  );
}

export function ExpiryControlsSection() {
  const settingsQuery = trpc.settings.get.useQuery();
  const [rules, setRules] = useState(settingsQuery.data?.expiryControls?.rules);

  useEffect(() => {
    if (settingsQuery.data?.expiryControls?.rules) {
      setRules(JSON.parse(JSON.stringify(settingsQuery.data.expiryControls.rules)));
    }
  }, [settingsQuery.data]);

  const updateMutation = trpc.settings.updateExpiryControls.useMutation({
    onSuccess: () => {
      toast.success('Expiry control settings saved');
      settingsQuery.refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  const handleSave = () => {
    if (!rules) return;
    updateMutation.mutate({ rules });
  };

  const handleReset = () => {
    if (settingsQuery.data?.expiryControls?.rules) {
      setRules(JSON.parse(JSON.stringify(settingsQuery.data.expiryControls.rules)));
    }
  };

  if (!rules) {
    return (
      <SettingsCard>
        <div className="flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          <span className="text-[11px] text-muted-foreground">Loading expiry settings...</span>
        </div>
      </SettingsCard>
    );
  }

  const instrumentColors: Record<string, string> = {
    NIFTY_50: 'text-info-cyan border-info-cyan/30',
    BANKNIFTY: 'text-bullish border-bullish/30',
    CRUDEOIL: 'text-warning-amber border-warning-amber/30',
    NATURALGAS: 'text-destructive border-destructive/30',
  };

  const instrumentLabels: Record<string, string> = {
    NIFTY_50: 'NIFTY 50',
    BANKNIFTY: 'BANK NIFTY',
    CRUDEOIL: 'CRUDE OIL',
    NATURALGAS: 'NATURAL GAS',
  };

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
      {rules.map((rule, idx) => (
        <SettingsCard key={rule.instrument}>
          <div className="flex items-center gap-2 mb-3 pb-2 border-b border-border">
            <span className={`text-[11px] font-bold tracking-wider uppercase px-2 py-0.5 rounded border ${instrumentColors[rule.instrument] ?? 'text-foreground border-border'}`}>
              {instrumentLabels[rule.instrument] ?? rule.instrument}
            </span>
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <FieldLabel hint="Block all trading on expiry day">Block on Expiry Day</FieldLabel>
              <ToggleSwitch
                checked={rule.blockOnExpiryDay}
                onChange={(v) => {
                  const newRules = [...rules];
                  newRules[idx] = { ...newRules[idx], blockOnExpiryDay: v };
                  setRules(newRules);
                }}
              />
            </div>
            <div className="flex items-center justify-between">
              <FieldLabel hint="Block trading N days before expiry">Block Days Before</FieldLabel>
              <NumberInput
                value={rule.blockDaysBefore}
                onChange={(v) => {
                  const newRules = [...rules];
                  newRules[idx] = { ...newRules[idx], blockDaysBefore: v };
                  setRules(newRules);
                }}
                min={0}
                max={10}
                suffix="days"
              />
            </div>
            <div className="flex items-center justify-between">
              <FieldLabel hint="Reduce position size near expiry">Reduce Position Size</FieldLabel>
              <ToggleSwitch
                checked={rule.reducePositionSize}
                onChange={(v) => {
                  const newRules = [...rules];
                  newRules[idx] = { ...newRules[idx], reducePositionSize: v };
                  setRules(newRules);
                }}
              />
            </div>
            {rule.reducePositionSize && (
              <div className="flex items-center justify-between">
                <FieldLabel hint="Reduce to this % of normal position size">Reduce To</FieldLabel>
                <NumberInput
                  value={rule.reduceSizePercent}
                  onChange={(v) => {
                    const newRules = [...rules];
                    newRules[idx] = { ...newRules[idx], reduceSizePercent: v };
                    setRules(newRules);
                  }}
                  min={10}
                  max={100}
                  suffix="%"
                />
              </div>
            )}
            <div className="flex items-center justify-between">
              <FieldLabel hint="Show warning banner near expiry">Warning Banner</FieldLabel>
              <ToggleSwitch
                checked={rule.warningBanner}
                onChange={(v) => {
                  const newRules = [...rules];
                  newRules[idx] = { ...newRules[idx], warningBanner: v };
                  setRules(newRules);
                }}
              />
            </div>
            <div className="flex items-center justify-between">
              <FieldLabel hint="Auto-exit positions before expiry">Auto Exit</FieldLabel>
              <ToggleSwitch
                checked={rule.autoExit}
                onChange={(v) => {
                  const newRules = [...rules];
                  newRules[idx] = { ...newRules[idx], autoExit: v };
                  setRules(newRules);
                }}
              />
            </div>
            {rule.autoExit && (
              <div className="flex items-center justify-between">
                <FieldLabel hint="Auto-exit N minutes before expiry close">Exit Before</FieldLabel>
                <NumberInput
                  value={rule.autoExitMinutes}
                  onChange={(v) => {
                    const newRules = [...rules];
                    newRules[idx] = { ...newRules[idx], autoExitMinutes: v };
                    setRules(newRules);
                  }}
                  min={5}
                  max={120}
                  suffix="min"
                />
              </div>
            )}
            <div className="flex items-center justify-between">
              <FieldLabel hint="Don't carry positions to expiry day">No Carry to Expiry</FieldLabel>
              <ToggleSwitch
                checked={rule.noCarryToExpiry}
                onChange={(v) => {
                  const newRules = [...rules];
                  newRules[idx] = { ...newRules[idx], noCarryToExpiry: v };
                  setRules(newRules);
                }}
              />
            </div>
          </div>
        </SettingsCard>
      ))}

      <div className="col-span-full flex items-center gap-2 justify-end">
        <ResetButton onClick={handleReset} />
        <SaveButton onClick={handleSave} loading={updateMutation.isPending} />
      </div>
    </div>
  );
}

export function ChargesSection() {
  const settingsQuery = trpc.settings.get.useQuery();
  const [rates, setRates] = useState(settingsQuery.data?.charges?.rates);

  useEffect(() => {
    if (settingsQuery.data?.charges?.rates) {
      setRates(JSON.parse(JSON.stringify(settingsQuery.data.charges.rates)));
    }
  }, [settingsQuery.data]);

  const updateMutation = trpc.settings.updateCharges.useMutation({
    onSuccess: () => {
      toast.success('Charge rates saved');
      settingsQuery.refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  const handleSave = () => {
    if (!rates) return;
    updateMutation.mutate({ rates });
  };

  const handleReset = () => {
    if (settingsQuery.data?.charges?.rates) {
      setRates(JSON.parse(JSON.stringify(settingsQuery.data.charges.rates)));
    }
  };

  if (!rates) {
    return (
      <SettingsCard>
        <div className="flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          <span className="text-[11px] text-muted-foreground">Loading charge rates...</span>
        </div>
      </SettingsCard>
    );
  }

  const unitLabels: Record<string, string> = {
    flat_per_order: '₹/order',
    percent_sell: '% (sell)',
    percent_buy: '% (buy)',
    percent: '%',
    percent_on_brokerage: '% on brokerage',
  };

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
      <SettingsCard title="Indian Standard Charges (Options)" className="col-span-full">
        <div className="space-y-1 mb-3">
          <span className="text-[10px] text-muted-foreground">
            These rates are used to calculate net P&L after deducting all charges.
          </span>
        </div>
        <div className="space-y-3">
          {rates.map((charge, idx) => (
            <div key={charge.name} className="flex items-center justify-between gap-4 py-2 border-b border-border last:border-0">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <ToggleSwitch
                    checked={charge.enabled}
                    onChange={(v) => {
                      const newRates = [...rates];
                      newRates[idx] = { ...newRates[idx], enabled: v };
                      setRates(newRates);
                    }}
                  />
                  <div>
                    <span className={`text-[11px] font-bold tracking-wider ${charge.enabled ? 'text-foreground' : 'text-muted-foreground line-through'}`}>
                      {charge.name}
                    </span>
                    <p className="text-[9px] text-muted-foreground">{charge.description}</p>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <input
                  type="number"
                  value={charge.rate}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    if (!isNaN(v) && v >= 0) {
                      const newRates = [...rates];
                      newRates[idx] = { ...newRates[idx], rate: v };
                      setRates(newRates);
                    }
                  }}
                  step={charge.unit === 'flat_per_order' ? 1 : 0.0001}
                  min={0}
                  className="w-24 h-7 px-2 text-[11px] bg-background border border-border rounded text-foreground tabular-nums text-right focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <span className="text-[9px] text-muted-foreground w-20 text-right">
                  {unitLabels[charge.unit] ?? charge.unit}
                </span>
              </div>
            </div>
          ))}
        </div>
      </SettingsCard>

      <div className="col-span-full flex items-center gap-2 p-2 rounded bg-info-cyan/5 border border-info-cyan/20">
        <Info className="h-3.5 w-3.5 text-info-cyan shrink-0" />
        <span className="text-[10px] text-info-cyan">
          Charges are applied to all P&L calculations. Rates are based on Indian standard charges for Options trading via Dhan.
        </span>
      </div>

      <div className="col-span-full flex items-center gap-2 justify-end">
        <ResetButton onClick={handleReset} />
        <SaveButton onClick={handleSave} loading={updateMutation.isPending} />
      </div>
    </div>
  );
}

// ─── Instruments Section ─────────────────────────────────────────

export function InstrumentsSection() {
  const instrumentsQuery = trpc.instruments.list.useQuery();

  const [showSearch, setShowSearch] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [searchExchange, setSearchExchange] = useState<'ALL' | 'NSE' | 'MCX' | 'BSE'>('ALL');
  const [searchResults, setSearchResults] = useState<Array<any>>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [hotKeyAssignMode, setHotKeyAssignMode] = useState<string | null>(null);
  const [isAssigningHotkey, setIsAssigningHotkey] = useState(false);

  const instruments = instrumentsQuery.data || [];

  const handleSearch = async () => {
    if (!searchText.trim()) {
      setSearchResults([]);
      return;
    }
    setIsSearching(true);
    try {
      const params = new URLSearchParams();
      params.set('query', searchText);
      if (searchExchange !== 'ALL') {
        params.set('exchange', searchExchange);
      }
      const response = await fetch(`/api/trading/search-instruments?${params}`);
      const data = await response.json();
      if (data.results) {
        setSearchResults(data.results.slice(0, 10));
      } else if (data.error) {
        toast.error(data.error || 'Search failed');
      }
    } catch (err: any) {
      console.error('Search failed:', err);
      toast.error('Search failed');
    }
    setIsSearching(false);
  };

  const handleAddInstrument = async (result: any) => {
    setIsAdding(true);
    try {
      const response = await fetch('/api/trading/instruments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: result.securityId,
          displayName: result.customSymbol || result.tradingSymbol,
          exchange: result.exchange,
          exchangeSegment: result.segment,
          underlying: result.securityId,
          autoResolve: false,
          symbolName: result.symbolName || null,
        }),
      });
      const data = await response.json();
      if (data.success) {
        toast.success('Instrument added');
        setSearchText('');
        setSearchResults([]);
        instrumentsQuery.refetch();
      } else {
        toast.error(data.error || 'Failed to add instrument');
      }
    } catch (err: any) {
      console.error('Add failed:', err);
      toast.error('Failed to add instrument');
    }
    setIsAdding(false);
  };

  const handleRemoveInstrument = async (key: string) => {
    setIsRemoving(true);
    try {
      const response = await fetch(`/api/trading/instruments/${key}`, {
        method: 'DELETE',
      });
      const data = await response.json();
      if (data.success) {
        toast.success('Instrument removed');
        instrumentsQuery.refetch();
      } else {
        toast.error(data.error || 'Failed to remove instrument');
      }
    } catch (err: any) {
      console.error('Remove failed:', err);
      toast.error('Failed to remove instrument');
    }
    setIsRemoving(false);
  };

  const handleHotKeyPress = async (e: React.KeyboardEvent, instrumentKey: string) => {
    e.preventDefault();
    const key = e.key.toLowerCase();

    // Ignore modifier keys and special keys
    if (['shift', 'control', 'alt', 'meta', 'enter', 'escape'].includes(key)) {
      if (key === 'escape') {
        setHotKeyAssignMode(null);
      }
      return;
    }

    setIsAssigningHotkey(true);
    try {
      const response = await fetch(`/api/trading/instruments/${instrumentKey}/hotkey`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hotkey: key }),
      });
      const data = await response.json();
      if (data.success) {
        toast.success(`Hotkey "${key.toUpperCase()}" assigned`);
        setHotKeyAssignMode(null);
        instrumentsQuery.refetch();
      } else {
        toast.error(data.error || 'Failed to assign hotkey');
      }
    } catch (err: any) {
      console.error('Hotkey assignment failed:', err);
      toast.error('Failed to assign hotkey');
    }
    setIsAssigningHotkey(false);
  };

  return (
    <div className="grid grid-cols-1 gap-4">
      <SettingsCard title="Configured Instruments">
        <div className="space-y-2 mb-4">
          <div className="text-[10px] text-muted-foreground">
            {instruments.length} instrument{instruments.length !== 1 ? 's' : ''} configured
          </div>
        </div>
        <div className="space-y-2 max-h-64 overflow-y-auto">
          {instruments.length === 0 ? (
            <span className="text-[11px] text-muted-foreground">No instruments configured</span>
          ) : (
            instruments.map((inst: any) => (
              <div key={inst.key} className="flex items-center justify-between gap-3 p-2 rounded border border-border text-[11px]">
                <div className="flex-1 min-w-0">
                  <div className="font-bold">{inst.displayName}</div>
                  <div className="text-[9px] text-muted-foreground">{inst.exchange} • {inst.exchangeSegment}</div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {inst.isDefault && (
                    <span className="px-2 py-0.5 text-[9px] bg-primary/10 text-primary rounded">default</span>
                  )}
                  {hotKeyAssignMode === inst.key ? (
                    <input
                      autoFocus
                      onKeyDown={(e) => handleHotKeyPress(e, inst.key)}
                      onBlur={() => setHotKeyAssignMode(null)}
                      placeholder="Press key..."
                      className="w-12 px-1 py-0.5 text-[10px] text-center bg-background border border-primary rounded text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  ) : (
                    <>
                      {inst.hotkey && (
                        <span className="px-2 py-0.5 text-[10px] bg-accent/20 text-accent-foreground rounded font-mono font-bold">
                          {inst.hotkey.toUpperCase()}
                        </span>
                      )}
                      <button
                        onClick={() => setHotKeyAssignMode(inst.key)}
                        disabled={isAssigningHotkey}
                        className="px-2 py-1 text-[10px] rounded border border-primary/30 text-primary hover:bg-primary/5 disabled:opacity-50"
                        title="Assign hotkey"
                      >
                        {inst.hotkey ? 'Change' : 'Set'} Key
                      </button>
                    </>
                  )}
                  <button
                    onClick={() => handleRemoveInstrument(inst.key)}
                    disabled={inst.isDefault || isRemoving}
                    className="px-2 py-1 text-[10px] rounded border border-destructive/30 text-destructive hover:bg-destructive/5 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </SettingsCard>

      {!showSearch && (
        <button
          onClick={() => setShowSearch(true)}
          className="w-full py-2 px-4 text-[11px] font-bold tracking-wider uppercase rounded border border-primary/30 text-primary hover:bg-primary/5 transition-colors"
        >
          + Add Instrument
        </button>
      )}

      {showSearch && (
        <SettingsCard title="Search & Add Instrument">
          <div className="space-y-3">
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Search symbol (e.g., RELIANCE, NIFTY)..."
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                className="flex-1 h-7 px-2 text-[11px] bg-background border border-border rounded text-foreground placeholder-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <select
                value={searchExchange}
                onChange={(e) => setSearchExchange(e.target.value as any)}
                className="h-7 px-2 text-[11px] bg-background border border-border rounded text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <option>ALL</option>
                <option>NSE</option>
                <option>MCX</option>
                <option>BSE</option>
              </select>
              <button
                onClick={handleSearch}
                disabled={isSearching}
                className="px-3 py-1 text-[11px] font-bold rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {isSearching ? '⟳' : 'Search'}
              </button>
            </div>

            {searchResults.length > 0 && (
              <div className="border border-border rounded p-2 space-y-1 max-h-48 overflow-y-auto">
                {searchResults.map((result: any, idx: number) => (
                  <div key={idx} className="flex items-center justify-between gap-2 p-1.5 text-[10px] rounded hover:bg-muted">
                    <div className="flex-1 min-w-0">
                      <div className="font-mono">{result.tradingSymbol}</div>
                      <div className="text-muted-foreground">{result.exchange} • {result.instrumentName}</div>
                    </div>
                    <button
                      onClick={() => handleAddInstrument(result)}
                      disabled={isAdding}
                      className="px-2 py-0.5 text-[9px] rounded bg-primary/10 text-primary hover:bg-primary/20 disabled:opacity-50"
                    >
                      Add
                    </button>
                  </div>
                ))}
              </div>
            )}

            <button
              onClick={() => setShowSearch(false)}
              className="w-full py-1.5 text-[10px] text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </SettingsCard>
      )}
    </div>
  );
}

// ─── Main Settings Page ──────────────────────────────────────────

export default function Settings() {
  const { user, loading } = useAuth();
  const [activeSection, setActiveSection] = useState<SettingsSection>('broker');

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex items-center gap-2">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
          <span className="text-[11px] text-muted-foreground">Loading...</span>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <div className="flex flex-col items-center gap-8 p-8 max-w-md w-full">
          <h1 className="text-2xl font-semibold tracking-tight text-center">
            Sign in to continue
          </h1>
          <p className="text-sm text-muted-foreground text-center max-w-sm">
            Access to settings requires authentication.
          </p>
          <button
            onClick={() => { window.location.href = getLoginUrl(); }}
            className="w-full px-6 py-3 rounded bg-primary text-primary-foreground font-medium hover:bg-primary/90 transition-colors"
          >
            Sign in
          </button>
        </div>
      </div>
    );
  }

  const renderSection = () => {
    switch (activeSection) {
      case 'broker':
        return <BrokerConfigSection />;
      case 'execution':
        return <OrderExecutionSection />;
      case 'discipline':
        return <DisciplineSection />;
      case 'timeWindows':
        return <TimeWindowsSection />;
      case 'expiry':
        return <ExpiryControlsSection />;
      case 'charges':
        return <ChargesSection />;
      case 'capital':
        return <CapitalManagementSection />;
      case 'instruments':
        return <InstrumentsSection />;
      default:
        return null;
    }
  };

  const currentSection = SECTIONS.find((s) => s.id === activeSection);

  return (
    <div className="container py-6">
      <div className="flex gap-6">
            {/* Sidebar Navigation */}
            <div className="w-64 shrink-0">
              <div className="sticky top-20">
                <nav className="space-y-1">
                  {SECTIONS.map((section) => {
                    const isActive = activeSection === section.id;
                    const Icon = section.icon;
                    return (
                      <button
                        key={section.id}
                        onClick={() => setActiveSection(section.id)}
                        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-left transition-all ${
                          isActive
                            ? 'bg-primary/10 border border-primary/20 text-foreground'
                            : 'hover:bg-accent text-muted-foreground hover:text-foreground border border-transparent'
                        }`}
                      >
                        <Icon className={`h-4 w-4 shrink-0 ${isActive ? 'text-primary' : ''}`} />
                        <div className="flex-1 min-w-0">
                          <span className={`text-[11px] font-bold tracking-wider uppercase block ${isActive ? 'text-primary' : ''}`}>
                            {section.label}
                          </span>
                          <span className="text-[9px] text-muted-foreground truncate block mt-0.5">
                            {section.description}
                          </span>
                        </div>
                        {isActive && (
                          <ChevronRight className="h-3 w-3 text-primary shrink-0" />
                        )}
                      </button>
                    );
                  })}
                </nav>

                {/* Last updated */}
                <div className="mt-6 px-3">
                  <span className="text-[9px] text-muted-foreground tracking-wider uppercase">
                    Settings are persisted to MongoDB
                  </span>
                </div>
              </div>
            </div>

            {/* Main Content */}
            <div className="flex-1 min-w-0">
              {/* Section Header */}
              <div className="mb-5">
                <div className="flex items-center gap-2 mb-1">
                  {currentSection && <currentSection.icon className="h-4 w-4 text-primary" />}
                  <h2 className="font-display text-base font-bold tracking-tight text-foreground">
                    {currentSection?.label}
                  </h2>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {currentSection?.description}
                </p>
              </div>

              {/* Section Content */}
              <div className="animate-fade-in-up">
                {renderSection()}
              </div>
            </div>
      </div>
    </div>
  );
}
