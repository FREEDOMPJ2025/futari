/**
 * PEM text → PKCS#8 DER bytes, shared by the APNs (ES256) and FCM (RS256) keys.
 *
 * The armour lines are stripped with a generic pattern on purpose: the repo's
 * secret guard fails on any tracked line that spells out a private-key armour
 * header, and this file must not trip it.
 *
 * Pure (no Deno APIs) so vitest can run it: tests/push-fcm-968.test.ts.
 */

const PEM_ARMOUR = /-----(BEGIN|END) [A-Z ]+-----/g

/**
 * A key pasted from a service-account JSON keeps the JSON escape `\n` as two
 * literal characters. Turn those back into newlines; a PEM that already has
 * real newlines is unchanged.
 *
 * Failure looks like (if this were skipped): the base64 body contains stray
 * `\` and `n` characters, `atob` throws, and the whole FCM branch logs
 * `[fcm] branch failed` every night while APNs keeps working.
 */
export function normalizePemNewlines(pem: string): string {
  return pem.replace(/\\n/g, '\n')
}

export function pkcs8DerFromPem(pem: string): Uint8Array<ArrayBuffer> {
  const body = normalizePemNewlines(pem).replace(PEM_ARMOUR, '').replace(/\s/g, '')
  const bin = atob(body)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
