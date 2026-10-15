'use client'

import { useEffect, useState } from 'react'
import { Switch } from '@/components/Switch'
import {
  OFFLINE_PREF_KEY,
  getOfflineOwner,
  getOfflinePref,
} from '@/lib/offline/preference'
import {
  enqueueOfflineSequence,
  hasFullSWRegistration,
  isSWSupported,
} from '@/lib/offline/swControl'
import {
  getSessionUserHash,
  runPrefOffMount,
  runTurnOff,
  runTurnOn,
} from '@/lib/offline/lifecycle'
import { useTranslations } from '@/lib/i18n/client'

export function OfflineBrowsingToggle() {
  const t = useTranslations()
  const [enabled, setEnabled] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [supported, setSupported] = useState(true)

  // Displayed state = the preference, with the owner matching (#1673). This
  // never writes `true`: only handleToggle's ON path may (F4). The old
  // calibration (`active || stored`) could switch a turned-off device back on
  // because some worker was still registered.
  useEffect(() => {
    if (!isSWSupported()) {
      setSupported(false)
      return
    }
    let cancelled = false
    const sync = async () => {
      const stored = getOfflinePref()
      if (!stored) {
        if (!cancelled) setEnabled(false)
        // Pref off but `/sw.js` still registered → the off path (mount sweep).
        if (await hasFullSWRegistration()) {
          void enqueueOfflineSequence((seq) =>
            seq.expected ? Promise.resolve() : runPrefOffMount(seq),
          ).catch(() => {})
        }
        return
      }
      const owner = getOfflineOwner()
      const hash = owner ? await getSessionUserHash() : null
      if (cancelled) return
      // A different signed-in user: show off; the dashboard mount's binding
      // check runs the full off.
      setEnabled(!(owner && hash && owner !== hash))
    }
    void sync()
    const onStorage = (e: StorageEvent) => {
      if (e.key === OFFLINE_PREF_KEY || e.key === null) void sync()
    }
    window.addEventListener('storage', onStorage)
    return () => {
      cancelled = true
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  const handleToggle = async (next: boolean) => {
    if (pending) return
    setError(null)
    setPending(true)
    try {
      if (next) {
        const result = await enqueueOfflineSequence((seq) => runTurnOn(seq))
        if (result === 'error') setError(t.settings.offlineToggleError)
      } else {
        await enqueueOfflineSequence((seq) => runTurnOff(seq))
      }
    } catch {
      setError(t.settings.offlineToggleError)
    } finally {
      // The pref is the only truth; never re-derive it from "is there a SW".
      setEnabled(getOfflinePref())
      setPending(false)
    }
  }

  if (!supported) {
    return (
      <div
        className="rounded-card flex items-center px-5 py-4"
        style={{ background: 'var(--surface)', border: '1px solid var(--hairline)' }}
      >
        <div className="flex-1 min-w-0 pr-4">
          <div className="text-sm font-medium" style={{ color: 'var(--ink)' }}>
            {t.settings.offlineBrowsing}
          </div>
          <div className="text-xs mt-0.5" style={{ color: 'var(--ink-3)' }}>
            {t.settings.offlineUnsupported}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div
        className="rounded-card flex items-center justify-between px-5 py-4"
        style={{ background: 'var(--surface)', border: '1px solid var(--hairline)' }}
      >
        <div className="flex-1 min-w-0 pr-4">
          <div className="text-sm font-medium" style={{ color: 'var(--ink)' }}>
            {t.settings.offlineBrowsing}
          </div>
          <div className="text-xs mt-0.5" style={{ color: 'var(--ink-3)' }}>
            {pending
              ? t.settings.offlineToggling
              : enabled
                ? t.settings.offlineHintOn
                : t.settings.offlineHintOff}
          </div>
        </div>
        <Switch
          checked={enabled}
          onChange={handleToggle}
          ariaLabel={t.settings.offlineBrowsing}
          disabled={pending}
        />
      </div>
      {error && (
        <div className="text-xs mt-2 px-1" style={{ color: 'var(--debit-text)' }}>
          {error}
        </div>
      )}
    </div>
  )
}
