/**
 * TokenExpiredModal — auto-shows when broker token is expired.
 * Allows user to paste a new access token without navigating to Settings.
 * Client ID is shown read-only (it never changes once set). If missing,
 * the user must enter it before updating the token.
 */
import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { trpc } from "../lib/trpc";
import { toast } from "sonner";

export function TokenExpiredModal() {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [clientId, setClientId] = useState("");
  const [dismissed, setDismissed] = useState(false);

  const statusQuery = trpc.broker.status.useQuery(undefined, {
    refetchInterval: 10000,
    retry: 1,
  });

  const configQuery = trpc.broker.config.get.useQuery(undefined, {
    enabled: open,
  });

  const savedClientId = configQuery.data?.credentials?.clientId ?? "";

  // Pre-fill clientId from saved config
  useEffect(() => {
    if (savedClientId) {
      setClientId(savedClientId);
    }
  }, [savedClientId]);

  const tokenMutation = trpc.broker.token.update.useMutation({
    onSuccess: () => {
      toast.success("Token updated successfully");
      setToken("");
      setOpen(false);
      setDismissed(false);
      statusQuery.refetch();
    },
    onError: (err) => {
      toast.error(`Token update failed: ${err.message}`);
    },
  });

  // Auto-show when token is expired and not dismissed
  useEffect(() => {
    const status = statusQuery.data as any;
    if (!status) return;

    const isExpired =
      status.tokenStatus === "expired" ||
      status.apiStatus === "error";

    if (isExpired && !dismissed) {
      setOpen(true);
    } else if (!isExpired) {
      // Token is valid again, reset dismissed state
      setDismissed(false);
      setOpen(false);
    }
  }, [statusQuery.data, dismissed]);

  const handleSubmit = () => {
    if (!token.trim()) {
      toast.error("Access token is required");
      return;
    }
    if (!clientId.trim()) {
      toast.error("Client ID is required");
      return;
    }
    tokenMutation.mutate({
      token: token.trim(),
      clientId: clientId.trim(),
    });
  };

  const handleDismiss = () => {
    setOpen(false);
    setDismissed(true);
  };

  const hasClientId = !!savedClientId;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleDismiss(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-loss-red">Access Token Expired</DialogTitle>
          <DialogDescription>
            Your Dhan access token has expired. Paste a new token from your{" "}
            <a
              href="https://login.dhan.co"
              target="_blank"
              rel="noopener noreferrer"
              className="underline text-info-cyan"
            >
              Dhan dashboard
            </a>{" "}
            to continue trading.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {/* Client ID — read-only if already saved, editable if missing */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Client ID {!hasClientId && <span className="text-loss-red">*</span>}
            </label>
            {hasClientId ? (
              <div className="px-3 py-2 rounded-md border bg-muted/30 font-mono text-xs text-muted-foreground">
                {savedClientId}
              </div>
            ) : (
              <Input
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder="Your Dhan client ID (e.g. 1100012345)"
                className="font-mono text-xs"
              />
            )}
          </div>
          {/* Access Token */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              New Access Token <span className="text-loss-red">*</span>
            </label>
            <Input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Paste new access token..."
              className="font-mono text-sm"
            />
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={handleDismiss}>
            Dismiss
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!token.trim() || !clientId.trim() || tokenMutation.isPending}
          >
            {tokenMutation.isPending ? "Updating..." : "Update Token"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
