export interface StatusBadgeProps {
  status: string;
  /** When status === "CLOSED", the exit reason picks the badge style:
   *  TP_HIT → green ✓ TP, SL_HIT → red ✗ SL, anything else → generic
   *  CLOSED pill. Pass through from `trade.exitReason` (B11-followup
   *  unified vocab: TP_HIT / SL_HIT / MOMENTUM_EXIT / ...). */
  exitReason?: string;
  /** Broker reject reason (Dhan ReasonDescription) — shown as the hover
   *  tooltip on the REJECTED pill so you can see WHY it was rejected. */
  reason?: string;
}

export function StatusBadge({ status, exitReason, reason }: StatusBadgeProps) {
  switch (status) {
    case 'OPEN':
      return (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-bold bg-warning-amber/20 text-warning-amber">
          <span className="h-1.5 w-1.5 rounded-full bg-warning-amber animate-pulse" />
          OPEN
        </span>
      );
    case 'PENDING':
      return (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-bold bg-muted text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-pulse" />
          PENDING
        </span>
      );
    case 'CLOSED':
      return renderClosedPill(exitReason);
    case 'CANCELLED':
      return (
        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded font-bold bg-muted text-muted-foreground">
          CANCELLED
        </span>
      );
    case 'REJECTED':
      return (
        <span
          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded font-bold bg-destructive/20 text-destructive cursor-help"
          title={reason ? `Rejected: ${reason}` : 'Rejected by broker'}
        >
          REJECTED
        </span>
      );
    case 'BROKER_DESYNC':
      return (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-bold bg-destructive/30 text-destructive border border-destructive">
          <span aria-hidden="true">⚠</span>
          DESYNC
        </span>
      );
    default:
      return (
        <span className="text-[0.5rem] text-muted-foreground uppercase">
          {status.replace('CLOSED_', '')}
        </span>
      );
  }
}

function renderClosedPill(exitReason?: string) {
  if (exitReason === 'TP_HIT') {
    return (
      <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded font-bold bg-bullish/20 text-bullish">
        ✓ TP
      </span>
    );
  }
  if (exitReason === 'SL_HIT') {
    return (
      <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded font-bold bg-destructive/20 text-destructive">
        ✗ SL
      </span>
    );
  }
  // Trailing stop — the trade ran, then gave part of it back. Amber rather than
  // red: it's a managed exit, not the original risk being hit.
  if (exitReason === 'TSL_HIT') {
    return (
      <span
        className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded font-bold bg-warning-amber/20 text-warning-amber"
        title="Trailing stop hit — the stop had moved off its original level"
      >
        ↘ TSL
      </span>
    );
  }
  // Held too long — RCA's max-age rule closed it.
  if (exitReason === 'AGE_EXIT') {
    return (
      <span
        className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded font-bold bg-neutral-steel/20 text-neutral-steel"
        title="Aged out — closed by the max-holding-time rule"
      >
        ⏱ AGE
      </span>
    );
  }
  // Squared off at the close — not a strategy decision.
  if (exitReason === 'EOD' || exitReason === 'EOD_SQUAREOFF') {
    return (
      <span
        className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded font-bold bg-info-cyan/20 text-info-cyan"
        title="End-of-day square-off — the market closed, not a strategy exit"
      >
        ⏹ EOD
      </span>
    );
  }
  // Every other ExitReason (MOMENTUM_EXIT, VOLATILITY_EXIT, STALE_PRICE_EXIT,
  // DISCIPLINE_EXIT, AI_EXIT, MANUAL, EXPIRY) and unknown / missing reason all
  // render as a neutral CLOSED pill.
  return (
    <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded font-bold bg-muted text-muted-foreground">
      CLOSED
    </span>
  );
}
