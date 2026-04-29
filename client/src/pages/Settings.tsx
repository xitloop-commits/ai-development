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
import { useState, useEffect, useMemo, createContext, useContext, useRef } from 'react';
import { trpc } from '@/lib/trpc';
import { authHeaders } from '@/lib/internalAuth';
import { useCapital } from '@/contexts/CapitalContext';
import { Link } from 'wouter';
import { toast } from 'sonner';
import {
  ArrowLeft,
  Settings as SettingsIcon,
  ShieldCheck,
  Clock,
  CalendarClock,
  Receipt,
  Zap,
  Save,
  RotateCcw,
  ChevronRight,
  AlertTriangle,
  Info,
  Loader2,
  Landmark,
  Layers,
  Power,
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
  | 'tradingMode'
  | 'execution'
  | 'discipline'
  | 'executor'
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
  { id: 'tradingMode', label: 'Trading Mode', icon: Layers, description: 'Workspace modes and per-workspace kill switches' },
  { id: 'execution', label: 'Order Execution', icon: Zap, description: 'Entry offset, SL/TP, targets, trailing stop' },
  { id: 'discipline', label: 'Discipline', icon: ShieldCheck, description: 'Circuit breaker, trade limits, pre-trade gate, streaks' },
  { id: 'executor', label: 'Trade Executor', icon: Zap, description: 'AI Live lot cap, RCA exit thresholds, recovery polling' },
  { id: 'timeWindows', label: 'Time Windows', icon: Clock, description: 'NSE & MCX trading time restrictions' },
  { id: 'expiry', label: 'Expiry Controls', icon: CalendarClock, description: 'Per-instrument expiry day rules' },
  { id: 'charges', label: 'Charges', icon: Receipt, description: 'Brokerage, STT, GST, and other charge rates' },
  { id: 'capital', label: 'Capital Management', icon: Landmark, description: 'Reset initial capital, pool allocation' },
];

// ─── Page-level Actions Context ──────────────────────────────────
// Sections register their save / reset handlers here; the page header
// renders them at the top-right so save/reset is always one place.

export interface SettingsActions {
  onSave?: () => void;
  onReset?: () => void;
  saving?: boolean;
  /** When false, Save button is disabled (no dirty state). */
  canSave?: boolean;
}

export const SettingsActionsContext = createContext<{
  setActions: (a: SettingsActions | null) => void;
}>({ setActions: () => {} });

/**
 * Sections call this with their save / reset handlers; the Settings page
 * top-bar renders them at the right side. Pass `null` to clear (or
 * unmount).
 *
 * Stability: callbacks live in refs (read fresh on each invocation),
 * so callers can pass fresh function literals every render without
 * looping. The effect re-runs only when primitive flags (saving,
 * canSave) flip — that's when the header needs to repaint.
 */
export function useRegisterActions(actions: SettingsActions | null): void {
  const { setActions } = useContext(SettingsActionsContext);
  const onSaveRef = useRef(actions?.onSave);
  const onResetRef = useRef(actions?.onReset);
  // Always sync refs to the latest callbacks.
  onSaveRef.current = actions?.onSave;
  onResetRef.current = actions?.onReset;

  const saving = actions?.saving ?? false;
  const canSave = actions?.canSave;
  const hasSave = !!actions?.onSave;
  const hasReset = !!actions?.onReset;

  useEffect(() => {
    if (!hasSave && !hasReset) {
      setActions(null);
      return;
    }
    setActions({
      onSave: hasSave ? () => onSaveRef.current?.() : undefined,
      onReset: hasReset ? () => onResetRef.current?.() : undefined,
      saving,
      canSave,
    });
    return () => setActions(null);
  }, [hasSave, hasReset, saving, canSave, setActions]);
}

// ─── Helper Components ───────────────────────────────────────────

function FieldLabel({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <label className="text-[0.6875rem] font-bold tracking-wider uppercase text-muted-foreground">
        {children}
      </label>
      {hint && (
        <span className="text-[0.5625rem] text-muted-foreground/70">{hint}</span>
      )}
    </div>
  );
}

function SettingsCard({ title, children, className = '' }: { title?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`border border-border rounded-md bg-card p-4 ${className}`}>
      {title && (
        <h3 className="text-[0.6875rem] font-bold tracking-wider uppercase text-muted-foreground mb-3 pb-2 border-b border-border">
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

// ─── Number to Indian words ─────────────────────────────────

const _ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const _tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function numberToWords(n: number): string {
  if (n === 0) return 'Zero';
  if (n < 0) return 'Minus ' + numberToWords(-n);
  n = Math.floor(n);
  const parts: string[] = [];

  if (n >= 1_00_00_000) {
    parts.push(numberToWords(Math.floor(n / 1_00_00_000)) + ' Crore');
    n %= 1_00_00_000;
  }
  if (n >= 1_00_000) {
    parts.push(numberToWords(Math.floor(n / 1_00_000)) + ' Lakh');
    n %= 1_00_000;
  }
  if (n >= 1_000) {
    parts.push(numberToWords(Math.floor(n / 1_000)) + ' Thousand');
    n %= 1_000;
  }
  if (n >= 100) {
    parts.push(_ones[Math.floor(n / 100)] + ' Hundred');
    n %= 100;
  }
  if (n >= 20) {
    parts.push(_tens[Math.floor(n / 10)] + (n % 10 ? ' ' + _ones[n % 10] : ''));
  } else if (n > 0) {
    parts.push(_ones[n]);
  }
  return parts.join(' ');
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
  const [raw, setRaw] = useState(String(value));
  useEffect(() => { setRaw(String(value)); }, [value]);

  return (
    <div className={`flex items-center gap-1.5 ${className}`}>
      <input
        type="number"
        value={raw}
        onChange={(e) => {
          setRaw(e.target.value);
          const v = parseFloat(e.target.value);
          if (!isNaN(v)) {
            if (min !== undefined && v < min) return;
            if (max !== undefined && v > max) return;
            onChange(v);
          }
        }}
        onBlur={() => {
          const v = parseFloat(raw);
          if (isNaN(v) || (min !== undefined && v < min)) {
            setRaw(String(min ?? value));
            onChange(min ?? value);
          }
        }}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        className="w-20 h-8 px-2 text-[0.6875rem] bg-background border border-border rounded text-foreground tabular-nums focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed"
      />
      {suffix && (
        <span className="text-[0.625rem] text-muted-foreground">{suffix}</span>
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
      className="h-8 px-2 text-[0.6875rem] bg-background border border-border rounded text-foreground focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
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
      className="h-8 px-2 text-[0.6875rem] bg-background border border-border rounded text-foreground focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed"
    />
  );
}

export function SaveButton({ onClick, loading, disabled }: { onClick: () => void; loading: boolean; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={loading || disabled}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[0.625rem] font-bold tracking-wider uppercase bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
      {loading ? 'SAVING...' : 'SAVE'}
    </button>
  );
}

export function ResetButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[0.625rem] font-bold tracking-wider uppercase border border-border text-muted-foreground hover:bg-accent transition-colors"
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
    // Default quantity for quick order
    defaultQty: 1,
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
        defaultQty: (config.settings as any).defaultQty ?? prev.defaultQty,
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
        defaultQty: settings.defaultQty,
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
        defaultQty: (config.settings as any).defaultQty ?? 1,
      });
    }
  };

  useRegisterActions(
    config
      ? {
          onSave: handleSave,
          onReset: handleReset,
          saving: updateMutation.isPending,
        }
      : null,
  );

  if (!config) {
    return (
      <SettingsCard>
        <p className="text-[0.6875rem] text-muted-foreground">No broker configured. Set up a broker first.</p>
      </SettingsCard>
    );
  }

  return (
    <div className="grid gap-4 items-start" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))" }}>
      {/* Daily Target */}
      <SettingsCard title="Daily Target">
        <div className="space-y-1 mb-3">
          <span className="text-[0.625rem] text-muted-foreground">
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
          <div className="flex items-center justify-between">
            <FieldLabel hint="Default quantity in lots for quick order popup">
              Default Qty (lots)
            </FieldLabel>
            <NumberInput
              value={settings.defaultQty}
              onChange={(v) => setSettings((s) => ({ ...s, defaultQty: v }))}
              min={1}
              max={100}
              step={1}
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
    <div className="grid gap-4 items-start" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))" }}>
      {/* Current Capital Overview */}
      <SettingsCard title="Current Capital" className="col-span-full">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-background border border-border rounded p-2.5 text-center">
            <div className="text-[0.5625rem] text-muted-foreground uppercase tracking-wider">Initial Funding</div>
            <div className="text-[0.8125rem] font-mono text-foreground mt-1 font-bold">{fmt(capital.initialFunding)}</div>
          </div>
          <div className="bg-background border border-border rounded p-2.5 text-center">
            <div className="text-[0.5625rem] text-muted-foreground uppercase tracking-wider">Trading Pool</div>
            <div className="text-[0.8125rem] font-mono text-primary mt-1 font-bold">{fmt(capital.tradingPool)}</div>
          </div>
          <div className="bg-background border border-border rounded p-2.5 text-center">
            <div className="text-[0.5625rem] text-muted-foreground uppercase tracking-wider">Reserve Pool</div>
            <div className="text-[0.8125rem] font-mono text-foreground mt-1 font-bold">{fmt(capital.reservePool)}</div>
          </div>
          <div className="bg-background border border-border rounded p-2.5 text-center">
            <div className="text-[0.5625rem] text-muted-foreground uppercase tracking-wider">Net Worth</div>
            <div className="text-[0.8125rem] font-mono text-foreground mt-1 font-bold">{fmt(capital.netWorth)}</div>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-3">
          <div className="bg-background border border-border rounded p-2.5 text-center">
            <div className="text-[0.5625rem] text-muted-foreground uppercase tracking-wider">Day Index</div>
            <div className="text-[0.8125rem] font-mono text-foreground mt-1 font-bold">{capital.currentDayIndex}</div>
          </div>
          <div className="bg-background border border-border rounded p-2.5 text-center">
            <div className="text-[0.5625rem] text-muted-foreground uppercase tracking-wider">Cumulative P&L</div>
            <div className={`text-[0.8125rem] font-mono mt-1 font-bold ${capital.cumulativePnl >= 0 ? 'text-bullish' : 'text-bearish'}`}>
              {capital.cumulativePnl >= 0 ? '+' : ''}{fmt(capital.cumulativePnl)}
            </div>
          </div>
          <div className="bg-background border border-border rounded p-2.5 text-center">
            <div className="text-[0.5625rem] text-muted-foreground uppercase tracking-wider">Total Charges</div>
            <div className="text-[0.8125rem] font-mono text-muted-foreground mt-1 font-bold">{fmt(capital.cumulativeCharges)}</div>
          </div>
        </div>
      </SettingsCard>

      {/* Pool Allocation Info */}
      <SettingsCard title="Pool Allocation">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[0.625rem] text-muted-foreground">Trading Pool share</span>
            <span className="text-[0.6875rem] font-mono text-foreground font-bold">75%</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[0.625rem] text-muted-foreground">Reserve Pool share</span>
            <span className="text-[0.6875rem] font-mono text-foreground font-bold">25%</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[0.625rem] text-muted-foreground">Daily Target</span>
            <span className="text-[0.6875rem] font-mono text-primary font-bold">{capital.targetPercent}%</span>
          </div>
        </div>
        <div className="mt-3 pt-2 border-t border-border">
          <span className="text-[0.5625rem] text-muted-foreground">
            New capital injections and profit distributions follow the 75/25 split.
            Losses are absorbed entirely by the Trading Pool.
          </span>
        </div>
      </SettingsCard>

      {/* Reset Initial Capital */}
      <SettingsCard title="Reset Initial Capital" className="border-destructive/30">
        <div className="space-y-3">
          {hasCycleStarted && (
            <div className="flex items-center gap-2 p-2 rounded bg-destructive/10 border border-destructive/30">
              <AlertTriangle className="h-3.5 w-3.5 text-destructive shrink-0" />
              <span className="text-[0.625rem] text-destructive">
                You are on Day {capital.currentDayIndex} with active data. Resetting will delete all day records and trades permanently.
              </span>
            </div>
          )}
            <>
              <div className="space-y-1">
                <span className="text-[0.625rem] text-muted-foreground">
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
                  suffix="₹"
                />
              </div>

              {/* Entered value in words */}
              <div className="text-[0.625rem] text-muted-foreground italic">
                Rupees {numberToWords(newFunding)} Only
              </div>

              {/* Preview of what reset will create */}
              <div className="flex items-center gap-2 text-[0.5625rem] text-muted-foreground">
                <AlertTriangle className="h-3 w-3 text-warning-amber shrink-0" />
                <span>
                  After reset: Trading Pool = {fmt(newFunding * 0.75)}, Reserve Pool = {fmt(newFunding * 0.25)}, Day Index = 1
                </span>
              </div>

              {/* Reset button triggers confirmation dialog */}
              <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
                <AlertDialogTrigger asChild>
                  <button
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[0.625rem] font-bold tracking-wider uppercase border border-destructive/40 text-destructive hover:bg-destructive/10 transition-colors"
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
                    <AlertDialogDescription className="text-[0.6875rem] text-muted-foreground space-y-2">
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
                    <label className="text-[0.625rem] font-bold tracking-wider uppercase text-muted-foreground">
                      Type <span className="text-destructive">RESET</span> to confirm
                    </label>
                    <input
                      type="text"
                      value={confirmText}
                      onChange={(e) => setConfirmText(e.target.value)}
                      placeholder="RESET"
                      className="w-full h-8 px-2 text-[0.6875rem] bg-background border border-border rounded text-foreground font-mono tracking-widest focus:outline-none focus:ring-1 focus:ring-destructive"
                      autoFocus
                    />
                  </div>

                  <AlertDialogFooter>
                    <AlertDialogCancel
                      onClick={() => setConfirmText('')}
                      className="text-[0.625rem] h-8"
                    >
                      Cancel
                    </AlertDialogCancel>
                    <button
                      onClick={handleReset}
                      disabled={confirmText !== 'RESET' || resetCapitalPending}
                      className="flex items-center gap-1.5 px-4 py-1.5 rounded text-[0.625rem] font-bold tracking-wider uppercase bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed h-8"
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
        </div>
      </SettingsCard>
    </div>
  );
}

// ─── Mode Segmented Button ────────────────────────────────────────

function ModeToggle<T extends string>({
  value,
  options,
  onChange,
  disabled = false,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className={`flex rounded-md border border-border overflow-hidden ${disabled ? 'opacity-50' : ''}`}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          disabled={disabled}
          onClick={() => onChange(opt.value)}
          className={`px-3 py-1 text-[0.625rem] font-bold tracking-wider uppercase transition-colors ${
            value === opt.value
              ? 'bg-primary text-primary-foreground'
              : 'bg-background text-muted-foreground hover:bg-accent hover:text-foreground'
          } ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// ─── Trading Mode Section ─────────────────────────────────────────

export function TradingModeSection() {
  const settingsQuery = trpc.settings.get.useQuery();
  const updateModeMutation = trpc.settings.updateTradingMode.useMutation({
    onSuccess: () => {
      toast.success('Trading mode updated');
      settingsQuery.refetch();
    },
    onError: (err) => toast.error(err.message),
  });
  const killSwitchMutation = trpc.broker.killSwitch.useMutation({
    onSuccess: () => {
      settingsQuery.refetch();
    },
    onError: (err) => toast.error(`Kill switch error: ${err.message}`),
  });

  const tm = settingsQuery.data?.tradingMode;

  const handleMode = (field: 'aiTradesMode' | 'myTradesMode' | 'testingMode', value: string) => {
    updateModeMutation.mutate({ [field]: value } as any);
  };

  const handleKillSwitch = (workspace: 'ai' | 'my' | 'testing', active: boolean) => {
    killSwitchMutation.mutate({ workspace, action: active ? 'ACTIVATE' : 'DEACTIVATE' });
  };

  const isLoading = settingsQuery.isLoading;

  return (
    <div className="space-y-4">
      {/* AI Trades Workspace */}
      <SettingsCard title="AI Trades">
        <div className="space-y-4">
          <p className="text-[0.5625rem] text-muted-foreground">
            Mode toggle moved to the AppBar tab. Use the LIVE/PAPER pill on the active AI Trades tab to switch.
            A confirmation dialog appears on every switch.
          </p>

          <div className="flex items-center justify-between pt-3 border-t border-border">
            <div>
              <FieldLabel hint="Blocks new orders on ai-live. Cancel and exit always bypass.">
                AI Kill Switch
              </FieldLabel>
              {tm?.aiKillSwitch && (
                <span className="text-[0.5625rem] text-destructive font-bold tracking-wider">● ACTIVE — ai-live blocked</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {tm?.aiKillSwitch && (
                <span className="text-[0.5625rem] px-2 py-0.5 rounded bg-destructive/10 text-destructive border border-destructive/30 font-bold tracking-wider uppercase">
                  HALTED
                </span>
              )}
              <ToggleSwitch
                checked={tm?.aiKillSwitch ?? false}
                onChange={(v) => handleKillSwitch('ai', v)}
                disabled={killSwitchMutation.isPending || isLoading}
              />
            </div>
          </div>
        </div>
      </SettingsCard>

      {/* My Trades Workspace */}
      <SettingsCard title="My Trades">
        <div className="space-y-4">
          <p className="text-[0.5625rem] text-muted-foreground">
            Mode toggle moved to the AppBar tab. Use the LIVE/PAPER pill on the active My Trades tab to switch.
          </p>

          <div className="flex items-center justify-between pt-3 border-t border-border">
            <div>
              <FieldLabel hint="Blocks new orders on my-live. Cancel and exit always bypass.">
                My Kill Switch
              </FieldLabel>
              {tm?.myKillSwitch && (
                <span className="text-[0.5625rem] text-destructive font-bold tracking-wider">● ACTIVE — my-live blocked</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {tm?.myKillSwitch && (
                <span className="text-[0.5625rem] px-2 py-0.5 rounded bg-destructive/10 text-destructive border border-destructive/30 font-bold tracking-wider uppercase">
                  HALTED
                </span>
              )}
              <ToggleSwitch
                checked={tm?.myKillSwitch ?? false}
                onChange={(v) => handleKillSwitch('my', v)}
                disabled={killSwitchMutation.isPending || isLoading}
              />
            </div>
          </div>
        </div>
      </SettingsCard>

      {/* Testing Workspace */}
      <SettingsCard title="Testing">
        <div className="space-y-4">
          <p className="text-[0.5625rem] text-muted-foreground">
            Mode toggle moved to the AppBar tab. Use the LIVE/SANDBOX pill on the active Testing tab to switch.
          </p>

          <div className="flex items-center justify-between pt-3 border-t border-border">
            <div>
              <FieldLabel hint="Blocks new orders on testing-live only. Sandbox is never affected.">
                Testing Kill Switch
              </FieldLabel>
              {tm?.testingKillSwitch && (
                <span className="text-[0.5625rem] text-destructive font-bold tracking-wider">● ACTIVE — testing-live blocked</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {tm?.testingKillSwitch && (
                <span className="text-[0.5625rem] px-2 py-0.5 rounded bg-destructive/10 text-destructive border border-destructive/30 font-bold tracking-wider uppercase">
                  HALTED
                </span>
              )}
              <ToggleSwitch
                checked={tm?.testingKillSwitch ?? false}
                onChange={(v) => handleKillSwitch('testing', v)}
                disabled={killSwitchMutation.isPending || isLoading}
              />
            </div>
          </div>
        </div>
      </SettingsCard>

      {/* Info note */}
      <div className="flex items-start gap-2 p-3 rounded-md bg-muted/30 border border-border">
        <Info className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
        <p className="text-[0.625rem] text-muted-foreground leading-relaxed">
          Kill switches are <strong className="text-foreground">independent</strong> — activating AI kill switch does not affect My Trades or Testing.
          Kill switches only block live channels — paper and sandbox channels are never blocked.
          State persists across server restarts.
        </p>
      </div>
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

  useRegisterActions(
    ds
      ? { onSave: handleSave, onReset: handleReset, saving: updateMutation.isPending }
      : null,
  );

  if (!ds) {
    return (
      <SettingsCard>
        <div className="flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          <span className="text-[0.6875rem] text-muted-foreground">Loading discipline settings...</span>
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
    <div className="grid gap-4 items-start" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))" }}>
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
                          className={`px-2.5 py-1 rounded text-[0.625rem] font-bold tracking-wider uppercase border transition-colors ${
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

      {/* Capital Protection — IV Classifier (Module 8 follow-up) */}
      <SettingsCard title="IV Classifier">
        <p className="text-[0.6875rem] text-muted-foreground/80 leading-relaxed mb-3">
          Tunables for the option-chain IV regime classifier. RCA samples
          ATM IV on every Fetcher push and tags it cheap / fair / expensive
          relative to a rolling history. DA's carry-forward eval reads
          the label to decide whether long-premium positions can stay
          overnight. Saving here pushes the new tunables into RCA
          immediately — no restart needed.
        </p>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <FieldLabel hint="# of recent ATM IV samples kept per instrument">History Window</FieldLabel>
            <NumberInput
              value={ds.capitalProtection?.iv?.historyWindow ?? 500}
              onChange={(v) => upd('capitalProtection.iv.historyWindow', v)}
              min={20}
              max={5000}
              step={50}
            />
          </div>
          <div className="flex items-center justify-between">
            <FieldLabel hint="Min samples before a non-null label is returned">Min Samples</FieldLabel>
            <NumberInput
              value={ds.capitalProtection?.iv?.minSamples ?? 50}
              onChange={(v) => upd('capitalProtection.iv.minSamples', v)}
              min={5}
              max={2000}
              step={5}
            />
          </div>
          <div className="flex items-center justify-between">
            <FieldLabel hint="Current IV at or below this percentile → cheap">Cheap Percentile</FieldLabel>
            <NumberInput
              value={ds.capitalProtection?.iv?.cheapPercentile ?? 25}
              onChange={(v) => upd('capitalProtection.iv.cheapPercentile', v)}
              min={0}
              max={100}
              step={5}
              suffix="%"
            />
          </div>
          <div className="flex items-center justify-between">
            <FieldLabel hint="Current IV at or above this percentile → expensive">Expensive Percentile</FieldLabel>
            <NumberInput
              value={ds.capitalProtection?.iv?.expensivePercentile ?? 75}
              onChange={(v) => upd('capitalProtection.iv.expensivePercentile', v)}
              min={0}
              max={100}
              step={5}
              suffix="%"
            />
          </div>
        </div>
      </SettingsCard>
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

  useRegisterActions(
    tw ? { onSave: handleSave, onReset: handleReset, saving: updateMutation.isPending } : null,
  );

  if (!tw) {
    return (
      <SettingsCard>
        <div className="flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          <span className="text-[0.6875rem] text-muted-foreground">Loading time window settings...</span>
        </div>
      </SettingsCard>
    );
  }

  return (
    <div className="grid gap-4 items-start" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))" }}>
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
        <span className="text-[0.625rem] text-info-cyan">
          Time windows are enforced by the Discipline Agent. Lunch break pause applies only to NSE. MCX has no scheduled lunch break.
        </span>
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

  useRegisterActions(
    rules ? { onSave: handleSave, onReset: handleReset, saving: updateMutation.isPending } : null,
  );

  if (!rules) {
    return (
      <SettingsCard>
        <div className="flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          <span className="text-[0.6875rem] text-muted-foreground">Loading expiry settings...</span>
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
    <div className="grid gap-4 items-start" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))" }}>
      {rules.map((rule, idx) => (
        <SettingsCard key={rule.instrument}>
          <div className="flex items-center gap-2 mb-3 pb-2 border-b border-border">
            <span className={`text-[0.6875rem] font-bold tracking-wider uppercase px-2 py-0.5 rounded border ${instrumentColors[rule.instrument] ?? 'text-foreground border-border'}`}>
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

  useRegisterActions(
    rates ? { onSave: handleSave, onReset: handleReset, saving: updateMutation.isPending } : null,
  );

  if (!rates) {
    return (
      <SettingsCard>
        <div className="flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          <span className="text-[0.6875rem] text-muted-foreground">Loading charge rates...</span>
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
    <div className="grid gap-4 items-start" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))" }}>
      <SettingsCard title="Indian Standard Charges (Options)" className="col-span-full">
        <div className="space-y-1 mb-3">
          <span className="text-[0.625rem] text-muted-foreground">
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
                    <span className={`text-[0.6875rem] font-bold tracking-wider ${charge.enabled ? 'text-foreground' : 'text-muted-foreground line-through'}`}>
                      {charge.name}
                    </span>
                    <p className="text-[0.5625rem] text-muted-foreground">{charge.description}</p>
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
                  className="w-24 h-7 px-2 text-[0.6875rem] bg-background border border-border rounded text-foreground tabular-nums text-right focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <span className="text-[0.5625rem] text-muted-foreground w-20 text-right">
                  {unitLabels[charge.unit] ?? charge.unit}
                </span>
              </div>
            </div>
          ))}
        </div>
      </SettingsCard>

      <div className="col-span-full flex items-center gap-2 p-2 rounded bg-info-cyan/5 border border-info-cyan/20">
        <Info className="h-3.5 w-3.5 text-info-cyan shrink-0" />
        <span className="text-[0.625rem] text-info-cyan">
          Charges are applied to all P&L calculations. Rates are based on Indian standard charges for Options trading via Dhan.
        </span>
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
      const response = await fetch(`/api/trading/search-instruments?${params}`, {
        headers: { ...authHeaders() },
      });
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
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
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
        headers: { ...authHeaders() },
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
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
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
          <div className="text-[0.625rem] text-muted-foreground">
            {instruments.length} instrument{instruments.length !== 1 ? 's' : ''} configured
          </div>
        </div>
        <div className="space-y-2 max-h-64 overflow-y-auto">
          {instruments.length === 0 ? (
            <span className="text-[0.6875rem] text-muted-foreground">No instruments configured</span>
          ) : (
            instruments.map((inst: any) => (
              <div key={inst.key} className="flex items-center justify-between gap-3 p-2 rounded border border-border text-[0.6875rem]">
                <div className="flex-1 min-w-0">
                  <div className="font-bold">{inst.displayName}</div>
                  <div className="text-[0.5625rem] text-muted-foreground">{inst.exchange} • {inst.exchangeSegment}</div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {inst.isDefault && (
                    <span className="px-2 py-0.5 text-[0.5625rem] bg-primary/10 text-primary rounded">default</span>
                  )}
                  {hotKeyAssignMode === inst.key ? (
                    <input
                      autoFocus
                      onKeyDown={(e) => handleHotKeyPress(e, inst.key)}
                      onBlur={() => setHotKeyAssignMode(null)}
                      placeholder="Press key..."
                      className="w-12 px-1 py-0.5 text-[0.625rem] text-center bg-background border border-primary rounded text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  ) : (
                    <>
                      {inst.hotkey && (
                        <span className="px-2 py-0.5 text-[0.625rem] bg-accent/20 text-accent-foreground rounded font-mono font-bold">
                          {inst.hotkey.toUpperCase()}
                        </span>
                      )}
                      <button
                        onClick={() => setHotKeyAssignMode(inst.key)}
                        disabled={isAssigningHotkey}
                        className="px-2 py-1 text-[0.625rem] rounded border border-primary/30 text-primary hover:bg-primary/5 disabled:opacity-50"
                        title="Assign hotkey"
                      >
                        {inst.hotkey ? 'Change' : 'Set'} Key
                      </button>
                    </>
                  )}
                  <button
                    onClick={() => handleRemoveInstrument(inst.key)}
                    disabled={inst.isDefault || isRemoving}
                    className="px-2 py-1 text-[0.625rem] rounded border border-destructive/30 text-destructive hover:bg-destructive/5 disabled:opacity-50 disabled:cursor-not-allowed"
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
          className="w-full py-2 px-4 text-[0.6875rem] font-bold tracking-wider uppercase rounded border border-primary/30 text-primary hover:bg-primary/5 transition-colors"
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
                className="flex-1 h-7 px-2 text-[0.6875rem] bg-background border border-border rounded text-foreground placeholder-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <select
                value={searchExchange}
                onChange={(e) => setSearchExchange(e.target.value as any)}
                className="h-7 px-2 text-[0.6875rem] bg-background border border-border rounded text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <option>ALL</option>
                <option>NSE</option>
                <option>MCX</option>
                <option>BSE</option>
              </select>
              <button
                onClick={handleSearch}
                disabled={isSearching}
                className="px-3 py-1 text-[0.6875rem] font-bold rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {isSearching ? '⟳' : 'Search'}
              </button>
            </div>

            {searchResults.length > 0 && (
              <div className="border border-border rounded p-2 space-y-1 max-h-48 overflow-y-auto">
                {searchResults.map((result: any, idx: number) => (
                  <div key={idx} className="flex items-center justify-between gap-2 p-1.5 text-[0.625rem] rounded hover:bg-muted">
                    <div className="flex-1 min-w-0">
                      <div className="font-mono">{result.tradingSymbol}</div>
                      <div className="text-muted-foreground">{result.exchange} • {result.instrumentName}</div>
                    </div>
                    <button
                      onClick={() => handleAddInstrument(result)}
                      disabled={isAdding}
                      className="px-2 py-0.5 text-[0.5625rem] rounded bg-primary/10 text-primary hover:bg-primary/20 disabled:opacity-50"
                    >
                      Add
                    </button>
                  </div>
                ))}
              </div>
            )}

            <button
              onClick={() => setShowSearch(false)}
              className="w-full py-1.5 text-[0.625rem] text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </SettingsCard>
      )}
    </div>
  );
}

// ─── Trade Executor Settings Section ────────────────────────────

function ExecutorSettingsSection() {
  const utils = trpc.useUtils();
  const settingsQuery = trpc.executor.getSettings.useQuery();
  const updateMutation = trpc.executor.updateSettings.useMutation({
    onSuccess: () => {
      toast.success('Executor settings saved');
      utils.executor.getSettings.invalidate();
    },
    onError: (err: any) => toast.error(`Save failed: ${err.message}`),
  });

  const settings = settingsQuery.data;
  type ExecutorDraft = {
    aiLiveLotCap: number;
    rcaMaxAgeMs: number;
    rcaStaleTickMs: number;
    rcaVolThreshold: number;
    recoveryStuckMs: number;
    rcaChannels: string[];
    recoveryChannels: string[];
  };
  const [draft, setDraft] = useState<ExecutorDraft | null>(null);

  // Hydrate the draft from the server response once.
  useEffect(() => {
    if (settings && !draft) {
      setDraft({
        aiLiveLotCap: settings.aiLiveLotCap,
        rcaMaxAgeMs: settings.rcaMaxAgeMs,
        rcaStaleTickMs: settings.rcaStaleTickMs,
        rcaVolThreshold: settings.rcaVolThreshold,
        recoveryStuckMs: settings.recoveryStuckMs,
        rcaChannels: settings.rcaChannels,
        recoveryChannels: settings.recoveryChannels,
      });
    }
  }, [settings, draft]);

  if (settingsQuery.isLoading || !draft) {
    return (
      <div className="text-xs text-muted-foreground font-mono">Loading executor settings…</div>
    );
  }

  const arrayEq = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((v, i) => v === b[i]);

  const dirty =
    settings &&
    (draft.aiLiveLotCap !== settings.aiLiveLotCap ||
      draft.rcaMaxAgeMs !== settings.rcaMaxAgeMs ||
      draft.rcaStaleTickMs !== settings.rcaStaleTickMs ||
      draft.rcaVolThreshold !== settings.rcaVolThreshold ||
      draft.recoveryStuckMs !== settings.recoveryStuckMs ||
      !arrayEq(draft.rcaChannels, settings.rcaChannels) ||
      !arrayEq(draft.recoveryChannels, settings.recoveryChannels));

  const onSave = () => updateMutation.mutate(draft as any);
  const onReset = () => {
    if (settings) {
      setDraft({
        aiLiveLotCap: settings.aiLiveLotCap,
        rcaMaxAgeMs: settings.rcaMaxAgeMs,
        rcaStaleTickMs: settings.rcaStaleTickMs,
        rcaVolThreshold: settings.rcaVolThreshold,
        recoveryStuckMs: settings.recoveryStuckMs,
        rcaChannels: settings.rcaChannels,
        recoveryChannels: settings.recoveryChannels,
      });
    }
  };

  useRegisterActions({
    onSave,
    onReset,
    saving: updateMutation.isPending,
    canSave: !!dirty,
  });

  const allChannels: Array<{ id: string; label: string }> = [
    { id: 'ai-paper', label: 'AI Paper' },
    { id: 'ai-live', label: 'AI Live' },
    { id: 'my-paper', label: 'My Paper' },
    { id: 'my-live', label: 'My Live' },
    { id: 'testing-sandbox', label: 'Testing Sandbox' },
    { id: 'testing-live', label: 'Testing Live' },
  ];
  const toggleArr = (arr: string[], v: string): string[] =>
    arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];

  return (
    <div className="grid gap-4 items-start font-mono" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))" }}>
      <SettingsCard title="AI Live Lot Cap">
        <p className="text-[0.6875rem] text-muted-foreground/80 leading-relaxed mb-3">
          Hard cap on the number of lots any single ai-live trade may place.
          Canary launches at 1; raise after the 30-day comparison clears.
        </p>
        <div className="flex items-center gap-3">
          <FieldLabel hint="lots">AI_LIVE_LOT_CAP</FieldLabel>
          <input
            type="number"
            min={1}
            max={100}
            value={draft.aiLiveLotCap}
            onChange={(e) => setDraft({ ...draft, aiLiveLotCap: Math.max(1, parseInt(e.target.value) || 1) })}
            className="w-20 px-2 py-1 text-xs font-mono bg-background border border-border rounded text-foreground tabular-nums"
          />
        </div>
      </SettingsCard>

      <SettingsCard title="RCA Exit Triggers">
        <p className="text-[0.6875rem] text-muted-foreground/80 leading-relaxed mb-3">
          When the Risk Control Agent triggers an exit on AI positions.
          Lower thresholds = more aggressive exits.
        </p>
        <div className="grid grid-cols-2 gap-x-6 gap-y-3">
          <div className="flex flex-col gap-1">
            <FieldLabel hint="minutes">Max Position Age</FieldLabel>
            <input
              type="number"
              min={1}
              max={1440}
              value={Math.round(draft.rcaMaxAgeMs / 60_000)}
              onChange={(e) => setDraft({ ...draft, rcaMaxAgeMs: Math.max(1, parseInt(e.target.value) || 1) * 60_000 })}
              className="w-24 px-2 py-1 text-xs font-mono bg-background border border-border rounded text-foreground tabular-nums"
            />
          </div>
          <div className="flex flex-col gap-1">
            <FieldLabel hint="minutes — exit if no tick">Stale-Price Window</FieldLabel>
            <input
              type="number"
              min={1}
              max={60}
              value={Math.round(draft.rcaStaleTickMs / 60_000)}
              onChange={(e) => setDraft({ ...draft, rcaStaleTickMs: Math.max(1, parseInt(e.target.value) || 1) * 60_000 })}
              className="w-24 px-2 py-1 text-xs font-mono bg-background border border-border rounded text-foreground tabular-nums"
            />
          </div>
          <div className="flex flex-col gap-1">
            <FieldLabel hint="0..2 — predicted max-drawdown trigger">Volatility Threshold</FieldLabel>
            <input
              type="number"
              min={0}
              max={2}
              step={0.05}
              value={draft.rcaVolThreshold}
              onChange={(e) => setDraft({ ...draft, rcaVolThreshold: parseFloat(e.target.value) || 0 })}
              className="w-24 px-2 py-1 text-xs font-mono bg-background border border-border rounded text-foreground tabular-nums"
            />
          </div>
        </div>
      </SettingsCard>

      <SettingsCard title="Order Recovery">
        <p className="text-[0.6875rem] text-muted-foreground/80 leading-relaxed mb-3">
          When the recovery engine polls the broker for stuck PENDING
          live orders. Lower = more polling, faster recovery, more API calls.
        </p>
        <div className="flex items-center gap-3">
          <FieldLabel hint="seconds — minimum age before polling">Stuck Threshold</FieldLabel>
          <input
            type="number"
            min={10}
            max={600}
            value={Math.round(draft.recoveryStuckMs / 1000)}
            onChange={(e) => setDraft({ ...draft, recoveryStuckMs: Math.max(10, parseInt(e.target.value) || 10) * 1000 })}
            className="w-24 px-2 py-1 text-xs font-mono bg-background border border-border rounded text-foreground tabular-nums"
          />
        </div>
      </SettingsCard>

      <SettingsCard title="Monitored Channels">
        <p className="text-[0.6875rem] text-muted-foreground/80 leading-relaxed mb-3">
          Which channels RCA watches for risk-driven exits, and which
          channels Recovery polls for stuck PENDING orders. Add ai-live
          to RCA when the canary launches.
        </p>
        <div className="space-y-3">
          <div>
            <FieldLabel hint="age / stale / momentum / volatility exits">RCA Monitor</FieldLabel>
            <div className="flex flex-wrap gap-1.5 mt-2">
              {allChannels.map((c) => {
                const active = draft.rcaChannels.includes(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setDraft({ ...draft, rcaChannels: toggleArr(draft.rcaChannels, c.id) })}
                    className={`px-2 py-1 text-[0.625rem] font-bold tracking-wider uppercase rounded border ${
                      active
                        ? 'bg-primary/15 border-primary/40 text-primary'
                        : 'border-border text-muted-foreground hover:bg-accent'
                    }`}
                  >
                    {c.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <FieldLabel hint="poll broker for stuck PENDING orders (live channels only matter)">Recovery Engine</FieldLabel>
            <div className="flex flex-wrap gap-1.5 mt-2">
              {allChannels.map((c) => {
                const active = draft.recoveryChannels.includes(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setDraft({ ...draft, recoveryChannels: toggleArr(draft.recoveryChannels, c.id) })}
                    className={`px-2 py-1 text-[0.625rem] font-bold tracking-wider uppercase rounded border ${
                      active
                        ? 'bg-primary/15 border-primary/40 text-primary'
                        : 'border-border text-muted-foreground hover:bg-accent'
                    }`}
                  >
                    {c.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </SettingsCard>
    </div>
  );
}
