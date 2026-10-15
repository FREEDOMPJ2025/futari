/**
 * Why a new user came to sign up, carried through /onboarding and /setup so
 * the end of setup lands where they meant to go (#1726).
 *
 * Only a closed set of values is accepted, and each maps to a fixed in-app
 * path defined here. Nothing from the URL is ever used as a redirect target,
 * so this cannot become an open redirect: an unknown or repeated value reads
 * as "no intent" and the normal flow runs.
 *
 * What failure looks like: nothing errors. A typo in a value or a dropped
 * `?intent=` just sends the user through the ordinary onboarding to
 * /dashboard, and the outing they came for is never mentioned.
 */
export type OnboardingIntent = 'outing'

/** Where setup sends someone with this intent once their ledger exists. */
export const INTENT_DESTINATION: Record<OnboardingIntent, string> = {
  // `create=1` opens the new-outing sheet on arrival (OutingList).
  outing: '/outings?create=1',
}

/** Where someone who already has a ledger goes: the same place as before #1726. */
export const INTENT_EXISTING_USER_DESTINATION: Record<OnboardingIntent, string> = {
  outing: '/outings',
}

/** The sign-in `next` for /features/outing's CTA. */
export const OUTING_ONBOARDING_NEXT = '/onboarding?intent=outing'

/** Exact match against the closed set; arrays (repeated params) and anything else → null. */
export function parseOnboardingIntent(value: unknown): OnboardingIntent | null {
  return value === 'outing' ? 'outing' : null
}

/** `?intent=outing` suffix for the next onboarding hop, or '' with no intent. */
export function intentQuery(intent: OnboardingIntent | null): string {
  return intent ? `?intent=${intent}` : ''
}
