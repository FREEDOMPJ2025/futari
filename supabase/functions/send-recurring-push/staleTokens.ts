/**
 * Which push tokens to delete after a send, and what a failure may log
 * (#968 S4b, security-review F4 / F6).
 *
 * Pure (no Deno APIs) so vitest can run it: tests/push-fcm-968.test.ts.
 *
 * ## FCM: the delete rule
 *
 * Firebase's token-management guide ("Detect invalid token responses from the
 * FCM backend", https://firebase.google.com/docs/cloud-messaging/manage-tokens)
 * names two HTTP v1 responses that may mean the targeted token is invalid or
 * expired: `UNREGISTERED` (HTTP 404) and `INVALID_ARGUMENT` (HTTP 400), and
 * says it is safe to delete the token on either only "if you are certain that
 * the message payload is valid" — INVALID_ARGUMENT is also what a bad payload
 * returns (ErrorCode reference,
 * https://firebase.google.com/docs/reference/fcm/rest/v1/ErrorCode: "Request
 * parameters were invalid ... invalid registration, invalid package name,
 * message too big, invalid data key, invalid TTL, or other invalid
 * parameters"). So, keyed on the parsed JSON error body only:
 *
 * - delete on HTTP 404 when some `error.details[].errorCode` is `UNREGISTERED`;
 * - delete on HTTP 400 only when some `error.details[].errorCode` is
 *   `INVALID_ARGUMENT` AND some `error.details[].fieldViolations[].field` is
 *   `message.token` (the google.rpc.BadRequest detail that pins the invalid
 *   field to the registration token, not to the payload);
 * - never on 401 / 403 / 429 / 5xx / any other status / a network error or
 *   timeout / a body that does not parse — those say nothing about the token;
 * - breaker: when more than half of this run's FCM sends that got an HTTP
 *   response came back 400, delete no FCM token at all and log it. A run where
 *   most sends are "invalid" is far likelier to be our own payload or config
 *   than a mass of dead phones.
 *
 * Nothing keys on `error.message` (free text, may change, and may echo the
 * token). If Google ever drops the fieldViolations detail, 400s stop deleting
 * (the safe direction) and those tokens just keep failing with a log line.
 *
 * Failure looks like (if the rule were looser): one bad deploy of the payload
 * makes every FCM send return 400 INVALID_ARGUMENT, every Android token is
 * deleted that night, and Android users silently stop getting the push until
 * each one reopens the app — no error anywhere after that first night.
 *
 * ## APNs
 *
 * 410 (Unregistered) deletes, as before. Deletes are by PushTokens row id and
 * platform, never by token string alone.
 */

export type FcmOutcome =
  | 'ok'
  | 'unregistered' // 404 + UNREGISTERED → delete
  | 'invalid-token' // 400 + INVALID_ARGUMENT + field message.token → delete
  | 'bad-request' // any other 400 → keep, counts toward the breaker
  | 'keep' // everything else → keep

export interface FcmSendResult {
  ids: readonly string[]
  /** HTTP status, or null when the request threw (network error, timeout). */
  httpStatus: number | null
  /** Parsed JSON body of a non-2xx response, or null. */
  body: unknown
}

export interface FcmDeleteDecision {
  deleteIds: string[]
  breakerTripped: boolean
  badRequests: number
  responded: number
}

interface ParsedFcmError {
  status: unknown
  errorCodes: unknown[]
  tokenFieldViolation: boolean
}

function parseFcmError(body: unknown): ParsedFcmError {
  const err = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined
  if (!err || typeof err !== 'object') return { status: undefined, errorCodes: [], tokenFieldViolation: false }
  const e = err as { status?: unknown; details?: unknown }
  const details = Array.isArray(e.details) ? e.details : []
  const errorCodes: unknown[] = []
  let tokenFieldViolation = false
  for (const d of details) {
    if (!d || typeof d !== 'object') continue
    const detail = d as { errorCode?: unknown; fieldViolations?: unknown }
    if (detail.errorCode !== undefined) errorCodes.push(detail.errorCode)
    if (Array.isArray(detail.fieldViolations)) {
      for (const v of detail.fieldViolations) {
        if (v && typeof v === 'object' && (v as { field?: unknown }).field === 'message.token') {
          tokenFieldViolation = true
        }
      }
    }
  }
  return { status: e.status, errorCodes, tokenFieldViolation }
}

export function classifyFcmResponse(httpStatus: number | null, body: unknown): FcmOutcome {
  if (httpStatus === null) return 'keep'
  if (httpStatus >= 200 && httpStatus < 300) return 'ok'
  const parsed = parseFcmError(body)
  if (httpStatus === 404 && parsed.errorCodes.includes('UNREGISTERED')) return 'unregistered'
  if (httpStatus === 400) {
    return parsed.errorCodes.includes('INVALID_ARGUMENT') && parsed.tokenFieldViolation
      ? 'invalid-token'
      : 'bad-request'
  }
  return 'keep'
}

export function decideFcmDeletes(results: readonly FcmSendResult[]): FcmDeleteDecision {
  let responded = 0
  let badRequests = 0
  const candidates: string[] = []
  for (const r of results) {
    if (r.httpStatus === null) continue
    responded++
    if (r.httpStatus === 400) badRequests++
    const outcome = classifyFcmResponse(r.httpStatus, r.body)
    if (outcome === 'unregistered' || outcome === 'invalid-token') candidates.push(...r.ids)
  }
  const breakerTripped = responded > 0 && badRequests * 2 > responded
  return {
    deleteIds: breakerTripped ? [] : [...new Set(candidates)],
    breakerTripped,
    badRequests,
    responded,
  }
}

export function isStaleApnsStatus(status: number): boolean {
  return status === 410
}

// ─── Logging: status codes and short enum-like codes only ────────────────────
// Never the access token, the signed assertion, an Authorization header, a
// request body, or Google's / Apple's free-text `message`. Codes from a
// response body are untrusted, so anything that is not a short identifier is
// logged as `other`.

const SAFE_CODE = /^[A-Za-z0-9_.-]{1,64}$/

export function safeCode(v: unknown): string {
  if (v === undefined || v === null) return 'none'
  return typeof v === 'string' && SAFE_CODE.test(v) ? v : 'other'
}

export function tokenPrefix(token: string): string {
  return `${token.slice(0, 8)}…`
}

export function fcmFailureLog(token: string, httpStatus: number | null, body: unknown): string {
  if (httpStatus === null) return `[fcm] failed token=${tokenPrefix(token)} status=network`
  const parsed = parseFcmError(body)
  const codes = parsed.errorCodes.length ? parsed.errorCodes.map(safeCode).join(',') : 'none'
  return `[fcm] failed token=${tokenPrefix(token)} status=${httpStatus} error.status=${safeCode(parsed.status)} errorCode=${codes}`
}

export function apnsFailureLog(token: string, status: number, bodyText: string): string {
  let reason: unknown
  try {
    const j = JSON.parse(bodyText) as unknown
    reason = j && typeof j === 'object' ? (j as { reason?: unknown }).reason : undefined
  } catch {
    reason = undefined
  }
  return `[apns] failed token=${tokenPrefix(token)} status=${status} reason=${safeCode(reason)}`
}

/** From an OAuth token-endpoint error only the `error` field (e.g. invalid_grant). */
export function oauthFailureLog(httpStatus: number, body: unknown): string {
  const error = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined
  return `[fcm] oauth failed status=${httpStatus} error=${safeCode(error)}`
}
