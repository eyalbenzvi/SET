/**
 * Clipboard and Web Share helpers, both optional browser features.
 *
 * Ported from the owner's SuperTaki project (github.com/eyalbenzvi/SuperTaki,
 * src/lib/share.ts) so the invite flow behaves identically in both games —
 * including the `execCommand` fallback, which is what makes copying work in the
 * in-app browsers where the async Clipboard API is unavailable.
 */

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

export function canShare(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

export async function shareLink(data: {
  title: string;
  text: string;
  url: string;
}): Promise<boolean> {
  if (!canShare()) return false;
  try {
    await navigator.share(data);
    return true;
  } catch {
    // A cancelled share rejects; that is not an error worth surfacing.
    return false;
  }
}
