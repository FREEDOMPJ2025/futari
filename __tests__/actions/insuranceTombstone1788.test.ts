// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Sql } from 'postgres'
import { createStandInDb, dropStandInDb, isLocalUrl } from './_supabaseStandIn'
import { Recorder, TOMB, ledger, person, requestDeletion } from './_deletionWorld1701'

// ─── #1788: can an insurance reader hand a viewer a TOMBSTONE'S NAME? ──────
//
// Suspicion (read in code, from PR #1786's verifier): `asset.ts` /
// `aibutsu.ts` select the live Profiles name of a policy's 要保人 / 被保人. Once
// that person deletes their account the Profiles row is kept as a tombstone
// (display_name 「已離開的夥伴」, is_tombstone true) because the policy's FK
// references it, so an en / ja viewer would read the zh-TW literal, unstyled.
//
// Against a real Postgres (stand-in migrated through 0099) this suite builds
// the worlds where that could happen, deletes the person with the REAL
// `process_account_deletions()`, then runs the REAL page functions
// (`app/(dashboard)/assets/page.tsx`, `assets/[id]/page.tsx`) and reads the
// props they hand to the client components:
//
//   W1  A and B share a ledger; B deletes the account. A stays.
//       - A on the current chapter           (list + detail, 3 policy shapes)
//       - A pinned to the closed chapter B shared with them (list + detail)
//   W2  B deletes; A had LEFT the ledger earlier (C stayed). A pinned to the
//       closed chapter they shared with B  → former-member view.
//   W3  The same, with A and C gone from the picture except A's own
//       look-back after A also left a ledger whose remaining owner is a
//       tombstone (solo ledger kept for A alone).
//
// Verdict recorded here: NOT REPRODUCIBLE through any page. The readers were
// hardened anyway (the three Profiles joins return NULL for a tombstone), and
// the 'readers' block below pins that. A tombstone is
// never a current member, so `memberLinkScope` drops them (name and id never
// leave the server; the card shows 「前伴侶」); the one scope that DOES list a
// departed chapter member (a pinned non-member viewer) belongs to the
// former-member view, whose list and detail return before any policy member
// is read (#1612).
//
// Failure looks like: nothing errors. A viewer reads 已離開的夥伴 on a policy
// card in English, or a former member's look-back starts carrying policy
// members again.
//
// LOCAL THROWAWAY SERVER ONLY. Skips itself unless DATABASE_URL is localhost:
//
//   docker run -d --name pg-1788 -e POSTGRES_PASSWORD=pg -p 127.0.0.1:55788:5432 postgres:17
//   DATABASE_URL=postgres://postgres:pg@127.0.0.1:55788/postgres \
//   DATABASE_URL_DIRECT=postgres://postgres:pg@127.0.0.1:55788/postgres \
//     npx vitest run --no-file-parallelism __tests__/actions/insuranceTombstone1788.test.ts
//
// Integration folder (`__tests__/actions/**`): excluded from CI.
// ──────────────────────────────────────────────────────────────────────────

function loadEnvLocal() {
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
loadEnvLocal()
vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 })

let viewerId = ''
vi.mock('@/lib/supabase/server', () => ({
  getCurrentUser: async () => (viewerId ? { id: viewerId, email: 'v-1788@example.invalid' } : null),
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: viewerId ? { id: viewerId } : null }, error: null }) },
  }),
}))
const cookieJar = new Map<string, string>()
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (k: string) => (cookieJar.has(k) ? { name: k, value: cookieJar.get(k)! } : undefined),
    getAll: () => [...cookieJar].map(([name, value]) => ({ name, value })),
    has: (k: string) => cookieJar.has(k),
    set: (name: string, value: string) => { cookieJar.set(name, value) },
    delete: (name: string) => { cookieJar.delete(name) },
  }),
  headers: async () => new Headers(),
}))
vi.mock('next/navigation', () => ({
  notFound: () => { throw new Error('NEXT_NOT_FOUND') },
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`) },
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}))
vi.mock('next/cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/cache')>()),
  revalidatePath: () => {},
  revalidateTag: () => {},
}))
vi.mock('@/lib/analytics/server', () => ({
  captureServer: async () => {},
  isUserFirstNonDeletedRecord: async () => false,
}))

// The app talks to the stand-in database, never to what .env.local points at.
const adminUrl = process.env.DATABASE_URL ?? ''
const isLocalDb = isLocalUrl(adminUrl)
let standInUrl = ''
if (isLocalDb) {
  standInUrl = await createStandInDb(adminUrl, '0099')
  process.env.DATABASE_URL = standInUrl
  process.env.DATABASE_URL_DIRECT = standInUrl
}

const postgres = (await import('postgres')).default
const { PAST_EPOCH_COOKIE } = await import('@/lib/db/queries/epoch')
const { LOCALE_COOKIE } = await import('@/lib/i18n/locales-meta')
const { getInsuranceDetailsForViewer, loadMemberLinkScope } = await import('@/lib/db/queries/insuranceView')
const { listAssetsForGroup, getAssetById } = await import('@/lib/db/queries/asset')
const { resolveViewerEpochContext } = await import('@/lib/db/queries/epoch')
const { default: AssetsPage } = await import('@/app/(dashboard)/assets/page')
const { default: AssetDetailPage } = await import('@/app/(dashboard)/assets/[id]/page')
const { en } = await import('@/lib/i18n/locales/en')
const { ja } = await import('@/lib/i18n/locales/ja')

const LOCALES = [
  { code: 'en', t: en },
  { code: 'ja', t: ja },
] as const

let sql: Sql

type PolicyKey = 'holderB' | 'insuredB' | 'bothB' | 'savingsBothB' | 'control'
interface World {
  A: string
  B: string
  group: string
  policies: Record<PolicyKey, string>
  closedEpoch: string
  /** B's Profiles row after the deletion job. */
  tomb: { is_tombstone: boolean; display_name: string }
}

/**
 * A policy asset + details. `holder` / `insured` are profile ids (insured is a
 * member: insured_type 'user').
 */
async function policy(
  rec: Recorder, g: string, label: string, kind: string, holder: string, insured: string, createdAt: string,
): Promise<string> {
  const id = await rec.ins('Assets', label, { group_id: g, type: 'insurance', name: `policy ${label}`, created_at: new Date(createdAt) })
  await rec.ins('InsuranceDetails', `${label}.d`, {
    asset_id: id, insurance_type: kind, insured_type: 'user', insured_user_id: insured,
    policy_holder_user_id: holder, insurer: 'Acme', annual_premium: 12000, currency: 'twd',
    starts_at: '2026-01-01', expiry_date: '2040-01-01', term_years: 20, pay_cycle: 'annual',
  }, 'asset_id')
  return id
}

async function policies(rec: Recorder, g: string, tag: string, A: string, B: string, createdAt: string) {
  return {
    holderB: await policy(rec, g, `${tag}-holderB`, 'medical', B, A, createdAt),
    insuredB: await policy(rec, g, `${tag}-insuredB`, 'medical', A, B, createdAt),
    bothB: await policy(rec, g, `${tag}-bothB`, 'medical', B, B, createdAt),
    savingsBothB: await policy(rec, g, `${tag}-savings`, 'savings', B, B, createdAt),
    control: await policy(rec, g, `${tag}-control`, 'medical', A, A, createdAt),
  } satisfies Record<PolicyKey, string>
}

async function runDeletion(): Promise<void> {
  await sql`SELECT public.process_account_deletions()`
}

async function tombstone(id: string) {
  const [r] = await sql<{ is_tombstone: boolean; display_name: string }[]>`
    SELECT is_tombstone, display_name FROM "Profiles" WHERE id = ${id}`
  return r
}

/** W1: A and B share G (guardian beta on); B deletes the account, A stays. */
async function worldStayer(): Promise<World> {
  const rec = new Recorder(sql)
  const A = await person(sql, 'W1 A')
  const B = await person(sql, 'W1 B real name')
  const { g, epochs } = await ledger(rec, sql, 'W1-G', 'W1 家計簿', [
    { label: 'W1-E1', start: '2026-02-10T00:00:00Z', end: null, a: A, b: B },
  ])
  await sql`UPDATE "OikosGroups" SET guardian_beta_enabled = true WHERE id = ${g}`
  const p = await policies(rec, g, 'W1', A, B, '2026-03-01T00:00:00Z')
  await requestDeletion(sql, B)
  await runDeletion()
  return { A, B, group: g, policies: p, closedEpoch: epochs['W1-E1'], tomb: await tombstone(B) }
}

/**
 * W2: A shared a closed chapter with B, then left; C owns the ledger now.
 * B (who left earlier too) deletes the account afterwards.
 */
async function worldLeaver(): Promise<World> {
  const rec = new Recorder(sql)
  const A = await person(sql, 'W2 A')
  const B = await person(sql, 'W2 B real name')
  const C = await person(sql, 'W2 C')
  const { g, epochs } = await ledger(rec, sql, 'W2-G', 'W2 家計簿', [
    { label: 'W2-E1', start: '2026-02-10T00:00:00Z', end: '2026-07-20T00:00:00Z', a: A, b: B },
    { label: 'W2-E2', start: '2026-07-20T00:00:00Z', end: null, a: C, b: null },
  ])
  await sql`UPDATE "OikosGroups" SET guardian_beta_enabled = true WHERE id = ${g}`
  const p = await policies(rec, g, 'W2', A, B, '2026-03-01T00:00:00Z')
  // A's own ledger, so A has somewhere to be after leaving.
  await ledger(rec, sql, 'W2-AG', 'W2 A 的家計簿', [
    { label: 'W2-AE', start: '2026-07-20T00:00:00Z', end: null, a: A, b: null },
  ])
  await requestDeletion(sql, B)
  await runDeletion()
  return { A, B, group: g, policies: p, closedEpoch: epochs['W2-E1'], tomb: await tombstone(B) }
}

/**
 * W3: the ledger's remaining owner is ALSO the deleted account. A left, B
 * stayed (solo, A can still look back), then B deletes. The ledger group row
 * itself names a tombstone as member_a — the one place a tombstone IS the
 * group's current member.
 */
async function worldTombOwner(): Promise<World> {
  const rec = new Recorder(sql)
  const A = await person(sql, 'W3 A')
  const B = await person(sql, 'W3 B real name')
  const { g, epochs } = await ledger(rec, sql, 'W3-G', 'W3 家計簿', [
    { label: 'W3-E1', start: '2026-02-10T00:00:00Z', end: '2026-07-20T00:00:00Z', a: A, b: B },
    { label: 'W3-E2', start: '2026-07-20T00:00:00Z', end: null, a: B, b: null },
  ])
  await sql`UPDATE "OikosGroups" SET guardian_beta_enabled = true WHERE id = ${g}`
  const p = await policies(rec, g, 'W3', A, B, '2026-03-01T00:00:00Z')
  await ledger(rec, sql, 'W3-AG', 'W3 A 的家計簿', [
    { label: 'W3-AE', start: '2026-07-20T00:00:00Z', end: null, a: A, b: null },
  ])
  await requestDeletion(sql, B)
  await runDeletion()
  return { A, B, group: g, policies: p, closedEpoch: epochs['W3-E1'], tomb: await tombstone(B) }
}

// ─── observing the pages ────────────────────────────────────────────────────

interface Element { type: unknown; props: Record<string, unknown> }
const asEl = (x: unknown) => x as Element
const compName = (el: Element) => (el.type as { name?: string }).name ?? String(el.type)

function setView(viewer: string, locale: 'en' | 'ja', pin: string | null) {
  viewerId = viewer
  cookieJar.clear()
  cookieJar.set(LOCALE_COOKIE, locale)
  if (pin) cookieJar.set(PAST_EPOCH_COOKIE, pin)
}

/** /assets → { component, items by asset id }. */
async function listView(viewer: string, locale: 'en' | 'ja', pin: string | null) {
  setView(viewer, locale, pin)
  const el = asEl(await AssetsPage())
  return { component: compName(el), props: el.props }
}

/** /assets/[id] → the element the page returned. */
async function detailView(viewer: string, locale: 'en' | 'ja', pin: string | null, assetId: string) {
  setView(viewer, locale, pin)
  const el = asEl(await AssetDetailPage({ params: Promise.resolve({ id: assetId }) }))
  return { component: compName(el), props: el.props }
}

/** Every string leaf in a value, so one assertion covers the whole payload. */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out))
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, out))
  return out
}

function noTombstoneLeak(payload: unknown, w: World) {
  const s = JSON.stringify(payload)
  expect(s).not.toContain(TOMB)
  expect(s).not.toContain(w.B)
  expect(s).not.toContain('real name')
}

let w1: World, w2: World, w3: World

beforeAll(async () => {
  if (!isLocalDb) return
  sql = postgres(standInUrl, { max: 1, onnotice: () => {} })
  w1 = await worldStayer()
  w2 = await worldLeaver()
  w3 = await worldTombOwner()
})

afterAll(async () => {
  if (!isLocalDb) return
  await sql?.end({ timeout: 5 })
  await dropStandInDb(adminUrl, standInUrl)
})

const d = isLocalDb ? describe : describe.skip

d('worlds are what the test says they are', () => {
  it('the deletion job left B as a tombstone in every world', () => {
    for (const w of [w1, w2, w3]) {
      expect(w.tomb).toEqual({ is_tombstone: true, display_name: TOMB })
    }
  })

  it('W1: B left the group row; A is its only member', async () => {
    const [g] = await sql<{ member_a: string; member_b: string | null }[]>`
      SELECT member_a, member_b FROM "OikosGroups" WHERE id = ${w1.group}`
    expect(g).toEqual({ member_a: w1.A, member_b: null })
  })

  it('W3: the only current member of the ledger is the tombstone', async () => {
    const [g] = await sql<{ member_a: string; member_b: string | null }[]>`
      SELECT member_a, member_b FROM "OikosGroups" WHERE id = ${w3.group}`
    expect(g).toEqual({ member_a: w3.B, member_b: null })
  })
})

d('W1 — A is still in the ledger and B (holder / insured) deleted the account', () => {
  for (const { code } of LOCALES) {
    for (const [name, pin] of [['current chapter', () => null], ['past chapter (pinned)', () => w1.closedEpoch]] as const) {
      it(`${code}, ${name}: /assets list drops B — no name, no id, 前伴侶 label on`, async () => {
        const { component, props } = await listView(w1.A, code, pin())
        expect(component).toBe('AssetsListClient')
        const items = props.items as { id: string; insurance?: Record<string, unknown> }[]
        const byId = new Map(items.map((i) => [i.id, i.insurance!]))
        noTombstoneLeak(items, w1)

        const holderB = byId.get(w1.policies.holderB)!
        expect(holderB).toMatchObject({ policyHolderIsFormer: true, policyHolderUserId: null, policyHolderDisplayName: null, policyHolderAvatarUrl: null, formerLabel: true })
        const insuredB = byId.get(w1.policies.insuredB)!
        expect(insuredB).toMatchObject({ insuredIsFormer: true, insuredUserId: null, insuredUserDisplayName: null, formerLabel: true })
        const bothB = byId.get(w1.policies.bothB)!
        expect(bothB).toMatchObject({ policyHolderIsFormer: true, insuredIsFormer: true, policyHolderDisplayName: null, insuredUserDisplayName: null })
        // control: A's own policy still shows A by name
        expect(byId.get(w1.policies.control)).toMatchObject({ policyHolderIsFormer: false, insuredIsFormer: false, policyHolderUserId: w1.A })
      })

      it(`${code}, ${name}: /assets/[id] drops B on every policy shape`, async () => {
        for (const key of ['holderB', 'insuredB', 'bothB', 'savingsBothB'] as const) {
          const { component, props } = await detailView(w1.A, code, pin(), w1.policies[key])
          expect(component).toBe(key === 'savingsBothB' ? 'SavingsView' : 'InsuranceDetailClientLegacy')
          noTombstoneLeak(props.details, w1)
          noTombstoneLeak(props.assetSheetInitial, w1)
          const holderIsB = key !== 'insuredB'
          const insuredIsB = key !== 'holderB'
          expect(props.details).toMatchObject({
            formerLabel: true,
            policyHolderIsFormer: holderIsB,
            insuredIsFormer: insuredIsB,
            policyHolderUserId: holderIsB ? null : w1.A,
            insuredUserDisplayName: insuredIsB ? null : 'W1 A',
          })
          // the edit sheet is told B is former, not handed B's id
          const sheet = props.assetSheetInitial as Record<string, unknown>
          expect(sheet.insPolicyHolderUserId === null || sheet.insPolicyHolderUserId === w1.A).toBe(true)
        }
      })
    }
  }
})

d('W2 — A left the ledger earlier; A looks back at the chapter shared with B', () => {
  for (const { code } of LOCALES) {
    it(`${code}: /assets is the former-member list — names and totals only`, async () => {
      const { component, props } = await listView(w2.A, code, w2.closedEpoch)
      expect(component).toBe('FormerChapterAssetsList')
      const items = props.items as Record<string, unknown>[]
      expect(items.length).toBe(5)
      for (const i of items) expect(Object.keys(i).sort()).toEqual(['id', 'name', 'totalAmount', 'type'])
      noTombstoneLeak(items, w2)
    })

    it(`${code}: /assets/[id] is the former-member detail — the policy's name and the chapter's money`, async () => {
      for (const key of ['holderB', 'insuredB', 'bothB', 'savingsBothB'] as const) {
        const { component, props } = await detailView(w2.A, code, w2.closedEpoch, w2.policies[key])
        expect(component).toBe('FormerChapterAssetDetail')
        expect(props.details).toBeUndefined()
        expect(props.assetSheetInitial).toBeUndefined()
        noTombstoneLeak(props, w2)
      }
    })
  }
})

d('W3 — the ledger group names the tombstone as its member; A looks back', () => {
  for (const { code } of LOCALES) {
    it(`${code}: still the former-member view, nothing of the tombstone reaches the page`, async () => {
      const list = await listView(w3.A, code, w3.closedEpoch)
      expect(list.component).toBe('FormerChapterAssetsList')
      noTombstoneLeak(list.props.items, w3)
      for (const key of ['holderB', 'bothB', 'savingsBothB'] as const) {
        const det = await detailView(w3.A, code, w3.closedEpoch, w3.policies[key])
        expect(det.component).toBe('FormerChapterAssetDetail')
        noTombstoneLeak(det.props, w3)
      }
    })
  }
})

d('guardian beta gate does not open another route', () => {
  it('A (current member) with guardian_beta_enabled OFF gets the gated view, no policy members', async () => {
    await sql`UPDATE "OikosGroups" SET guardian_beta_enabled = false WHERE id = ${w1.group}`
    try {
      const { component, props } = await detailView(w1.A, 'en', null, w1.policies.bothB)
      expect(component).toBe('InsuranceGatedClient')
      noTombstoneLeak(props, w1)
    } finally {
      await sql`UPDATE "OikosGroups" SET guardian_beta_enabled = true WHERE id = ${w1.group}`
    }
  })
})

// ─── the readers underneath the pages ───────────────────────────────────────
//
// What the suspicion is about, one layer down: the SELECTs. These are NOT
// reachable from a page (see above) but show what the readers themselves
// return, so a future change that lets a former-member view load policy
// members (or a new caller of listAssetsForGroup / getAssetById) is caught.

d('readers: a tombstone has no name at the SELECT (hardening; not reachable from a page today)', () => {
  it('raw rows: the Profiles joins return NULL for a tombstone, never the zh-TW literal', async () => {
    const rows = await listAssetsForGroup(w1.group, w1.A)
    const row = rows.find((r) => r.id === w1.policies.bothB)!
    expect(row.insurancePolicyHolderDisplayName).toBeNull()
    expect(row.insuranceInsuredUserDisplayName).toBeNull()
    const one = await getAssetById(w1.policies.bothB, w1.group, w1.A)
    expect(one?.insurancePolicyHolderDisplayName).toBeNull()
    expect(one?.insuranceInsuredUserDisplayName).toBeNull()
    // control: a live member still resolves by name
    const control = rows.find((r) => r.id === w1.policies.control)!
    expect(control.insurancePolicyHolderDisplayName).toBe('W1 A')
  })

  it('current member scope: the tombstone is not in it, so the view drops B', async () => {
    setView(w1.A, 'en', null)
    const ctx = (await resolveViewerEpochContext(w1.A))!
    const scope = await loadMemberLinkScope(ctx, w1.A)
    expect([...scope.allowed]).toEqual([w1.A])
    const view = await getInsuranceDetailsForViewer(w1.policies.bothB, w1.group, w1.A, scope)
    expect(view).toMatchObject({ policyHolderUserId: null, insuredUserDisplayName: null, policyHolderIsFormer: true, insuredIsFormer: true })
  })

  it('pinned non-member scope allows the tombstone (chapter member), and the reader still returns no name', async () => {
    setView(w2.A, 'en', w2.closedEpoch)
    const ctx = (await resolveViewerEpochContext(w2.A))!
    expect(ctx.isFormerMemberView).toBe(true)
    const scope = await loadMemberLinkScope(ctx, w2.A)
    expect(scope.allowed.has(w2.B)).toBe(true)
    const view = await getInsuranceDetailsForViewer(w2.policies.bothB, w2.group, w2.A, scope)
    expect(view?.insuredUserDisplayName).toBeNull()
    expect(JSON.stringify(view)).not.toContain(TOMB)
    // a live member next to the tombstone keeps their name
    const mixed = await getInsuranceDetailsForViewer(w2.policies.holderB, w2.group, w2.A, scope)
    expect(mixed?.insuredUserDisplayName).toBe('W2 A')
  })
})

// The pages' early return is the only thing between the pinned scope and the
// client. Guard it where it lives: a policy-member read must stay below the
// `isFormerMemberView` return in both pages.
d('guard: both pages return for a former-member view before any policy member is read', () => {
  const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf-8')
  for (const [file, marker] of [
    ['app/(dashboard)/assets/page.tsx', 'loadMemberLinkScope(context'],
    ['app/(dashboard)/assets/[id]/page.tsx', 'loadMemberLinkScope(context'],
  ] as const) {
    it(file, () => {
      const src = read(file)
      const gate = src.indexOf('context.isFormerMemberView')
      const firstMemberRead = src.indexOf(marker)
      expect(gate).toBeGreaterThan(-1)
      expect(firstMemberRead).toBeGreaterThan(gate)
      // the gate block returns (does not just set a flag)
      expect(src.slice(gate, firstMemberRead)).toContain('return')
    })
  }
})

// Strings the three locales show for the label, for the report.
d('labels', () => {
  it('en / ja have translations for the left label and the former-partner label', () => {
    expect(en.common.leftPartnerLabel).not.toBe(TOMB)
    expect(ja.common.leftPartnerLabel).not.toBe(TOMB)
    expect(strings(en.assets.insuranceList.policyHolderFormer)).toEqual(['Former partner'])
  })
})
