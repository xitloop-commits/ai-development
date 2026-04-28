/**
 * Operator-driven reconciliation for BROKER_DESYNC trades (B4 follow-up).
 *
 * When tradeExecutor.exitTrade or modifyOrder fails at the broker, the
 * trade is flagged with `desync` metadata; the local state stays as-is
 * and Discipline blocks new entries until the operator reconciles.
 *
 * The operator opens Dhan in another tab, verifies what's actually true
 * at the broker, then picks one of:
 *   - Confirm closed:    broker confirmed position gone → close locally
 *   - Confirm still open: broker confirmed position alive → restore status,
 *                         optionally overwrite SL/TP from broker's values
 *   - Cancel modify:      MODIFY-desync only — keep local SL/TP as-is,
 *                         just clear the desync flag
 *
 * Server contract: see server/executor/router.ts → executor.reconcileDesync.
 */
import { useState } from 'react';
import { trpc } from '@/lib/trpc';
import { toast } from 'sonner';
import type { Channel, TradeRecord } from '@/lib/tradeTypes';

export interface ReconcileDesyncDialogProps {
  open: boolean;
  trade: TradeRecord;
  channel: Channel;
  onClose: () => void;
}

type Action = 'confirm-closed' | 'confirm-still-open' | 'cancel-modify';

const CLOSE_STATUSES = [
  'CLOSED_TP',
  'CLOSED_SL',
  'CLOSED_MANUAL',
  'CLOSED_PARTIAL',
  'CLOSED_EOD',
] as const;

export function ReconcileDesyncDialog({ open, trade, channel, onClose }: ReconcileDesyncDialogProps) {
  const [action, setAction] = useState<Action>('confirm-closed');
  // confirm-closed inputs
  const [exitPriceStr, setExitPriceStr] = useState(String(trade.ltp ?? trade.entryPrice));
  const [closeStatus, setCloseStatus] = useState<typeof CLOSE_STATUSES[number]>('CLOSED_MANUAL');
  // confirm-still-open inputs (optional — leave blank to keep local values)
  const [slStr, setSlStr] = useState('');
  const [tpStr, setTpStr] = useState('');

  const utils = trpc.useUtils();
  const reconcileMutation = trpc.executor.reconcileDesync.useMutation({
    onSuccess: () => {
      void utils.portfolio.allDays.invalidate();
      void utils.portfolio.currentDay.invalidate();
      toast.success('Reconciled');
      onClose();
    },
    onError: (err) => {
      toast.error(`Reconcile failed: ${err.message}`);
    },
  });

  if (!open) return null;
  const desync = trade.desync;
  if (!desync) {
    // Defensive — UI should only ever open this dialog when desync is set.
    return null;
  }

  // For MODIFY-desync, "Confirm closed" doesn't make sense (the position
  // is alive at broker; only the bracket diverges). Surface it but
  // discourage it.
  const canCancelModify = desync.kind === 'MODIFY';

  function handleSubmit() {
    if (action === 'confirm-closed') {
      const exitPrice = Number(exitPriceStr);
      if (!Number.isFinite(exitPrice) || exitPrice <= 0) {
        toast.error('Exit price must be a positive number');
        return;
      }
      reconcileMutation.mutate({
        channel,
        tradeId: trade.id,
        action: 'confirm-closed',
        exitPrice,
        closeStatus,
      });
      return;
    }
    if (action === 'confirm-still-open') {
      const sl = slStr.trim() ? Number(slStr) : undefined;
      const tp = tpStr.trim() ? Number(tpStr) : undefined;
      if (sl !== undefined && (!Number.isFinite(sl) || sl <= 0)) {
        toast.error('SL must be a positive number (or leave blank)');
        return;
      }
      if (tp !== undefined && (!Number.isFinite(tp) || tp <= 0)) {
        toast.error('TP must be a positive number (or leave blank)');
        return;
      }
      reconcileMutation.mutate({
        channel,
        tradeId: trade.id,
        action: 'confirm-still-open',
        stopLossPrice: sl ?? null,
        targetPrice: tp ?? null,
      });
      return;
    }
    if (action === 'cancel-modify') {
      reconcileMutation.mutate({
        channel,
        tradeId: trade.id,
        action: 'cancel-modify',
      });
      return;
    }
  }

  const submitting = reconcileMutation.isPending;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-card border border-destructive rounded-lg p-5 max-w-md w-full mx-4 shadow-xl">
        <h3 className="text-sm font-bold text-destructive mb-1 flex items-center gap-2">
          <span aria-hidden="true">⚠</span>
          Reconcile BROKER_DESYNC
        </h3>
        <p className="text-[0.6875rem] text-muted-foreground mb-3">
          Trade {trade.id} on {channel} — broker {desync.kind === 'EXIT' ? 'exit order' : 'SL/TP modify'} failed.
          Open Dhan, verify the actual state, then choose the matching action.
        </p>

        <div className="bg-muted/40 rounded p-2 mb-3 text-[0.625rem] font-mono text-muted-foreground">
          <div><span className="text-foreground">Reason:</span> {desync.reason}</div>
          <div><span className="text-foreground">When:</span> {new Date(desync.timestamp).toLocaleString('en-IN')}</div>
          {desync.attempted && (
            <div>
              <span className="text-foreground">Attempted SL/TP:</span>{' '}
              {desync.attempted.stopLossPrice ?? '—'} / {desync.attempted.targetPrice ?? '—'}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2 mb-3 text-[0.6875rem]">
          <label className="flex items-start gap-2">
            <input
              type="radio"
              name="reconcile-action"
              checked={action === 'confirm-closed'}
              onChange={() => setAction('confirm-closed')}
            />
            <span>
              <span className="font-bold">Confirm closed</span> — Dhan shows the position is gone. Close locally.
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="radio"
              name="reconcile-action"
              checked={action === 'confirm-still-open'}
              onChange={() => setAction('confirm-still-open')}
            />
            <span>
              <span className="font-bold">Confirm still open</span> — Dhan shows the position is alive. Restore status; optionally update SL/TP.
            </span>
          </label>
          {canCancelModify && (
            <label className="flex items-start gap-2">
              <input
                type="radio"
                name="reconcile-action"
                checked={action === 'cancel-modify'}
                onChange={() => setAction('cancel-modify')}
              />
              <span>
                <span className="font-bold">Cancel modify</span> — keep current local SL/TP. Just clear the desync flag.
              </span>
            </label>
          )}
        </div>

        {action === 'confirm-closed' && (
          <div className="space-y-2 mb-3">
            <div>
              <label className="text-[0.625rem] text-muted-foreground block mb-0.5">Exit price (from Dhan)</label>
              <input
                type="number"
                step="0.01"
                value={exitPriceStr}
                onChange={(e) => setExitPriceStr(e.target.value)}
                className="w-full px-2 py-1 rounded bg-background border border-border text-[0.6875rem]"
              />
            </div>
            <div>
              <label className="text-[0.625rem] text-muted-foreground block mb-0.5">Close status</label>
              <select
                value={closeStatus}
                onChange={(e) => setCloseStatus(e.target.value as typeof CLOSE_STATUSES[number])}
                className="w-full px-2 py-1 rounded bg-background border border-border text-[0.6875rem]"
              >
                {CLOSE_STATUSES.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
          </div>
        )}

        {action === 'confirm-still-open' && (
          <div className="space-y-2 mb-3">
            <div>
              <label className="text-[0.625rem] text-muted-foreground block mb-0.5">
                Stop-loss at broker (optional — blank to keep local)
              </label>
              <input
                type="number"
                step="0.01"
                value={slStr}
                onChange={(e) => setSlStr(e.target.value)}
                placeholder={trade.stopLossPrice != null ? String(trade.stopLossPrice) : '—'}
                className="w-full px-2 py-1 rounded bg-background border border-border text-[0.6875rem]"
              />
            </div>
            <div>
              <label className="text-[0.625rem] text-muted-foreground block mb-0.5">
                Take-profit at broker (optional — blank to keep local)
              </label>
              <input
                type="number"
                step="0.01"
                value={tpStr}
                onChange={(e) => setTpStr(e.target.value)}
                placeholder={trade.targetPrice != null ? String(trade.targetPrice) : '—'}
                className="w-full px-2 py-1 rounded bg-background border border-border text-[0.6875rem]"
              />
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-3 py-1 rounded font-medium bg-secondary text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="px-3 py-1 rounded font-bold bg-destructive/30 text-destructive border border-destructive hover:bg-destructive/40 transition-colors disabled:opacity-50"
          >
            {submitting ? 'Reconciling…' : 'Reconcile'}
          </button>
        </div>
      </div>
    </div>
  );
}
