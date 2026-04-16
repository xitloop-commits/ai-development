/**
 * SetupBrokerModal — shows on startup when no broker is configured.
 * Lets user pick a broker (Dhan / Paper Trading) and enter credentials.
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
import { ClipboardPaste } from "lucide-react";

export function SetupBrokerModal() {
  const [open, setOpen] = useState(false);
  const [brokerId, setBrokerId] = useState("dhan");
  const [accessToken, setAccessToken] = useState("");

  const statusQuery = trpc.broker.status.useQuery(undefined, {
    refetchInterval: 10_000,
    retry: 1,
  });

  const adaptersQuery = trpc.broker.adapters.list.useQuery();

  const setupMutation = trpc.broker.setup.useMutation({
    onSuccess: () => {
      toast.success("Broker configured successfully!");
      setOpen(false);
      setAccessToken("");
      statusQuery.refetch();
    },
    onError: (err) => {
      toast.error(`Setup failed: ${err.message}`);
    },
  });

  // Show when no active broker is configured
  useEffect(() => {
    const status = statusQuery.data;
    if (!status) return;

    if (!status.activeBrokerId) {
      setOpen(true);
    }
  }, [statusQuery.data]);

  const adapters = adaptersQuery.data ?? [];
  const selectedAdapter = adapters.find((a) => a.brokerId === brokerId);
  const isPaper = selectedAdapter?.isPaperBroker ?? false;

  const handleSubmit = () => {
    if (!isPaper && !accessToken.trim()) {
      toast.error("Access token is required for live trading");
      return;
    }
    setupMutation.mutate({
      brokerId,
      accessToken: isPaper ? undefined : accessToken.trim(),
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Setup Broker</DialogTitle>
          <DialogDescription>
            No broker is configured. Select a broker and enter your credentials
            to get started.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Broker Selection */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">
              Broker
            </label>
            <div className="flex gap-2">
              {adapters.map((a) => (
                <button
                  key={a.brokerId}
                  onClick={() => setBrokerId(a.brokerId)}
                  className={`flex-1 px-3 py-2 rounded-md text-xs font-medium border transition-colors ${
                    brokerId === a.brokerId
                      ? "border-info-cyan bg-info-cyan/10 text-info-cyan"
                      : "border-border bg-background text-muted-foreground hover:border-foreground/30"
                  }`}
                >
                  {a.displayName}
                  {a.isPaperBroker && (
                    <span className="block text-[0.625rem] opacity-60">
                      No credentials needed
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Credentials (only for live brokers) */}
          {!isPaper && (
            <>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">
                  Access Token <span className="text-loss-red">*</span>
                </label>
                <div className="relative flex items-center">
                  <Input
                    value={accessToken}
                    onChange={(e) => setAccessToken(e.target.value)}
                    placeholder="Paste your Dhan access token..."
                    className="font-mono text-xs pr-9"
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const text = await navigator.clipboard.readText();
                        setAccessToken(text.trim());
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
                <p className="text-[0.625rem] text-muted-foreground">
                  Get your token from{" "}
                  <a
                    href="https://login.dhan.co"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline text-info-cyan"
                  >
                    login.dhan.co
                  </a>
                </p>
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button
            onClick={handleSubmit}
            disabled={setupMutation.isPending}
            className="w-full"
          >
            {setupMutation.isPending
              ? "Setting up..."
              : isPaper
                ? "Start Paper Trading"
                : "Connect Broker"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
