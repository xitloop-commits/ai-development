import { toast } from 'sonner';
import { copyText } from './clipboard';

/**
 * Copy a contract string and TELL the operator what happened.
 *
 * Shared by the today and past trade rows so both behave identically. The old
 * inline version used `navigator.clipboard?.writeText(...)`, whose optional
 * chain made a failure indistinguishable from a success — on the plain-http
 * origin the desk is normally opened at, that API doesn't exist and the click
 * did nothing at all, silently. See lib/clipboard.ts.
 */
export async function copyContract(text: string): Promise<void> {
  const ok = await copyText(text);
  if (ok) toast.success(`Copied: ${text}`);
  else toast.error(`Could not copy "${text}" — select and copy it by hand.`);
}
