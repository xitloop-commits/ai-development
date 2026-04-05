import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { formatINR } from '@/lib/formatINR';

const UNDERLYING_MAP: Record<string, string> = {
  'NIFTY 50': 'NIFTY',
  'BANK NIFTY': 'BANKNIFTY',
  'CRUDE OIL': 'CRUDEOIL',
  'NATURAL GAS': 'NATURALGAS',
};

const UI_TO_RESOLVED_MAP: Record<string, string> = {
  'NIFTY 50': 'NIFTY_50',
  'BANK NIFTY': 'BANKNIFTY',
  'CRUDE OIL': 'CRUDEOIL',
  'NATURAL GAS': 'NATURALGAS',
};

const STRIKE_WINDOW = 10;
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
  resolvedInstruments?: Array<{
    name: string;
    securityId: string;
    exchange: string;
  }>;
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
  dayOpenedAt?: number;
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

function formatAge(openedAt?: number) {
  if (!openedAt) return '';
  const diffMin = Math.floor((Date.now() - openedAt) / 60000);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  return `${Math.floor(diffHr / 24)}d`;
}

function formatExpiry(dateStr: string) {
  try {
    const d = new Date(`${dateStr}T00:00:00`);
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  } catch {
    return dateStr;
  }
}

function getWorkspaceTone(workspace: NewTradeFormProps['workspace']) {
  switch (workspace) {
    case 'live':
      return {
        row: 'border-bullish/30 bg-bullish/[0.04] border-l-bullish/60',
        text: 'text-bullish',
        textSoft: 'text-bullish/80',
      };
    case 'paper_manual':
      return {
        row: 'border-warning-amber/30 bg-warning-amber/[0.04] border-l-warning-amber/60',
        text: 'text-warning-amber',
        textSoft: 'text-warning-amber/80',
      };
    default:
      return {
        row: 'border-info-cyan/30 bg-info-cyan/[0.04] border-l-info-cyan/60',
        text: 'text-info-cyan',
        textSoft: 'text-info-cyan/80',
      };
  }
}

export default function NewTradeForm(props: NewTradeFormProps) {
  const {
    workspace,
    availableCapital,
    instruments,
    resolvedInstruments,
    onSubmit,
    onCancel,
    loading = false,
    dayOpenedAt,
    dayValues,
  } = props;

  const instrumentOptions = useMemo(
    () => (instruments.length > 0 ? instruments : DEFAULT_INSTRUMENTS),
    [instruments]
  );
  const defaultInstrument = instrumentOptions[0] ?? DEFAULT_INSTRUMENTS[0];

  const [instrument, setInstrument] = useState(defaultInstrument);
  const [direction, setDirection] = useState<'BUY' | 'SELL' | null>(null);
  const [optionType, setOptionType] = useState<'CE' | 'PE' | 'NONE' | null>(null);
  const [selectedStrike, setSelectedStrike] = useState('');
  const [entryPrice, setEntryPrice] = useState('');
  const [capitalPercent, setCapitalPercent] = useState(5);
  const [expiry, setExpiry] = useState('');

  // All current instruments (NIFTY 50, BANK NIFTY, CRUDE OIL, NATURAL GAS) are derivatives.
  // Equity instruments (if added later) would not appear in UNDERLYING_MAP.
  const isDerivative = instrument in UNDERLYING_MAP;
  const isOptionTrade = optionType === 'CE' || optionType === 'PE';
  const canSelectExpiry = isDerivative && optionType !== 'NONE';
  const canSelectStrike = isDerivative && optionType !== 'NONE' && !!expiry;
  const tone = getWorkspaceTone(workspace);
  const brokerConfigQuery = trpc.broker.config.get.useQuery(undefined);
  const isPaperBroker = brokerConfigQuery.data?.isPaperBroker ?? false;
  const resolvedName = UI_TO_RESOLVED_MAP[instrument] ?? instrument;
  const resolvedInstrument = useMemo(
    () => resolvedInstruments?.find((item) => item.name === resolvedName),
    [resolvedInstruments, resolvedName]
  );
  const requestUnderlying = !isPaperBroker && resolvedInstrument?.securityId
    ? resolvedInstrument.securityId
    : (UNDERLYING_MAP[instrument] ?? resolvedName);
  const requestExchangeSegment = !isPaperBroker && resolvedInstrument?.exchange
    ? resolvedInstrument.exchange
    : undefined;

  useEffect(() => {
    if (instrumentOptions.includes(instrument)) return;
    setInstrument(defaultInstrument);
  }, [defaultInstrument, instrument, instrumentOptions]);

  // Auto-set optionType when switching between derivative and equity instruments
  useEffect(() => {
    if (!isDerivative) {
      // Equity: no CE/PE selection needed, force to NONE (direct trade)
      setOptionType('NONE');
      setExpiry('');
      setSelectedStrike('');
    } else if (optionType === 'NONE') {
      // Switching back to derivative: reset so user picks CE/PE
      setOptionType(null);
    }
  }, [isDerivative]); // eslint-disable-line react-hooks/exhaustive-deps

  const expiryQuery = trpc.broker.expiryList.useQuery(
    { underlying: requestUnderlying, exchangeSegment: requestExchangeSegment },
    { enabled: canSelectExpiry }
  );

  const expiryOptions = useMemo(() => {
    const expiries = expiryQuery.data ?? [];
    return [...expiries].sort((a, b) => {
      const aTime = new Date(`${a}T00:00:00`).getTime();
      const bTime = new Date(`${b}T00:00:00`).getTime();
      return aTime - bTime;
    });
  }, [expiryQuery.data]);

  useEffect(() => {
    if (!canSelectExpiry || expiryOptions.length === 0) {
      setExpiry('');
      return;
    }

    setExpiry((current) => (
      current && expiryOptions.includes(current)
        ? current
        : expiryOptions[0]
    ));
  }, [canSelectExpiry, expiryOptions, instrument]);

  const optionChainQuery = trpc.broker.optionChain.useQuery(
    { underlying: requestUnderlying, expiry, exchangeSegment: requestExchangeSegment },
    { enabled: canSelectStrike, refetchInterval: 5000 }
  );

  const strikeOptions = useMemo(() => {
    const rows = optionChainQuery.data?.rows ?? [];
    if (rows.length === 0) return [];

    const sorted = [...rows].sort((a, b) => a.strike - b.strike);
    const spotPrice = optionChainQuery.data?.spotPrice ?? 0;

    let atmIndex = 0;
    let minDist = Number.POSITIVE_INFINITY;
    sorted.forEach((row, idx) => {
      const dist = Math.abs(row.strike - spotPrice);
      if (dist < minDist) {
        minDist = dist;
        atmIndex = idx;
      }
    });

    const startIdx = Math.max(0, atmIndex - STRIKE_WINDOW);
    const endIdx = Math.min(sorted.length - 1, atmIndex + STRIKE_WINDOW);
    const visible = sorted.slice(startIdx, endIdx + 1);

    return visible.map((row) => ({
      strike: row.strike,
      callLTP: row.callLTP,
      putLTP: row.putLTP,
      isATM: row.strike === sorted[atmIndex].strike,
    }));
  }, [optionChainQuery.data]);

  useEffect(() => {
    if (!isOptionTrade || selectedStrike || strikeOptions.length === 0) return;
    const atmStrike = strikeOptions.find((strike) => strike.isATM);
    if (atmStrike) {
      setSelectedStrike(String(atmStrike.strike));
    }
  }, [isOptionTrade, selectedStrike, strikeOptions]);

  useEffect(() => {
    setSelectedStrike('');
    setEntryPrice('');
  }, [expiry, instrument, optionType]);

  useEffect(() => {
    if (!isOptionTrade || !selectedStrike) return;
    const strikeData = strikeOptions.find((item) => String(item.strike) === selectedStrike);
    if (!strikeData) return;

    const ltp = optionType === 'CE' ? strikeData.callLTP : strikeData.putLTP;
    if (ltp > 0) {
      setEntryPrice(ltp.toFixed(2));
    }
  }, [isOptionTrade, optionType, selectedStrike, strikeOptions]);

  const currentLtp = useMemo(() => {
    if (!isOptionTrade || !selectedStrike) return 0;
    const strikeData = strikeOptions.find((item) => String(item.strike) === selectedStrike);
    if (!strikeData) return 0;
    return optionType === 'CE' ? strikeData.callLTP : strikeData.putLTP;
  }, [isOptionTrade, optionType, selectedStrike, strikeOptions]);

  const estimatedMargin = availableCapital * capitalPercent / 100;
  const estimatedQty = entryPrice ? Math.floor(estimatedMargin / parseFloat(entryPrice)) : 0;
  const formReady =
    !!instrument &&
    !!direction &&
    (isDerivative ? !!optionType : true) &&
    (!isOptionTrade || (!!expiry && !!selectedStrike)) &&
    !!entryPrice &&
    parseFloat(entryPrice) > 0;

  const handleSubmit = async () => {
    if (!formReady || !direction) return;

    const effectiveOptionType = optionType ?? 'NONE';
    const type =
      effectiveOptionType === 'NONE'
        ? direction
        : `${effectiveOptionType === 'CE' ? 'CALL' : 'PUT'}_${direction}` as
          'CALL_BUY' | 'CALL_SELL' | 'PUT_BUY' | 'PUT_SELL';

    await onSubmit({
      instrument,
      type,
      strike: isOptionTrade && selectedStrike ? parseFloat(selectedStrike) : null,
      expiry: isOptionTrade ? expiry : '',
      entryPrice: parseFloat(entryPrice),
      capitalPercent,
    });

    setSelectedStrike('');
    setEntryPrice('');
    setCapitalPercent(5);
    setDirection(null);
    setOptionType(null);
    setExpiry('');
  };

  const cycleDateLabel = (() => {
    const dateLabel = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
    const ageLabel = formatAge(dayOpenedAt);
    return ageLabel ? `${dateLabel} | ${ageLabel}` : dateLabel;
  })();

  const selectClass = 'w-full bg-background border border-border rounded px-1.5 py-1 text-[10px] text-foreground focus:border-primary focus:outline-none';
  const compactSelectClass = 'shrink-0 bg-background border border-border rounded px-1.5 py-1 text-[10px] text-foreground focus:border-primary focus:outline-none disabled:opacity-50';
  const inputClass = 'w-full bg-background border border-border rounded px-1.5 py-1 text-[10px] text-foreground tabular-nums text-right focus:border-primary focus:outline-none';

  return (
    <tr className={`border-b border-l-2 ${tone.row}`}>
      <td className="px-2 py-2">
        {dayValues ? (
          <span className={`tabular-nums ${tone.textSoft}`}>{dayValues.dayIndex}</span>
        ) : (
          <span className={`text-[9px] font-bold ${tone.text}`}>NEW</span>
        )}
      </td>

      <td className="px-2 py-2">
        <span className={`block truncate text-[10px] tabular-nums ${tone.text}`}>{cycleDateLabel}</span>
      </td>

      <td className={`px-2 py-2 text-right tabular-nums ${tone.textSoft}`}>
        {dayValues ? fmt(dayValues.tradeCapital, true) : '-'}
      </td>

      <td className={`px-2 py-2 text-right tabular-nums ${tone.textSoft}`}>
        {dayValues ? (
          <>
            {fmt(dayValues.targetAmount)}
            <span className="ml-0.5 text-[8px]">({dayValues.targetPercent}%)</span>
          </>
        ) : '-'}
      </td>

      <td className={`px-2 py-2 text-right tabular-nums ${tone.textSoft}`}>
        {dayValues ? fmt(dayValues.projCapital, true) : '-'}
      </td>

      <td className="px-2 py-1">
        <div className="flex items-center gap-1.5 whitespace-nowrap">
          {/* Instrument dropdown */}
          <select
            value={instrument}
            onChange={(e) => setInstrument(e.target.value)}
            className={`${compactSelectClass} w-[100px]`}
          >
            {instrumentOptions.map((inst) => (
              <option key={inst} value={inst}>{inst}</option>
            ))}
          </select>

          {/* Derivative fields: Expiry | Strike | CE/PE group */}
          {isDerivative && (
            <>
              <span className="text-border text-[9px]">|</span>
              <select
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
                className={`${compactSelectClass} w-[78px]`}
              >
                <option value="">
                  {expiryQuery.isLoading ? 'Loading...' : 'Expiry'}
                </option>
                {expiryOptions.map((exp) => (
                  <option key={exp} value={exp}>
                    {formatExpiry(exp)}
                  </option>
                ))}
                {!expiryQuery.isLoading && expiryOptions.length === 0 && (
                  <option value="" disabled>No expiries</option>
                )}
              </select>

              <span className="text-border text-[9px]">|</span>
              <select
                value={selectedStrike}
                onChange={(e) => setSelectedStrike(e.target.value)}
                disabled={!expiry}
                className={`${compactSelectClass} w-[84px]`}
              >
                <option value="">
                  {expiry ? 'Strike' : 'Pick Exp'}
                </option>
                {optionChainQuery.isLoading && (
                  <option value="" disabled>Loading...</option>
                )}
                {strikeOptions.map((strike) => (
                  <option key={strike.strike} value={String(strike.strike)}>
                    {strike.strike}
                  </option>
                ))}
                {expiry && !optionChainQuery.isLoading && strikeOptions.length === 0 && (
                  <option value="" disabled>No strikes</option>
                )}
              </select>

              <span className="text-border text-[9px]">|</span>
              {/* CE / PE group */}
              <div className="flex shrink-0 items-center gap-1 rounded border border-border/50 px-1 py-0.5">
                {(['CE', 'PE'] as const).map((opt) => (
                  <button
                    key={opt}
                    onClick={() => setOptionType(opt)}
                    className={`px-1.5 py-0.5 rounded text-[9px] font-bold transition-colors ${
                      optionType === opt
                        ? 'bg-primary/20 text-primary'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {opt}
                  </button>
                ))}
              </div>
            </>
          )}

          <span className="text-border text-[9px]">|</span>
          {/* B / S group */}
          <div className="flex shrink-0 items-center gap-1 rounded border border-border/50 px-1 py-0.5">
            <button
              onClick={() => setDirection('BUY')}
              className={`px-1.5 py-0.5 rounded text-[9px] font-bold transition-colors ${
                direction === 'BUY'
                  ? 'bg-bullish/20 text-bullish'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              B
            </button>
            <button
              onClick={() => setDirection('SELL')}
              className={`px-1.5 py-0.5 rounded text-[9px] font-bold transition-colors ${
                direction === 'SELL'
                  ? 'bg-destructive/20 text-destructive'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              S
            </button>
          </div>
        </div>
      </td>

      <td className="px-2 py-1">
        <input
          type="number"
          value={entryPrice}
          onChange={(e) => setEntryPrice(e.target.value)}
          placeholder="Entry"
          step="0.05"
          className={inputClass}
        />
      </td>

      <td className="px-2 py-2 text-right">
        <span className="text-[10px] italic tabular-nums text-muted-foreground/60">
          {currentLtp > 0 ? currentLtp.toFixed(2) : '-'}
        </span>
      </td>

      <td className="px-2 py-1">
        <select
          value={capitalPercent}
          onChange={(e) => setCapitalPercent(parseInt(e.target.value, 10))}
          className="w-full bg-background border border-border rounded px-1 py-1 text-[10px] text-foreground tabular-nums text-right focus:border-primary focus:outline-none"
          title={estimatedQty > 0 ? `Estimated qty: ${estimatedQty} | Margin: ${fmt(estimatedMargin)}` : 'Select capital percent'}
        >
          {CAPITAL_PERCENT_OPTIONS.map((pct) => (
            <option key={pct} value={pct}>{pct}%</option>
          ))}
        </select>
      </td>

      <td className="px-2 py-1">
        <div className="flex items-center justify-end gap-1">
          <button
            onClick={handleSubmit}
            disabled={loading || !formReady}
            className="rounded bg-bullish/20 px-1.5 py-1 text-[9px] font-bold text-bullish transition-colors hover:bg-bullish/30 disabled:cursor-not-allowed disabled:opacity-30"
            title="Place trade"
          >
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : 'OK'}
          </button>
          <button
            onClick={onCancel}
            className="rounded bg-destructive/20 px-1.5 py-1 text-[9px] font-bold text-destructive transition-colors hover:bg-destructive/30"
            title="Cancel"
          >
            X
          </button>
        </div>
      </td>

      <td className="px-2 py-2 text-right text-muted-foreground">-</td>
      <td className="px-2 py-2 text-right text-muted-foreground">-</td>
      <td className="px-2 py-2 text-right text-muted-foreground">-</td>
      <td className="px-2 py-2" />
    </tr>
  );
}
