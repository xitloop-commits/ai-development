/**
 * CredentialGate — hard startup gate.
 *
 * On every app launch checks:
 *   1. Client ID is not empty
 *   2. Access token is < 24 hours old
 *
 * If either check fails, blocks the entire app with a non-dismissable
 * dialog until the user provides valid credentials.
 *
 * Client ID is permanent (entered once, never changes).
 * Access token must be refreshed daily.
 *
 * Renders children only when both checks pass.
 */
import { useState, useEffect, type ReactNode } from "react";
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
import { ClipboardPaste } from "lucide-react";

const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

interface CredentialGateProps {
  children: ReactNode;
}

export function CredentialGate({ children }: CredentialGateProps) {
  const [token, setToken] = useState("");
  const [clientId, setClientId] = useState("");
  const [dismissed, setDismissed] = useState(false);

  const statusQuery = trpc.broker.status.useQuery(undefined, {
    refetchInterval: 30_000,
    retry: 1,
  });

  const configQuery = trpc.broker.config.get.useQuery(undefined, {
    refetchInterval: 30_000,
  });

  const tokenMutation = trpc.broker.token.update.useMutation({
    onSuccess: () => {
      toast.success("Credentials updated successfully");
      setToken("");
      setClientId("");
      statusQuery.refetch();
      configQuery.refetch();
    },
    onError: (err) => {
      toast.error(`Update failed: ${err.message}`);
    },
  });

  // ── Derive gate state ──────────────────────────────────────────
  const status = statusQuery.data;
  const config = configQuery.data;
  const isLoading = statusQuery.isLoading || configQuery.isLoading;

  // No broker configured at all — let SetupBrokerModal handle that
  const noBroker = !status?.activeBrokerId;
  const isPaper = config?.isPaperBroker ?? false;

  // Check conditions (only for live brokers)
  const savedClientId = config?.credentials?.clientId ?? "";
  const tokenUpdatedAt = config?.credentials?.updatedAt ?? 0;
  const tokenAge = tokenUpdatedAt > 0 ? Date.now() - tokenUpdatedAt : Infinity;

  const clientIdMissing = !isPaper && !noBroker && !savedClientId && configQuery.isFetched;
  const tokenExpired = !isPaper && !noBroker && (
    tokenAge >= TWENTY_FOUR_HOURS ||
    status?.tokenStatus === "expired"
  );

  const gateBlocked = clientIdMissing || tokenExpired;

  // Pre-fill client ID from saved config
  useEffect(() => {
    if (savedClientId) {
      setClientId(savedClientId);
    }
  }, [savedClientId]);

  // ── Submit handler ─────────────────────────────────────────────
  const handleSubmit = () => {
    const resolvedClientId = savedClientId || clientId.trim();
    if (!resolvedClientId) {
      toast.error("Client ID is required");
      return;
    }
    if (!token.trim()) {
      toast.error("Access token is required");
      return;
    }
    tokenMutation.mutate({
      token: token.trim(),
      clientId: resolvedClientId,
    });
  };

  // ── Determine what to show ─────────────────────────────────────
  // If loading or no broker or paper mode, pass through
  if (isLoading || noBroker || isPaper || !gateBlocked || dismissed) {
    return <>{children}</>;
  }

  // Dynamic messaging
  const needsClientId = clientIdMissing;
  const needsToken = tokenExpired;

  let title = "Credentials Required";
  let description = "";
  if (needsClientId && needsToken) {
    title = "Setup Required";
    description = "Your Client ID is missing and access token has expired. Enter both to continue.";
  } else if (needsClientId) {
    title = "Client ID Required";
    description = "Your Dhan Client ID is required for API authentication. Enter it below to continue.";
  } else {
    title = "Access Token Expired";
    description = "Your Dhan access token has expired (tokens are valid for 24 hours). Paste a new token to continue.";
  }

  return (
    <>
      {/* Render a dark backdrop instead of the app */}
      <div className="fixed inset-0 bg-background z-40" />

      <Dialog open={true} onOpenChange={(v) => !v && setDismissed(true)}>
        <DialogContent
          className="sm:max-w-md z-50"
          onPointerDownOutside={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle className="text-warning-amber">{title}</DialogTitle>
            <DialogDescription>
              {description}{" "}
              {needsToken && (
                <>
                  Get a new token from{" "}
                  <a
                    href="https://login.dhan.co"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline text-info-cyan"
                  >
                    login.dhan.co
                  </a>
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {/* Client ID — read-only if saved, editable if missing */}
            {needsClientId ? (
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">
                  Client ID <span className="text-loss-red">*</span>
                </label>
                <Input
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder="Your Dhan client ID (e.g. 1100012345)"
                  className="font-mono text-xs"
                  autoFocus
                />
              </div>
            ) : (
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">
                  Client ID
                </label>
                <div className="px-3 py-2 rounded-md border bg-muted/30 font-mono text-xs text-muted-foreground">
                  {savedClientId}
                </div>
              </div>
            )}

            {/* Access Token — always required */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                Access Token <span className="text-loss-red">*</span>
              </label>
              <div className="relative flex items-center">
                <Input
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="Paste your access token..."
                  className="font-mono text-sm pr-9"
                  autoFocus={!needsClientId}
                />
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const text = await navigator.clipboard.readText();
                      setToken(text.trim());
                    } catch {
                      toast.error("Clipboard access denied");
                    }
                  }}
                  className="absolute right-2 text-muted-foreground hover:text-foreground transition-colors"
                  title="Paste from clipboard"
                >
                  <ClipboardPaste className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button
              onClick={handleSubmit}
              disabled={
                (!savedClientId && !clientId.trim()) ||
                !token.trim() ||
                tokenMutation.isPending
              }
              className="w-full"
            >
              {tokenMutation.isPending ? "Updating..." : "Continue"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
