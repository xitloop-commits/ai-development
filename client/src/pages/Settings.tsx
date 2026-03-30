/**
 * Settings Page — Feature 4: Settings Foundation
 * Terminal Noir themed settings page with sidebar navigation and 6 sections:
 * 1. Broker Config
 * 2. Order Execution
 * 3. Discipline
 * 4. Time Windows
 * 5. Expiry Controls
 * 6. Charges
 */
import { useState, useEffect, useMemo } from 'react';
import { useAuth } from '@/_core/hooks/useAuth';
import { getLoginUrl } from '@/const';
import { trpc } from '@/lib/trpc';
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
} from 'lucide-react';

// ─── Types ───────────────────────────────────────────────────────

type SettingsSection =
  | 'broker'
  | 'execution'
  | 'discipline'
  | 'timeWindows'
  | 'expiry'
  | 'charges';

interface SectionItem {
  id: SettingsSection;
  label: string;
  icon: React.ElementType;
  description: string;
}

const SECTIONS: SectionItem[] = [
  { id: 'broker', label: 'Broker Config', icon: Wallet, description: 'Active broker, credentials, connection status' },
  { id: 'execution', label: 'Order Execution', icon: Zap, description: 'Entry offset, SL/TP, order & product type' },
  { id: 'discipline', label: 'Discipline', icon: ShieldCheck, description: 'Trade limits, loss limits, checklist rules' },
  { id: 'timeWindows', label: 'Time Windows', icon: Clock, description: 'NSE & MCX trading time restrictions' },
  { id: 'expiry', label: 'Expiry Controls', icon: CalendarClock, description: 'Per-instrument expiry day rules' },
  { id: 'charges', label: 'Charges', icon: Receipt, description: 'Brokerage, STT, GST, and other charge rates' },
];

const INSTRUMENTS = ['NIFTY_50', 'BANKNIFTY', 'CRUDEOIL', 'NATURALGAS'];

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
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  className?: string;
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
        className="w-20 h-8 px-2 text-[11px] bg-background border border-border rounded text-foreground tabular-nums focus:outline-none focus:ring-1 focus:ring-primary"
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
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 px-2 text-[11px] bg-background border border-border rounded text-foreground focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer"
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

function TimeInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      type="time"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 px-2 text-[11px] bg-background border border-border rounded text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
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

// ─── Section Components ──────────────────────────────────────────

function BrokerConfigSection() {
  const configQuery = trpc.broker.config.get.useQuery();
  const allConfigsQuery = trpc.broker.config.list.useQuery();
  const statusQuery = trpc.broker.status.useQuery();
  const tokenQuery = trpc.broker.token.status.useQuery();
  const switchMutation = trpc.broker.config.switchBroker.useMutation({
    onSuccess: () => {
      toast.success('Broker switched successfully');
      configQuery.refetch();
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
    },
    onError: (err) => toast.error(err.message),
  });

  const config = configQuery.data;
  const allConfigs = allConfigsQuery.data ?? [];
  const status = statusQuery.data;
  const token = tokenQuery.data;

  return (
    <div className="space-y-4">
      {/* Active Broker */}
      <SettingsCard title="Active Broker">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <FieldLabel hint="Select the broker to use for trading">Active Broker</FieldLabel>
            <SelectInput
              value={status?.activeBrokerId ?? ''}
              onChange={(v) => switchMutation.mutate({ brokerId: v })}
              options={allConfigs.map((c) => ({ value: c.brokerId, label: c.displayName }))}
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
              <span className="text-[11px] text-foreground tabular-nums">
                {config.credentials.clientId || '—'}
              </span>
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
                status={config.credentials.status}
                label={config.credentials.status.toUpperCase()}
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
                  if (tokenInput.trim()) {
                    tokenMutation.mutate({ token: tokenInput.trim() });
                  }
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

function OrderExecutionSection() {
  const configQuery = trpc.broker.config.get.useQuery();
  const config = configQuery.data;

  const [settings, setSettings] = useState({
    orderEntryOffset: 1.0,
    defaultSL: 2.0,
    defaultTP: 5.0,
    orderType: 'LIMIT' as string,
    productType: 'INTRADAY' as string,
  });

  useEffect(() => {
    if (config?.settings) {
      setSettings({
        orderEntryOffset: config.settings.orderEntryOffset,
        defaultSL: config.settings.defaultSL,
        defaultTP: config.settings.defaultTP,
        orderType: config.settings.orderType,
        productType: config.settings.productType,
      });
    }
  }, [config]);

  const updateMutation = trpc.broker.config.updateSettings.useMutation({
    onSuccess: () => {
      toast.success('Order execution settings saved');
      configQuery.refetch();
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
      },
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
    <div className="space-y-4">
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
            <FieldLabel hint="Default target profit percentage from entry price">
              Default Target Profit
            </FieldLabel>
            <NumberInput
              value={settings.defaultTP}
              onChange={(v) => setSettings((s) => ({ ...s, defaultTP: v }))}
              min={0}
              max={100}
              step={0.5}
              suffix="%"
            />
          </div>
        </div>
      </SettingsCard>

      <div className="flex items-center gap-2 justify-end">
        <ResetButton onClick={handleReset} />
        <SaveButton onClick={handleSave} loading={updateMutation.isPending} />
      </div>
    </div>
  );
}

function DisciplineSection() {
  const settingsQuery = trpc.settings.get.useQuery();
  const [discipline, setDiscipline] = useState(settingsQuery.data?.discipline);

  useEffect(() => {
    if (settingsQuery.data?.discipline) {
      setDiscipline({ ...settingsQuery.data.discipline });
    }
  }, [settingsQuery.data]);

  const updateMutation = trpc.settings.updateDiscipline.useMutation({
    onSuccess: () => {
      toast.success('Discipline settings saved');
      settingsQuery.refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  const handleSave = () => {
    if (!discipline) return;
    updateMutation.mutate(discipline);
  };

  const handleReset = () => {
    if (settingsQuery.data?.discipline) {
      setDiscipline({ ...settingsQuery.data.discipline });
    }
  };

  if (!discipline) {
    return (
      <SettingsCard>
        <div className="flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          <span className="text-[11px] text-muted-foreground">Loading discipline settings...</span>
        </div>
      </SettingsCard>
    );
  }

  return (
    <div className="space-y-4">
      <SettingsCard title="Trade Limits">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <FieldLabel hint="Maximum trades per day (combined NSE + MCX)">
              Max Trades / Day
            </FieldLabel>
            <NumberInput
              value={discipline.maxTradesPerDay}
              onChange={(v) => setDiscipline((s) => s ? { ...s, maxTradesPerDay: v } : s)}
              min={1}
              max={50}
            />
          </div>
          <div className="flex items-center justify-between">
            <FieldLabel hint="Maximum position size as % of capital">
              Max Position Size
            </FieldLabel>
            <NumberInput
              value={discipline.maxPositionSize}
              onChange={(v) => setDiscipline((s) => s ? { ...s, maxPositionSize: v } : s)}
              min={1}
              max={100}
              suffix="%"
            />
          </div>
        </div>
      </SettingsCard>

      <SettingsCard title="Loss Protection">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <FieldLabel hint="Daily loss limit in rupees">
              Max Loss / Day
            </FieldLabel>
            <NumberInput
              value={discipline.maxLossPerDay}
              onChange={(v) => setDiscipline((s) => s ? { ...s, maxLossPerDay: v } : s)}
              min={0}
              suffix="₹"
            />
          </div>
          <div className="flex items-center justify-between">
            <FieldLabel hint="Daily loss limit as % of capital">
              Max Loss / Day (%)
            </FieldLabel>
            <NumberInput
              value={discipline.maxLossPerDayPercent}
              onChange={(v) => setDiscipline((s) => s ? { ...s, maxLossPerDayPercent: v } : s)}
              min={0}
              max={100}
              step={0.5}
              suffix="%"
            />
          </div>
          <div className="flex items-center justify-between">
            <FieldLabel hint="Stop trading after N consecutive losses">
              Max Consecutive Losses
            </FieldLabel>
            <NumberInput
              value={discipline.maxConsecutiveLosses}
              onChange={(v) => setDiscipline((s) => s ? { ...s, maxConsecutiveLosses: v } : s)}
              min={1}
              max={20}
            />
          </div>
          <div className="flex items-center justify-between">
            <FieldLabel hint="Cooldown period after a losing trade">
              Cooldown After Loss
            </FieldLabel>
            <NumberInput
              value={discipline.cooldownAfterLoss}
              onChange={(v) => setDiscipline((s) => s ? { ...s, cooldownAfterLoss: v } : s)}
              min={0}
              max={120}
              suffix="min"
            />
          </div>
          <div className="flex items-center justify-between">
            <FieldLabel hint="Block all trades after hitting daily loss limit">
              No Revenge Trading
            </FieldLabel>
            <ToggleSwitch
              checked={discipline.noRevengeTrading}
              onChange={(v) => setDiscipline((s) => s ? { ...s, noRevengeTrading: v } : s)}
            />
          </div>
        </div>
      </SettingsCard>

      <SettingsCard title="Pre-Trade Checks">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <FieldLabel hint="Require completing the pre-entry checklist">
              Mandatory Checklist
            </FieldLabel>
            <ToggleSwitch
              checked={discipline.mandatoryChecklist}
              onChange={(v) => setDiscipline((s) => s ? { ...s, mandatoryChecklist: v } : s)}
            />
          </div>
          {discipline.mandatoryChecklist && (
            <div className="flex items-center justify-between">
              <FieldLabel hint="Minimum checklist score required to trade">
                Min Checklist Score
              </FieldLabel>
              <NumberInput
                value={discipline.minChecklistScore}
                onChange={(v) => setDiscipline((s) => s ? { ...s, minChecklistScore: v } : s)}
                min={0}
                max={100}
                suffix="/100"
              />
            </div>
          )}
          <div className="flex items-center justify-between">
            <FieldLabel hint="Require a written rationale for each trade">
              Require Rationale
            </FieldLabel>
            <ToggleSwitch
              checked={discipline.requireRationale}
              onChange={(v) => setDiscipline((s) => s ? { ...s, requireRationale: v } : s)}
            />
          </div>
        </div>
      </SettingsCard>

      <SettingsCard title="Trailing Stop">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <FieldLabel hint="Enable automatic trailing stop loss">
              Trailing Stop
            </FieldLabel>
            <ToggleSwitch
              checked={discipline.trailingStopEnabled}
              onChange={(v) => setDiscipline((s) => s ? { ...s, trailingStopEnabled: v } : s)}
            />
          </div>
          {discipline.trailingStopEnabled && (
            <div className="flex items-center justify-between">
              <FieldLabel hint="Trailing stop loss distance from peak">
                Trailing SL %
              </FieldLabel>
              <NumberInput
                value={discipline.trailingStopPercent}
                onChange={(v) => setDiscipline((s) => s ? { ...s, trailingStopPercent: v } : s)}
                min={0}
                max={50}
                step={0.1}
                suffix="%"
              />
            </div>
          )}
        </div>
      </SettingsCard>

      <div className="flex items-center gap-2 justify-end">
        <ResetButton onClick={handleReset} />
        <SaveButton onClick={handleSave} loading={updateMutation.isPending} />
      </div>
    </div>
  );
}

function TimeWindowsSection() {
  const settingsQuery = trpc.settings.get.useQuery();
  const [timeWindows, setTimeWindows] = useState(settingsQuery.data?.timeWindows);

  useEffect(() => {
    if (settingsQuery.data?.timeWindows) {
      setTimeWindows(JSON.parse(JSON.stringify(settingsQuery.data.timeWindows)));
    }
  }, [settingsQuery.data]);

  const updateMutation = trpc.settings.updateTimeWindows.useMutation({
    onSuccess: () => {
      toast.success('Time window settings saved');
      settingsQuery.refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  const handleSave = () => {
    if (!timeWindows) return;
    updateMutation.mutate(timeWindows);
  };

  const handleReset = () => {
    if (settingsQuery.data?.timeWindows) {
      setTimeWindows(JSON.parse(JSON.stringify(settingsQuery.data.timeWindows)));
    }
  };

  if (!timeWindows) {
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
    <div className="space-y-4">
      {/* NSE */}
      <SettingsCard title="NSE (National Stock Exchange)">
        <div className="space-y-1 mb-3">
          <span className="text-[10px] text-muted-foreground">Regular session: 9:15 AM – 3:30 PM IST</span>
        </div>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <FieldLabel hint="No trading for first N minutes after market open">
              No-Trade First
            </FieldLabel>
            <NumberInput
              value={timeWindows.nse.noTradeFirstMinutes}
              onChange={(v) => setTimeWindows((s) => s ? { ...s, nse: { ...s.nse, noTradeFirstMinutes: v } } : s)}
              min={0}
              max={120}
              suffix="min"
            />
          </div>
          <div className="flex items-center justify-between">
            <FieldLabel hint="No trading for last N minutes before market close">
              No-Trade Last
            </FieldLabel>
            <NumberInput
              value={timeWindows.nse.noTradeLastMinutes}
              onChange={(v) => setTimeWindows((s) => s ? { ...s, nse: { ...s.nse, noTradeLastMinutes: v } } : s)}
              min={0}
              max={120}
              suffix="min"
            />
          </div>
          <div className="flex items-center justify-between">
            <FieldLabel hint="Pause trading during lunch break">
              Lunch Break Pause
            </FieldLabel>
            <ToggleSwitch
              checked={timeWindows.nse.lunchBreakPause}
              onChange={(v) => setTimeWindows((s) => s ? { ...s, nse: { ...s.nse, lunchBreakPause: v } } : s)}
            />
          </div>
          {timeWindows.nse.lunchBreakPause && (
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <FieldLabel>Start</FieldLabel>
                <TimeInput
                  value={timeWindows.nse.lunchBreakStart}
                  onChange={(v) => setTimeWindows((s) => s ? { ...s, nse: { ...s.nse, lunchBreakStart: v } } : s)}
                />
              </div>
              <div className="flex items-center gap-2">
                <FieldLabel>End</FieldLabel>
                <TimeInput
                  value={timeWindows.nse.lunchBreakEnd}
                  onChange={(v) => setTimeWindows((s) => s ? { ...s, nse: { ...s.nse, lunchBreakEnd: v } } : s)}
                />
              </div>
            </div>
          )}
        </div>
      </SettingsCard>

      {/* MCX */}
      <SettingsCard title="MCX (Multi Commodity Exchange)">
        <div className="space-y-1 mb-3">
          <span className="text-[10px] text-muted-foreground">Regular session: 9:00 AM – 11:30 PM IST</span>
        </div>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <FieldLabel hint="No trading for first N minutes after market open">
              No-Trade First
            </FieldLabel>
            <NumberInput
              value={timeWindows.mcx.noTradeFirstMinutes}
              onChange={(v) => setTimeWindows((s) => s ? { ...s, mcx: { ...s.mcx, noTradeFirstMinutes: v } } : s)}
              min={0}
              max={120}
              suffix="min"
            />
          </div>
          <div className="flex items-center justify-between">
            <FieldLabel hint="No trading for last N minutes before market close">
              No-Trade Last
            </FieldLabel>
            <NumberInput
              value={timeWindows.mcx.noTradeLastMinutes}
              onChange={(v) => setTimeWindows((s) => s ? { ...s, mcx: { ...s.mcx, noTradeLastMinutes: v } } : s)}
              min={0}
              max={120}
              suffix="min"
            />
          </div>
        </div>
      </SettingsCard>

      <div className="flex items-center gap-2 p-2 rounded bg-info-cyan/5 border border-info-cyan/20">
        <Info className="h-3.5 w-3.5 text-info-cyan shrink-0" />
        <span className="text-[10px] text-info-cyan">
          Lunch break pause applies only to NSE. MCX has no scheduled lunch break.
        </span>
      </div>

      <div className="flex items-center gap-2 justify-end">
        <ResetButton onClick={handleReset} />
        <SaveButton onClick={handleSave} loading={updateMutation.isPending} />
      </div>
    </div>
  );
}

function ExpiryControlsSection() {
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
    <div className="space-y-4">
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

      <div className="flex items-center gap-2 justify-end">
        <ResetButton onClick={handleReset} />
        <SaveButton onClick={handleSave} loading={updateMutation.isPending} />
      </div>
    </div>
  );
}

function ChargesSection() {
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
    <div className="space-y-4">
      <SettingsCard title="Indian Standard Charges (Options)">
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

      <div className="flex items-center gap-2 p-2 rounded bg-info-cyan/5 border border-info-cyan/20">
        <Info className="h-3.5 w-3.5 text-info-cyan shrink-0" />
        <span className="text-[10px] text-info-cyan">
          Charges are applied to all P&L calculations. Rates are based on Indian standard charges for Options trading via Dhan.
        </span>
      </div>

      <div className="flex items-center gap-2 justify-end">
        <ResetButton onClick={handleReset} />
        <SaveButton onClick={handleSave} loading={updateMutation.isPending} />
      </div>
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
            <div className="flex-1 min-w-0 max-w-2xl">
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
