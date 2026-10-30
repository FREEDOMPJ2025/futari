/**
 * #1605 — the daily "pending card due" push goes only to current members.
 *
 * Scenario (F9): A and B shared ledger G; A removed B. B's phone still has a
 * PushTokens row on G (nothing moved it). G has a pending card due today, so
 * send-recurring-push loads G's tokens. Before the fix it sent to every token
 * on G, B's included. Failure looks like: no error anywhere; the ex keeps
 * getting 「有待確認的定期收支」 for a ledger they can no longer open.
 *
 * The filter is a real unit test (memberTokens.ts, extracted because the Deno
 * entrypoint cannot be loaded under vitest); the wiring in index.ts is
 * asserted on its source, like recurring-cron-taipei-date.test.ts does.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  tokensOfCurrentMembers,
  type TokenRow,
} from '../supabase/functions/send-recurring-push/memberTokens.ts'

const A = 'aaaaaaaa-0000-4000-8000-000000000001' // stayer
const B = 'bbbbbbbb-0000-4000-8000-000000000002' // removed ex
const C = 'cccccccc-0000-4000-8000-000000000003' // later partner
const G = '99999999-0000-4000-8000-000000000009' // ledger with a card due today

/** Just the token strings, which is what #1605's cases are about. */
const tokenStrings = (rows: TokenRow[]) => tokensOfCurrentMembers(rows).map((t) => t.token)

/** A PushTokens row as the select returns it; ids are unique per row. */
let nextId = 0
function row(token: string, user_id: string, OikosGroups: TokenRow['OikosGroups'], platform = 'apns'): TokenRow {
  nextId++
  return { id: `row-${nextId}`, platform, token, user_id, group_id: G, OikosGroups }
}

describe('tokensOfCurrentMembers (#1605)', () => {
  it('the ex\'s token on G is not sent G\'s push; the stayer\'s is', () => {
    // What the token query returns for due group G after A removed B.
    const rows: TokenRow[] = [
      row('tok-stayer', A, { member_a: A, member_b: null }),
      row('tok-ex', B, { member_a: A, member_b: null }),
    ]
    expect(tokenStrings(rows)).toEqual(['tok-stayer'])
  })

  it('after a new partner joins, the new partner is sent it and the ex still is not', () => {
    const g = { member_a: A, member_b: C }
    const rows: TokenRow[] = [
      row('tok-stayer', A, g),
      row('tok-ex', B, g),
      row('tok-new', C, g),
    ]
    expect(tokenStrings(rows).sort()).toEqual(['tok-new', 'tok-stayer'])
  })

  it('fails closed on a missing or empty embed; accepts an array-shaped embed', () => {
    const rows: TokenRow[] = [
      row('tok-null', A, null),
      row('tok-empty', A, []),
      row('tok-arr', A, [{ member_a: A, member_b: null }]),
    ]
    expect(tokenStrings(rows)).toEqual(['tok-arr'])
  })

  it('a device token registered by both members is pushed once', () => {
    const g = { member_a: A, member_b: C }
    const rows: TokenRow[] = [
      row('tok-shared', A, g),
      row('tok-shared', C, g),
    ]
    expect(tokenStrings(rows)).toEqual(['tok-shared'])
  })
})

describe('tokensOfCurrentMembers carries platform and row ids (#968 S4b)', () => {
  const g = { member_a: A, member_b: C }

  it('routes a mixed APNs / FCM ledger by platform, still members-only', () => {
    const rows: TokenRow[] = [
      row('apns-a', A, g, 'apns'),
      row('fcm-c', C, g, 'fcm'),
      row('fcm-ex', B, g, 'fcm'),
    ]
    const targets = tokensOfCurrentMembers(rows)
    expect(targets.map((t) => [t.platform, t.token]).sort()).toEqual([
      ['apns', 'apns-a'],
      ['fcm', 'fcm-c'],
    ])
  })

  it('the same token string on two platforms is two targets, not one', () => {
    // De-duplicating on token alone would drop one platform's push and, worse,
    // could send an APNs payload to an FCM endpoint or the reverse.
    const apns = row('same-string', A, g, 'apns')
    const fcm = row('same-string', A, g, 'fcm')
    const targets = tokensOfCurrentMembers([apns, fcm])
    expect(targets).toHaveLength(2)
    expect(targets.find((t) => t.platform === 'apns')!.ids).toEqual([apns.id])
    expect(targets.find((t) => t.platform === 'fcm')!.ids).toEqual([fcm.id])
  })

  it('one device registered by both members is one push that owns both row ids', () => {
    const a = row('fcm-shared', A, g, 'fcm')
    const c = row('fcm-shared', C, g, 'fcm')
    expect(tokensOfCurrentMembers([a, c])).toEqual([
      { platform: 'fcm', token: 'fcm-shared', ids: [a.id, c.id] },
    ])
  })

  it('an ex\'s row never contributes an id (so a stale delete cannot reach it)', () => {
    const a = row('fcm-shared', A, g, 'fcm')
    const ex = row('fcm-shared', B, g, 'fcm')
    expect(tokensOfCurrentMembers([a, ex])).toEqual([
      { platform: 'fcm', token: 'fcm-shared', ids: [a.id] },
    ])
  })

  it('skips an unknown platform (fail closed)', () => {
    expect(tokensOfCurrentMembers([row('tok-web', A, g, 'webpush')])).toEqual([])
  })
})

describe('send-recurring-push wiring (#1605)', () => {
  const src = readFileSync(
    join(process.cwd(), 'supabase/functions/send-recurring-push/index.ts'),
    'utf8',
  )

  it('loads each token with its group\'s members over the group_id FK', () => {
    expect(src).toContain(
      "select('id, platform, token, user_id, group_id, OikosGroups!inner(member_a, member_b)')",
    )
  })

  it('sends only what the member filter returns', () => {
    expect(src).toContain('tokensOfCurrentMembers(')
    // The old group-only select must not come back.
    expect(src).not.toMatch(/\.select\('token'\)/)
  })

  it('loads both platforms (#968 S4b): no platform filter on the token query', () => {
    // #1827 — the query now sits inside a keyset-paging callback; the slice
    // runs from it to the point where its rows are used.
    const start = src.indexOf(".from('PushTokens')\n        .select(")
    const end = src.indexOf('if (tokenErr)')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(src.slice(start, end)).not.toContain(".eq('platform'")
  })
})
