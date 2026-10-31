'use client'

import { useEffect, useState } from 'react'
import { SignInButton, preloadNativeAuthModules, type SignInAbortReason } from './SignInButton'
import { SignInNotice } from './SignInNotice'
import { WaitingCurtain } from './WaitingCurtain'

/**
 * Owns the shared "an attempt is in flight" state for both provider buttons and
 * paints a waiting curtain over the page while it is true (#1083).
 *
 * Why this exists at all: on the native shells the sign-in page is never
 * replaced during OAuth. The in-app browser opens ON TOP of it, so when the
 * deep link comes back and we close that browser, the user is looking at a
 * fully interactive sign-in form again — for as long as the /auth/callback
 * round-trip takes. A second tap there starts a fresh attempt whose appUrlOpen
 * listener dies with the page the first attempt is already navigating away
 * from, leaving an in-app browser open that nothing will ever answer.
 *
 * Both buttons share one flag deliberately: the second tap that breaks things
 * is just as likely to land on the other provider.
 */
export function SignInActions({
  googleLabel,
  appleLabel,
  pendingLabel,
  appleFallbackHint,
  unreachableHint,
}: {
  googleLabel: string
  appleLabel: string
  pendingLabel: string
  /** Shown after the iOS Apple browser fallback ends without signing in (#1552). */
  appleFallbackHint?: string
  /** Shown when the auth server could not be reached (#1845). */
  unreachableHint?: string
}) {
  const [pending, setPending] = useState(false)
  const [abortReason, setAbortReason] = useState<SignInAbortReason | null>(null)

  // #1314 — fetch the native plugin chunks now, not on the tap.
  useEffect(() => {
    preloadNativeAuthModules()
  }, [])

  // A new attempt clears the hint; only an abort that carries a reason sets one.
  const start = () => {
    setAbortReason(null)
    setPending(true)
  }
  const abort = (reason?: SignInAbortReason) => {
    setPending(false)
    setAbortReason(reason ?? null)
  }
  const hint =
    abortReason === 'apple_fallback_failed' ? appleFallbackHint
    : abortReason === 'unreachable' ? unreachableHint
    : undefined

  return (
    <>
      {hint && <SignInNotice>{hint}</SignInNotice>}
      <SignInButton provider="google" label={googleLabel} pending={pending} onStart={start} onAbort={abort} />
      <SignInButton provider="apple" label={appleLabel} pending={pending} onStart={start} onAbort={abort} />
      {pending && <WaitingCurtain label={pendingLabel} />}
    </>
  )
}
