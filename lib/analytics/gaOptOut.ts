/**
 * Keep the owner's own testing out of GA without an IP rule (the home line is
 * a dynamic HiNet IP, and an IP rule would also drop the couple's real usage).
 *
 * - Automated browsers (Playwright, WebDriver) report `navigator.webdriver`
 *   and never send.
 * - A person's browser opts out once with `?ga_optout=1` on any prod page,
 *   stored in localStorage; `?ga_optout=0` opts back in.
 *
 * Client-only: reads `navigator` and localStorage, so call it from an effect,
 * never during render (the server HTML must not depend on it).
 *
 * What failure looks like: nothing errors. Too narrow, and test hits keep
 * showing up in GA; too broad, and real visitors' GA traffic and Ko-fi
 * attribution quietly drop. `tests/google-analytics-gate.test.tsx` covers both.
 */
export const GA_OPT_OUT_PARAM = 'ga_optout'
export const GA_OPT_OUT_KEY = 'futari_ga_optout'

export function isGaOptedOut(optOutParam: string | null): boolean {
  try {
    if (optOutParam === '1') window.localStorage.setItem(GA_OPT_OUT_KEY, '1')
    else if (optOutParam === '0') window.localStorage.removeItem(GA_OPT_OUT_KEY)
  } catch {
    // Storage blocked (private mode, locked-down WebView): fall through.
  }
  if (optOutParam === '1') return true
  if (navigator.webdriver === true) return true
  try {
    return window.localStorage.getItem(GA_OPT_OUT_KEY) === '1'
  } catch {
    return false
  }
}
