/**
 * Which push tokens may be sent a ledger's "pending card due" push (#1605).
 *
 * A PushTokens row says "user U's device, registered while U was in ledger G".
 * Nothing used to move or delete that row when U left G (leaveGroup), was
 * removed from it (removePartner), or joined another ledger (acceptInvite), and
 * the sender matched tokens by `group_id` only. So a removed ex kept getting
 * G's daily push about the stayer's recurring cards. Failure looks like:
 * nothing errors; the ex's phone says 「有待確認的定期收支」 for a ledger they
 * can no longer open.
 *
 * This is the authoritative check, done at send time: a token is sent only
 * when its owner is a current `member_a` / `member_b` of the token's group.
 * It needs only the existing `group_id` FK (the PostgREST embed in index.ts),
 * not migration 0087 — 0087 stops new bad rows; this stops sending to old ones.
 *
 * Lives in its own module (imported by index.ts) because the Deno entrypoint
 * cannot be loaded under vitest; tests/push-member-tokens-1605.test.ts runs it.
 */

export interface GroupMembers {
  member_a: string | null
  member_b: string | null
}

export type PushPlatform = 'apns' | 'fcm'

export interface TokenRow {
  id: string
  platform: string
  token: string
  user_id: string
  group_id: string
  // PostgREST returns a to-one embed as an object; tolerate an array (or a
  // missing embed) so a shape change fails closed instead of sending to all.
  OikosGroups: GroupMembers | GroupMembers[] | null
}

/**
 * One device to push to. `ids` are every PushTokens row that resolved to this
 * (platform, token) — the same device registered by both members is two rows
 * (UNIQUE is per user) but one push. A stale-token delete removes exactly
 * these rows by id, never "every row with this token string" (#968 S4b).
 */
export interface PushTarget {
  platform: PushPlatform
  token: string
  ids: string[]
}

function isPushPlatform(p: string): p is PushPlatform {
  return p === 'apns' || p === 'fcm'
}

/**
 * Push targets whose owner is a current member of the token's group,
 * de-duplicated on (platform, token) — not on token alone: an APNs and an FCM
 * token are different devices even if the strings were ever equal, and
 * merging them would send one platform's push to the other's endpoint.
 * A row with an unknown platform is skipped (fail closed).
 */
export function tokensOfCurrentMembers(rows: readonly TokenRow[]): PushTarget[] {
  const out = new Map<string, PushTarget>()
  for (const row of rows) {
    const embed = Array.isArray(row.OikosGroups) ? row.OikosGroups[0] : row.OikosGroups
    if (!embed || !row.user_id) continue
    if (!isPushPlatform(row.platform) || !row.token || !row.id) continue
    if (row.user_id !== embed.member_a && row.user_id !== embed.member_b) continue
    const key = `${row.platform}\u0000${row.token}`
    const existing = out.get(key)
    if (existing) {
      if (!existing.ids.includes(row.id)) existing.ids.push(row.id)
    } else {
      out.set(key, { platform: row.platform, token: row.token, ids: [row.id] })
    }
  }
  return [...out.values()]
}
