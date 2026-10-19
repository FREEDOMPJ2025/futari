'use client'

import { useEffect, useId, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from '@/lib/i18n/client'
import { describeError } from '@/lib/errors'
import { unwrapAction } from '@/lib/action-errors'
import { generateShortcutKey, revokeShortcutKey } from '@/actions/shortcutKey'
import { SubpageHeader } from '@/app/(dashboard)/_components/SubpageHeader'
import { ConfirmModal } from '@/app/(dashboard)/_components/ConfirmModal'
import { Button } from '@/components/ui/Button'
import { TextInput } from '@/components/ui/TextInput'

/** What the server page may pass: no key, no hash, no id (see page.tsx). */
export interface ShortcutKeyView {
  hint: string
  createdLabel: string
  lastUsedLabel: string | null
}

type Confirming = 'regenerate' | 'revoke' | null
type CopyNote = 'copied' | 'copyFailed' | null

/**
 * #1536 — 捷徑金鑰 settings page.
 *
 * The freshly generated key lives ONLY in `freshKey` below: it comes from the
 * generate action's response and is never written to a URL, storage, a prop
 * from the server, or anything the service worker caches. It is dropped on
 * revoke, on `pagehide` (so a page restored from the back/forward cache does
 * not show it again), and with the component when the user navigates away.
 * `router.refresh()` after an action re-reads the hint and times from the
 * server; it keeps this component's state, so the key stays on screen until
 * the user leaves.
 *
 * Failure looks like (if someone moves the key into a prop or the URL to
 * "survive a refresh"): nothing errors; the plaintext key just sits in the
 * page's RSC payload / history, readable later by anyone with the device.
 */
export function ShortcutKeyContent({ current }: { current: ShortcutKeyView | null }) {
  const t = useTranslations()
  const tk = t.settings.shortcutKey
  const router = useRouter()
  const inputId = useId()
  const [freshKey, setFreshKey] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<Confirming>(null)
  const [copyNote, setCopyNote] = useState<CopyNote>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  useEffect(() => {
    const drop = () => setFreshKey(null)
    window.addEventListener('pagehide', drop)
    return () => window.removeEventListener('pagehide', drop)
  }, [])

  function run(kind: 'generate' | 'revoke') {
    setError(null)
    setCopyNote(null)
    start(async () => {
      try {
        if (kind === 'generate') {
          const { key } = unwrapAction(await generateShortcutKey())
          setFreshKey(key)
        } else {
          unwrapAction(await revokeShortcutKey())
          setFreshKey(null)
        }
        setConfirming(null)
        router.refresh()
      } catch (e: unknown) {
        setConfirming(null)
        setError(describeError(e, tk.failed, t.common.offlineError, t.errors.actions))
      }
    })
  }

  async function copy() {
    if (!freshKey) return
    try {
      if (!navigator.clipboard) throw new Error('no clipboard')
      await navigator.clipboard.writeText(freshKey)
      setCopyNote('copied')
    } catch {
      setCopyNote('copyFailed')
    }
  }

  return (
    <>
      <SubpageHeader title={tk.title} backLabel={tk.back} />

      <div className="px-5 pt-6 pb-6">
        <h1 className="text-page leading-tight font-medium text-ink">{tk.pageHeading}</h1>
        <p className="text-sm mt-3 text-ink-2">{tk.pageSubtitle}</p>
      </div>

      {freshKey && (
        <section className="px-4 pb-6" aria-labelledby={`${inputId}-heading`}>
          <div className="rounded-card p-4 bg-surface border border-hairline">
            <h2 id={`${inputId}-heading`} className="text-base font-medium text-ink">
              {tk.fresh.heading}
            </h2>
            <p className="text-sm mt-1.5 leading-relaxed text-ink-2">{tk.fresh.body}</p>
            <label htmlFor={inputId} className="sr-only">{tk.fresh.inputLabel}</label>
            <TextInput
              id={inputId}
              className="mt-3"
              inputClassName="font-numeric"
              value={freshKey}
              readOnly
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              onFocus={(e) => e.currentTarget.select()}
            />
            <div className="mt-3 flex items-center gap-3">
              <Button variant="primary" size="sm" onClick={copy}>
                {copyNote === 'copied' ? tk.fresh.copied : tk.fresh.copy}
              </Button>
              <span className="text-sm text-ink-2" role="status">
                {copyNote === 'copyFailed' ? tk.fresh.copyFailed : ''}
              </span>
            </div>
          </div>
        </section>
      )}

      <section className="px-4 pb-6">
        {current ? (
          <div className="rounded-card p-4 bg-surface border border-hairline">
            <h2 className="text-base font-medium text-ink">{tk.current.heading}</h2>
            <dl className="mt-2 text-sm text-ink-2">
              <div className="flex justify-between gap-3 py-1">
                <dt>{tk.current.hintLabel}</dt>
                <dd className="font-numeric text-ink">…{current.hint}</dd>
              </div>
              <div className="flex justify-between gap-3 py-1">
                <dt>{tk.current.createdLabel}</dt>
                <dd className="text-ink text-right">{current.createdLabel}</dd>
              </div>
              <div className="flex justify-between gap-3 py-1">
                <dt>{tk.current.lastUsedLabel}</dt>
                <dd className="text-ink text-right">{current.lastUsedLabel ?? tk.current.neverUsed}</dd>
              </div>
            </dl>
            <div className="mt-4 flex flex-wrap gap-3">
              <Button
                variant="secondary"
                size="sm"
                disabled={pending}
                onClick={() => setConfirming('regenerate')}
              >
                {tk.regenerate.cta}
              </Button>
              {/* Plain button, not Button variant="ghost": the ghost variant's
                * own text colour would compete with text-destructive. */}
              <button
                type="button"
                className="h-[var(--control-sm)] px-4 rounded-bubble bg-transparent border-0 text-sm font-medium cursor-pointer text-destructive disabled:opacity-50 disabled:cursor-default"
                disabled={pending}
                onClick={() => setConfirming('revoke')}
              >
                {tk.revoke.cta}
              </button>
            </div>
          </div>
        ) : (
          <div className="rounded-card p-4 bg-surface border border-hairline">
            <p className="text-sm text-ink-2">{tk.empty}</p>
            <Button
              className="mt-3"
              variant="primary"
              size="sm"
              loading={pending}
              onClick={() => run('generate')}
            >
              {tk.generate}
            </Button>
          </div>
        )}

        {error && (
          <p className="text-sm mt-2 px-1 text-[var(--debit-text)]" role="alert">{error}</p>
        )}
      </section>

      <section className="px-4 pb-12">
        <div className="rounded-card p-4 bg-surface-alt border border-hairline" role="note">
          <div className="text-sm font-medium text-ink">{tk.shareWarning.heading}</div>
          <p className="text-sm mt-1 leading-relaxed text-ink-2">{tk.shareWarning.body}</p>
        </div>
      </section>

      <ConfirmModal
        open={confirming === 'regenerate'}
        title={tk.regenerate.confirmTitle}
        description={tk.regenerate.confirmBody}
        confirmLabel={tk.regenerate.confirmLabel}
        pending={pending}
        onCancel={() => setConfirming(null)}
        onConfirm={() => run('generate')}
      />
      <ConfirmModal
        open={confirming === 'revoke'}
        title={tk.revoke.confirmTitle}
        description={tk.revoke.confirmBody}
        confirmLabel={tk.revoke.confirmLabel}
        pending={pending}
        onCancel={() => setConfirming(null)}
        onConfirm={() => run('revoke')}
      />
    </>
  )
}
