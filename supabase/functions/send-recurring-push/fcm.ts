/**
 * FCM HTTP v1 request building for send-recurring-push (#968 S4b).
 *
 * Everything here is pure (WebCrypto and plain objects, no Deno APIs, no URL
 * imports) so vitest can run it: tests/push-fcm-968.test.ts. The network calls
 * and the djwt signing live in index.ts.
 *
 * Credentials: the service account futari-fcm-sender@oikos-pj (role
 * firebasecloudmessaging.admin only) is split into three function secrets —
 * FCM_CLIENT_EMAIL, FCM_PRIVATE_KEY_PEM, FCM_PRIVATE_KEY_ID. The project id
 * and token URI are not secret and are fixed here, so a secret can never
 * point the function at another project or token endpoint. Rotation steps are
 * in docs/superpowers/ops-runbook.md.
 */
import { pkcs8DerFromPem } from './pem.ts'

export const FCM_PROJECT_ID = 'oikos-pj'
export const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token'
export const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
export const FCM_SEND_URL = `https://fcm.googleapis.com/v1/projects/${FCM_PROJECT_ID}/messages:send`
export const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer'
/** Lifetime of the signed assertion; Google rejects more than one hour. */
export const ASSERTION_TTL_SECONDS = 3600
/** Per-request timeout for the OAuth exchange and each FCM send. */
export const FCM_FETCH_TIMEOUT_MS = 10_000

export interface FcmConfig {
  clientEmail: string
  privateKeyPem: string
  privateKeyId: string
}

/**
 * Reads the three FCM secrets through `get` (Deno.env.get in index.ts).
 * Returns null when any is missing or blank; index.ts then skips the FCM
 * branch with one log line and APNs is unaffected.
 *
 * Failure looks like: Android users silently stop getting the nightly push
 * and the function log shows `[fcm] secrets missing` once per run.
 */
export function readFcmConfig(get: (name: string) => string | undefined): FcmConfig | null {
  const clientEmail = get('FCM_CLIENT_EMAIL')?.trim()
  const privateKeyPem = get('FCM_PRIVATE_KEY_PEM')
  const privateKeyId = get('FCM_PRIVATE_KEY_ID')?.trim()
  if (!clientEmail || !privateKeyPem?.trim() || !privateKeyId) return null
  return { clientEmail, privateKeyPem, privateKeyId }
}

/** JOSE header of the OAuth assertion: RS256, `kid` = the service-account key id. */
export function fcmAssertionHeader(privateKeyId: string) {
  return { alg: 'RS256' as const, typ: 'JWT' as const, kid: privateKeyId }
}

/** Claims of the OAuth assertion (Google "service account JWT bearer" flow). */
export function fcmAssertionClaims(clientEmail: string, nowSeconds: number) {
  return {
    iss: clientEmail,
    scope: FCM_SCOPE,
    aud: GOOGLE_TOKEN_URI,
    iat: nowSeconds,
    exp: nowSeconds + ASSERTION_TTL_SECONDS,
  }
}

/** The signing key: PKCS#8 RSA, RS256, non-extractable, sign only. */
export function importFcmSigningKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'pkcs8',
    pkcs8DerFromPem(pem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
}

/** Form body for the token exchange. */
export function oauthTokenRequestBody(assertion: string): URLSearchParams {
  return new URLSearchParams({ grant_type: JWT_BEARER_GRANT, assertion })
}

/** The access token from a token-endpoint response, or null if it is not a non-empty string. */
export function accessTokenFrom(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null
  const t = (json as { access_token?: unknown }).access_token
  return typeof t === 'string' && t.length > 0 ? t : null
}

/**
 * The FCM message. Same fixed title/body as the APNs push and no `data`
 * payload: nothing about the ledger leaves the server (security-review F13).
 */
export function fcmMessage(token: string, title: string, body: string) {
  return { message: { token, notification: { title, body } } }
}
