/**
 * IndexOptionRow — a watchlist index row that can place a manual option trade.
 *
 * Shows the underlying LTP plus the current expiry and ATM strike, with a CE/PE
 * toggle. Ctrl+click "Long" BUYS the selected side at the ATM strike.
 *
 * Ctrl is deliberate: the row sits in a list you scroll and click past, and on a
 * live channel a stray click is a real order. The modifier makes placement an
 * intentional act; a plain click just flips nothing and shows the hint.
 *
 * Everything needed is already on the instrument's live state — `atm_strike`,
 * `atm_ce_security_id`, `atm_pe_security_id`, `hours_to_expiry` — pushed over
 * the TFA websocket, so there's no option-chain fetch on this path.
 *
 * BUY only. Selling is not offered here: `exitStrategies.ts` assumes a bought
 * option (profit = premium UP), so Runway/Anchor would compute a short's stop on
 * the profitable side and bank its target as a loss. Sprint handles both
 * directions, but shipping a short that silently breaks two of three strategies
 * isn't worth the button.
 */
import { useState } from 'react';
import { useInstrumentLiveState } from '@/hooks/useInstrumentLiveState';
import { useCapital } from '@/contexts/CapitalContext';
import { useInstrumentTick } from '@/hooks/useTickStream';
import { formatCalendarDay } from '@/lib/tradeFormatters';
import { liveOptionConfirm } from '@/lib/optionOrderConfirm';
import { ConfirmDialog } from './ConfirmDialog';
import { trpc } from '@/lib/trpc';

type Side = 'CE' | 'PE';

interface AtmShape {
  spot_price?: number | null;
  atm_strike?: number | null;
  atm_ce_security_id?: string | null;
  atm_pe_security_id?: string | null;
  hours_to_expiry?: number | null;
}

export function IndexOptionRow({ name, label, color }: { name: string; label: string; color: string }) {
  // Canonical live-state key: NIFTY_50 → nifty50, BANKNIFTY → banknifty.
  const key = name.toLowerCase().replace(/_/g, '');
  const state = useInstrumentLiveState<{ live?: AtmShape; signal?: AtmShape }>(key);
  const [side, setSide] = useState<Side>('CE');
  const [confirm, setConfirm] = useState<{ title: string; message: string; onConfirm: () => void } | null>(null);

  const { placeTrade, channel } = useCapital();

  // Live state first, last signal as fallback — same precedence the chart page uses.
  const live = state?.live ?? null;
  const sig = state?.signal ?? null;
  const spot = live?.spot_price ?? 0;
  const atmStrike = live?.atm_strike ?? sig?.atm_strike ?? null;
  const ceId = live?.atm_ce_security_id ?? sig?.atm_ce_security_id ?? null;
  const peId = live?.atm_pe_security_id ?? sig?.atm_pe_security_id ?? null;
  const hoursToExp = live?.hours_to_expiry ?? sig?.hours_to_expiry ?? null;
  const expiryLabel = hoursToExp != null && hoursToExp > 0
    ? formatCalendarDay(Date.now() + hoursToExp * 3600000)
    : null;

  const contractSecurityId = side === 'CE' ? ceId : peId;

  // Live premium for the selected contract — this is the entry price we send,
  // and what the confirm dialog quotes.
  const optionExchange = key === 'crudeoil' || key === 'naturalgas' ? 'MCX_COMM' : 'NSE_FNO';
  const tick = useInstrumentTick(optionExchange, contractSecurityId ?? undefined);
  const premium = tick?.ltp ?? 0;

  // Manual sizing comes from the AI menu's `manual` block (T85), so this row
  // obeys the same per-instrument size as every other manual entry point.
  const aiConfig = trpc.trading.aiConfig.useQuery(undefined);
  const sizing = aiConfig.data?.manual?.sizing?.perInstrument?.[key] ?? null;

  const ready = !!contractSecurityId && atmStrike != null && premium > 0;

  function place() {
    if (!ready) return;
    const type = side === 'CE' ? 'CALL_BUY' : 'PUT_BUY';
    // "lots" → qty in lots (server multiplies by lotSize); "percent" → let the
    // server size from capital. Default to 1 lot when nothing is configured.
    const useLots = !sizing || sizing.mode === 'lots';
    const trade = {
      instrument: name,
      type: type as 'CALL_BUY' | 'PUT_BUY',
      strike: atmStrike,
      expiry: '', // server resolves the current expiry
      entryPrice: premium,
      capitalPercent: useLots ? 0 : sizing!.value,
      qty: useLots ? Math.max(1, Math.round(sizing?.value ?? 1)) : 0,
      contractSecurityId,
    };

    const needsConfirm = liveOptionConfirm(channel, trade);
    if (needsConfirm) {
      setConfirm({ ...needsConfirm, onConfirm: () => { placeTrade(trade); setConfirm(null); } });
      return;
    }
    placeTrade(trade);
  }

  const liveWord = channel === 'paper' ? 'paper' : 'LIVE';

  return (
    <>
      <div className="border-b border-border/50 hover:bg-muted/30">
        {/* Line 1 — underlying */}
        <div className="flex items-center gap-2 px-2.5 pt-1.5">
          <span className="h-2 w-2 rounded-full shrink-0" style={{ background: color }} />
          <span className="text-xs font-bold flex-1 truncate" style={{ color }}>{label}</span>
          <span className="text-xs font-bold tabular-nums text-foreground min-w-[64px] text-right">
            {spot > 0
              ? spot.toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
              : <span className="text-[0.625rem] italic text-muted-foreground">…</span>}
          </span>
        </div>

        {/* Line 2 — expiry · strike · CE/PE · Long */}
        <div className="flex items-center gap-1.5 px-2.5 pb-1.5 pt-1">
          <span className="text-[0.5625rem] text-muted-foreground tabular-nums">
            {expiryLabel ?? '—'}
          </span>
          <span className="text-[0.625rem] font-bold tabular-nums text-foreground">
            {atmStrike ?? '—'}
          </span>

          {/* CE / PE toggle */}
          <div className="flex rounded border border-border overflow-hidden ml-auto">
            {(['CE', 'PE'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSide(s)}
                className={`px-1.5 py-0.5 text-[0.5625rem] font-bold transition-colors ${
                  side === s
                    ? s === 'CE'
                      ? 'bg-bullish/20 text-bullish'
                      : 'bg-bearish/20 text-bearish'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {s}
              </button>
            ))}
          </div>

          {/* Long — ctrl+click places */}
          <button
            type="button"
            disabled={!ready}
            onClick={(e) => { if (e.ctrlKey || e.metaKey) place(); }}
            title={
              ready
                ? `Ctrl+click to BUY ${label} ${atmStrike} ${side} at ~₹${premium.toFixed(2)} (${liveWord})`
                : 'Waiting for the ATM contract and its premium'
            }
            className="px-1.5 py-0.5 rounded text-[0.5625rem] font-bold border transition-colors disabled:opacity-40 bg-bullish/15 text-bullish border-bullish/40 hover:bg-bullish/25"
          >
            Long
          </button>
        </div>
      </div>

      {confirm && (
        <ConfirmDialog
          open
          title={confirm.title}
          message={confirm.message}
          onConfirm={confirm.onConfirm}
          onCancel={() => setConfirm(null)}
        />
      )}
    </>
  );
}
