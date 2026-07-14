import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, LineChart } from 'lucide-react';
import { toast } from 'sonner';
import { estimateSingleLegCharges, DEFAULT_CHARGES, chargeRatesForTrade } from '@shared/chargesEngine';
import { ChargesBreakdownTip } from './ChargesBreakdownTip';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { Channel, TradeRecord } from '@/lib/tradeTypes';
import { channelToWorkspace, optionExchangeFor, feedExchangeForTrade, isEquityTrade, isPaperChannel } from '@/lib/tradeTypes';
import {
  fmt,
  pnlColor,
  formatAge,
  formatDuration,
  formatExpiryLabel,
  getTradeDirectionLabel,
  getTradeContractLabel,
  contractCopyText,
} from '@/lib/tradeFormatters';
import { tradePoints } from '@/lib/tradeCalculations';
import { getWorkspaceThemeMeta, withAlpha, cohortPillStyle, cohortLabel } from '@/lib/tradeThemes';
import { useInstrumentColors } from '@/lib/useInstrumentColors';
import { istDateString } from '@/lib/signalChart';
import OptionChartDialog, { type OptionChartTargetLite } from './OptionChartDialog';
import { useSelectedSignalSeq } from '@/lib/selectionStore';
import { useInstrumentTick } from '@/hooks/useTickStream';
import { trpc } from '@/lib/trpc';
import { InstrumentTag } from './InstrumentTag';
import { StatusBadge } from './StatusBadge';
import { TpSlMergedBody, pctFromPrice } from './TpSlMergedBody';
import { ReconcileDesyncDialog } from './ReconcileDesyncDialog';
import { TradeBar } from './TradeBar';

export interface TodayTradeRowProps {
  trade: TradeRecord;
  isFirst: boolean;
  showNet: boolean;
  onExit: (tradeId: string, instrument: string) => void;
  exitLoading?: boolean;
  onUpdateTpSl: (
    tradeId: string,
    patch: { targetPrice?: number; stopLossPrice?: number; trailingStopEnabled?: boolean },
  ) => void;
  todayRef?: React.RefObject<HTMLTableRowElement | null>;
  canManageTrades: boolean;
  channel: Channel;
  /** Global trailing-stop setting (from broker config). Trailing is now a
   *  workspace-wide switch, not per-trade — so the row reflects this flag
   *  rather than the trade's frozen value. */
  globalTrailingEnabled?: boolean;
  /** Fallback hard-stop % (settings defaultSL) — used only when the trade has no
   *  stored stop yet; otherwise the bar derives the stop from trade.stopLossPrice. */
  slPercent?: number;
  /** Trailing activation gate % (settings) — positions the pending TSL marker. */
  tslGatePercent?: number;
  /** Seconds price must hold past the gate before the server arms the TSL. */
  tslHoldSeconds?: number;
  /** 1-based trade number within the day, shown on the left of the row. */
  tradeNo?: number;
}

interface RenderProps extends TodayTradeRowProps {
  liveLtp?: number;
}

function _TodayTradeRow({
  trade,
  isFirst,
  showNet,
  onExit,
  exitLoading,
  onUpdateTpSl,
  todayRef,
  canManageTrades,
  channel,
  globalTrailingEnabled = false,
  slPercent,
  tslGatePercent,
  tslHoldSeconds,
  tradeNo,
  liveLtp,
}: RenderProps) {
  const [editOpen, setEditOpen] = useState(false);
  const [reconcileOpen, setReconcileOpen] = useState(false);
  const [chartOpen, setChartOpen] = useState(false);
  const [slPrice, setSlPrice] = useState('');
  const [tpPrice, setTpPrice] = useState('');
  const theme = getWorkspaceThemeMeta(channelToWorkspace(channel));
  const { hexOf } = useInstrumentColors();
  const instHex = hexOf(trade.instrument);
  const isOpen = trade.status === 'OPEN';
  // Whether THIS trade is actively trailing: paper-only (the live exit engine is
  // skipped — see T60 / gap #4) and only when its per-trade TSL mode is "auto".
  // Independent of the global trailing switch, which only SEEDS the mode at open.
  const serverTrails = isPaperChannel(channel) && (trade.tslMode ?? 'auto') !== 'manual';
  // Per-trade risk overrides (paper): toggle the hard stoploss and TSL auto/manual.
  const utils = trpc.useUtils();
  const setRiskMutation = trpc.executor.setTradeRisk.useMutation({
    onSuccess: () => {
      void utils.portfolio.allDays.invalidate();
      void utils.portfolio.state.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  // B4 follow-up — a trade is "desync'd" when the broker call failed but
  // local state hasn't been confirmed. Operator must reconcile before
  // any further actions on this trade are allowed.
  const isDesync = trade.desync !== undefined;
  const isBuy = trade.type.includes('BUY');
  const displayLtp = liveLtp ?? trade.ltp;

  // Flash background green/red on LTP change (open trades only — closed rows never get here with a changing liveLtp).
  const prevLtpRef = useRef<number | undefined>(undefined);
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);
  useEffect(() => {
    const prev = prevLtpRef.current;
    prevLtpRef.current = displayLtp;
    if (prev === undefined || prev === displayLtp || !isOpen) return;
    setFlash(displayLtp > prev ? 'up' : 'down');
    const t = setTimeout(() => setFlash(null), 400);
    return () => clearTimeout(t);
  }, [displayLtp, isOpen]);
  const flashClass = flash === 'up' ? 'bg-bullish/30' : flash === 'down' ? 'bg-destructive/30' : '';
  const liveUnrealizedPnl = isOpen
    ? (isBuy ? (displayLtp - trade.entryPrice) : (trade.entryPrice - displayLtp)) * trade.qty
    : 0;
  const pnl = isOpen ? liveUnrealizedPnl : (showNet ? trade.pnl : trade.pnl + trade.charges);
  // Brighter (full-opacity) P&L colour for the P&L / P&L% columns so they pop a
  // little more than the /80 used elsewhere.
  const pnlBright = pnl > 0 ? 'text-bullish' : pnl < 0 ? 'text-destructive' : 'text-foreground';
  // Round-trip charges (buy + sell) + per-charge breakdown for the tooltip.
  // Estimate both legs from prices (entry + exit/LTP) — used directly for open
  // trades, and as a fallback breakdown for closed trades that don't carry a
  // stored one. Closed trades otherwise show the real figures from the server.
  const exitRef = isOpen ? displayLtp : (trade.exitPrice ?? trade.entryPrice);
  // Stocks estimate with their equity (intraday/delivery) profile; options use the default.
  const estRates = chargeRatesForTrade(trade, DEFAULT_CHARGES);
  const entryLeg = estimateSingleLegCharges(trade.entryPrice, trade.qty, isBuy, estRates);
  const exitLeg = estimateSingleLegCharges(exitRef, trade.qty, !isBuy, estRates);
  const estByName = new Map<string, number>();
  for (const b of [...entryLeg.breakdown, ...exitLeg.breakdown]) {
    estByName.set(b.name, (estByName.get(b.name) ?? 0) + b.amount);
  }
  const estBreakdown = Array.from(estByName, ([name, amount]) => ({ name, amount: Math.round(amount * 100) / 100 }));
  const charges = isOpen ? entryLeg.total + exitLeg.total : (trade.charges || entryLeg.total + exitLeg.total);
  const chargesBreakdown = isOpen
    ? estBreakdown
    : (trade.chargesBreakdown && trade.chargesBreakdown.length > 0 ? trade.chargesBreakdown : estBreakdown);
  const pnlPercent = trade.entryPrice > 0
    ? ((isOpen ? liveUnrealizedPnl : trade.pnl) / (trade.entryPrice * trade.qty) * 100)
    : 0;

  const directionLabel = getTradeDirectionLabel(trade.type);
  const contractLabel = getTradeContractLabel(trade.type);
  // Target for the popup option chart (only for CE/PE trades with a contract id).
  const chartTarget: OptionChartTargetLite | null =
    (contractLabel === 'CE' || contractLabel === 'PE') && trade.contractSecurityId && trade.strike != null
      ? {
          instrumentKey: trade.instrument,
          displayName: `${trade.instrument} ${trade.strike} ${contractLabel}`,
          securityId: trade.contractSecurityId,
          exchangeSegment: optionExchangeFor(trade.instrument),
          strike: trade.strike,
          side: contractLabel,
          channel,
          date: istDateString(new Date(trade.openedAt)),
          expiry: trade.expiry,
        }
      : null;
  const expiryLabel = formatExpiryLabel(trade.expiry);

  // Tray→desk selection: highlight + scroll this row when its signal card is clicked.
  const selectedSeq = useSelectedSignalSeq();
  const isSelected = trade.signalSeq != null && trade.signalSeq === selectedSeq;
  const rowElRef = useRef<HTMLTableRowElement | null>(null);
  const attachRow = useCallback((el: HTMLTableRowElement | null) => {
    rowElRef.current = el;
    if (todayRef) todayRef.current = el;
  }, [todayRef]);
  useEffect(() => {
    if (isSelected) rowElRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [isSelected]);

  return (
    <>
    <tr
      ref={attachRow}
      className={`border-b border-border transition-colors text-foreground border-l-2 ${
        isFirst ? theme.borderStrong : theme.borderSoft
      } ${isOpen ? '' : 'opacity-60'} ${isSelected ? 'outline outline-2 -outline-offset-2 outline-info-cyan' : ''}`}
      style={{ backgroundColor: withAlpha(instHex, isFirst ? 0.16 : 0.08) }}
    >
      {/* Instrument + TradeBar take the full left width (cols 0–5); the day-level
          numbers that used to sit here are now in the top summary banner. */}
      <td colSpan={6} className="px-2 py-1.5 border-r border-border">
        <div className="flex items-center gap-2 w-full">
          {/* Instrument identity (left) */}
          <div className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap min-w-0 shrink-0">
            {trade.signalSeq != null && (
              <span
                className="text-[0.625rem] font-semibold tabular-nums text-info-cyan shrink-0"
                title="Signal # — matches the tray card"
              >
                #{trade.signalSeq}
              </span>
            )}
            {/* Instrument identity (the whole closed row is dimmed at row level). */}
            <div className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap min-w-0">
              {(() => {
                const copyText = contractCopyText(trade.instrument, trade.expiry, trade.strike, contractLabel);
                return copyText ? (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      navigator.clipboard?.writeText(copyText).then(
                        () => toast.success(`Copied: ${copyText}`),
                        () => toast.error('Copy failed'),
                      );
                    }}
                    className="cursor-pointer"
                    title={`Click to copy: ${copyText}`}
                  >
                    <InstrumentTag name={trade.instrument} muted={!isOpen} />
                  </span>
                ) : (
                  <InstrumentTag name={trade.instrument} muted={!isOpen} />
                );
              })()}
              {trade.cohort && (
                <span
                  className="text-[0.5rem] font-semibold uppercase tracking-wide rounded px-1 py-0.5 shrink-0"
                  style={cohortPillStyle(trade.cohort)}
                  title={`Signal cohort: ${trade.cohort}`}
                >
                  {cohortLabel(trade.cohort)}
                </span>
              )}
              {expiryLabel && (
                <>
                  <span className="text-border">|</span>
                  <span className="text-[0.5625rem] tabular-nums text-muted-foreground">{expiryLabel}</span>
                </>
              )}
              {trade.strike !== null && (
                <>
                  <span className="text-border">|</span>
                  <span className="text-[0.5625rem] tabular-nums text-muted-foreground">{trade.strike}</span>
                </>
              )}
              <span className="text-border">|</span>
              <span className={`text-[0.5625rem] ${isOpen ? 'font-bold' : ''} ${theme.buttonActive} rounded px-1 py-0.5`}>{contractLabel}</span>
              <span className="text-border">|</span>
              <span className={`text-[0.5625rem] ${isOpen ? 'font-semibold' : ''} ${isBuy ? 'text-bullish' : 'text-destructive'}`}>{directionLabel}</span>
              {(contractLabel === 'CE' || contractLabel === 'PE') &&
                trade.contractSecurityId &&
                trade.strike != null && (
                  <button
                    type="button"
                    onClick={() => setChartOpen(true)}
                    className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                    title="Open this strike's chart popup — candles + your entry/exit + SL/TP, live 5s"
                  >
                    <LineChart className="h-3 w-3" />
                  </button>
                )}
            </div>
          </div>

          {/* TradeBar fills the middle, on the same line (open trades only) */}
          {isOpen && (
            <div className="flex-1 min-w-0">
              <TradeBar
                isBuy={isBuy}
                entryPrice={trade.entryPrice}
                ltp={displayLtp}
                slPercent={
                  trade.stopLossPrice && trade.stopLossPrice > 0
                    ? ((isBuy ? trade.entryPrice - trade.stopLossPrice : trade.stopLossPrice - trade.entryPrice) /
                        trade.entryPrice) * 100
                    : slPercent
                }
                tpPercent={
                  trade.targetPrice && trade.targetPrice > 0
                    ? ((isBuy ? trade.targetPrice - trade.entryPrice : trade.entryPrice - trade.targetPrice) /
                        trade.entryPrice) * 100
                    : undefined
                }
                trailingEnabled={serverTrails}
                tslHoldSeconds={tslHoldSeconds}
                tslActivatedAt={trade.tslActivatedAt ?? null}
                tslGatePrice={(() => {
                  const be = trade.breakevenPrice ?? trade.entryPrice;
                  const g = tslGatePercent ?? 2;
                  return isBuy ? be * (1 + g / 100) : be * (1 - g / 100);
                })()}
                units={trade.qty}
                roundTripCharges={charges}
                compact
                onSetTp={isPaperChannel(channel) ? (price) => onUpdateTpSl(trade.id, { targetPrice: price }) : undefined}
                onSetSl={isPaperChannel(channel) ? (price) => onUpdateTpSl(trade.id, { stopLossPrice: price }) : undefined}
                onStopLossHit={() => {
                  // Diagnostic only ([XSYNC] exit-sync): the client LTP crossed
                  // the marker. NOT a user toast — that fires on the real
                  // server exit (status transition below), which can differ.
                  if (import.meta.env.DEV) console.log(`[XSYNC-CLI] predict SL-HIT trade=${trade.id} ${trade.instrument} ltp=${displayLtp.toFixed(2)} stop=${trade.stopLossPrice}`);
                }}
                onTakeProfitHit={() => {
                  if (import.meta.env.DEV) console.log(`[XSYNC-CLI] predict TP-HIT trade=${trade.id} ${trade.instrument} ltp=${displayLtp.toFixed(2)} target=${trade.targetPrice}`);
                }}
              />
            </div>
          )}

          {/* Age + exit / reconcile controls (right) */}
          <div className="flex items-center gap-1 shrink-0 ml-auto">
            {/* Sustained duration: live age while open, final hold once closed */}
            {isOpen ? (
              <span className="text-[0.5rem] text-muted-foreground/60 tabular-nums" title="Time in trade (live)">
                {formatAge(trade.openedAt)}
              </span>
            ) : (
              (() => {
                const held = trade.durationMs ?? (trade.closedAt && trade.openedAt ? trade.closedAt - trade.openedAt : null);
                return held != null ? (
                  <span className="text-[0.5rem] text-muted-foreground/60 tabular-nums" title="Trade duration (held)">
                    {formatDuration(held)}
                  </span>
                ) : null;
              })()
            )}
            {isDesync && canManageTrades && (
              <button
                onClick={(e) => { e.stopPropagation(); setReconcileOpen(true); }}
                className="px-1.5 py-0.5 rounded font-bold transition-colors bg-destructive/30 text-destructive border border-destructive hover:bg-destructive/40 text-[0.5625rem] uppercase tracking-wider"
                title={`BROKER_DESYNC (${trade.desync?.kind}): ${trade.desync?.reason ?? ''} — click to reconcile`}
              >
                ⚠ Reconcile
              </button>
            )}
            {/* Per-trade risk toggles — shown on EVERY paper workspace (ai / my /
                testing), so you can override the SEA's risk on its own auto-trades.
                Paper-only: hidden on live channels where the stops are real broker
                orders, not the software-managed ones these toggles control.
                SL: disable the hard stoploss (trailing stop still exits).
                TP: disable the take-profit (trade rides on SL/TSL only).
                TSL: auto ↔ manual (freeze trailing) — independent of the global
                     trailing switch, which only seeds the mode at open. */}
            {isOpen && !isDesync && isPaperChannel(channel) && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setRiskMutation.mutate({ channel, tradeId: trade.id, stopLossDisabled: !(trade.stopLossDisabled ?? false) });
                }}
                disabled={setRiskMutation.isPending}
                className={`px-1.5 py-0.5 rounded text-[0.5625rem] font-bold border transition-colors disabled:opacity-40 ${
                  trade.stopLossDisabled
                    ? 'bg-warning-amber/25 text-warning-amber border-warning-amber/60'
                    : 'bg-foreground/10 text-foreground border-foreground/30 hover:bg-foreground/20'
                }`}
                title={trade.stopLossDisabled
                  ? 'Hard stoploss OFF — click to re-enable (trailing stop still active either way)'
                  : 'Hard stoploss ON — click to disable it (keeps the trailing stop)'}
              >
                SL {trade.stopLossDisabled ? 'off' : 'on'}
              </button>
            )}
            {isOpen && !isDesync && isPaperChannel(channel) && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setRiskMutation.mutate({ channel, tradeId: trade.id, targetDisabled: !(trade.targetDisabled ?? false) });
                }}
                disabled={setRiskMutation.isPending}
                className={`px-1.5 py-0.5 rounded text-[0.5625rem] font-bold border transition-colors disabled:opacity-40 ${
                  trade.targetDisabled
                    ? 'bg-warning-amber/25 text-warning-amber border-warning-amber/60'
                    : 'bg-foreground/10 text-foreground border-foreground/30 hover:bg-foreground/20'
                }`}
                title={trade.targetDisabled
                  ? 'Take-profit OFF — click to re-enable (trade rides on SL/TSL only while off)'
                  : 'Take-profit ON — click to disable it (let the trade run past target on SL/TSL)'}
              >
                TP {trade.targetDisabled ? 'off' : 'on'}
              </button>
            )}
            {isOpen && !isDesync && isPaperChannel(channel) && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setRiskMutation.mutate({ channel, tradeId: trade.id, tslMode: (trade.tslMode ?? 'auto') === 'manual' ? 'auto' : 'manual' });
                }}
                disabled={setRiskMutation.isPending}
                className={`px-1.5 py-0.5 rounded text-[0.5625rem] font-bold border transition-colors disabled:opacity-40 ${
                  trade.tslMode === 'manual'
                    ? 'bg-info-cyan/25 text-info-cyan border-info-cyan/60'
                    : 'bg-foreground/10 text-foreground border-foreground/30 hover:bg-foreground/20'
                }`}
                title={trade.tslMode === 'manual'
                  ? 'Trailing stop MANUAL (frozen — you set the stop) — click for AUTO'
                  : 'Trailing stop AUTO (server trails) — click to freeze (MANUAL)'}
              >
                TSL {trade.tslMode === 'manual' ? 'M' : 'A'}
              </button>
            )}
            {/* Exit is allowed for the option workspaces (manual controls) and,
                additionally, for paper stock trades in the Stocks workspace. */}
            {isOpen && !isDesync && (canManageTrades || (isPaperChannel(channel) && isEquityTrade(trade))) && (
              <button
                onClick={(e) => { e.stopPropagation(); onExit(trade.id, trade.instrument); }}
                disabled={exitLoading}
                className="px-1 py-0.5 rounded font-bold transition-colors bg-destructive/15 text-destructive hover:bg-destructive/25 disabled:opacity-30"
                title="Exit position"
              >
                {exitLoading ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : '×'}
              </button>
            )}
          </div>
        </div>
      </td>
      <td className="px-2 py-1.5 text-right tabular-nums border-r border-border">
        {trade.entryPrice.toFixed(2)}
      </td>
      <td className="px-2 py-1.5 text-right border-r border-border">
        <Popover open={editOpen} onOpenChange={open => { if (!open) setEditOpen(false); }}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <span
                  className={`tabular-nums cursor-pointer rounded px-1 transition-colors duration-300 ${isOpen ? (displayLtp >= trade.entryPrice ? 'text-bullish' : 'text-destructive') : pnlColor(pnl)} ${flashClass}`}
                  onClick={() => {
                    if (!isOpen || !canManageTrades) return;
                    if (isDesync) return; // reconcile first
                    setSlPrice(trade.stopLossPrice?.toFixed(2) ?? '');
                    setTpPrice(trade.targetPrice?.toFixed(2) ?? '');
                    setEditOpen(true);
                  }}
                >
                  {isOpen ? displayLtp.toFixed(2) : (trade.exitPrice?.toFixed(2) ?? '')}
                  {/* Wave 1: small TSL indicator when trailing-stop is active. SL value
                      itself ratchets via tickHandler; this badge tells operator the
                      stop is moving without needing to hover for the tooltip. */}
                  {isOpen && serverTrails && (
                    <span
                      className="ml-0.5 text-[0.5625rem] text-muted-foreground/80 align-baseline"
                      title="Trailing Stop active"
                    >
                      ↗
                    </span>
                  )}
                  {/* No contract id → the leg can't be subscribed, so the price
                      is the last stored snapshot, not live. Surface it instead
                      of silently showing a frozen number. */}
                  {isOpen && !trade.contractSecurityId && (
                    <span
                      className="ml-0.5 text-[0.5625rem] text-warning-amber align-baseline"
                      title="No live price — this trade has no contract id, so the shown price is the last stored snapshot, not the live LTP."
                    >
                      ⚠
                    </span>
                  )}
                </span>
              </PopoverTrigger>
            </TooltipTrigger>
            {isOpen && (trade.stopLossPrice != null || trade.targetPrice != null) && (
              <TooltipContent side="top">
                <div className="text-[0.625rem] space-y-0.5 tabular-nums">
                  {trade.stopLossPrice != null && (
                    <div className="flex justify-between gap-3">
                      <span className="text-destructive font-bold">{serverTrails ? 'TSL' : 'SL'}</span>
                      <span className="text-destructive">
                        {trade.stopLossPrice.toFixed(2)}
                        <span className="ml-1 text-destructive/70">
                          ({pctFromPrice('sl', isBuy, trade.entryPrice, trade.stopLossPrice).toFixed(1)}%)
                        </span>
                      </span>
                    </div>
                  )}
                  {trade.targetPrice != null && (
                    <div className="flex justify-between gap-3">
                      <span className="text-bullish font-bold">TP</span>
                      <span className="text-bullish">
                        {trade.targetPrice.toFixed(2)}
                        <span className="ml-1 text-bullish/70">
                          ({pctFromPrice('tp', isBuy, trade.entryPrice, trade.targetPrice).toFixed(1)}%)
                        </span>
                      </span>
                    </div>
                  )}
                </div>
              </TooltipContent>
            )}
          </Tooltip>
          <PopoverContent className="w-56 p-3" align="center" side="top">
            <TpSlMergedBody
              isBuy={isBuy}
              entryPrice={trade.entryPrice}
              slPrice={slPrice}
              setSlPrice={setSlPrice}
              tpPrice={tpPrice}
              setTpPrice={setTpPrice}
              trailingStopEnabled={globalTrailingEnabled}
              trailingStopPrice={trade.stopLossPrice ?? null}
              onCommit={() => {
                const sl = parseFloat(slPrice);
                const tp = parseFloat(tpPrice);
                const patch: { stopLossPrice?: number; targetPrice?: number } = {};
                if (sl > 0) patch.stopLossPrice = Math.round(sl * 100) / 100;
                if (tp > 0) patch.targetPrice = Math.round(tp * 100) / 100;
                if (Object.keys(patch).length > 0) onUpdateTpSl(trade.id, patch);
                setEditOpen(false);
              }}
              onCancel={() => setEditOpen(false)}
            />
          </PopoverContent>
        </Popover>
      </td>
      <td className="px-2 py-1.5 text-right tabular-nums border-r border-border">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-default">
              {trade.qty}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">
            <div className="text-[0.625rem] space-y-0.5 tabular-nums">
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Lots</span>
                <span className="font-bold">{trade.lotSize && trade.lotSize > 1 ? Math.floor(trade.qty / trade.lotSize) : 1}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Lot Size</span>
                <span className="font-bold">{trade.lotSize || 1}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Total Units</span>
                <span className="font-bold">{trade.qty}</span>
              </div>
            </div>
          </TooltipContent>
        </Tooltip>
      </td>
      <td className="px-2 py-1.5 text-right tabular-nums border-r border-border">
        {fmt(trade.entryPrice * trade.qty)}
      </td>
      <td className="px-2 py-1.5 text-right tabular-nums border-r border-border">
        {charges > 0 ? <ChargesBreakdownTip total={charges} breakdown={chargesBreakdown} estimate={isOpen} /> : ''}
      </td>
      <td className="px-2 py-1.5 text-right tabular-nums border-r border-border">
        {(() => {
          const price = isOpen ? displayLtp : (trade.exitPrice ?? 0);
          if (!price) return '';
          const pts = tradePoints(trade, price);
          return <span className={pnlColor(pnl)}>{pts >= 0 ? '+' : ''}{pts.toFixed(2)}</span>;
        })()}
      </td>
      <td className={`px-2 py-1.5 text-right tabular-nums border-r border-border ${pnlBright}`}>
        {fmt(Math.round(pnl), false)}
      </td>
      <td className={`px-2 py-1.5 text-right tabular-nums border-r border-border ${pnlBright}`}>
        {pnlPercent >= 0 ? '+' : ''}{pnlPercent.toFixed(1)}%
      </td>
      <td className="px-2 py-1.5 border-r border-border" />
      <td className="px-2 py-1.5 border-r border-border" />
      <td className="px-2 py-1.5 text-center">
        <StatusBadge status={trade.status} exitReason={trade.exitReason} reason={trade.rejectReason} />
      </td>
    </tr>
    <ReconcileDesyncDialog
      open={reconcileOpen}
      trade={trade}
      channel={channel}
      onClose={() => setReconcileOpen(false)}
    />
    <OptionChartDialog open={chartOpen} onOpenChange={setChartOpen} target={chartTarget} />
    </>
  );
}

/**
 * Subscriber wrapper mounted ONLY for OPEN trades.
 * Subscribes (via useInstrumentTick) to this trade's own contract, so it
 * re-renders only on its own ticks. Closed rows never mount this.
 */
function LiveTodayTradeRow(props: TodayTradeRowProps) {
  const { trade } = props;
  // Per-instrument subscription: this row re-renders only on its own contract's
  // ticks, not on every tick across the desk.
  const tick = useInstrumentTick(feedExchangeForTrade(trade), trade.contractSecurityId ?? null);
  return <_TodayTradeRow {...props} liveLtp={tick?.ltp} />;
}

/**
 * Public dispatcher. OPEN → subscribing wrapper; anything else → static row.
 * Memoized so closed rows skip re-renders on unrelated parent updates; open
 * rows drive their own renders via useSyncExternalStore (memo is bypassed).
 */
/**
 * Re-render only when something the row actually SHOWS changes.
 *
 * Two churn sources are deliberately ignored here:
 *  - `trade` identity churns every 2s poll (server re-serialisation of nullable
 *    fields), so we compare it BY VALUE — a closed trade's values are frozen, so
 *    it never re-renders; an open trade's ltp/pnl change, so it does.
 *  - the `onExit` / `onUpdateTpSl` handlers are recreated every poll (their deps
 *    include `currentDay` / the mutation object), but handler identity does NOT
 *    affect the rendered output, and closed rows never invoke them (no exit/edit
 *    on a closed trade). Open rows re-render anyway, so they always hold a fresh
 *    handler. Comparing them by reference was what kept every row re-rendering.
 *
 * Live WS ticks still update open rows via the inner useInstrumentTick
 * subscription, independent of this memo.
 */
function rowPropsEqual(a: TodayTradeRowProps, b: TodayTradeRowProps): boolean {
  return (
    a.isFirst === b.isFirst &&
    a.showNet === b.showNet &&
    a.exitLoading === b.exitLoading &&
    a.canManageTrades === b.canManageTrades &&
    a.channel === b.channel &&
    a.globalTrailingEnabled === b.globalTrailingEnabled &&
    a.slPercent === b.slPercent &&
    a.tslGatePercent === b.tslGatePercent &&
    a.tslHoldSeconds === b.tslHoldSeconds &&
    a.tradeNo === b.tradeNo &&
    a.todayRef === b.todayRef &&
    // By-value compare neutralises the per-poll reference + undefined/absent churn.
    JSON.stringify(a.trade) === JSON.stringify(b.trade)
  );
}

export const TodayTradeRow = memo(function TodayTradeRow(props: TodayTradeRowProps) {
  // TEMP DIAGNOSTIC ([XSYNC] exit-sync): observe the server's view reaching the
  // client — when this trade closes, and when a trailed stop arrives. Lives on
  // the dispatcher (persists across the OPEN→closed wrapper swap).
  const t = props.trade;
  const prevRef = useRef<{ status: string; stop: number | null }>({ status: t.status, stop: t.stopLossPrice ?? null });
  useEffect(() => {
    const prev = prevRef.current;
    if (prev.status === 'OPEN' && t.status !== 'OPEN') {
      // Real exit — the server actually closed the trade and pushed it over the
      // WS. Toast from THIS (the confirmed exit + reason + fill), not from
      // TradeBar's predicted LTP crossing, which can be early or never happen.
      const label = `${t.instrument}${t.strike ? ' ' + t.strike : ''}`;
      const at = t.exitPrice != null ? ` @ ${t.exitPrice.toFixed(2)}` : '';
      if (t.exitReason === 'TP_HIT') {
        toast.success(`Target hit · ${label}${at}`);
      } else if (t.exitReason === 'SL_HIT') {
        // SL_HIT also covers a trailing stop that locked in profit.
        if (t.pnl >= 0) {
          toast.success(`Trailing stop hit · ${label}${at} · +₹${Math.round(t.pnl).toLocaleString('en-IN')}`);
        } else {
          toast.error(`Stop-loss hit · ${label}${at}`);
        }
      } else {
        toast.info(`Exited · ${label}${at}`);
      }
      if (import.meta.env.DEV) {
        console.log(`[XSYNC-CLI] CLOSED trade=${t.id} ${t.instrument} status=${t.status} reason=${t.exitReason ?? '?'} exit=${t.exitPrice ?? '?'}`);
      }
    }
    if (import.meta.env.DEV) {
      const stop = t.stopLossPrice ?? null;
      if (stop !== prev.stop) {
        console.log(`[XSYNC-CLI] STOP-MOVED trade=${t.id} ${t.instrument} ${prev.stop}→${stop}`);
      }
    }
    prevRef.current = { status: t.status, stop: t.stopLossPrice ?? null };
  }, [t.status, t.stopLossPrice, t.id, t.instrument, t.exitPrice, t.exitReason, t.pnl]);

  if (props.trade.status === 'OPEN') {
    return <LiveTodayTradeRow {...props} />;
  }
  return <_TodayTradeRow {...props} />;
}, rowPropsEqual);
