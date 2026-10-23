import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.105.1'
import { create, getNumericDate } from 'https://deno.land/x/djwt@v3.0.2/mod.ts'
import { taipeiDateISO } from './taipeiDate.ts'
import { tokensOfCurrentMembers, type PushTarget, type TokenRow } from './memberTokens.ts'
import { checkServiceRoleJwt, projectRefFromUrl } from './callerAuth.ts'
import { pkcs8DerFromPem } from './pem.ts'
import {
  FCM_FETCH_TIMEOUT_MS,
  FCM_SEND_URL,
  GOOGLE_TOKEN_URI,
  accessTokenFrom,
  fcmAssertionClaims,
  fcmAssertionHeader,
  fcmMessage,
  importFcmSigningKey,
  oauthTokenRequestBody,
  readFcmConfig,
} from './fcm.ts'
import {
  apnsFailureLog,
  decideFcmDeletes,
  fcmFailureLog,
  isStaleApnsStatus,
  oauthFailureLog,
  type FcmSendResult,
} from './staleTokens.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
// null (custom domain, unset) makes every call fail closed: reason=no_ref_config.
const PROJECT_REF = projectRefFromUrl(SUPABASE_URL)
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const APNS_KEY_ID = Deno.env.get('APNS_KEY_ID')!
const APNS_TEAM_ID = Deno.env.get('APNS_TEAM_ID')!
const APNS_PRIVATE_KEY_PEM = Deno.env.get('APNS_PRIVATE_KEY_PEM')!
const APNS_BUNDLE_ID = 'dev.southernlight.futari'
const APNS_HOST = 'https://api.push.apple.com'

const PUSH_TITLE = '有待確認的定期收支'
const PUSH_BODY = '點開 Futari 確認本期帳目'

async function importApnsKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'pkcs8',
    pkcs8DerFromPem(pem),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  )
}

async function buildApnsJwt(key: CryptoKey): Promise<string> {
  return create(
    { alg: 'ES256', kid: APNS_KEY_ID },
    { iss: APNS_TEAM_ID, iat: getNumericDate(0) },
    key
  )
}

async function sendApnsNotification(
  jwt: string,
  token: string,
  title: string,
  body: string
): Promise<number> {
  const payload = JSON.stringify({
    aps: {
      alert: { title, body },
      sound: 'default',
      badge: 1,
    },
  })

  const res = await fetch(`${APNS_HOST}/3/device/${token}`, {
    method: 'POST',
    headers: {
      authorization: `bearer ${jwt}`,
      'apns-topic': APNS_BUNDLE_ID,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
    },
    body: payload,
  })

  if (!res.ok) {
    console.error(apnsFailureLog(token, res.status, await res.text()))
  }
  return res.status
}

interface BranchResult {
  sent: number
}

async function deleteStaleRows(
  supabase: SupabaseClient,
  platform: 'apns' | 'fcm',
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return
  // Scoped by row id AND platform — never by token string alone (#968 S4b):
  // a string match could reach another user's or another platform's row.
  const { error } = await supabase
    .from('PushTokens')
    .delete()
    .eq('platform', platform)
    .in('id', ids)
  if (error) console.error(`[push] stale ${platform} delete failed code=${error.code ?? 'none'}`)
}

async function sendApnsBranch(supabase: SupabaseClient, targets: PushTarget[]): Promise<BranchResult> {
  if (targets.length === 0) return { sent: 0 }
  const key = await importApnsKey(APNS_PRIVATE_KEY_PEM)
  const jwt = await buildApnsJwt(key)

  const staleIds: string[] = []
  let sent = 0
  for (const { token, ids } of targets) {
    const status = await sendApnsNotification(jwt, token, PUSH_TITLE, PUSH_BODY)
    if (status >= 200 && status < 300) sent++
    if (isStaleApnsStatus(status)) staleIds.push(...ids)
  }

  await deleteStaleRows(supabase, 'apns', staleIds)
  return { sent }
}

/**
 * One OAuth access token per invocation, held only in this call's memory —
 * never stored, never logged. Returns null (after logging only the status and
 * the OAuth `error` field) when the exchange fails.
 */
async function fetchFcmAccessToken(): Promise<string | null> {
  const cfg = readFcmConfig((name) => Deno.env.get(name))
  if (!cfg) {
    console.error('[fcm] secrets missing; skipping FCM sends')
    return null
  }
  const key = await importFcmSigningKey(cfg.privateKeyPem)
  const assertion = await create(
    fcmAssertionHeader(cfg.privateKeyId),
    fcmAssertionClaims(cfg.clientEmail, getNumericDate(0)),
    key,
  )
  const res = await fetch(GOOGLE_TOKEN_URI, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: oauthTokenRequestBody(assertion),
    signal: AbortSignal.timeout(FCM_FETCH_TIMEOUT_MS),
  })
  const json: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    console.error(oauthFailureLog(res.status, json))
    return null
  }
  const token = accessTokenFrom(json)
  if (!token) console.error(`[fcm] oauth failed status=${res.status} error=no_access_token`)
  return token
}

async function sendFcmOne(
  accessToken: string,
  token: string,
): Promise<Pick<FcmSendResult, 'httpStatus' | 'body'>> {
  try {
    const res = await fetch(FCM_SEND_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(fcmMessage(token, PUSH_TITLE, PUSH_BODY)),
      signal: AbortSignal.timeout(FCM_FETCH_TIMEOUT_MS),
    })
    if (res.ok) {
      await res.body?.cancel()
      return { httpStatus: res.status, body: null }
    }
    const body: unknown = await res.json().catch(() => null)
    console.error(fcmFailureLog(token, res.status, body))
    return { httpStatus: res.status, body }
  } catch {
    // Network error or timeout: says nothing about the token, so never a delete.
    console.error(fcmFailureLog(token, null, null))
    return { httpStatus: null, body: null }
  }
}

async function sendFcmBranch(supabase: SupabaseClient, targets: PushTarget[]): Promise<BranchResult> {
  if (targets.length === 0) return { sent: 0 }
  const accessToken = await fetchFcmAccessToken()
  if (!accessToken) return { sent: 0 }

  const results: FcmSendResult[] = []
  let sent = 0
  for (const { token, ids } of targets) {
    const r = await sendFcmOne(accessToken, token)
    if (r.httpStatus !== null && r.httpStatus >= 200 && r.httpStatus < 300) sent++
    results.push({ ids, ...r })
  }

  const decision = decideFcmDeletes(results)
  if (decision.breakerTripped) {
    console.error(
      `[fcm] stale-delete breaker tripped: ${decision.badRequests}/${decision.responded} sends returned 400; deleting no FCM tokens this run`,
    )
  }
  await deleteStaleRows(supabase, 'fcm', decision.deleteIds)
  return { sent }
}

/** Runs one platform's branch so that its failure cannot stop the other's. */
async function isolated(name: 'apns' | 'fcm', run: () => Promise<BranchResult>): Promise<BranchResult> {
  try {
    return await run()
  } catch (e) {
    // Only the error's name: messages from crypto / fetch failures can echo
    // request details.
    console.error(`[${name}] branch failed: ${e instanceof Error ? e.name : 'unknown'}`)
    return { sent: 0 }
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })

  // #968 S4b (F8) — only the notify-recurring-push cron, which sends the
  // legacy service_role JWT from Vault. The gateway (verify_jwt = true in
  // supabase/config.toml) has verified its signature; this checks the claims.
  // Checked before any DB work or secret read. Log only the reason, never
  // anything taken from the header.
  const caller = checkServiceRoleJwt(req.headers.get('authorization'), PROJECT_REF, Math.floor(Date.now() / 1000))
  if (!caller.ok) {
    console.warn(`[auth] reject reason=${caller.reason}`)
    return new Response('unauthorized', { status: 401 })
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  // Taipei wall-clock, not UTC (#1262). This runs at 00:10 Asia/Taipei; a UTC
  // date here is the previous day and misses the pendings the generators
  // created at 00:00, so the push would announce them a day late.
  const today = taipeiDateISO()

  const { data: groups, error: groupsErr } = await supabase
    .from('PendingExpenseOccurrences')
    .select('group_id')
    .lte('proposed_date', today)
    .is('skipped_at', null)
    .is('resolved_tx_id', null)

  if (groupsErr) {
    console.error('[push] query error', groupsErr)
    return new Response('error', { status: 500 })
  }

  const { data: incomeGroups } = await supabase
    .from('PendingIncomeOccurrences')
    .select('group_id')
    .lte('proposed_date', today)
    .is('skipped_at', null)
    .is('resolved_tx_id', null)

  const allGroupIds = [
    ...new Set([
      ...(groups ?? []).map(r => r.group_id),
      ...(incomeGroups ?? []).map(r => r.group_id),
    ])
  ]

  if (allGroupIds.length === 0) {
    return new Response(JSON.stringify({ sent: 0 }), { status: 200 })
  }

  // #1605 — only tokens whose owner is still a member of the token's group.
  // The embed rides the existing group_id FK; the filter is in memberTokens.ts.
  // #968 — both platforms; each target carries its platform and row ids.
  const { data: tokenRows, error: tokenErr } = await supabase
    .from('PushTokens')
    .select('id, platform, token, user_id, group_id, OikosGroups!inner(member_a, member_b)')
    .in('group_id', allGroupIds)

  if (tokenErr) console.error('[push] token query error', tokenErr)
  const targets = tokensOfCurrentMembers((tokenRows ?? []) as TokenRow[])

  if (tokenErr || !targets.length) {
    return new Response(JSON.stringify({ sent: 0 }), { status: 200 })
  }

  // Each branch is wrapped: an FCM secret / OAuth / network failure cannot
  // stop the APNs sends, and an APNs failure cannot stop FCM.
  const apns = await isolated('apns', () =>
    sendApnsBranch(supabase, targets.filter((t) => t.platform === 'apns')))
  const fcm = await isolated('fcm', () =>
    sendFcmBranch(supabase, targets.filter((t) => t.platform === 'fcm')))

  return new Response(JSON.stringify({ sent: apns.sent + fcm.sent }), { status: 200 })
})
