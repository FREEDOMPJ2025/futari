import { hasShareSheet, openShareSheet } from '@/lib/shareSheet'

/**
 * Share an invite URL: always copies to clipboard first (desktop safety net),
 * then opens the native share sheet on top if available (mobile convenience).
 *
 * Returns:
 *  - 'shared' when the native share sheet was used and not cancelled. The URL
 *    is still in the clipboard at this point, but the caller typically suppresses
 *    the "已複製" toast since the user explicitly took a share action.
 *  - 'copied' when we only managed to copy (no share API, or share cancelled,
 *    or share threw a non-AbortError). The caller should toast "已複製連結".
 *
 * Throws when neither clipboard nor share is available — extremely rare in
 * practice (non-secure context with a non-modern browser).
 */
export async function shareInviteLink(
  url: string,
  title = 'Futari 邀請',
  text?: string,
): Promise<'shared' | 'copied'> {
  // Step 1: copy to clipboard. This is the reliable path for desktop users —
  // even if step 2 below opens a share sheet they don't want, the URL is
  // already on their clipboard so they can paste anywhere.
  let copied = false
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(url)
      copied = true
    } catch {
      // Clipboard might be blocked (non-secure context, permission denied).
      // Fall through; we'll rely on share.
    }
  }

  // Step 2: try the native share sheet (mobile users get LINE / iMessage / etc.).
  // Web Share, or @capacitor/share inside the Android shell (#1749).
  if (hasShareSheet()) {
    try {
      await openShareSheet({ title, text, url })
      return 'shared'
    } catch {
      // The user dismissed the sheet, or sharing failed for some reason. In both
      // cases the clipboard copy from step 1 still gives them a usable result.
    }
  }

  if (copied) return 'copied'
  throw new Error('連結無法傳送')
}
