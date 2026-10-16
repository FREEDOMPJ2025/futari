'use client'

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { ConfirmModal } from '@/app/(dashboard)/_components/ConfirmModal'
import { Button } from '@/components/ui/Button'
import { useLocale, useTranslations } from '@/lib/i18n/client'
import { unwrapAction } from '@/lib/action-errors'
import { describeError } from '@/lib/errors'
import { getOutingShareLink, resetOutingShareLink } from '@/actions/outing'
import { trackOutingLinkShared } from '@/lib/analytics/outingEvents'

/** `<origin>/<locale>/outing/<token>` — the public join page (S3). */
export function outingShareUrl(origin: string, locale: string, token: string): string {
  return `${origin}/${locale}/outing/${token}`
}

/**
 * Write a text that may still be on its way. Safari only lets a click write
 * to the clipboard inside the gesture itself, and the first copy has to wait
 * for the server to create the token; `ClipboardItem` accepts a promise and
 * keeps the gesture. Elsewhere, write once the text is in.
 * Failure looks like: the button says nothing happened on iPhone only, and
 * the URL never reaches the clipboard — the shown URL is the fallback.
 */
function writeClipboard(text: Promise<string>): Promise<void> {
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    return navigator.clipboard.write([
      new ClipboardItem({ 'text/plain': text.then((s) => new Blob([s], { type: 'text/plain' })) }),
    ])
  }
  return text.then((s) => {
    if (!navigator.clipboard) throw new Error('no clipboard')
    return navigator.clipboard.writeText(s)
  })
}

type Note = 'copied' | 'copyFailed' | 'reset' | 'messageCopied' | null

/** True when the browser has a system share sheet. iOS Safari, the iOS shell
 *  (WKWebView) and most phone browsers do; the Android shell's WebView does
 *  not, and neither do many desktop browsers, so those copy instead. Read
 *  after mount only: the server render can't know. */
function hasShareSheet(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function'
}

function isAbort(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError'
}

/**
 * The share link and everything that sends it (#1558, #1727), shared by the
 * share card and the 「還有幾個名字沒人選」 line so both reach the same state.
 *
 * Share sheet (#1727): `navigator.share` must run inside the tap, and the token
 * comes from the server, so where a share sheet exists the link is fetched when
 * the card appears and again whenever the tab comes back into view (the partner
 * may have reset it from their phone). Where there is no share sheet nothing is
 * fetched up front; the share button then copies a ready-to-paste message with
 * the link, using the same in-gesture clipboard write as 複製連結.
 * Failure looks like: on iPhone the share button does nothing (the share was
 * refused for running outside the tap), or a stale link goes out after a reset.
 */
export function useOutingShare(outingId: string, outingName: string, enabled = true) {
  const t = useTranslations()
  const to = t.outing
  const locale = useLocale()
  const [url, setUrl] = useState<string | null>(null)
  const [note, setNote] = useState<Note>(null)
  const [error, setError] = useState('')
  const [pending, startTransition] = useTransition()
  const [resetting, startReset] = useTransition()
  const [canShareSheet, setCanShareSheet] = useState(false)
  const latestUrl = useRef<string | null>(null)

  const toUrl = useCallback((token: string) => outingShareUrl(window.location.origin, locale, token), [locale])
  const fetchUrl = useCallback(
    () => getOutingShareLink({ outingId }).then((r) => toUrl(unwrapAction(r).token)),
    [outingId, toUrl],
  )
  const showUrl = (u: string) => {
    latestUrl.current = u
    setUrl(u)
  }
  const message = to.share.message.replace('{name}', outingName)

  useEffect(() => {
    // `enabled` is false when the viewer can't share (not editable): nothing is fetched.
    if (!enabled || !hasShareSheet()) return
    setCanShareSheet(true)
    let alive = true
    const refresh = () => {
      fetchUrl().then((u) => { if (alive) { latestUrl.current = u; setUrl(u) } }, () => {})
    }
    refresh()
    const onVisible = () => { if (document.visibilityState === 'visible') refresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [enabled, fetchUrl])

  /** Copy `text(url)` inside the gesture; `kind` picks the note and the event. */
  const copyFresh = (text: (u: string) => string, kind: 'copied' | 'messageCopied') => {
    setNote(null)
    setError('')
    // Asked every time rather than cached: the partner may have reset the
    // link from their phone since this page loaded.
    const urlP = fetchUrl()
    // Started synchronously, inside the click (see writeClipboard).
    const copyP = writeClipboard(urlP.then(text))
    startTransition(async () => {
      try {
        showUrl(await urlP)
      } catch (e) {
        copyP.catch(() => {})
        setError(describeError(e, t.common.error, t.common.offlineError, t.errors.actions))
        return
      }
      try {
        await copyP
        setNote(kind)
        // Only a copy that worked: on copyFailed the URL is on screen, but
        // whether it gets selected and sent is not something we can see.
        trackOutingLinkShared('copy')
      } catch {
        setNote('copyFailed')
      }
    })
  }

  const copyLink = () => copyFresh((u) => u, 'copied')

  const share = () => {
    const ready = latestUrl.current
    if (!canShareSheet || !ready) {
      copyFresh((u) => `${message}\n${u}`, 'messageCopied')
      return
    }
    setNote(null)
    setError('')
    // Called synchronously in the tap: Safari refuses a share that isn't.
    navigator.share({ title: outingName, text: message, url: ready }).then(
      () => trackOutingLinkShared('share'),
      (e) => {
        if (isAbort(e)) return // closed the sheet: nothing was sent, nothing to say
        // Refused or broken: the link is on screen; offer it by hand.
        setNote('copyFailed')
      },
    )
  }

  /** The link for the QR code: the latest known one, or fetched now. */
  const linkForQr = (): Promise<string> =>
    latestUrl.current ? Promise.resolve(latestUrl.current) : fetchUrl().then((u) => { showUrl(u); return u })

  const reset = (onDone: () => void, onError: (msg: string) => void) => {
    startReset(async () => {
      try {
        const { token } = unwrapAction(await resetOutingShareLink({ outingId }))
        showUrl(toUrl(token))
        setNote('reset')
        setError('')
        onDone()
      } catch (e) {
        onError(describeError(e, t.common.error, t.common.offlineError, t.errors.actions))
      }
    })
  }

  return { url, note, error, setError, pending, resetting, share, copyLink, linkForQr, reset }
}

export type OutingShare = ReturnType<typeof useOutingShare>

/**
 * 分享連結 (#1558, members only). Every copy asks the server for the link,
 * which creates the token the first time; later copies get the same token, so
 * copying twice never breaks a link already sent. 重設 replaces it after a
 * confirm: the old link stops working, people who already joined keep going.
 * #1727 adds the share sheet with a prefilled message and the QR code.
 */
export function ShareLinkCard({ outingId, outingName = '' }: { outingId: string; outingName?: string }) {
  const share = useOutingShare(outingId, outingName)
  return <ShareLinkCardView share={share} />
}

export function ShareLinkCardView({ share }: { share: OutingShare }) {
  const t = useTranslations()
  const to = t.outing
  const [confirmingReset, setConfirmingReset] = useState(false)
  const [resetError, setResetError] = useState('')
  const { url, note, error, setError, pending, resetting } = share

  const noteText = note === 'copied' ? to.share.copied
    : note === 'copyFailed' ? to.share.copyFailed
      : note === 'reset' ? to.share.resetDone
        : note === 'messageCopied' ? to.share.messageCopied
          : ''

  return (
    <section id="outing-share" className="rounded-card p-4 bg-surface border border-hairline">
      <div className="text-sm font-medium mb-2 text-ink-2">{to.share.label}</div>
      <p className="text-sm leading-relaxed text-ink-3">{to.share.hint}</p>

      {url && (
        <p data-testid="outing-share-url" className="mt-3 text-sm break-all select-all text-ink">{url}</p>
      )}

      <Button variant="primary" onClick={share.share} disabled={pending} className="mt-3 w-full">
        {to.share.shareCta}
      </Button>
      <div className="mt-2.5 flex gap-2.5">
        <Button variant="secondary" onClick={share.copyLink} disabled={pending} className="flex-1">
          {pending ? t.common.processing : to.share.copy}
        </Button>
        <Button variant="ghost" onClick={() => { setResetError(''); setConfirmingReset(true) }}>
          {to.share.reset}
        </Button>
      </div>

      <p role="status" aria-live="polite" className="mt-2 text-xs text-ink-3 empty:hidden">{noteText}</p>
      {error && <p role="alert" className="mt-2 text-sm text-[var(--debit-text)]">{error}</p>}

      <OutingQr share={share} onError={setError} />

      <ConfirmModal
        open={confirmingReset}
        title={to.share.resetConfirmTitle}
        description={to.share.resetConfirmBody}
        confirmLabel={to.share.resetConfirm}
        pending={resetting}
        onCancel={() => setConfirmingReset(false)}
        onConfirm={() => share.reset(() => setConfirmingReset(false), setResetError)}
      >
        {resetError && <p role="alert" className="text-sm mb-4 text-[var(--debit-text)]">{resetError}</p>}
      </ConfirmModal>
    </section>
  )
}

/**
 * QR code of the share link, for friends sitting at the same table (#1727).
 * Shown on tap and kept until hidden: unlike the partner invite (InviteQr,
 * #1017), this link is meant to be handed around the group, and it can be
 * reset if it reaches the wrong people. It follows a reset (re-rendered from
 * the current link).
 */
function OutingQr({ share, onError }: { share: OutingShare; onError: (msg: string) => void }) {
  const t = useTranslations()
  const to = t.outing
  const [shown, setShown] = useState(false)
  const [svg, setSvg] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!shown || !share.url) return
    let alive = true
    // Dynamic import keeps uqr out of the outing page's first load.
    import('uqr').then(({ renderSVG }) => {
      // `share.url` is built from our own origin and a server-issued token,
      // never free text, so the generated markup is safe to inject below.
      if (alive) setSvg(renderSVG(share.url!, { ecc: 'M', border: 2 }))
    })
    return () => { alive = false }
  }, [shown, share.url])

  const show = async () => {
    setLoading(true)
    try {
      await share.linkForQr()
      setShown(true)
      trackOutingLinkShared('qr')
    } catch (e) {
      onError(describeError(e, t.common.error, t.common.offlineError, t.errors.actions))
    } finally {
      setLoading(false)
    }
  }

  if (!shown) {
    return (
      <Button variant="ghost" onClick={show} disabled={loading} className="mt-2 w-full">
        {to.share.qrShow}
      </Button>
    )
  }
  return (
    <div className="mt-3 rounded-2xl border border-hairline bg-surface p-4 flex flex-col items-center gap-3">
      {/* Black on white in every theme: uqr paints its own white background
          rect, which keeps the code scannable in dark mode (see InviteQr). */}
      <div
        role="img"
        aria-label={to.share.qrAlt}
        data-testid="outing-qr"
        className="w-full max-w-60 [&>svg]:w-full [&>svg]:h-auto [&>svg]:block"
        dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
      />
      <p className="m-0 text-xs text-center text-ink-3">{to.share.qrHint}</p>
      <Button variant="ghost" onClick={() => setShown(false)}>
        {to.share.qrHide}
      </Button>
    </div>
  )
}
