/**
 * QuickOrderPopup — compact horizontal popup for placing quick orders via hotkeys.
 * All inputs render in a single row. ATM strike, LTP, SL/Target auto-filled from live data.
 */
import { useState, useEffect, useMemo } from 'react';
import { X, Settings2, ChevronUp, ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import { trpc } from '../lib/trpc';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

// instrumentKey → option chain underlying symbol
const INSTRUMENT_UNDERLYING: Record<string, string> = {
  NIFTY_50: 'NIFTY',
  BANKNIFTY: 'BANKNIFTY',
  CRUDEOIL: 'CRUDEOIL',
  NATURALGAS: 'NATURALGAS',
};

const QTY_PRESETS = [1, 2, 3, 5, 10, 15, 20, 50];

type OptionType = 'CE' | 'PE';
type Direction = 'BUY' | 'SELL';

export interface QuickOrderData {
  instrument: string;              // instrumentKey e.g. "NIFTY_50"
  instrumentName?: string;         // display name e.g. "NIFTY 50"
  tradeType: 'CALL_BUY' | 'PUT_BUY' | 'CALL_SELL' | 'PUT_SELL';
  strike: number;
  entryPrice: number;
  quantity: number;
  lotSize?: number;
  stopLoss?: number;
  target?: number;
  tslEnabled?: boolean;
  contractSecurityId?: string | null; // option contract security ID for LTP feed
}

interface ResolvedInstrument {
  name: string;
  securityId: string;
  exchange: string;
}

interface QuickOrderPopupProps {
  isOpen: boolean;
  instrumentKey: string;
  instrumentName: string;
  resolvedInstruments?: ResolvedInstrument[];
  onClose: () => void;
  onSubmit: (data: QuickOrderData) => void;
  isLoading?: boolean;
}

export function QuickOrderPopup({
  isOpen,
  instrumentKey,
  instrumentName,
  resolvedInstruments,
  onClose,
  onSubmit,
  isLoading,
}: QuickOrderPopupProps) {
  const [optionType, setOptionType] = useState<OptionType>('CE');
  const [direction, setDirection] = useState<Direction>('BUY');
  const [strike, setStrike] = useState(0);
  const [entryPrice, setEntryPrice] = useState(0);
  const [qty, setQty] = useState(1);
  const [stopLoss, setStopLoss] = useState<number | undefined>();
  const [target, setTarget] = useState<number | undefined>();
  const [tslEnabled, setTslEnabled] = useState(false);
  const [isQtyPopoverOpen, setIsQtyPopoverOpen] = useState(false);

  const tradeType = `${optionType === 'CE' ? 'CALL' : 'PUT'}_${direction}` as QuickOrderData['tradeType'];
  const symbolUnderlying = INSTRUMENT_UNDERLYING[instrumentKey] ?? instrumentKey;

  // ── Remote Data ────────────────────────────────────────────────
  const configQuery = trpc.broker.config.get.useQuery(undefined);

  // Read-only data calls always go through real Dhan via getActiveBroker();
  // the isPaperBroker flag from broker_configs no longer applies. Send
  // securityId + exchangeSegment whenever the resolved instrument is
  // available so Dhan gets a numeric UnderlyingScrip.
  const resolvedInstrument = resolvedInstruments?.find((r) => r.name === instrumentKey);
  const underlying = resolvedInstrument?.securityId ?? symbolUnderlying;
  const exchangeSegment = resolvedInstrument?.exchange ?? undefined;

  const marginQuery = trpc.broker.margin.useQuery({ channel: "ai-live" as const }, {
    enabled: isOpen,
    refetchInterval: 15_000,
  });
  const expiryQuery = trpc.broker.expiryList.useQuery(
    { underlying, exchangeSegment },
    { enabled: isOpen && !!underlying }
  );
  const nearestExpiry = useMemo(() => {
    const expiries = expiryQuery.data ?? [];
    return [...expiries].sort(
      (a, b) => new Date(`${a}T00:00:00`).getTime() - new Date(`${b}T00:00:00`).getTime()
    )[0] ?? '';
  }, [expiryQuery.data]);

  const optionChainQuery = trpc.broker.optionChain.useQuery(
    { underlying, expiry: nearestExpiry, exchangeSegment },
    { enabled: isOpen && !!nearestExpiry, refetchInterval: 5_000 }
  );

  // ── Derived values ─────────────────────────────────────────────
  const settings = configQuery.data?.settings;
  const defaultSLPct = settings?.defaultSL ?? 2;
  const defaultTPPct = settings?.tradeTargetOptions ?? 30;
  const defaultQty = (settings as any)?.defaultQty ?? 1;

  const lotSize = optionChainQuery.data?.lotSize ?? 1;
  const totalUnits = qty * Math.max(lotSize, 1);
  const availableFund = marginQuery.data?.available ?? 0;
  const capitalRequired = entryPrice * totalUnits;

  const atmRow = useMemo(() => {
    const rows = optionChainQuery.data?.rows ?? [];
    if (rows.length === 0) return null;
    const spotPrice = optionChainQuery.data?.spotPrice ?? 0;
    let best = rows[0];
    let minDist = Infinity;
    for (const row of rows) {
      const dist = Math.abs(row.strike - spotPrice);
      if (dist < minDist) { minDist = dist; best = row; }
    }
    return best;
  }, [optionChainQuery.data]);

  // ── Effects ────────────────────────────────────────────────────

  // Reset form on open
  useEffect(() => {
    if (!isOpen) return;
    setOptionType('CE');
    setDirection('BUY');
    setQty(defaultQty);
    setEntryPrice(0);
    setStopLoss(undefined);
    setTarget(undefined);
    // Set strike immediately from cached ATM data (if available), otherwise 0 until query loads
    setStrike(atmRow?.strike ?? 0);
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // Init TSL from broker settings
  useEffect(() => {
    if (isOpen && settings?.trailingStopEnabled !== undefined) {
      setTslEnabled(settings.trailingStopEnabled);
    }
  }, [isOpen, settings?.trailingStopEnabled]);

  // Auto-fill ATM strike whenever option chain loads/updates (overrides the 0 from reset)
  useEffect(() => {
    if (atmRow && isOpen) setStrike(atmRow.strike);
  }, [atmRow?.strike]); // intentionally omit isOpen — fires whenever ATM data arrives

  // Auto-fill entry price from LTP
  useEffect(() => {
    if (!atmRow || !isOpen) return;
    const ltp = optionType === 'CE' ? atmRow.callLTP : atmRow.putLTP;
    if (ltp > 0) setEntryPrice(ltp);
  }, [atmRow, optionType, isOpen]);

  // Auto-fill SL / Target from settings percentages
  useEffect(() => {
    if (entryPrice <= 0) return;
    const isBuy = direction === 'BUY';
    setStopLoss(
      parseFloat((isBuy
        ? entryPrice * (1 - defaultSLPct / 100)
        : entryPrice * (1 + defaultSLPct / 100)
      ).toFixed(2))
    );
    setTarget(
      parseFloat((isBuy
        ? entryPrice * (1 + defaultTPPct / 100)
        : entryPrice * (1 - defaultTPPct / 100)
      ).toFixed(2))
    );
  }, [entryPrice, direction, defaultSLPct, defaultTPPct]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  // ── Handlers ───────────────────────────────────────────────────
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (entryPrice <= 0) { toast.error('Entry price must be greater than 0'); return; }
    const rows = optionChainQuery.data?.rows ?? [];
    const strikeRow = rows.find((r) => r.strike === strike) ?? atmRow;
    const contractSecurityId = strikeRow
      ? (optionType === 'CE' ? strikeRow.callSecurityId : strikeRow.putSecurityId) ?? null
      : null;
    onSubmit({ instrument: instrumentKey, instrumentName, tradeType, strike, entryPrice, quantity: qty, lotSize: lotSize > 1 ? lotSize : undefined, stopLoss, target, tslEnabled, contractSecurityId });
  };

  if (!isOpen) return null;

  // ── Styles ─────────────────────────────────────────────────────
  const isBuy = direction === 'BUY';
  const inactiveToggle = 'border-border text-muted-foreground hover:border-foreground/30 bg-transparent';
  const ceActive = 'bg-info-cyan/15 border-info-cyan text-info-cyan';
  const buyActive = 'bg-profit-green/15 border-profit-green text-profit-green';
  const sellActive = 'bg-loss-red/15 border-loss-red text-loss-red';
  const inputCls = 'px-2 py-1.5 text-xs bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary text-right tabular-nums w-full';

  const fmtAmt = (n: number) =>
    n >= 100_000 ? `₹${(n / 100_000).toFixed(2)}L`
    : n >= 1_000 ? `₹${(n / 1_000).toFixed(1)}K`
    : `₹${n.toFixed(0)}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="rounded-lg border border-border bg-background shadow-xl min-w-max">

        {/* ── Header ── */}
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <div className="flex items-center gap-2.5">
            <span className="text-sm font-bold">{instrumentName}</span>
            {nearestExpiry && (
              <span className="text-[0.625rem] text-muted-foreground border border-border rounded px-1.5 py-0.5 font-mono">
                {nearestExpiry}
              </span>
            )}
            {optionChainQuery.isFetching && (
              <span className="text-[0.625rem] text-muted-foreground animate-pulse">loading…</span>
            )}
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-3 text-[0.625rem] text-muted-foreground">
              <span>
                Available:{' '}
                <span className="text-foreground font-mono">
                  {availableFund > 0 ? fmtAmt(availableFund) : '—'}
                </span>
              </span>
              <span>
                Required:{' '}
                <span className={`font-mono ${capitalRequired > 0 && capitalRequired > availableFund && availableFund > 0 ? 'text-loss-red' : 'text-foreground'}`}>
                  {capitalRequired > 0 ? fmtAmt(capitalRequired) : '—'}
                </span>
              </span>
            </div>
            <button onClick={onClose} className="rounded p-0.5 hover:bg-muted transition-colors" disabled={isLoading}>
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* ── Form row ── */}
        <form onSubmit={handleSubmit} className="flex items-end gap-3 px-4 py-3">

          {/* Option type: CE / PE */}
          <div className="space-y-1">
            <label className="text-[0.625rem] font-medium text-muted-foreground block">Type</label>
            <div className="flex rounded border border-border overflow-hidden">
              {(['CE', 'PE'] as OptionType[]).map((t, i) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setOptionType(t)}
                  className={`px-3 py-1.5 text-xs font-semibold transition-colors ${i === 0 ? 'border-r border-border' : ''} ${optionType === t ? ceActive : inactiveToggle}`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {/* Direction: BUY / SELL */}
          <div className="space-y-1">
            <label className="text-[0.625rem] font-medium text-transparent block select-none">_</label>
            <div className="flex rounded border border-border overflow-hidden">
              <button
                type="button"
                onClick={() => setDirection('BUY')}
                className={`px-3 py-1.5 text-xs font-semibold transition-colors border-r border-border ${direction === 'BUY' ? buyActive : inactiveToggle}`}
              >
                BUY
              </button>
              <button
                type="button"
                onClick={() => setDirection('SELL')}
                className={`px-3 py-1.5 text-xs font-semibold transition-colors ${direction === 'SELL' ? sellActive : inactiveToggle}`}
              >
                SELL
              </button>
            </div>
          </div>

          {/* Strike */}
          <div className="space-y-1 w-24">
            <label className="text-[0.625rem] font-medium text-muted-foreground block">Strike</label>
            <input
              type="number"
              value={strike || ''}
              onChange={(e) => setStrike(Number(e.target.value))}
              placeholder="ATM"
              className={inputCls}
              disabled={isLoading}
            />
          </div>

          {/* Entry Price */}
          <div className="space-y-1 w-20">
            <label className="text-[0.625rem] font-medium text-muted-foreground block">Entry</label>
            <input
              type="number"
              step="0.05"
              value={entryPrice || ''}
              onChange={(e) => setEntryPrice(Number(e.target.value))}
              placeholder="0.00"
              className={inputCls}
              disabled={isLoading}
            />
          </div>

          {/* Quantity */}
          <div className="space-y-1">
            <label className="text-[0.625rem] font-medium text-muted-foreground block">Qty</label>
            <div className="flex items-center gap-1">
              {/* ▼ / display / ▲ */}
              <div className="flex items-center border border-border rounded overflow-hidden">
                <button
                  type="button"
                  onClick={() => setQty(Math.max(1, qty - 1))}
                  className="px-1.5 py-1.5 hover:bg-muted transition-colors border-r border-border disabled:opacity-40"
                  disabled={isLoading || qty <= 1}
                >
                  <ChevronDown className="h-3 w-3" />
                </button>
                <span className="px-2 text-xs font-mono tabular-nums text-center" style={{ minWidth: '72px' }}>
                  {lotSize > 1 ? `${qty}×${lotSize}=${totalUnits}` : String(totalUnits)}
                </span>
                <button
                  type="button"
                  onClick={() => setQty(qty + 1)}
                  className="px-1.5 py-1.5 hover:bg-muted transition-colors border-l border-border"
                  disabled={isLoading}
                >
                  <ChevronUp className="h-3 w-3" />
                </button>
              </div>
              {/* Settings balloon */}
              <Popover open={isQtyPopoverOpen} onOpenChange={setIsQtyPopoverOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="p-1.5 rounded border border-border hover:bg-muted transition-colors text-muted-foreground"
                    title="Quantity presets"
                  >
                    <Settings2 className="h-3 w-3" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-52 p-3" align="start">
                  <div className="space-y-2">
                    <div className="text-xs font-medium">Quick Qty (lots)</div>
                    <div className="flex gap-1 flex-wrap">
                      {QTY_PRESETS.map((v) => (
                        <button
                          key={v}
                          type="button"
                          onClick={() => { setQty(v); setIsQtyPopoverOpen(false); }}
                          className={`px-2 py-1 text-xs rounded border transition-colors hover:bg-accent hover:text-accent-foreground ${qty === v ? 'border-primary text-primary bg-primary/5' : 'border-border'}`}
                        >
                          {v}
                        </button>
                      ))}
                    </div>
                    {lotSize > 1 && (
                      <p className="text-[0.625rem] text-muted-foreground pt-1 border-t border-border">
                        {qty} lot{qty > 1 ? 's' : ''} × {lotSize} = <strong>{totalUnits}</strong> units
                      </p>
                    )}
                  </div>
                </PopoverContent>
              </Popover>
            </div>
          </div>

          {/* Stop Loss */}
          <div className="space-y-1 w-20">
            <label className="text-[0.625rem] font-medium text-loss-red block">SL</label>
            <input
              type="number"
              step="0.05"
              value={stopLoss ?? ''}
              onChange={(e) => setStopLoss(e.target.value ? Number(e.target.value) : undefined)}
              placeholder="—"
              className={`${inputCls} text-loss-red`}
              disabled={isLoading}
            />
          </div>

          {/* Target */}
          <div className="space-y-1 w-20">
            <label className="text-[0.625rem] font-medium text-profit-green block">Target</label>
            <input
              type="number"
              step="0.05"
              value={target ?? ''}
              onChange={(e) => setTarget(e.target.value ? Number(e.target.value) : undefined)}
              placeholder="—"
              className={`${inputCls} text-profit-green`}
              disabled={isLoading}
            />
          </div>

          {/* TSL Toggle */}
          <div className="space-y-1">
            <label className="text-[0.625rem] font-medium text-muted-foreground block">TSL</label>
            <button
              type="button"
              onClick={() => setTslEnabled(!tslEnabled)}
              className={`px-3 py-1.5 text-xs font-semibold rounded border transition-colors ${
                tslEnabled
                  ? 'border-warning-amber bg-warning-amber/10 text-warning-amber'
                  : 'border-border text-muted-foreground hover:border-foreground/30'
              }`}
            >
              {tslEnabled ? 'ON' : 'OFF'}
            </button>
          </div>

          {/* Submit */}
          <div className="space-y-1">
            <label className="text-[0.625rem] font-medium text-transparent block select-none">_</label>
            <button
              type="submit"
              disabled={isLoading || entryPrice <= 0}
              className={`px-5 py-1.5 text-xs font-bold rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                isBuy
                  ? 'bg-profit-green text-white hover:bg-profit-green/90'
                  : 'bg-loss-red text-white hover:bg-loss-red/90'
              }`}
            >
              {isLoading ? 'Placing…' : isBuy ? 'BUY' : 'SELL'}
            </button>
          </div>

        </form>
      </div>
    </div>
  );
}
