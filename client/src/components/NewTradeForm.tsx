/**
 * NewTradeForm — Inline trade entry form that slides into the Trading Desk table.
 * Fields: Instrument, B/S, CE/PE, Strike, Entry (auto LTP), Capital %
 */
import { useState } from 'react';
import { X, Send, Loader2 } from 'lucide-react';

interface NewTradeFormProps {
  workspace: 'live' | 'paper';
  availableCapital: number;
  instruments: string[];
  onSubmit: (trade: {
    instrument: string;
    type: 'CALL_BUY' | 'CALL_SELL' | 'PUT_BUY' | 'PUT_SELL' | 'BUY' | 'SELL';
    strike: number | null;
    entryPrice: number;
    capitalPercent: number;
  }) => Promise<void>;
  onCancel: () => void;
  loading?: boolean;
}

const INSTRUMENTS = ['NIFTY 50', 'BANK NIFTY', 'CRUDE OIL', 'NATURAL GAS'];

export default function NewTradeForm({
  workspace,
  availableCapital,
  instruments,
  onSubmit,
  onCancel,
  loading = false,
}: NewTradeFormProps) {
  const [instrument, setInstrument] = useState(instruments[0] ?? INSTRUMENTS[0]);
  const [direction, setDirection] = useState<'BUY' | 'SELL'>('BUY');
  const [optionType, setOptionType] = useState<'CE' | 'PE' | 'NONE'>('CE');
  const [strike, setStrike] = useState<string>('');
  const [entryPrice, setEntryPrice] = useState<string>('');
  const [capitalPercent, setCapitalPercent] = useState<number>(10);

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
      entryPrice: parseFloat(entryPrice),
      capitalPercent,
    });
  };

  return (
    <tr className="border-b border-warning-amber/30 bg-warning-amber/5 animate-fade-in-up">
      {/* Day */}
      <td className="px-2 py-2">
        <span className="text-[9px] text-warning-amber font-bold">NEW</span>
      </td>
      {/* Date */}
      <td className="px-2 py-2" />
      {/* Trade Capital */}
      <td className="px-2 py-2" />
      {/* Target */}
      <td className="px-2 py-2" />
      {/* Proj Capital */}
      <td className="px-2 py-2" />
      {/* Instrument */}
      <td className="px-2 py-1">
        <select
          value={instrument}
          onChange={(e) => setInstrument(e.target.value)}
          className="w-full bg-background border border-border rounded px-1.5 py-1 text-[10px] text-foreground focus:border-primary focus:outline-none"
        >
          {(instruments.length > 0 ? instruments : INSTRUMENTS).map((inst) => (
            <option key={inst} value={inst}>{inst}</option>
          ))}
        </select>
      </td>
      {/* Type (B/S + CE/PE) */}
      <td className="px-2 py-1">
        <div className="flex gap-1">
          <button
            onClick={() => setDirection('BUY')}
            className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${
              direction === 'BUY'
                ? 'bg-bullish/20 text-bullish border border-bullish/40'
                : 'bg-muted text-muted-foreground border border-transparent'
            }`}
          >
            B
          </button>
          <button
            onClick={() => setDirection('SELL')}
            className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${
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
              className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${
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
      {/* Strike */}
      <td className="px-2 py-1">
        {optionType !== 'NONE' ? (
          <input
            type="number"
            value={strike}
            onChange={(e) => setStrike(e.target.value)}
            placeholder="Strike"
            className="w-20 bg-background border border-border rounded px-1.5 py-1 text-[10px] text-foreground tabular-nums text-right focus:border-primary focus:outline-none"
          />
        ) : (
          <span className="text-[10px] text-muted-foreground">—</span>
        )}
      </td>
      {/* Entry */}
      <td className="px-2 py-1">
        <input
          type="number"
          value={entryPrice}
          onChange={(e) => setEntryPrice(e.target.value)}
          placeholder="Entry ₹"
          step="0.05"
          className="w-20 bg-background border border-border rounded px-1.5 py-1 text-[10px] text-foreground tabular-nums text-right focus:border-primary focus:outline-none"
        />
      </td>
      {/* LTP */}
      <td className="px-2 py-2" />
      {/* Qty */}
      <td className="px-2 py-1 text-right">
        <span className="text-[10px] tabular-nums text-foreground">{estimatedQty}</span>
      </td>
      {/* P&L */}
      <td className="px-2 py-1">
        <div className="flex flex-col items-end">
          <span className="text-[9px] text-muted-foreground">
            {capitalPercent}% of ₹{Math.round(availableCapital).toLocaleString('en-IN')}
          </span>
          <input
            type="range"
            min={5}
            max={100}
            step={5}
            value={capitalPercent}
            onChange={(e) => setCapitalPercent(parseInt(e.target.value))}
            className="w-20 h-1 accent-primary mt-1"
          />
        </div>
      </td>
      {/* Charges */}
      <td className="px-2 py-2" />
      {/* Actual Capital */}
      <td className="px-2 py-2" />
      {/* Deviation */}
      <td className="px-2 py-2" />
      {/* Rating / Actions */}
      <td className="px-2 py-1">
        <div className="flex items-center gap-1">
          <button
            onClick={handleSubmit}
            disabled={loading || !entryPrice || parseFloat(entryPrice) <= 0}
            className="p-1 rounded bg-bullish/20 text-bullish hover:bg-bullish/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            title="Place trade"
          >
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
          </button>
          <button
            onClick={onCancel}
            className="p-1 rounded bg-destructive/20 text-destructive hover:bg-destructive/30 transition-colors"
            title="Cancel"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      </td>
    </tr>
  );
}
