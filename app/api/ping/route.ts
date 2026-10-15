// #1674 — the web offline page's probe ("is the site reachable again?").
//
// Public and exact: proxy.ts lets `/api/ping` through before any getUser(), so
// it answers while the session is dead or Supabase is down. No auth, no DB, no
// body. The page counts only `204 && !redirected` as "back": a redirect to
// sign-in or a captive portal's 200 would otherwise reload the user into a
// page that isn't there.

export const dynamic = 'force-dynamic'

const HEADERS = { 'Cache-Control': 'no-store, max-age=0' }

export function GET(): Response {
  return new Response(null, { status: 204, headers: HEADERS })
}

export function HEAD(): Response {
  return new Response(null, { status: 204, headers: HEADERS })
}
