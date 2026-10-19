import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { seedAuthUsers, deleteAuthUsers } from '../actions/_authUser'

export function loadEnvLocal() {
  const envPath = resolve(__dirname, '../../.env.local')
  if (!existsSync(envPath)) return
  for (const raw of readFileSync(envPath, 'utf-8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = val
  }
}

/**
 * auth.users rows seedGroup added in this process (one per test file: vitest
 * isolates modules per file). See deleteSeededAuthUsers.
 */
const seededAuthIds: string[] = []

/**
 * Remove the auth.users rows seedGroup added. Call it from the suite's afterAll.
 * The suites deliberately leave their groups and profiles behind (only outing
 * rows are purged). Since 0096 the orphan sweep collects a solo ledger whose
 * member has no auth row, so deleting the rows here hands those leftovers back
 * to the sweep, as they were before seedGroup created the rows. While the
 * suite runs the rows exist, so the sweep cannot take a ledger out from under
 * a test (#1710).
 */
export async function deleteSeededAuthUsers(): Promise<void> {
  await deleteAuthUsers(seededAuthIds.splice(0))
}

/**
 * Seed a fresh group with one open epoch. Returns the viewer (member_a) id,
 * the partner (member_b) id unless solo, the group id, and the open epoch id.
 * Call AFTER loadEnvLocal() and after importing db.
 */
export async function seedGroup(opts: { solo?: boolean } = {}) {
  const { db } = await import('@/lib/db/client')
  const { profiles, oikosGroups, groupEpochs, groupBalance } = await import('@/lib/db/schema')

  const userId = randomUUID()
  const partnerId = opts.solo ? null : randomUUID()
  await db.insert(profiles).values({ id: userId, displayName: '我' })
  if (partnerId) await db.insert(profiles).values({ id: partnerId, displayName: '伴' })
  // A solo ledger whose member_a has no auth.users row is swept as an orphan
  // (0096, #1710); a duo can become one when a member leaves.
  const people = [{ id: userId, displayName: '我' }, ...(partnerId ? [{ id: partnerId, displayName: '伴' }] : [])]
  await seedAuthUsers(people)
  seededAuthIds.push(...people.map((p) => p.id))

  const now = new Date()
  const [group] = await db.insert(oikosGroups).values({
    name: 'test', memberA: userId, memberB: partnerId,
    currentEpochStartedAt: now, baseCurrency: 'twd',
  }).returning()
  const [epoch] = await db.insert(groupEpochs).values({
    groupId: group.id, startedAt: now, memberAId: userId, memberBId: partnerId,
  }).returning()
  await db.insert(groupBalance).values({ groupId: group.id, balance: 0 })

  return { userId, partnerId, groupId: group.id, epochId: epoch.id }
}
