/**
 * #1827 S3 — a refused PushTokens upsert is reported, by its code only.
 *
 * Since 0101 the database refuses a token of the wrong shape (23514), and
 * since 0087 a ledger the user is not in (42501). supabase-js hands that back
 * as `{ error }`; it used to be dropped. Failure looks like: a phone never
 * gets a push and nothing anywhere says why. The report must never carry the
 * token: a CHECK violation's `details` reads "Failing row contains (…)" with
 * the token in it, and the message can quote it too.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const TOKEN = 'ABCDEF0123456789'.repeat(4)
const report = vi.fn()
let upsertResult: { error: unknown; status?: number } = { error: null }
const listeners: Record<string, (e: unknown) => unknown> = {}

vi.mock('@/lib/observability/reportClientError', () => ({ reportClientError: report }))
vi.mock('@capacitor/push-notifications', () => ({
  PushNotifications: {
    requestPermissions: async () => ({ receive: 'granted' }),
    register: async () => {},
    addListener: (n: string, cb: (e: unknown) => unknown) => { listeners[n] = cb },
  },
}))
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' } }))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ from: () => ({ upsert: async () => upsertResult }) }),
}))
vi.mock('@/lib/pushTokenStorage', () => ({ storePushToken: vi.fn() }))

const { registerPushToken } = await import('@/lib/pushNotifications')

async function registerWith(error: unknown, status = 400) {
  upsertResult = { error, status }
  await registerPushToken('u', 'g')
  await listeners.registration({ value: TOKEN })
}

beforeEach(() => { report.mockClear() })

describe('#1827 PushTokens upsert failure report', () => {
  it('a CHECK violation is reported with code 23514 and nothing from the row', async () => {
    await registerWith({
      code: '23514',
      message: 'new row for relation "PushTokens" violates check constraint "push_tokens_token_format"',
      details: `Failing row contains (id, user, group, apns, ${TOKEN}, now, now).`,
      hint: null,
    })
    expect(report).toHaveBeenCalledOnce()
    const [err, tags] = report.mock.calls[0]
    expect((err as Error).message).toBe('push token upsert failed code=23514')
    expect(tags).toEqual({ area: 'push', op: 'token_upsert' })
    expect(JSON.stringify(report.mock.calls) + (err as Error).message + String((err as Error).stack)).not.toContain(TOKEN)
  })

  it('a membership refusal (0087) is reported as 42501', async () => {
    await registerWith({ code: '42501', message: 'new row violates row-level security policy', details: null, hint: null })
    expect((report.mock.calls[0][0] as Error).message).toBe('push token upsert failed code=42501')
  })

  it('a code that is not a short identifier is reported as other', async () => {
    await registerWith({ code: `x ${TOKEN}`, message: '' })
    expect((report.mock.calls[0][0] as Error).message).toBe('push token upsert failed code=other status=400')
    await registerWith({ message: 'no code at all' }, 502)
    expect((report.mock.calls[1][0] as Error).message).toBe('push token upsert failed code=other status=502')
  })

  // #1883 — postgrest-js turns a fetch that never reached the server into
  // { code: '', message: 'TypeError: Load failed' } with status 0.
  it('a request that never reached the server is reported as network', async () => {
    await registerWith({ code: '', message: 'TypeError: Load failed', details: 'stack', hint: '' }, 0)
    const [err] = report.mock.calls[0]
    expect((err as Error).message).toBe('push token upsert failed code=network')
    expect(JSON.stringify(report.mock.calls)).not.toContain('Load failed')
  })

  it('a missing status is reported as unknown, never as network', async () => {
    upsertResult = { error: { code: '' } }
    await registerPushToken('u', 'g')
    await listeners.registration({ value: TOKEN })
    expect((report.mock.calls[0][0] as Error).message).toBe('push token upsert failed code=other status=unknown')
  })

  it('a successful upsert reports nothing', async () => {
    await registerWith(null)
    expect(report).not.toHaveBeenCalled()
  })
})
