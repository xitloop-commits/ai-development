/**
 * IndexOptionRow â€” a watchlist index row that can place a manual option trade.
 *
 * Shows the underlying LTP plus the current expiry and ATM strike, with a CE/PE
 * toggle. Ctrl+click "Long" BUYS the selected side at the ATM strike.
 *
 * Ctrl is deliberate: the row sits in a list you scroll and click past, and on a
 * live channel a stray click is a real order. The modifier makes placement an
 * intentional act; a plain click just flips nothing and shows the hint.
 *
 * Everything needed is already on the instrument's live state â€” `atm_strike`,
 * `atm_ce_security_id`, `atm_pe_security_id`, `hours_to_expiry` â€” pushed over
 * the TFA websocket, so there's no option-chain fetch on this path.
 *
 * Long BUYS the selected side, Short SELLS it.
 *
 * The exit strategy comes from the AI menu's `manual` block and is sent
 * EXPLICITLY. It has to be: the executor defaults to "sprint" when no strategy
 * arrives, so a book configured for Runway silently ran every manual trade on
 * Sprint. Manual takes ONE strategy per trade (not a race like paper), so the
 * first enabled pill wins.
 *
 * Shorts are safe on all three strategies since T93 made the staged engine
 * direction-aware. Note the THRESHOLDS (25% cooling stop, breakeven at half
 * target) were tuned on bought options, where the most you can lose is the
 * premium paid â€” a short's loss is unbounded, so those numbers are mechanically
 * correct but not yet validated for shorts.
 *
 * Also note short options block MARGIN, but `calculateAvailableCapital` counts
 * `entryPrice Ã— qty` â€” the premium RECEIVED â€” so a short reads as far cheaper
 * than it is in every capital and exposure figure. Order gating is Discipline's
 * to own; this row does not attempt to model it.
 */
import { useEffect, useState } from 'react';
import { useInstrumentLiveState } from '@/hooks/useInstrumentLiveState';
import { useCapital } from '@/contexts/CapitalContext';
import { useInstrumentTick } from '@/hooks/useTickStream';
import { formatCalendarDay } from '@/lib/tradeFormatters';
import { liveOptionConfirm } from '@/lib/optionOrderConfirm';
import { ConfirmDialog } from './ConfirmDialog';
import { trpc } from '@/lib/trpc';
import { manualTradeSize, manualStrategyLabel } from '@/lib/manualTradeConfig';

type Side = 'CE' | 'PE';

/** Whole calendar days from today to `ms` (0 = same day, negative = past). */
function calendarDaysUntil(ms: number): number {
  const now = new Date();
  const exp = new Date(ms);
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const day = Date.UTC(exp.getFullYear(), exp.getMonth(), exp.getDate());
  return Math.round((day - today) / 86_400_000);
}

interface AtmShape {
  spot_price?: number | null;
  atm_strike?: number | null;
  atm_ce_security_id?: string | null;
  atm_pe_security_id?: string | null;
  hours_to_expiry?: number | null;
}

export function IndexOptionRow({ name, label, color }: { name: string; label: string; color: string }) {
  // Canonical live-state key: NIFTY_50 â†’ nifty50, BANKNIFTY â†’ banknifty.
  const key = name.toLowerCase().replace(/_/g, '');
  const state = useInstrumentLiveState<{ live?: AtmShape; signal?: AtmShape }>(key);
  const [side, setSide] = useState<Side>('CE');
  const [confirm, setConfirm] = useState<{ title: string; message: string; onConfirm: () => void } | null>(null);

  const { placeTrade, channel } = useCapital();

  // Live state first, last signal as fallback â€” same precedence the chart page uses.
  const live = state?.live ?? null;
  const sig = state?.signal ?? null;
  const spot = live?.spot_price ?? 0;
  const atmStrike = live?.atm_strike ?? sig?.atm_strike ?? null;
  const ceId = live?.atm_ce_security_id ?? sig?.atm_ce_security_id ?? null;
  const peId = live?.atm_pe_security_id ?? sig?.atm_pe_security_id ?? null;
  const hoursToExp = live?.hours_to_expiry ?? sig?.hours_to_expiry ?? null;
  const expiryMs = hoursToExp != null && hoursToExp > 0 ? Date.now() + hoursToExp * 3600000 : null;
  const expiryLabel = expiryMs != null ? formatCalendarDay(expiryMs) : null;
  // Whole CALENDAR days to expiry (0 = expires today), so a contract that is
  // 30h out reads "2d" not "1d". Calendar diff, not hours/24, so the count flips
  // at midnight like the date does.
  const daysToExp = expiryMs != null ? calendarDaysUntil(expiryMs) : null;

  // T161 â€” session strike lock + per-instrument master switch.
  const lockState = trpc.trading.strikeLockState.useQuery(undefined, { refetchInterval: 30_000, refetchOnWindowFocus: false });
  const relockMut = trpc.trading.strikeRelock.useMutation({ onSuccess: () => lockState.refetch() });
  const enableMut = trpc.trading.setInstrumentEnabled.useMutation({ onSuccess: () => lockState.refetch() });
  const lockCfg = lockState.data?.config;
  const lockEnabled = !!(channel === 'paper' ? lockCfg?.paperEnabled : lockCfg?.liveEnabled);
  const lock = lockEnabled ? lockState.data?.locks?.[key] ?? null : null;
  const instOn = lockState.data?.instrumentEnabled?.[key] !== false;
  // Ensure today's lock exists once the row is up (no-op when already locked).
  useEffect(() => {
    if (lockEnabled && !lock && lockState.isSuccess && !relockMut.isPending) {
      relockMut.mutate({ instrument: key });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once per lock gap
  }, [lockEnabled, lock == null, lockState.isSuccess]);

  // Locked â†’ the row shows and BUYS the session contract; unlocked â†’ live ATM.
  const lockedLeg = lock ? (side === 'CE' ? lock.ce : lock.pe) : null;
  const shownStrike = lockedLeg ? lockedLeg.strike : atmStrike;
  const contractSecurityId = lockedLeg ? lockedLeg.securityId : (side === 'CE' ? ceId : peId);

  // Live premium for the selected contract â€” this is the entry price we send,
  // and what the confirm dialog quotes.
  const optionExchange = key === 'crudeoil' || key === 'naturalgas' ? 'MCX_COMM' : 'NSE_FNO';
  const tick = useInstrumentTick(optionExchange, contractSecurityId ?? undefined);
  const premium = tick?.ltp ?? 0;

  // Sizing and strategy both come from the AI menu's `manual` block, via the
  // shared helper so this row and the signals feed cannot drift apart.
  const aiConfig = trpc.trading.aiConfig.useQuery(undefined);
  // The manual block of the book we are viewing (T127 â€” manual is per-book now).
  const book = channel === "paper" ? "paper" : "live";
  const manual = aiConfig.data?.[book]?.manual;

  // Display only. The SERVER resolves the actual strategy from the same config
  // (`resolveExitStrategy`) â€” sending it from here would let a caller bypass
  // that single authority, including its equity-pinned-to-sprint guard.
  const exitStrategy = manualStrategyLabel(manual);

  const ready = !!contractSecurityId && shownStrike != null && premium > 0;

  function place(direction: 'LONG' | 'SHORT') {
    if (!ready) return;
    const type = side === 'CE'
      ? (direction === 'LONG' ? 'CALL_BUY' : 'CALL_SELL')
      : (direction === 'LONG' ? 'PUT_BUY' : 'PUT_SELL');
    const trade = {
      // Canonical instrument spelling: "NIFTY50" / "BANKNIFTY", matching what
      // SEA signals send. The row's own prop is "NIFTY_50" (the client feed key)
      // â€” sending that would give trade records two spellings of one instrument
      // and break per-instrument lookups keyed on the canonical form.
      instrument: key.toUpperCase(),
      type: type as 'CALL_BUY' | 'PUT_BUY' | 'CALL_SELL' | 'PUT_SELL',
      strike: shownStrike,
      expiry: lock?.expiry ?? '', // locked expiry; else server resolves
      entryPrice: premium,
      ...manualTradeSize(manual, key),
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
        {/* Line 1 â€” underlying (name Â· days-to-expiry badge Â· spot) */}
        <div className="flex items-center gap-2 px-2.5 pt-1.5">
          <span className="h-2 w-2 rounded-full shrink-0" style={{ background: color }} />
          <div className="flex items-center gap-1.5 flex-1 min-w-0">
            <span className="text-xs font-bold truncate" style={{ color }}>{label}</span>
            {daysToExp != null && (
              <span
                className={`shrink-0 rounded px-1 py-px text-[0.5rem] font-bold tabular-nums ${
                  daysToExp <= 1 ? 'bg-warning-amber/20 text-warning-amber' : 'bg-muted/60 text-muted-foreground'
                }`}
                title={daysToExp === 0 ? 'Expires today' : `${daysToExp} day${daysToExp === 1 ? '' : 's'} to expiry`}
              >
                {daysToExp === 0 ? 'expiry' : `${daysToExp}d`}
              </span>
            )}
          </div>
          <span className="text-xs font-bold tabular-nums text-foreground min-w-[64px] text-right">
            {spot > 0
              ? spot.toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
              : <span className="text-[0.625rem] italic text-muted-foreground">â€¦</span>}
          </span>
        </div>

        {/* Line 2 â€” expiry Â· strike Â· CE/PE Â· Long */}
        <div className="flex items-center gap-1.5 px-2.5 pb-1.5 pt-1">
          <span className="text-[0.5625rem] text-muted-foreground tabular-nums">
            {expiryLabel ?? 'â€”'}
          </span>
          <span
            className="text-[0.625rem] font-bold tabular-nums text-foreground"
            title={lockedLeg ? `Session-locked ${side} strike (ATM at lock: ${lock?.atmAtLock})` : 'Live ATM strike'}
          >
            {shownStrike ?? 'â€”'}{lockedLeg ? ' ðŸ”’' : ''}
          </span>
          {lockedLeg && (
            <button
              type="button"
              onClick={() => relockMut.mutate({ instrument: key, force: true })}
              disabled={relockMut.isPending}
              className="text-[0.5rem] px-1 py-px rounded border border-border text-muted-foreground hover:text-foreground"
              title="Re-lock from the CURRENT ATM (âˆ“ configured offset)"
            >
              {relockMut.isPending ? 'â€¦' : 're-lock'}
            </button>
          )}
          {/* T161 â€” per-instrument master switch: signals + AI trades on/off */}
          <button
            type="button"
            onClick={() => enableMut.mutate({ instrument: key, enabled: !instOn })}
            disabled={enableMut.isPending}
            className={`text-[0.625rem] px-1 py-px rounded border transition-colors ${
              instOn ? 'border-bullish/50 text-bullish' : 'border-border text-muted-foreground'
            }`}
            title={instOn ? 'Signals + AI trades ON â€” click to stop this instrument' : 'STOPPED â€” signals dropped, AI trades blocked. Click to resume'}
          >
            {instOn ? 'âœ“' : 'âœ•'}
          </button>

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

          {/* Long / Short â€” ctrl+click places */}
          {([
            { dir: 'LONG' as const, verb: 'BUY', cls: 'bg-bullish/15 text-bullish border-bullish/40 hover:bg-bullish/25' },
            { dir: 'SHORT' as const, verb: 'SELL', cls: 'bg-bearish/15 text-bearish border-bearish/40 hover:bg-bearish/25' },
          ]).map(({ dir, verb, cls }) => (
            <button
              key={dir}
              type="button"
              disabled={!ready}
              onClick={(e) => { if (e.ctrlKey || e.metaKey) place(dir); }}
              title={
                ready
                  ? `Ctrl+click to ${verb} ${label} ${atmStrike} ${side} at ~â‚¹${premium.toFixed(2)} (${liveWord}) Â· ${exitStrategy} exit`
                  : 'Waiting for the ATM contract and its premium'
              }
              className={`px-1.5 py-0.5 rounded text-[0.5625rem] font-bold border transition-colors disabled:opacity-40 ${cls}`}
            >
              {dir === 'LONG' ? 'Long' : 'Short'}
            </button>
          ))}
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
