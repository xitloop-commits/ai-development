export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-card border border-border rounded-lg p-4 max-w-sm w-full mx-4 shadow-xl">
        <h3 className="text-sm font-bold text-foreground mb-2">{title}</h3>
        <p className="text-[0.6875rem] text-muted-foreground mb-4">{message}</p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1 rounded font-medium bg-secondary text-muted-foreground hover:text-foreground transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-3 py-1 rounded font-bold bg-destructive/20 text-destructive hover:bg-destructive/30 transition-colors"
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
