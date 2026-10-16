import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { seedAuthUsers, deleteAuthUsers } from './_authUser'

// ─── Regression for #1440 ─────────────────────────────────────────────────
//
// Background: leaveGroup re-routes the leaver's CashTransactions /
// IncomeTransactions / RecurringExpenseRules with a
// `SET asset_id = CASE WHEN asset_id = ANY(${movingAssetIds}::uuid[]) …`
// expression. Drizzle does NOT bind a JS array as a single array parameter —
// it expands it into a parenthesised parameter list, so with 1 id you get
// `ANY(($1)::uuid[])` (casting a scalar, not an array literal) and with 2+
// ids you get `ANY(($1, $2)::uuid[])` (a record cast). Postgres rejects both
// with 22P02 malformed array literal, aborting the whole transaction — so
// leaveGroup throws for ANY leaver who owns a House, Car or Insurance asset.
// leaveGroup.noOwnedAssets.test.ts documents this as a known follow-up (see
// its trailing NOTE); this suite is that follow-up.
//
// The fix rewrites the CASE to use `asset_id IN (${sql.join(...)})`, matching
// the pattern already used in lib/db/queries/asset.ts and _predicates.ts.
//
// Local throwaway database only; refuses to run against anything that is not
// localhost. Start one with:
//   docker run -d --name pg-1440 -e POSTGRES_PASSWORD=pg -p 127.0.0.1:55610:5432 postgres:17
//   DATABASE_URL_DIRECT=postgres://postgres:pg@127.0.0.1:55610/postgres npx drizzle-kit push --force
//   DATABASE_URL=postgres://postgres:pg@127.0.0.1:55610/postgres npx vitest run __tests__/actions/leaveGroup.ownedAssets.test.ts
// ──────────────────────────────────────────────────────────────────────────

function loadEnvLocal() {
  const envPath = resolve(__dirname, '../../.env.local')
  if (!existsSync(envPath)) return
  const text = readFileSync(envPath, 'utf-8')
  for (const raw of text.split('\n')) {
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
loadEnvLocal()
// Each test seeds over the network (incl. an auth.users row, #1710); the default
// 5 s is too tight against dev.
vi.setConfig({ testTimeout: 60_000 })

const databaseUrl = process.env.DATABASE_URL ?? ''
const isLocalDb = (() => {
  try {
    return ['localhost', '127.0.0.1', '::1'].includes(new URL(databaseUrl).hostname)
  } catch {
    return false
  }
})()

let mockUserId: string = ''
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: mockUserId } }, error: null }),
    },
  }),
}))

vi.mock('next/cache', () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
}))
// leaveGroup reads the locale cookie to name the new solo ledger (#1622); no
// request scope here, so cookies() would throw. No cookie -> zh-TW default.
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }))

vi.mock('@/lib/analytics/server', () => ({
  captureServer: async () => {},
  isUserFirstNonDeletedRecord: async () => false,
}))

const { db } = await import('@/lib/db/client')
const {
  profiles,
  oikosGroups,
  groupBalance,
  groupEpochs,
  cashTransactions,
  assets,
  carDetails,
  houseDetails,
  insuranceDetails,
  fuelLogs,
  recurringExpenseRules,
} = await import('@/lib/db/schema')
const { leaveGroup } = await import('@/actions/membership')
const { and, eq, inArray, isNotNull } = await import('drizzle-orm')
const { unwrapAction } = await import('@/lib/action-errors')

beforeAll(() => {
  if (!isLocalDb) return
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL not set; cannot run integration test. Ensure .env.local has DATABASE_URL, ' +
      'or export one pointing at a local throwaway Postgres (see file header).',
    )
  }
})

interface SeedRefs {
  userAId: string
  userBId: string
  oldGroupId: string
  oldEpochId: string
  assetIds: string[]
  cashTxIds: string[]
  ruleIds: string[]
  newGroupId?: string
}

function emptyRefs(userAId: string, userBId: string, oldGroupId: string, oldEpochId: string): SeedRefs {
  return { userAId, userBId, oldGroupId, oldEpochId, assetIds: [], cashTxIds: [], ruleIds: [] }
}

async function seedDuoGroup(): Promise<SeedRefs> {
  const userAId = randomUUID()
  const userBId = randomUUID()

  await db.insert(profiles).values([
    { id: userAId, displayName: 'TEST_1440_userA' },
    { id: userBId, displayName: 'TEST_1440_userB' },
  ])
  await seedAuthUsers([
    { id: userAId, displayName: 'TEST_1440_userA' },
    { id: userBId, displayName: 'TEST_1440_userB' },
  ])

  const [group] = await db.insert(oikosGroups).values({
    name: 'TEST_1440_duo',
    memberA: userAId,
    memberB: userBId,
  }).returning({ id: oikosGroups.id })

  await db.insert(groupBalance).values({ groupId: group.id, balance: 0, version: 0 })

  const [epoch] = await db.insert(groupEpochs).values({
    groupId: group.id,
    startedAt: new Date(),
    memberAId: userAId,
    memberBId: userBId,
  }).returning({ id: groupEpochs.id })

  return emptyRefs(userAId, userBId, group.id, epoch.id)
}

async function cleanup(refs: SeedRefs) {
  if (refs.cashTxIds.length) {
    await db.delete(cashTransactions).where(inArray(cashTransactions.id, refs.cashTxIds))
  }
  if (refs.ruleIds.length) {
    await db.delete(recurringExpenseRules).where(inArray(recurringExpenseRules.id, refs.ruleIds))
  }
  // #1442 — frozen copies (and fuel logs copied onto them) leaveGroup created
  // in either ledger. Records pointing at them are gone by now.
  const groupIds = refs.newGroupId ? [refs.oldGroupId, refs.newGroupId] : [refs.oldGroupId]
  const frozenCopies = await db.select({ id: assets.id }).from(assets)
    .where(and(inArray(assets.groupId, groupIds), isNotNull(assets.frozenAt)))
  if (frozenCopies.length) {
    const copyIds = frozenCopies.map((c) => c.id)
    await db.delete(fuelLogs).where(inArray(fuelLogs.assetId, copyIds))
    await db.delete(assets).where(inArray(assets.id, copyIds))
  }
  if (refs.assetIds.length) {
    await db.delete(carDetails).where(inArray(carDetails.assetId, refs.assetIds))
    await db.delete(houseDetails).where(inArray(houseDetails.assetId, refs.assetIds))
    await db.delete(insuranceDetails).where(inArray(insuranceDetails.assetId, refs.assetIds))
    await db.delete(assets).where(inArray(assets.id, refs.assetIds))
  }
  await db.delete(groupEpochs).where(eq(groupEpochs.groupId, refs.oldGroupId))
  if (refs.newGroupId) {
    await db.delete(groupEpochs).where(eq(groupEpochs.groupId, refs.newGroupId))
    await db.delete(groupBalance).where(eq(groupBalance.groupId, refs.newGroupId))
    await db.delete(oikosGroups).where(eq(oikosGroups.id, refs.newGroupId))
  }
  await db.delete(groupBalance).where(eq(groupBalance.groupId, refs.oldGroupId))
  await db.delete(oikosGroups).where(eq(oikosGroups.id, refs.oldGroupId))
  await deleteAuthUsers([refs.userAId, refs.userBId])
  await db.delete(profiles).where(inArray(profiles.id, [refs.userAId, refs.userBId]))
}

describe.skipIf(!isLocalDb)('leaveGroup — leaver with owned 愛物 (#1440)', () => {
  let activeRefs: SeedRefs | null = null

  afterEach(async () => {
    if (activeRefs) {
      try { await cleanup(activeRefs) } catch (e) { console.error('cleanup failed', e) }
      activeRefs = null
    }
  })

  it('moves a single owned car without 22P02; its expense stays, on a frozen copy (#1611)', async () => {
    const refs = await seedDuoGroup()
    activeRefs = refs

    const [car] = await db.insert(assets).values({
      groupId: refs.oldGroupId, type: 'car', name: 'TEST_1440 car',
    }).returning({ id: assets.id })
    refs.assetIds.push(car.id)
    await db.insert(carDetails).values({ assetId: car.id, primaryUserId: refs.userBId })

    const [carTx] = await db.insert(cashTransactions).values({
      groupId: refs.oldGroupId, paidBy: refs.userBId, assetId: car.id,
      amount: 500, splitType: 'all_mine',
      description: 'TEST_1440 fuel', category: 'transit',
      transactedAt: new Date('2026-05-01T00:00:00Z'),
    }).returning({ id: cashTransactions.id })
    refs.cashTxIds.push(carTx.id)

    mockUserId = refs.userBId
    const result = unwrapAction(await leaveGroup())
    refs.newGroupId = result.groupId

    const [movedAsset] = await db.select().from(assets).where(eq(assets.id, car.id)).limit(1)
    expect(movedAsset.groupId).toBe(result.groupId)

    // #1611: the leaver's record stays in the old ledger; the car it pointed
    // at moved, so it is re-pointed at a frozen copy in the old ledger.
    const [keptTx] = await db.select().from(cashTransactions).where(eq(cashTransactions.id, carTx.id)).limit(1)
    expect(keptTx.groupId).toBe(refs.oldGroupId)
    expect(keptTx.assetId).not.toBe(car.id)
    const [carCopy] = await db.select().from(assets).where(eq(assets.id, keptTx.assetId!)).limit(1)
    expect(carCopy.groupId).toBe(refs.oldGroupId)
    expect(carCopy.frozenAt).not.toBeNull()
    expect(carCopy.name).toBe('TEST_1440 car')
  })

  it('moves car + house + insurance together; records stay, a moving rule on a staying asset gets a frozen copy (#1442, #1611)', async () => {
    const refs = await seedDuoGroup()
    activeRefs = refs

    const [car] = await db.insert(assets).values({
      groupId: refs.oldGroupId, type: 'car', name: 'TEST_1440 car2',
    }).returning({ id: assets.id })
    refs.assetIds.push(car.id)
    await db.insert(carDetails).values({ assetId: car.id, primaryUserId: refs.userBId })

    const [house] = await db.insert(assets).values({
      groupId: refs.oldGroupId, type: 'house', name: 'TEST_1440 house',
    }).returning({ id: assets.id })
    refs.assetIds.push(house.id)
    await db.insert(houseDetails).values({ assetId: house.id, owner: refs.userBId })

    const [insurance] = await db.insert(assets).values({
      groupId: refs.oldGroupId, type: 'insurance', name: 'TEST_1440 insurance',
    }).returning({ id: assets.id })
    refs.assetIds.push(insurance.id)
    await db.insert(insuranceDetails).values({
      currency: 'twd', assetId: insurance.id, insuredType: 'user', insuredUserId: refs.userBId,
    })

    // An asset that stays with member A (not in movingAssetIds).
    const [stayingCar] = await db.insert(assets).values({
      groupId: refs.oldGroupId, type: 'car', name: 'TEST_1440 stayer car',
    }).returning({ id: assets.id })
    refs.assetIds.push(stayingCar.id)
    await db.insert(carDetails).values({ assetId: stayingCar.id, primaryUserId: refs.userAId })

    const [movingTx] = await db.insert(cashTransactions).values({
      groupId: refs.oldGroupId, paidBy: refs.userBId, assetId: house.id,
      amount: 1000, splitType: 'all_mine',
      description: 'TEST_1440 house repair', category: 'housing',
      transactedAt: new Date('2026-05-01T00:00:00Z'),
    }).returning({ id: cashTransactions.id })
    refs.cashTxIds.push(movingTx.id)

    // Leaver-paid tx whose asset_id points at the asset that stays behind.
    // Since #1611 the record stays too, so the link stays as it is.
    const [danglingTx] = await db.insert(cashTransactions).values({
      groupId: refs.oldGroupId, paidBy: refs.userBId, assetId: stayingCar.id,
      amount: 300, splitType: 'all_mine',
      description: 'TEST_1440 borrowed A car fuel', category: 'transit',
      transactedAt: new Date('2026-05-01T00:00:00Z'),
    }).returning({ id: cashTransactions.id })
    refs.cashTxIds.push(danglingTx.id)

    // Leaver's recurring rule on the staying car: the rule moves with the
    // leaver, so it must not be left on a cross-ledger reference. It is
    // re-pointed at a frozen copy in the leaver's new ledger (#1442).
    const [movingRule] = await db.insert(recurringExpenseRules).values({
      groupId: refs.oldGroupId, paidBy: refs.userBId, assetId: stayingCar.id,
      amount: 300, splitType: 'all_mine', description: 'TEST_1440 parking', category: 'transit',
      intervalMonths: 1, dayOfMonth: 1, startsOn: '2026-01-01', nextOccurrenceAt: '2026-11-01',
    }).returning({ id: recurringExpenseRules.id })
    refs.ruleIds.push(movingRule.id)

    mockUserId = refs.userBId
    const result = unwrapAction(await leaveGroup())
    refs.newGroupId = result.groupId

    const movedAssets = await db.select().from(assets)
      .where(inArray(assets.id, [car.id, house.id, insurance.id]))
    for (const a of movedAssets) expect(a.groupId).toBe(result.groupId)

    const [staying] = await db.select().from(assets).where(eq(assets.id, stayingCar.id)).limit(1)
    expect(staying.groupId).toBe(refs.oldGroupId)

    // #1611: the leaver's record on the moving house stays in the old
    // ledger, re-pointed at a frozen copy of the house there.
    const [keptTx] = await db.select().from(cashTransactions).where(eq(cashTransactions.id, movingTx.id)).limit(1)
    expect(keptTx.groupId).toBe(refs.oldGroupId)
    const [houseCopy] = await db.select().from(assets).where(eq(assets.id, keptTx.assetId!)).limit(1)
    expect(houseCopy.groupId).toBe(refs.oldGroupId)
    expect(houseCopy.frozenAt).not.toBeNull()
    expect(houseCopy.name).toBe('TEST_1440 house')

    const [keptDangling] = await db.select().from(cashTransactions).where(eq(cashTransactions.id, danglingTx.id)).limit(1)
    expect(keptDangling.groupId).toBe(refs.oldGroupId)
    expect(keptDangling.assetId).toBe(stayingCar.id)

    const [rule] = await db.select().from(recurringExpenseRules).where(eq(recurringExpenseRules.id, movingRule.id)).limit(1)
    expect(rule.groupId).toBe(result.groupId)
    expect(rule.assetId).not.toBe(stayingCar.id)
    expect(rule.pausedAt).not.toBeNull()
    const [copy] = await db.select().from(assets).where(eq(assets.id, rule.assetId!)).limit(1)
    expect(copy.groupId).toBe(result.groupId)
    expect(copy.frozenAt).not.toBeNull()
    expect(copy.type).toBe('car')
    expect(copy.name).toBe('TEST_1440 stayer car')
  })
})
