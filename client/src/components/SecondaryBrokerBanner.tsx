/**
 * SecondaryBrokerBanner — non-blocking soft alert for the spouse Dhan
 * account (`dhan-secondary-ac`) when its API status is degraded.
 *
 * Today CredentialGate hard-blocks the UI only on the primary account's
 * token expiry — primary is on the critical path for every channel. The
 * secondary account drives `live` (and TFA's data subscription); when
 * IT fails, manual / paper trading on the primary side still works fine,
 * so a hard block would be overkill. This banner sits below the AppBar
 * and surfaces the problem so it isn't silent (which today it is — only
 * the BSA log carries the warning).
 *
 * Skip when credentials are missing — that's an intentionally-unset
 * account, not a failure to nag about.
 */
import { AlertTriangle, X } from 'lucide-react';
import { useState } from 'react';
import { trpc } from '@/lib/trpc';

const SECONDARY_BROKER_ID = 'dhan-secondary-ac';

export function SecondaryBrokerBanner() {
  const [dismissed, setDismissed] = useState(false);

  const configQuery = trpc.broker.config.get.useQuery(
    { brokerId: SECONDARY_BROKER_ID },
    { refetchInterval: 30_000, retry: 1 },
  );

  if (dismissed) return null;
  const config = configQuery.data;
  if (!config) return null;

  const apiStatus = config.connection?.apiStatus ?? 'unknown';
  const hasCredentials =
    !!(config.credentials?.clientId || (config as any).auth?.clientId);

  // Only nag when credentials ARE configured (this is a real failure)
  // and the API is in a bad state. Missing creds = intentionally unset.
  const degraded = hasCredentials && apiStatus !== 'connected';
  if (!degraded) return null;

  return (
    <div className="shrink-0 px-4 py-1.5 bg-warning-amber/10 border-b border-warning-amber/40 flex items-center gap-2 text-[0.6875rem]">
      <AlertTriangle className="h-3.5 w-3.5 text-warning-amber shrink-0" />
      <div className="flex-1 text-foreground">
        <strong className="text-warning-amber">AI-Live broker degraded</strong>
        {' — '}
        <span className="text-muted-foreground">
          Spouse Dhan account (<code className="text-foreground">{SECONDARY_BROKER_ID}</code>) status:{' '}
          <span className="text-destructive font-bold">{apiStatus}</span>.
          Manual / paper trading on the primary account is unaffected.
          Restart the API server to retry the TOTP refresh, or check the BSA log.
        </span>
      </div>
      <button
        onClick={() => setDismissed(true)}
        className="shrink-0 p-1 rounded hover:bg-warning-amber/20 text-muted-foreground hover:text-foreground transition-colors"
        title="Dismiss (will reappear on next page load if still degraded)"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
