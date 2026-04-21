import { useEffect, useMemo, useState } from 'react';
import { Loader2, ChevronUp, ChevronDown } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { formatINR } from '@/lib/formatINR';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { estimateSingleLegCharges, type ChargeRate, DEFAULT_CHARGES } from '@shared/chargesEngine';
import { useChain, _ingest as ingestChain } from '@/stores/optionChainStore';

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
const CAPITAL_PERCENT_OPTIONS = [5, 10, 15, 20, 25, 40, 50, 60, 70, 80, 90, 100];

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
    qty: number;
    lotSize?: number;
    contractSecurityId?: string | null;
    targetPrice?: number | null;
    stopLossPrice?: number | null;
    trailingStopEnabled?: boolean;
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
        row: 'border-violet-pulse/30 bg-violet-pulse/[0.04] border-l-violet-pulse/60',
        text: 'text-violet-pulse',
        textSoft: 'text-violet-pulse/80',
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
  const [entryPriceEdited, setEntryPriceEdited] = useState(false);
  const [capitalPercent, setCapitalPercent] = useState(5);
  const [expiry, setExpiry] = useState('');
  const [qty, setQty] = useState(1);
  const [qtyMode, setQtyMode] = useState<'fixed' | 'percent'>('fixed');
  const [isQtyPopoverOpen, setIsQtyPopoverOpen] = useState(false);

  // SL/TP/TSL state (preserved across trades for the session)
  const [slEnabled, setSlEnabled] = useState(false);
  const [slPrice, setSlPrice] = useState('');
  const [tpEnabled, setTpEnabled] = useState(false);
  const [tpPrice, setTpPrice] = useState('');
  const [tslEnabled, setTslEnabled] = useState(false);
  const [isSLTPPopoverOpen, setIsSLTPPopoverOpen] = useState(false);
  const [hasUserInteractedWithSLTP, setHasUserInteractedWithSLTP] = useState(false);

  // All current instruments (NIFTY 50, BANK NIFTY, CRUDE OIL, NATURAL GAS) are derivatives.
  // Equity instruments (if added later) would not appear in UNDERLYING_MAP.
  const isDerivative = instrument in UNDERLYING_MAP;
  const isOptionTrade = optionType === 'CE' || optionType === 'PE';
  const canSelectExpiry = isDerivative && optionType !== 'NONE';
  const canSelectStrike = isDerivative && optionType !== 'NONE' && !!expiry;
  const tone = getWorkspaceTone(workspace);
  const brokerConfigQuery = trpc.broker.config.get.useQuery(undefined);
  const isPaperBroker = brokerConfigQuery.data?.isPaperBroker ?? false;

  // Initialize SL/TP/TSL settings from broker config on first load
  useEffect(() => {
    if (brokerConfigQuery.data?.settings && !slPrice && !tpPrice) {
      // Only initialize once when broker config loads
      const settings = brokerConfigQuery.data.settings;
      if (settings.trailingStopEnabled) {
        setTslEnabled(true);
      }
    }
  }, [brokerConfigQuery.data?.settings, slPrice, tpPrice]);

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

  // Clear expiry + strike immediately on instrument change so a stale value
  // (from the previous instrument's expiry list) can't be submitted while
  // the new expiry query is still refetching. Prevents "Invalid Expiry Date"
  // errors when switching e.g. NIFTY → CRUDE OIL and submitting quickly.
  useEffect(() => {
    setExpiry('');
    setSelectedStrike('');
  }, [instrument]);

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

  // ─── Option chain — read from client store (populated by server push) ──
  // The server's DhanAdapter.chainCache emits a chainUpdate over /ws/ticks
  // whenever it refreshes (triggered by TFA's ~5s polling). The browser's
  // optionChainStore mirrors those pushes. Zero Dhan traffic originates from
  // this form as long as the store has the requested (u, expiry, segment).
  const cachedChain = useChain(
    canSelectStrike ? requestUnderlying : null,
    canSelectStrike ? expiry : null,
    canSelectStrike ? (requestExchangeSegment || null) : null,
  );

  // Fallback: if the store is cold for this key (e.g. TFA not polling this
  // instrument, or browser just connected before first push), issue a single
  // tRPC query. Result is written into the store; every subsequent consumer
  // reads from the store. Self-healing — first visitor pays one fetch.
  const needsFallback = canSelectStrike && !cachedChain;
  const fallbackQuery = trpc.broker.optionChain.useQuery(
    { underlying: requestUnderlying, expiry, exchangeSegment: requestExchangeSegment },
    {
      enabled: needsFallback,
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
    }
  );

  useEffect(() => {
    const data = fallbackQuery.data;
    if (!data || !data.rows) return;
    ingestChain({
      underlying: requestUnderlying,
      expiry,
      exchangeSegment: requestExchangeSegment || 'IDX_I',
      spotPrice: data.spotPrice ?? 0,
      lotSize: data.lotSize ?? 1,
      timestamp: data.timestamp ?? Date.now(),
      strikes: data.rows.map((r) => ({
        strike: r.strike,
        ceSecurityId: r.callSecurityId ?? null,
        peSecurityId: r.putSecurityId ?? null,
        ceLTP: r.callLTP ?? 0,
        peLTP: r.putLTP ?? 0,
      })),
    });
  }, [fallbackQuery.data, requestUnderlying, expiry, requestExchangeSegment]);

  const strikeOptions = useMemo(() => {
    const strikes = cachedChain?.strikes ?? [];
    if (strikes.length === 0) return [];

    const sorted = [...strikes].sort((a, b) => a.strike - b.strike);
    const spotPrice = cachedChain?.spotPrice ?? 0;

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
      callLTP: row.ceLTP,
      putLTP: row.peLTP,
      callSecurityId: row.ceSecurityId ?? undefined,
      putSecurityId: row.peSecurityId ?? undefined,
      isATM: row.strike === sorted[atmIndex].strike,
    }));
  }, [cachedChain]);

  useEffect(() => {
    setSelectedStrike('');
    setEntryPrice('');
  }, [expiry, instrument]);

  useEffect(() => {
    if (selectedStrike || strikeOptions.length === 0) return;
    const atmStrike = strikeOptions.find((strike) => strike.isATM);
    if (atmStrike) {
      setSelectedStrike(String(atmStrike.strike));
    }
  }, [selectedStrike, strikeOptions]);

  useEffect(() => {
    if (!isOptionTrade || !selectedStrike) return;
    // Reset edited flag when strike/option changes, then set LTP as new default
    setEntryPriceEdited(false);
    const strikeData = strikeOptions.find((item) => String(item.strike) === selectedStrike);
    if (!strikeData) return;

    const ltp = optionType === 'CE' ? strikeData.callLTP : strikeData.putLTP;
    if (ltp > 0) {
      setEntryPrice(ltp.toFixed(2));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOptionTrade, optionType, selectedStrike]);  // Note: strikeOptions intentionally excluded to prevent LTP live-updates overwriting user edits

  // Reset qty when switching to percent mode or when instrument/entry price changes
  useEffect(() => {
    if (qtyMode === 'percent') {
      // Keep current percentage, but it will recalculate qty automatically via useMemo
    }
  }, [qtyMode, instrument, entryPrice, availableCapital]);

  const currentLtp = useMemo(() => {
    if (!isOptionTrade || !selectedStrike) return 0;
    const strikeData = strikeOptions.find((item) => String(item.strike) === selectedStrike);
    if (!strikeData) return 0;
    return optionType === 'CE' ? strikeData.callLTP : strikeData.putLTP;
  }, [isOptionTrade, optionType, selectedStrike, strikeOptions]);

  const selectedContractSecurityId = useMemo(() => {
    if (!isOptionTrade || !selectedStrike) return undefined;
    const strikeData = strikeOptions.find((item) => String(item.strike) === selectedStrike);
    if (!strikeData) return undefined;
    return optionType === 'CE' ? strikeData.callSecurityId : strikeData.putSecurityId;
  }, [isOptionTrade, optionType, selectedStrike, strikeOptions]);

  const underlyingSymbol = UNDERLYING_MAP[instrument] ?? instrument;
  const lotSizeQuery = trpc.broker.getLotSize.useQuery(
    { symbol: underlyingSymbol },
    { enabled: isDerivative, staleTime: Infinity }
  );
  const lotSize = cachedChain?.lotSize ?? lotSizeQuery.data ?? 1;

  // actualQty is always in LOTS (qty=1 means 1 lot).
  // totalUnits = actualQty * lotSize is what gets traded.
  const actualQty = useMemo(() => {
    if (qtyMode === 'percent') {
      const entryPriceNum = parseFloat(entryPrice || '0');
      if (entryPriceNum <= 0) return 0;
      const rawUnits = Math.floor((availableCapital * qty / 100) / entryPriceNum);
      return lotSize > 1 ? Math.max(1, Math.floor(rawUnits / lotSize)) : rawUnits;
    }
    return Math.max(1, qty);
  }, [qtyMode, qty, availableCapital, entryPrice, lotSize]);

  const totalUnits = actualQty * Math.max(lotSize, 1);
  const estimatedLots = lotSize > 1 ? actualQty : 0;
  const invested = totalUnits * parseFloat(entryPrice || '0');

  // Calculate estimated charges for entry leg
  const estimatedCharges = useMemo(() => {
    const entryPriceNum = parseFloat(entryPrice || '0');
    if (entryPriceNum <= 0 || totalUnits <= 0) return 0;

    const result = estimateSingleLegCharges(
      entryPriceNum,
      totalUnits,
      direction === 'BUY',
      DEFAULT_CHARGES as ChargeRate[]
    );
    return result.total;
  }, [entryPrice, totalUnits, direction]);

  const formReady =
    !!instrument &&
    !!direction &&
    (isDerivative ? !!optionType : true) &&
    (!isOptionTrade || (!!expiry && !!selectedStrike)) &&
    !!entryPrice &&
    parseFloat(entryPrice) > 0;

  const handleSubmit = async () => {

    const effectiveOptionType = optionType ?? 'NONE';
    const type =
      effectiveOptionType === 'NONE'
        ? direction!
        : `${effectiveOptionType === 'CE' ? 'CALL' : 'PUT'}_${direction!}` as
          'CALL_BUY' | 'CALL_SELL' | 'PUT_BUY' | 'PUT_SELL';

    await onSubmit({
      instrument,
      type,
      strike: isOptionTrade && selectedStrike ? parseFloat(selectedStrike) : null,
      expiry: isOptionTrade ? expiry : '',
      entryPrice: parseFloat(entryPrice),
      capitalPercent,
      qty: actualQty,
      lotSize: lotSize > 1 ? lotSize : undefined,
      contractSecurityId: selectedContractSecurityId ?? null,
      ...(hasUserInteractedWithSLTP && {
        stopLossPrice: slEnabled && slPrice ? parseFloat(slPrice) : null,
        targetPrice: tpEnabled && tpPrice ? parseFloat(tpPrice) : null,
        trailingStopEnabled: tslEnabled,
      }),
    });

    setSelectedStrike('');
    setEntryPrice('');
    setCapitalPercent(5);
    setDirection(null);
    setOptionType(null);
    setExpiry('');
  };

  const cycleDateLabel = (() => {
    const now = new Date();
    const day = now.getDate();
    const month = now.toLocaleDateString('en-IN', { month: 'short' });
    const year = String(now.getFullYear()).slice(2);
    const dateLabel = `${day} ${month} ${year}`;
    const ageLabel = formatAge(dayOpenedAt);
    return ageLabel ? `${dateLabel} | ${ageLabel}` : dateLabel;
  })();

  const selectClass = `w-full bg-background border border-border rounded px-1.5 py-1 text-[0.625rem] ${tone.text} focus:border-primary focus:outline-none`;
  const compactSelectClass = `shrink-0 bg-background border border-border rounded px-1.5 py-1 text-[0.625rem] ${tone.text} focus:border-primary focus:outline-none disabled:opacity-50`;
  const inputClass = `w-full bg-background border border-border rounded px-1.5 py-1 text-[0.625rem] ${tone.text} tabular-nums text-right focus:border-primary focus:outline-none`;

  return (
    <tr className={`border-b border-l-2 ${tone.row}`}>
      <td className="px-2 py-2 text-right border-r border-border">
        {dayValues ? (
          <span className={`tabular-nums ${tone.textSoft}`}>{dayValues.dayIndex}</span>
        ) : (
          <span className={`text-[0.5625rem] font-bold ${tone.text}`}>NEW</span>
        )}
      </td>

      <td className="px-2 py-2 text-right border-r border-border">
        <span className={`block truncate text-[0.625rem] tabular-nums ${tone.text}`}>{cycleDateLabel}</span>
      </td>

      <td className={`px-2 py-2 text-right tabular-nums border-r border-border ${tone.textSoft}`}>
        {dayValues ? fmt(dayValues.tradeCapital, true) : '-'}
      </td>

      <td className={`px-2 py-2 text-right tabular-nums border-r border-border ${tone.textSoft}`}>
        {dayValues ? (
          <>
            {fmt(dayValues.targetAmount)}
            <span className="ml-0.5 text-[0.5rem]">({dayValues.targetPercent}%)</span>
          </>
        ) : '-'}
      </td>

      <td className={`px-2 py-2 text-right tabular-nums border-r border-border ${tone.textSoft}`}>
        {dayValues ? fmt(dayValues.projCapital, true) : '-'}
      </td>

      <td className="px-2 py-1 border-r border-border">
        <div className="flex items-center justify-between gap-2">
          {/* Left section: Instrument and controls */}
          <div className="flex flex-wrap items-center gap-1">
            {/* Instrument dropdown */}
            <select
              value={instrument}
              onChange={(e) => setInstrument(e.target.value)}
              className={`${compactSelectClass} w-[88px]`}
            >
              {instrumentOptions.map((inst) => (
                <option key={inst} value={inst}>{inst}</option>
              ))}
            </select>

            {/* Derivative fields: Expiry | Strike | CE/PE group */}
            {isDerivative && (
              <>
                <span className="text-border text-[0.5625rem]">|</span>
                <select
                  value={expiry}
                  onChange={(e) => setExpiry(e.target.value)}
                  className={`${compactSelectClass} w-[62px]`}
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

                <span className="text-border text-[0.5625rem]">|</span>
                <select
                  value={selectedStrike}
                  onChange={(e) => setSelectedStrike(e.target.value)}
                  disabled={!expiry}
                  className={`${compactSelectClass} w-[68px]`}
                >
                  <option value="">
                    {expiry ? 'Strike' : 'Pick Exp'}
                  </option>
                  {needsFallback && fallbackQuery.isLoading && (
                    <option value="" disabled>Loading...</option>
                  )}
                  {strikeOptions.map((strike) => (
                    <option key={strike.strike} value={String(strike.strike)}>
                      {strike.strike}
                    </option>
                  ))}
                  {expiry && !fallbackQuery.isLoading && strikeOptions.length === 0 && (
                    <option value="" disabled>No strikes</option>
                  )}
                </select>

                <span className="text-border text-[0.5625rem]">|</span>
                {/* CE / PE group */}
                <div className="flex shrink-0 items-center gap-1 rounded border border-border/50 px-1 py-0.5">
                  {(['CE', 'PE'] as const).map((opt) => (
                    <button
                      key={opt}
                      onClick={() => setOptionType(opt)}
                      className={`px-1.5 py-0.5 rounded text-[0.5625rem] font-bold transition-colors ${
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

            <span className="text-border text-[0.5625rem]">|</span>
            {/* B / S group */}
            <div className="flex shrink-0 items-center gap-1 rounded border border-border/50 px-1 py-0.5">
              <button
                onClick={() => setDirection('BUY')}
                className={`px-1.5 py-0.5 rounded text-[0.5625rem] font-bold transition-colors ${
                  direction === 'BUY'
                    ? 'bg-bullish/20 text-bullish'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                B
              </button>
              <button
                onClick={() => setDirection('SELL')}
                className={`px-1.5 py-0.5 rounded text-[0.5625rem] font-bold transition-colors ${
                  direction === 'SELL'
                    ? 'bg-destructive/20 text-destructive'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                S
              </button>
            </div>
          </div>

          {/* Right section: SL/TP editor and OK / X buttons */}
          <div className="flex shrink-0 items-center gap-1">
            <Popover 
              open={isSLTPPopoverOpen} 
              onOpenChange={(open) => {
                setIsSLTPPopoverOpen(open);
                if (open) setHasUserInteractedWithSLTP(true);
              }}
            >
              <PopoverTrigger asChild>
                <button
                  className="rounded bg-info-cyan/20 px-1.5 py-1 text-[0.5625rem] font-bold text-info-cyan transition-colors hover:bg-info-cyan/30"
                  title="Edit SL/TP/TSL"
                >
                  ⚙
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-52 p-3" align="end">
                <div className="space-y-2">
                  <div className="text-sm font-bold">SL / TP / TSL</div>

                  {/* SL */}
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setSlEnabled(!slEnabled)}
                      className={`px-2 py-0.5 rounded text-[0.5625rem] font-bold transition-colors ${slEnabled ? 'bg-destructive/20 text-destructive' : 'bg-muted/30 text-muted-foreground'}`}
                    >
                      {slEnabled ? 'ON' : 'OFF'}
                    </button>
                    <span className="text-[0.5625rem] text-destructive font-bold w-5">SL</span>
                    <input
                      type="number"
                      step="0.05"
                      value={slPrice}
                      onChange={(e) => setSlPrice(e.target.value)}
                      placeholder="price"
                      className="flex-1 min-w-0 px-1.5 py-1 text-[0.625rem] rounded border border-destructive/40 bg-background outline-none focus:border-destructive"
                      disabled={!slEnabled}
                    />
                  </div>

                  {/* TP */}
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setTpEnabled(!tpEnabled)}
                      className={`px-2 py-0.5 rounded text-[0.5625rem] font-bold transition-colors ${tpEnabled ? 'bg-bullish/20 text-bullish' : 'bg-muted/30 text-muted-foreground'}`}
                    >
                      {tpEnabled ? 'ON' : 'OFF'}
                    </button>
                    <span className="text-[0.5625rem] text-bullish font-bold w-5">TP</span>
                    <input
                      type="number"
                      step="0.05"
                      value={tpPrice}
                      onChange={(e) => setTpPrice(e.target.value)}
                      placeholder="price"
                      className="flex-1 min-w-0 px-1.5 py-1 text-[0.625rem] rounded border border-bullish/40 bg-background outline-none focus:border-bullish"
                      disabled={!tpEnabled}
                    />
                  </div>

                  {/* TSL */}
                  <div className="flex items-center gap-2 pt-1 border-t border-border/30">
                    <button
                      onClick={() => setTslEnabled(!tslEnabled)}
                      className={`px-2 py-0.5 rounded text-[0.5625rem] font-bold transition-colors ${tslEnabled ? 'bg-info-cyan/20 text-info-cyan' : 'bg-muted/30 text-muted-foreground'}`}
                    >
                      {tslEnabled ? 'ON' : 'OFF'}
                    </button>
                    <span className="text-[0.5625rem] text-info-cyan font-bold flex-1">TSL</span>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
            <button
              onClick={handleSubmit}
              disabled={loading || !formReady}
              className="rounded bg-bullish/20 px-1.5 py-1 text-[0.5625rem] font-bold text-bullish transition-colors hover:bg-bullish/30 disabled:cursor-not-allowed disabled:opacity-30"
              title="Place trade"
            >
              {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : 'OK'}
            </button>
            <button
              onClick={onCancel}
              className="rounded bg-destructive/20 px-1.5 py-1 text-[0.5625rem] font-bold text-destructive transition-colors hover:bg-destructive/30"
              title="Cancel"
            >
              X
            </button>
          </div>
        </div>
      </td>

      <td className="py-1 border-r border-border">
        <input
          type="number"
          value={entryPrice}
          onChange={(e) => { setEntryPrice(e.target.value); setEntryPriceEdited(true); }}
          placeholder="Entry"
          step="0.05"
          className={`w-full bg-background border-y border-border px-1.5 py-1 text-[0.625rem] ${tone.text} tabular-nums text-right focus:border-primary focus:outline-none`}
        />
      </td>

      <td className="px-2 py-2 text-right border-r border-border">
        <span className={`text-[0.625rem] tabular-nums ${tone.textSoft}`}>
          {currentLtp > 0 ? currentLtp.toFixed(2) : '-'}
        </span>
      </td>

      <td className="px-2 py-1 border-r border-border">
        <Popover open={isQtyPopoverOpen} onOpenChange={setIsQtyPopoverOpen}>
          <PopoverTrigger asChild>
            <button
              className={`w-full px-2 py-1 text-[0.625rem] tabular-nums text-right rounded border transition-colors hover:bg-accent hover:text-accent-foreground cursor-pointer ${tone.textSoft} border-border`}
              title="Click to adjust quantity"
            >
              {actualQty > 0
                ? (lotSize > 1 ? actualQty : totalUnits)
                : qtyMode === 'percent' ? `${qty}%` : '1'}
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-64 p-3" align="start">
            <div className="space-y-3">
              <div className="text-sm font-medium">Quantity Settings</div>

              {/* Fixed Qty Section */}
              <div className="space-y-2">
                <div className="text-xs font-medium text-muted-foreground">Fixed Quantity</div>
                <div className="flex gap-1 flex-wrap">
                  {[1, 5, 10, 15, 20, 50].map((value) => (
                    <button
                      key={value}
                      onClick={() => {
                        setQty(value);
                        setQtyMode('fixed');
                        setIsQtyPopoverOpen(false);
                      }}
                      className="px-2 py-1 text-xs rounded border hover:bg-accent hover:text-accent-foreground transition-colors"
                    >
                      {value}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setQty(Math.max(1, qty - 1))}
                    className="p-1 rounded border hover:bg-accent hover:text-accent-foreground transition-colors"
                    disabled={qty <= 1}
                  >
                    <ChevronDown className="h-3 w-3" />
                  </button>
                  <span className="text-sm font-mono min-w-[3rem] text-center">{qty}</span>
                  <button
                    onClick={() => setQty(qty + 1)}
                    className="p-1 rounded border hover:bg-accent hover:text-accent-foreground transition-colors"
                  >
                    <ChevronUp className="h-3 w-3" />
                  </button>
                </div>
              </div>

              {/* Percentage Section */}
              <div className="space-y-2">
                <div className="text-xs font-medium text-muted-foreground">% of Capital</div>
                <div className="flex gap-1 flex-wrap">
                  {CAPITAL_PERCENT_OPTIONS.map((value) => (
                    <button
                      key={value}
                      onClick={() => {
                        setQty(value);
                        setQtyMode('percent');
                        setIsQtyPopoverOpen(false);
                      }}
                      className="px-2 py-1 text-xs rounded border hover:bg-accent hover:text-accent-foreground transition-colors"
                    >
                      {value}%
                    </button>
                  ))}
                </div>
              </div>

              <div className="text-xs text-muted-foreground">
                Mode: {qtyMode === 'fixed' ? 'Fixed' : 'Percentage'} | {lotSize > 1 ? `Lots: ${estimatedLots} | ` : ''}Capital: {fmt(invested)}
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </td>

      <td className={`px-2 py-2 text-right tabular-nums border-r border-border ${tone.textSoft}`}>
        {invested > 0 ? fmt(invested) : '-'}
      </td>

      <td className="px-2 py-2 border-r border-border" /> {/* Points - empty for new trade */}
      <td className="px-2 py-2 border-r border-border" /> {/* P&L - empty for new trade */}
      <td className="px-2 py-2 border-r border-border" /> {/* Capital - empty for new trade */}
      <td className="px-2 py-2 border-r border-border" /> {/* Dev. - empty for new trade */}
      <td className="px-2 py-2 text-center" /> {/* Rating - empty for new trade */}
    </tr>
  );
}
