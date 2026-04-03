/**
 * NewTradeForm — Inline trade entry row always visible in the Trading Desk table.
 * Fields: Instrument, B/S, CE/PE, Strike, Expiry, Entry (auto-fill LTP), Capital % (dropdown 5-25%)
 * Renders as a <tr> inside the 16-column table.
 */
import { useState, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { trpc } from '../lib/trpc';

/** Map UI instrument names to scrip master underlying symbols. */
const UNDERLYING_MAP: Record<string, string> = {
  'NIFTY 50': 'NIFTY',
  'BANK NIFTY': 'BANKNIFTY',
  'CRUDE OIL': 'CRUDEOIL',
  'NATURAL GAS': 'NATURALGAS',
};

/** Capital % options — max 25% per spec */
const CAPITAL_PERCENT_OPTIONS = [5, 10, 15, 20, 25];

interface NewTradeFormProps {
  workspace: 'live' | 'paper';
  availableCapital: number;
  instruments: string[];
  onSubmit: (trade: {
    instrument: string;
    type: 'CALL_BUY' | 'CALL_SELL' | 'PUT_BUY' | 'PUT_SELL' | 'BUY' | 'SELL';
    strike: number | null;
    expiry: string;
    entryPrice: number;
    capitalPercent: number;
  }) => Promise<void>;
  onCancel: () => void;
  loading?: boolean;
  /** If provided, shows day values (dimmed) for when this is the only row */
  dayValues?: {
    dayIndex: number;
    tradeCapital: number;
    targetAmount: number;
    targetPercent: number;
    projCapital: number;
  };
}

const DEFAULT_INSTRUMENTS = ['NIFTY 50', 'BANK NIFTY', 'CRUDE OIL', 'NATURAL GAS'];

function fmt(n: number, compact = false): string {
  if (compact && Math.abs(n) >= 100000) {
    return `₹${(n / 100000).toFixed(2)}L`;
  }
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function NewTradeForm({
  workspace,
  availableCapital,
  instruments,
  onSubmit,
  onCancel,
  loading = false,
  dayValues,
}: NewTradeFormProps) {
  const [instrument, setInstrument] = useState(instruments[0] ?? DEFAULT_INSTRUMENTS[0]);
  const [direction, setDirection] = useState<'BUY' | 'SELL'>('BUY');
  const [optionType, setOptionType] = useState<'CE' | 'PE' | 'NONE'>('CE');
  const [strike, setStrike] = useState<string>('');
  const [entryPrice, setEntryPrice] = useState<string>('');
  const [capitalPercent, setCapitalPercent] = useState<number>(10);
  const [expiry, setExpiry] = useState<string>('');

  // Fetch expiry dates for the selected instrument
  const underlying = UNDERLYING_MAP[instrument] ?? instrument;
  const expiryQuery = trpc.broker.expiryList.useQuery(
    { underlying },
    { enabled: optionType !== 'NONE' }
  );

  // Auto-select nearest expiry when data loads or instrument changes
  useEffect(() => {
    if (expiryQuery.data && expiryQuery.data.length > 0) {
      setExpiry(expiryQuery.data[0]);
    } else {
      setExpiry('');
    }
  }, [expiryQuery.data, instrument]);

  // LTP auto-fill placeholder — will be wired to live feed
  const autoLtp = entryPrice ? parseFloat(entryPrice) : 0;

  const estimatedMargin = (availableCapital * capitalPercent / 100);
  const estimatedQty = entryPrice ? Math.floor(estimatedMargin / parseFloat(entryPrice)) : 0;

  const handleSubmit = async () => {
    if (!entryPrice || parseFloat(entryPrice) <= 0) return;

    let type: 'CALL_BUY' | 'CALL_SELL' | 'PUT_BUY' | 'PUT_SELL' | 'BUY' | 'SELL';
    if (optionType === 'NONE') {
      type = direction;
    } else {
      type = `${optionType === 'CE' ? 'CALL' : 'PUT'}_${direction}` as typeof type;
    }

    await onSubmit({
      instrument,
      type,
      strike: optionType !== 'NONE' && strike ? parseFloat(strike) : null,
      expiry: optionType !== 'NONE' ? expiry : '',
      entryPrice: parseFloat(entryPrice),
      capitalPercent,
    });

    // Reset form after submission
    setStrike('');
    setEntryPrice('');
    setCapitalPercent(10);
  };

  /** Format expiry date for display (e.g., "2026-04-03" → "03 Apr") */
  const formatExpiry = (dateStr: string) => {
    try {
      const d = new Date(dateStr + 'T00:00:00');
      return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
    } catch {
      return dateStr;
    }
  };

  const inputClass = 'w-full bg-background border border-border rounded px-1.5 py-1 text-[10px] text-foreground tabular-nums text-right focus:border-primary focus:outline-none';
  const selectClass = 'w-full bg-background border border-border rounded px-1.5 py-1 text-[10px] text-foreground focus:border-primary focus:outline-none';

  return (
    <tr className="border-b border-bullish/30 bg-bullish/[0.04] border-l-2 border-l-bullish/60">
      {/* Day */}
      <td className="px-2 py-2">
        {dayValues ? (
          <span className="text-muted-foreground/40 tabular-nums">{dayValues.dayIndex}</span>
        ) : (
          <span className="text-[9px] text-bullish font-bold">NEW</span>
        )}
      </td>
      {/* Date */}
      <td className="px-2 py-2">
        <span className="text-[9px] text-bullish/60 italic">new</span>
      </td>
      {/* Trade Capital — dimmed */}
      <td className="px-2 py-2 text-right tabular-nums text-foreground/30">
        {dayValues ? fmt(dayValues.tradeCapital, true) : '—'}
      </td>
      {/* Target — dimmed */}
      <td className="px-2 py-2 text-right tabular-nums text-muted-foreground/30">
        {dayValues ? (
          <>
            {fmt(dayValues.targetAmount)}
            <span className="text-[8px] ml-0.5">({dayValues.targetPercent}%)</span>
          </>
        ) : '—'}
      </td>
      {/* Proj Capital — dimmed */}
      <td className="px-2 py-2 text-right tabular-nums text-muted-foreground/30">
        {dayValues ? fmt(dayValues.projCapital, true) : '—'}
      </td>
      {/* Instrument — dropdown */}
      <td className="px-2 py-1">
        <select
          value={instrument}
          onChange={(e) => setInstrument(e.target.value)}
          className={selectClass}
        >
          {(instruments.length > 0 ? instruments : DEFAULT_INSTRUMENTS).map((inst) => (
            <option key={inst} value={inst}>{inst}</option>
          ))}
        </select>
      </td>
      {/* Type (B/S + CE/PE toggles) */}
      <td className="px-2 py-1">
        <div className="flex gap-0.5">
          <button
            onClick={() => setDirection('BUY')}
            className={`px-1.5 py-0.5 rounded text-[9px] font-bold transition-colors ${
              direction === 'BUY'
                ? 'bg-bullish/20 text-bullish border border-bullish/40'
                : 'bg-muted text-muted-foreground border border-transparent'
            }`}
          >
            B
          </button>
          <button
            onClick={() => setDirection('SELL')}
            className={`px-1.5 py-0.5 rounded text-[9px] font-bold transition-colors ${
              direction === 'SELL'
                ? 'bg-destructive/20 text-destructive border border-destructive/40'
                : 'bg-muted text-muted-foreground border border-transparent'
            }`}
          >
            S
          </button>
          <div className="w-px bg-border mx-0.5" />
          {(['CE', 'PE', 'NONE'] as const).map((opt) => (
            <button
              key={opt}
              onClick={() => setOptionType(opt)}
              className={`px-1.5 py-0.5 rounded text-[9px] font-bold transition-colors ${
                optionType === opt
                  ? 'bg-primary/20 text-primary border border-primary/40'
                  : 'bg-muted text-muted-foreground border border-transparent'
              }`}
            >
              {opt === 'NONE' ? '—' : opt}
            </button>
          ))}
        </div>
      </td>
      {/* Strike + Expiry */}
      <td className="px-2 py-1">
        {optionType !== 'NONE' ? (
          <div className="flex flex-col gap-1">
            <input
              type="number"
              value={strike}
              onChange={(e) => setStrike(e.target.value)}
              placeholder="Strike"
              className={inputClass + ' w-20'}
            />
            <select
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
              className="w-20 bg-background border border-border rounded px-1 py-0.5 text-[9px] text-foreground focus:border-primary focus:outline-none"
            >
              {expiryQuery.isLoading && (
                <option value="">Loading...</option>
              )}
              {expiryQuery.data?.map((exp) => (
                <option key={exp} value={exp}>
                  {formatExpiry(exp)}
                </option>
              ))}
              {!expiryQuery.isLoading && (!expiryQuery.data || expiryQuery.data.length === 0) && (
                <option value="">No expiries</option>
              )}
            </select>
          </div>
        ) : (
          <span className="text-[10px] text-muted-foreground">—</span>
        )}
      </td>
      {/* Entry — auto-fill with LTP, editable */}
      <td className="px-2 py-1">
        <input
          type="number"
          value={entryPrice}
          onChange={(e) => setEntryPrice(e.target.value)}
          placeholder="Entry ₹"
          step="0.05"
          className={inputClass + ' w-20'}
        />
      </td>
      {/* LTP — auto-filled, italic, dimmed */}
      <td className="px-2 py-2 text-right">
        <span className="text-[10px] tabular-nums text-muted-foreground/60 italic">
          {autoLtp > 0 ? autoLtp.toFixed(2) : '—'}
        </span>
      </td>
      {/* Qty — Capital % dropdown + hint */}
      <td className="px-2 py-1">
        <div className="flex flex-col items-end gap-0.5">
          <select
            value={capitalPercent}
            onChange={(e) => setCapitalPercent(parseInt(e.target.value))}
            className="w-16 bg-background border border-border rounded px-1 py-0.5 text-[10px] text-foreground tabular-nums text-right focus:border-primary focus:outline-none"
          >
            {CAPITAL_PERCENT_OPTIONS.map((pct) => (
              <option key={pct} value={pct}>{pct}%</option>
            ))}
          </select>
          <span className="text-[8px] text-info-cyan/70 tabular-nums">
            {estimatedQty > 0 ? `${estimatedQty} lots` : '—'}
          </span>
          <span className="text-[7px] text-muted-foreground/50 tabular-nums">
            ~{fmt(estimatedMargin)}
          </span>
        </div>
      </td>
      {/* P&L — confirm/cancel buttons */}
      <td className="px-2 py-1">
        <div className="flex items-center justify-end gap-1">
          <button
            onClick={handleSubmit}
            disabled={loading || !entryPrice || parseFloat(entryPrice) <= 0}
            className="px-1.5 py-1 rounded text-[9px] font-bold bg-bullish/20 text-bullish hover:bg-bullish/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            title="Place trade"
          >
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : '✓'}
          </button>
          <button
            onClick={() => {
              setStrike('');
              setEntryPrice('');
              setCapitalPercent(10);
            }}
            className="px-1.5 py-1 rounded text-[9px] font-bold bg-destructive/20 text-destructive hover:bg-destructive/30 transition-colors"
            title="Clear form"
          >
            ×
          </button>
        </div>
      </td>
      {/* Charges */}
      <td className="px-2 py-2 text-right text-muted-foreground">—</td>
      {/* Actual Capital */}
      <td className="px-2 py-2 text-right text-muted-foreground">—</td>
      {/* Deviation */}
      <td className="px-2 py-2 text-right text-muted-foreground">—</td>
      {/* Rating */}
      <td className="px-2 py-2" />
    </tr>
  );
}
