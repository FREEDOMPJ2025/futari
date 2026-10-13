'use client'

import { createContext, useCallback, useContext, useState } from 'react'
import dynamic from 'next/dynamic'

// AvatarMenuSheet only mounts when the user taps their avatar — lazy-load
// to keep dashboard layout initial bundle small (#670 audit 6.1).
const AvatarMenuSheet = dynamic(
  () => import('./AvatarMenuSheet').then(m => m.AvatarMenuSheet),
  { ssr: false },
)

export interface AvatarMenuData {
  viewerEmail: string
  groupDefaultRatioA: number | null
  guardianBetaEnabled: boolean
  currentLocale: string
  /** #1328 — viewer's own avatar-visibility preference. */
  avatarHidden: boolean
  /**
   * #1546 — the solo ledger has an invite link that could still be accepted,
   * so the member section offers to make it unusable. Read when the layout
   * renders; the revoke re-checks under the group lock.
   */
  hasOpenInvite: boolean
}

interface AvatarMenuApi {
  open: () => void
  close: () => void
  isOpen: boolean
}

const AvatarMenuContext = createContext<AvatarMenuApi | null>(null)

export function useAvatarMenu(): AvatarMenuApi {
  const ctx = useContext(AvatarMenuContext)
  if (!ctx) throw new Error('useAvatarMenu must be inside <AvatarMenuProvider>')
  return ctx
}

interface Props {
  data: AvatarMenuData
  /**
   * #1612 — a former member looking back at a ledger they left: the sheet's
   * settings (ledger name, ratio, currency, guardian) act on the viewer's own
   * ledger, not the chapter on screen, so the menu does not open at all.
   */
  disabled?: boolean
  children: React.ReactNode
}

export function AvatarMenuProvider({ data, disabled = false, children }: Props) {
  const [isOpen, setOpen] = useState(false)
  const open = useCallback(() => { if (!disabled) setOpen(true) }, [disabled])
  const close = useCallback(() => setOpen(false), [])
  return (
    <AvatarMenuContext.Provider value={{ open, close, isOpen }}>
      {children}
      {!disabled && <AvatarMenuSheet open={isOpen} onClose={close} data={data} />}
    </AvatarMenuContext.Provider>
  )
}
