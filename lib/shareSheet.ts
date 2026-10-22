/**
 * The system share sheet, from one place (#1749).
 *
 * Web and the iOS shell (WKWebView) have the Web Share API. The Android
 * shell's WebView does not, so inside it the sheet comes from the
 * `@capacitor/share` plugin. Three callers use this: `lib/share.ts` (invite
 * link), `ShareLinkCard` (outing link) and `AndroidTesterInviteRow`.
 *
 * The platform is read at runtime (one deployment serves the web and both
 * shells; see CLAUDE.md 「三平台架構」) from the `window.Capacitor` the bridge
 * injects, like `lib/platform.ts`, so no Capacitor runtime reaches pages that
 * never share. The plugin itself is `import()`ed only when a share happens.
 *
 * Old Android shells were built before the plugin was added. Web changes reach
 * them at once but the plugin does not exist in them, and
 * `isPluginAvailable('Share')` is false there, so they keep the old path: the
 * caller copies instead. Failure looks like: tapping share in an old shell does
 * nothing at all, or throws "Share plugin is not implemented on android".
 */
import { nativeShellPlatform } from '@/lib/platform'

export type ShareSheetOptions = { title?: string; text?: string; url: string }

type CapacitorWithPlugins = { isPluginAvailable?: (name: string) => boolean }

/** True inside an Android shell that was built with `@capacitor/share`. */
export function hasAndroidSharePlugin(): boolean {
  if (typeof window === 'undefined' || nativeShellPlatform() !== 'android') return false
  const cap = (window as unknown as { Capacitor?: CapacitorWithPlugins }).Capacitor
  return cap?.isPluginAvailable?.('Share') === true
}

/** True when `openShareSheet` has a sheet to open. Read after mount only: the
 *  server render can't know. */
export function hasShareSheet(): boolean {
  return hasAndroidSharePlugin() || (typeof navigator !== 'undefined' && typeof navigator.share === 'function')
}

const loadSharePlugin = () => import('@capacitor/share')

/** Start loading the plugin so a later tap doesn't wait on the chunk. No-op
 *  everywhere but the Android shell. */
export function preloadShareSheet(): void {
  if (hasAndroidSharePlugin()) loadSharePlugin().catch(() => {})
}

/**
 * Open the sheet. Resolves once the user has picked a target, rejects when
 * they dismiss it (see `isShareCancel`) or when it can't be shown.
 *
 * The Web Share branch calls `navigator.share` before the first `await`, so a
 * caller that invokes this synchronously inside a tap keeps the user gesture
 * Safari insists on. The Android branch goes through the native bridge, which
 * does not look at web user activation.
 */
export async function openShareSheet({ title, text, url }: ShareSheetOptions): Promise<void> {
  if (hasAndroidSharePlugin()) {
    const { Share } = await loadSharePlugin()
    await Share.share({ title, text, url })
    return
  }
  await navigator.share({ title, text, url })
}

/**
 * The user closed the sheet without sharing: nothing was sent, nothing to say.
 *
 * Web Share rejects with a DOMException named `AbortError`. The Android plugin
 * rejects with a plain `Error` whose message is `Share canceled`, no code
 * (node_modules/@capacitor/share/android/src/main/java/com/capacitorjs/plugins/share/SharePlugin.java:79,
 * `call.reject("Share canceled")`; the bridge turns it into `cap.Exception`).
 * Failure looks like: dismissing the Android sheet shows a "copy failed" note
 * or falls back to copying, as if sharing had broken.
 */
export function isShareCancel(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false
  const { name, message } = e as { name?: unknown; message?: unknown }
  return name === 'AbortError' || message === 'Share canceled'
}
