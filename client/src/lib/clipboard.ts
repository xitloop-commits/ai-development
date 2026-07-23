/**
 * copyText — copy to the clipboard on THIS app's origin, and always say so.
 *
 * Two things were silently broken before this existed:
 *
 * 1. `navigator.clipboard` only exists in a SECURE CONTEXT — https, or
 *    localhost/127.0.0.1. The desk is normally opened at `http://lubas` (a hosts
 *    entry pointing at this machine, since vite runs with `host: true`), which
 *    is a plain-http origin and therefore NOT secure. So `navigator.clipboard`
 *    is `undefined` there and every copy did nothing.
 *
 * 2. The call sites wrote `navigator.clipboard?.writeText(...)`. The optional
 *    chain turned that undefined into a silent no-op — no toast, no error,
 *    nothing in the console. The feature looked present and did nothing, which
 *    is the worst of the three possible states.
 *
 * So: use the async API when it is actually available, otherwise fall back to
 * the hidden-textarea + `document.execCommand('copy')` trick, which still works
 * on insecure origins. Either way the caller gets a definite true/false and
 * shows a toast — a copy that fails must LOOK like it failed.
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;

  // Preferred path — real clipboard API (https / localhost).
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied, or the document wasn't focused. Fall through rather
      // than giving up: the legacy path often still succeeds.
    }
  }

  // Fallback — works on plain-http origins, where the API above is absent.
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    // Off-screen rather than display:none — a hidden element cannot be selected,
    // and `readOnly` stops mobile keyboards popping up on focus.
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
