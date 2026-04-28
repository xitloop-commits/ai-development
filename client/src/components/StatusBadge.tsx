export interface StatusBadgeProps {
  status: string;
}

export function StatusBadge({ status }: StatusBadgeProps) {
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
    case 'CLOSED_TP':
      return (
        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded font-bold bg-bullish/20 text-bullish">
          ✓ TP
        </span>
      );
    case 'CLOSED_SL':
      return (
        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded font-bold bg-destructive/20 text-destructive">
          ✗ SL
        </span>
      );
    case 'CLOSED_PARTIAL':
      return (
        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded font-bold bg-bullish/20 text-bullish">
          ✓ Partial
        </span>
      );
    case 'CANCELLED':
      return (
        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded font-bold bg-muted text-muted-foreground">
          CANCELLED
        </span>
      );
    case 'REJECTED':
      return (
        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded font-bold bg-destructive/20 text-destructive">
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
