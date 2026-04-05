/**
 * NewTradeForm — Inline trade entry row in the Trading Desk table.
 * Expiry: nearest expiry auto-selected, editable from the Type column.
 * Strike: dropdown populated from option chain (+/- strikes from ATM).
 * Entry: auto-fills with selected strike's LTP, editable for limit orders.
 * Capital %: dropdown 5–25%.
 */
import { useState, useEffect, useMemo } from 'react';
import { Loader2 } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { formatINR } from '@/lib/formatINR';

/** Map UI instrument names to scrip master underlying symbols. */
const UNDERLYING_MAP: Record<string, string> = {
  'NIFTY 50': 'NIFTY',
  'BANK NIFTY': 'BANKNIFTY',
  'CRUDE OIL': 'CRUDEOIL',
  'NATURAL GAS': 'NATURALGAS',
};

/** Strike range: +/- N strikes from ATM (per spec: option chain window) */
const STRIKE_WINDOW = 10;

/** Capital % options — max 25% per spec */
const CAPITAL_PERCENT_OPTIONS = [5, 10, 15, 20, 25];

const OPTION_TYPE_LABELS: Record<'CE' | 'PE' | 'NONE', string> = {
  CE: 'CE',
  PE: 'PE',
  NONE: 'DIR',
};

interface NewTradeFormProps {
  workspace: 'live' | 'paper_manual' | 'paper';
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

function fmt(n: number, _compact = false): string {
  return formatINR(n);
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
  const [selectedStrike, setSelectedStrike] = useState<string>('');
  const [entryPrice, setEntryPrice] = useState<string>('');
  const [capitalPercent, setCapitalPercent] = useState<number>(10);
  const [expiry, setExpiry] = useState<string>('');

  // Fetch expiry dates for the selected instrument
  const underlying = UNDERLYING_MAP[instrument] ?? instrument;
  const expiryQuery = trpc.broker.expiryList.useQuery(
    { underlying },
    { enabled: optionType !== 'NONE' }
  );

  const expiryOptions = useMemo(() => {
    const expiries = expiryQuery.data ?? [];
    return [...expiries].sort((a, b) => {
      const aTime = new Date(`${a}T00:00:00`).getTime();
      const bTime = new Date(`${b}T00:00:00`).getTime();
      return aTime - bTime;
    });
  }, [expiryQuery.data]);

  // Auto-select nearest expiry when data loads or instrument changes
  useEffect(() => {
    if (expiryOptions.length > 0) {
      setExpiry((current) => (current && expiryOptions.includes(current) ? current : expiryOptions[0]));
    } else {
      setExpiry('');
    }
  }, [expiryOptions, instrument]);

  // Fetch option chain for the selected instrument + expiry
  const optionChainQuery = trpc.broker.optionChain.useQuery(
    { underlying, expiry },
    { enabled: optionType !== 'NONE' && !!expiry, refetchInterval: 5000 }
  );

  // Compute ATM strike and +/- window strikes from option chain
  const strikeOptions = useMemo(() => {
    if (!optionChainQuery.data?.rows || optionChainQuery.data.rows.length === 0) {
      return [];
    }

    const rows = optionChainQuery.data.rows;
    const spotPrice = optionChainQuery.data.spotPrice;

    // Sort rows by strike
    const sorted = [...rows].sort((a, b) => a.strike - b.strike);

    // Find ATM — the strike closest to spot price
    let atmIndex = 0;
    let minDist = Infinity;
    sorted.forEach((row, idx) => {
      const dist = Math.abs(row.strike - spotPrice);
      if (dist < minDist) {
        minDist = dist;
        atmIndex = idx;
      }
    });

    // Get +/- STRIKE_WINDOW strikes from ATM
    const startIdx = Math.max(0, atmIndex - STRIKE_WINDOW);
    const endIdx = Math.min(sorted.length - 1, atmIndex + STRIKE_WINDOW);
    const windowStrikes = sorted.slice(startIdx, endIdx + 1);

    return windowStrikes.map((row) => ({
      strike: row.strike,
      callLTP: row.callLTP,
      putLTP: row.putLTP,
      isATM: row.strike === sorted[atmIndex].strike,
      // Label: show distance from ATM
      distFromATM: Math.round((row.strike - sorted[atmIndex].strike) / (sorted[1]?.strike - sorted[0]?.strike || 1)),
    }));
  }, [optionChainQuery.data]);

  // Auto-select ATM strike when option chain loads
  useEffect(() => {
    if (strikeOptions.length > 0 && !selectedStrike) {
      const atm = strikeOptions.find((s) => s.isATM);
      if (atm) {
        setSelectedStrike(String(atm.strike));
      }
    }
  }, [strikeOptions, selectedStrike]);

  // Reset strike when instrument or expiry changes
  useEffect(() => {
    setSelectedStrike('');
    setEntryPrice('');
  }, [instrument, expiry, optionType]);

  // Auto-fill entry price when strike is selected
  useEffect(() => {
    if (selectedStrike && strikeOptions.length > 0) {
      const strikeData = strikeOptions.find((s) => String(s.strike) === selectedStrike);
      if (strikeData) {
        const ltp = optionType === 'CE' ? strikeData.callLTP : strikeData.putLTP;
        if (ltp > 0) {
          setEntryPrice(ltp.toFixed(2));
        }
      }
    }
  }, [selectedStrike, optionType, strikeOptions]);

  // For non-option instruments, entry stays manual
  const currentLtp = useMemo(() => {
    if (optionType === 'NONE') return 0;
    if (!selectedStrike || strikeOptions.length === 0) return 0;
    const strikeData = strikeOptions.find((s) => String(s.strike) === selectedStrike);
    if (!strikeData) return 0;
    return optionType === 'CE' ? strikeData.callLTP : strikeData.putLTP;
  }, [selectedStrike, optionType, strikeOptions]);

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
      strike: optionType !== 'NONE' && selectedStrike ? parseFloat(selectedStrike) : null,
      expiry: optionType !== 'NONE' ? expiry : '',
      entryPrice: parseFloat(entryPrice),
      capitalPercent,
    });

    // Reset form after submission
    setSelectedStrike('');
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

  const selectClass = 'w-full bg-background border border-border rounded px-1.5 py-1 text-[10px] text-foreground focus:border-primary focus:outline-none';
  const inputClass = 'w-full bg-background border border-border rounded px-1.5 py-1 text-[10px] text-foreground tabular-nums text-right focus:border-primary focus:outline-none';

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
      {/* Type (Expiry + B/S + contract type toggles) */}
      <td className="px-2 py-1">
        <div className="flex flex-col gap-1">
          <div>
            {optionType !== 'NONE' ? (
              <select
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
                className="w-24 bg-background border border-border rounded px-1 py-0.5 text-[9px] text-foreground focus:border-primary focus:outline-none"
              >
                {expiryQuery.isLoading && (
                  <option value="">Loading...</option>
                )}
                {expiryOptions.map((exp) => (
                  <option key={exp} value={exp}>
                    {formatExpiry(exp)}
                  </option>
                ))}
                {!expiryQuery.isLoading && expiryOptions.length === 0 && (
                  <option value="">No expiries</option>
                )}
              </select>
            ) : (
              <span className="inline-flex h-[24px] items-center text-[9px] text-muted-foreground/60">
                Direct trade
              </span>
            )}
          </div>
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
                title={opt === 'NONE' ? 'Direct trade (no option contract)' : undefined}
              >
                {OPTION_TYPE_LABELS[opt]}
              </button>
            ))}
          </div>
        </div>
      </td>
      {/* Strike — dropdown from option chain */}
      <td className="px-2 py-1">
        {optionType !== 'NONE' ? (
          <select
            value={selectedStrike}
            onChange={(e) => setSelectedStrike(e.target.value)}
            className={selectClass + ' w-24'}
          >
            <option value="">Select strike</option>
            {optionChainQuery.isLoading && (
              <option value="" disabled>Loading...</option>
            )}
            {strikeOptions.map((s) => {
              const ltp = optionType === 'CE' ? s.callLTP : s.putLTP;
              const label = s.isATM
                ? `${s.strike} (ATM) ₹${ltp.toFixed(1)}`
                : `${s.strike} (${s.distFromATM > 0 ? '+' : ''}${s.distFromATM}) ₹${ltp.toFixed(1)}`;
              return (
                <option key={s.strike} value={String(s.strike)}>
                  {label}
                </option>
              );
            })}
            {!optionChainQuery.isLoading && strikeOptions.length === 0 && (
              <option value="" disabled>No strikes</option>
            )}
          </select>
        ) : (
          <span className="text-[10px] text-muted-foreground">—</span>
        )}
      </td>
      {/* Entry — auto-fill with selected strike's LTP, editable */}
      <td className="px-2 py-1">
        <input
          type="number"
          value={entryPrice}
          onChange={(e) => setEntryPrice(e.target.value)}
          placeholder="Entry ₹"
          step="0.05"
          className={inputClass + ' w-20'}
        />
        {currentLtp > 0 && (
          <div className="text-[7px] text-muted-foreground/50 text-right mt-0.5">
            LTP: ₹{currentLtp.toFixed(2)}
          </div>
        )}
      </td>
      {/* LTP — auto-filled, italic, dimmed */}
      <td className="px-2 py-2 text-right">
        <span className="text-[10px] tabular-nums text-muted-foreground/60 italic">
          {currentLtp > 0 ? currentLtp.toFixed(2) : '—'}
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
            onClick={onCancel}
            className="px-1.5 py-1 rounded text-[9px] font-bold bg-destructive/20 text-destructive hover:bg-destructive/30 transition-colors"
            title="Cancel"
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
