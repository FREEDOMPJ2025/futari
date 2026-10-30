import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.105.1'
import { create, getNumericDate } from 'https://deno.land/x/djwt@v3.0.2/mod.ts'
import { taipeiDateISO } from './taipeiDate.ts'
import { tokensOfCurrentMembers, type PushTarget, type TokenRow } from './memberTokens.ts'
import { planSends, type RowOwner } from './sendPlan.ts'
import { APNS_FETCH_TIMEOUT_MS, RUN_DEADLINE_MS, SEND_CONCURRENCY, runWithDeadline } from './sendPool.ts'
import { GROUP_ID_CHUNK, PAGE_SIZE, chunks, keysetPages } from './keysetPages.ts'
import { checkCronApiKey, secretKeyNamed } from './callerAuth.ts'
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
  safeCode,
  type FcmSendResult,
} from './staleTokens.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
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

/** The APNs status, or null when the request threw (network error or timeout). */
async function sendApnsNotification(
  jwt: string,
  token: string,
  title: string,
  body: string
): Promise<number | null> {
  const payload = JSON.stringify({
    aps: {
      alert: { title, body },
      sound: 'default',
      badge: 1,
    },
  })

  try {
    // #1827 — bounded like each FCM send: one hanging connection used to hold
    // the whole (then sequential) run past the function's wall-clock limit.
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
      signal: AbortSignal.timeout(APNS_FETCH_TIMEOUT_MS),
    })
    if (res.ok) {
      await res.body?.cancel()
    } else {
      console.error(apnsFailureLog(token, res.status, await res.text()))
    }
    return res.status
  } catch {
    // Network error or timeout: says nothing about the token, so never a delete.
    console.error(apnsFailureLog(token, null, ''))
    return null
  }
}

interface BranchResult {
  sent: number
  skippedByDeadline: number
}

const NOTHING_SENT: BranchResult = { sent: 0, skippedByDeadline: 0 }

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

async function sendApnsBranch(
  supabase: SupabaseClient,
  targets: PushTarget[],
  deadlineAt: number,
): Promise<BranchResult> {
  if (targets.length === 0) return NOTHING_SENT
  const key = await importApnsKey(APNS_PRIVATE_KEY_PEM)
  const jwt = await buildApnsJwt(key)

  // #1827 — SEND_CONCURRENCY at a time; nothing new starts after the deadline,
  // and the stale delete below always runs for what did complete.
  const run = await runWithDeadline(
    targets,
    { concurrency: SEND_CONCURRENCY, deadlineAt },
    async ({ token, ids }) => ({ ids, status: await sendApnsNotification(jwt, token, PUSH_TITLE, PUSH_BODY) }),
  )
  const staleIds: string[] = []
  let sent = 0
  for (const { ids, status } of run.results) {
    if (status !== null && status >= 200 && status < 300) sent++
    if (status !== null && isStaleApnsStatus(status)) staleIds.push(...ids)
  }

  await deleteStaleRows(supabase, 'apns', staleIds)
  return { sent, skippedByDeadline: run.skippedByDeadline }
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

async function sendFcmBranch(
  supabase: SupabaseClient,
  targets: PushTarget[],
  deadlineAt: number,
): Promise<BranchResult> {
  if (targets.length === 0) return NOTHING_SENT
  const accessToken = await fetchFcmAccessToken()
  if (!accessToken) return NOTHING_SENT

  // #1827 — same pool and deadline as APNs. The breaker below still counts
  // only sends that got an HTTP response, now among those that completed.
  const run = await runWithDeadline(
    targets,
    { concurrency: SEND_CONCURRENCY, deadlineAt },
    async ({ token, ids }): Promise<FcmSendResult> => ({ ids, ...(await sendFcmOne(accessToken, token)) }),
  )
  const results: FcmSendResult[] = run.results
  let sent = 0
  for (const r of results) {
    if (r.httpStatus !== null && r.httpStatus >= 200 && r.httpStatus < 300) sent++
  }

  const decision = decideFcmDeletes(results)
  if (decision.breakerTripped) {
    console.error(
      `[fcm] stale-delete breaker tripped: ${decision.badRequests}/${decision.responded} sends returned 400; deleting no FCM tokens this run`,
    )
  }
  await deleteStaleRows(supabase, 'fcm', decision.deleteIds)
  return { sent, skippedByDeadline: run.skippedByDeadline }
}

/** Runs one platform's branch so that its failure cannot stop the other's. */
async function isolated(name: 'apns' | 'fcm', run: () => Promise<BranchResult>): Promise<BranchResult> {
  try {
    return await run()
  } catch (e) {
    // Only the error's name: messages from crypto / fetch failures can echo
    // request details.
    console.error(`[${name}] branch failed: ${e instanceof Error ? e.name : 'unknown'}`)
    return NOTHING_SENT
  }
}

/**
 * The run's one summary line and the cron's 200 (#1827). Counts only — never a
 * token, user or ledger id. skipped_by_cap: targets planSends left out
 * (per-user / per-ledger / per-run caps); skipped_by_deadline: planned targets
 * never started because RUN_DEADLINE_MS had passed.
 */
function finish(sent: number, skippedByCap: number, skippedByDeadline: number): Response {
  console.log(`[push] summary sent=${sent} skipped_by_cap=${skippedByCap} skipped_by_deadline=${skippedByDeadline}`)
  return new Response(
    JSON.stringify({ sent, skipped_by_cap: skippedByCap, skipped_by_deadline: skippedByDeadline }),
    { status: 200 },
  )
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })

  // #1834 — only the notify-recurring-push cron, which sends the named secret
  // key `cron` as `apikey` (from Vault). verify_jwt = false in
  // supabase/config.toml, so this is the ONLY check: it runs before any DB work
  // or other secret read, and fails closed. SUPABASE_SECRET_KEYS is read per
  // request, never at module scope. Log only the reason, never anything taken
  // from the header or the env.
  const secretKeys = Deno.env.get('SUPABASE_SECRET_KEYS')
  const caller = checkCronApiKey(req.headers.get('apikey'), secretKeys)
  if (!caller.ok) {
    console.warn(`[auth] reject reason=${caller.reason}`)
    return new Response('unauthorized', { status: 401 })
  }

  // The DB client uses the project's `default` secret key (#1834 F3), not
  // SUPABASE_SERVICE_ROLE_KEY: Supabase's docs call that variable the legacy
  // key (on dev it measured as an sb_ key), and what it holds once the legacy
  // keys are retired at the end of 2026 is not documented. Failure looks like:
  // cron gets 500, the function logs `[push] no default secret key`.
  const dbKey = secretKeyNamed(secretKeys, 'default')
  if (!dbKey) {
    console.error('[push] no default secret key; cannot query')
    return new Response('error', { status: 500 })
  }
  const supabase = createClient(SUPABASE_URL, dbKey)

  // Taipei wall-clock, not UTC (#1262). This runs at 00:10 Asia/Taipei; a UTC
  // date here is the previous day and misses the pendings the generators
  // created at 00:00, so the push would announce them a day late.
  const today = taipeiDateISO()

  // #1827 — the deadline counts from here, so slow reads leave less time to
  // send rather than pushing the run past the function's wall-clock limit.
  const deadlineAt = Date.now() + RUN_DEADLINE_MS

  // #1827 (F-F) — every due ledger, read in keyset pages (keysetPages.ts): a
  // single select stops silently at the project's max rows. Paged by
  // group_id, so each page moves to new ledgers; only the distinct ids count.
  const dueGroups = async (table: 'PendingExpenseOccurrences' | 'PendingIncomeOccurrences') =>
    keysetPages<{ group_id: string }>((after) => {
      const q = supabase
        .from(table)
        .select('group_id')
        .lte('proposed_date', today)
        .is('skipped_at', null)
        .is('resolved_tx_id', null)
        .order('group_id')
        .limit(PAGE_SIZE)
      return after === null ? q : q.gt('group_id', after)
    }, (r) => r.group_id)

  const expense = await dueGroups('PendingExpenseOccurrences')
  if (expense.errorCode) {
    console.error(`[push] query error code=${safeCode(expense.errorCode)}`)
    return new Response('error', { status: 500 })
  }
  // As before #1827, an income read failure does not stop the expense pushes.
  const income = await dueGroups('PendingIncomeOccurrences')
  if (income.errorCode) console.error(`[push] income query error code=${safeCode(income.errorCode)}`)

  const allGroupIds = [
    ...new Set([
      ...expense.rows.map(r => r.group_id),
      ...income.rows.map(r => r.group_id),
    ])
  ].sort()

  if (allGroupIds.length === 0) return finish(0, 0, 0)

  // #1605 — only tokens whose owner is still a member of the token's group.
  // The embed rides the existing group_id FK; the filter is in memberTokens.ts.
  // #968 — both platforms; each target carries its platform and row ids.
  // #1827 — GROUP_ID_CHUNK ledgers per request, each read in keyset pages by
  // row id, so no ledger's tokens are cut off at max rows.
  const tokenRows: TokenRow[] = []
  let tokenErr: string | null = null
  for (const chunk of chunks(allGroupIds, GROUP_ID_CHUNK)) {
    const page = await keysetPages<TokenRow>((after) => {
      const q = supabase
        .from('PushTokens')
        .select('id, platform, token, user_id, group_id, OikosGroups!inner(member_a, member_b)')
        .in('group_id', chunk)
        .order('id')
        .limit(PAGE_SIZE)
      return after === null ? q : q.gt('id', after)
    }, (r) => r.id)
    tokenRows.push(...page.rows)
    if (page.errorCode) {
      tokenErr = page.errorCode
      break
    }
  }

  if (tokenErr) console.error(`[push] token query error code=${safeCode(tokenErr)}`)
  const targets = tokensOfCurrentMembers(tokenRows)

  if (tokenErr || !targets.length) return finish(0, 0, 0)

  // #1827 — fair order and caps (sendPlan.ts): round-robin across ledgers and
  // their users; at most PER_USER / PER_LEDGER / PER_RUN sends.
  const owners = new Map<string, RowOwner>(
    tokenRows.map((r) => [r.id, { userId: r.user_id, groupId: r.group_id }]),
  )
  const plan = planSends(targets, owners)

  // Each branch is wrapped: an FCM secret / OAuth / network failure cannot
  // stop the APNs sends, and an APNs failure cannot stop FCM. #1827 — the two
  // run side by side, each with its own pool, against the same deadline.
  const [apns, fcm] = await Promise.all([
    isolated('apns', () =>
      sendApnsBranch(supabase, plan.targets.filter((t) => t.platform === 'apns'), deadlineAt)),
    isolated('fcm', () =>
      sendFcmBranch(supabase, plan.targets.filter((t) => t.platform === 'fcm'), deadlineAt)),
  ])

  return finish(apns.sent + fcm.sent, plan.skippedByCap, apns.skippedByDeadline + fcm.skippedByDeadline)
})
