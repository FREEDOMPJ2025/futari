// Per-locale demo ledgers for the store screenshots (#1904) — DEV DATABASE ONLY.
//
// The zh-TW screenshots come from the dev ledger 3a896cf2-… (「我們的帳本」).
// Its records are zh-TW text, so an en/zh-CN/ja capture of it is mixed-language.
// This script gives the same two demo members (Futa / Tari, avatar_hidden) one
// more ledger per locale, shaped like the parts of the zh-TW ledger the four
// captured screens show: ~11 recent expenses (Aria's {item1..3} among them),
// assets incl. the plant {plantName}, and an ended 7-day trip to {tripPlace}
// in two currencies (#1904 comment 6605692812). It never writes the zh-TW
// ledger.
//
//   npx tsx scripts/og/seed-demo-ledgers.ts                     # dry run (default): prints the plan, writes NOTHING
//   npx tsx scripts/og/seed-demo-ledgers.ts --apply             # create (or re-create) en, zh-CN, ja
//   npx tsx scripts/og/seed-demo-ledgers.ts --apply --locale=ja
//   npx tsx scripts/og/seed-demo-ledgers.ts --remove            # delete exactly the rows this script created
//   npx tsx scripts/og/seed-demo-ledgers.ts --activate=en       # make the en ledger the one the app shows
//   npx tsx scripts/og/seed-demo-ledgers.ts --activate=zh-TW    # back to the zh-TW ledger
//   (--activate, --apply and --remove also print their plan first; add
//    --dry-run to any of them to stop after the plan.)
//
// Run from the repo root: tsx resolves the app's `@/` imports from tsconfig.json.
//
// ── How the app picks the ledger (why --activate exists) ─────────────────────
// There is no "current ledger" cookie or column. getActiveGroupForUser
// (lib/db/queries/group.ts) takes, among the groups the user is member_a or
// member_b of, the one with the latest OikosGroups.current_epoch_started_at.
// So switching = moving that timestamp. --activate puts the chosen locale
// ledger one minute after the newest other ledger of either demo member, and
// every other locale ledger one day before the oldest. The zh-TW ledger's own
// row is never written: activating zh-TW just moves every locale ledger back
// below it.
// Balance and the chapter window count rows by created_at >= that timestamp
// (lib/db/queries/balance.ts); both positions are months before the seeded
// rows' created_at (now), so moving it never hides a seeded row.
// Failure looks like: nothing errors; the dashboard simply shows another
// ledger. capture-screens.mjs therefore checks the ledger name on /dashboard.
//
// ── Identity of what this script creates ────────────────────────────────────
// Every row id is a deterministic UUID derived from "futari-demo-ledger:
// <locale>:<key>", so the script finds its own rows without a name tag, and
// --remove deletes those ids and nothing else. Rows other code adds to these
// ledgers later (someone records an expense while testing) are not ours: the
// foreign keys then stop --remove / --apply, the transaction rolls back, and
// the script says so.
//
// ── Safety ──────────────────────────────────────────────────────────────────
// Refuses to run at all (dry run included) unless every database / Supabase
// URL in the env file names the dev project ufhcprrauwsxdmscbkrf and none
// names prod (lib/reencryptCore.ts assertTargetMatchesUrl, the same check the
// re-encrypt script uses). Prints the target ref, never a URL, key or password.
//
// ── What it reuses from the app ─────────────────────────────────────────────
// Drizzle schema + client (lib/db), encrypt/aadFor (lib/crypto.ts) for the
// encrypted columns, convertViaSnapshot/validateTripCurrencySnapshot for trip
// amounts, buildTripSummaries for the trip-end fold (the same rows endTrip
// writes, including its `${trip.name} 結算` description), recalcGroupBalance
// for the GroupBalance cache, getActiveGroupForUser to report which ledger
// the app will show.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..', '..')
const DEMO_DATA_DIR = path.join(__dirname, 'demo-data')

// The zh-TW demo ledger. Read (for its members and its timestamp), never written.
const ZH_TW_GROUP_ID = '3a896cf2-fe3c-4525-b5d6-789ce17e3e4e'
const DEV_REF = 'ufhcprrauwsxdmscbkrf'
const PROD_REF = 'cxbnlahuhdvrbwcnzoqo'
// Same sprout date as the zh-TW plant (客廳的小仙子, PlantDetails.sprouted_at),
// so {days} counts the same way: 285 on 2026-09-20.
const PLANT_SPROUTED_AT = '2025-12-09'

// ─── Arguments ──────────────────────────────────────────────────────────────

type Locale = 'en' | 'zh-CN' | 'ja'
const LOCALES: Locale[] = ['en', 'zh-CN', 'ja']

const argv = process.argv.slice(2)
const flag = (name: string) => argv.includes(`--${name}`)
const opt = (name: string) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : undefined
}
const known = ['--apply', '--remove', '--dry-run']
for (const a of argv) {
  if (!known.includes(a) && !/^--(locale|activate|env-file)=/.test(a)) {
    console.error(`unknown argument ${a}`)
    process.exit(2)
  }
}
const activateTarget = opt('activate')
const modes = [flag('apply') && 'apply', flag('remove') && 'remove', activateTarget && 'activate'].filter(Boolean)
if (modes.length > 1) {
  console.error('use one of --apply, --remove, --activate=<locale> at a time')
  process.exit(2)
}
const mode = (modes[0] || 'plan') as 'apply' | 'remove' | 'activate' | 'plan'
const write = mode !== 'plan' && !flag('dry-run')
const locales: Locale[] = (opt('locale') ?? LOCALES.join(',')).split(',').map((l) => {
  if (!LOCALES.includes(l as Locale)) {
    console.error(`--locale takes ${LOCALES.join(', ')} (zh-TW has its own ledger and is never seeded)`)
    process.exit(2)
  }
  return l as Locale
})
if (activateTarget && activateTarget !== 'zh-TW' && !LOCALES.includes(activateTarget as Locale)) {
  console.error(`--activate takes zh-TW, ${LOCALES.join(', ')}`)
  process.exit(2)
}

// ─── Dev-only guard (before any app module is loaded) ────────────────────────

const envFile = path.resolve(opt('env-file') ?? path.join(REPO, '.env.local'))
if (!existsSync(envFile)) {
  console.error(`env file not found: ${envFile}`)
  process.exit(2)
}
const fileEnv = parseEnv(readFileSync(envFile, 'utf8')) as Record<string, string | undefined>
const { assertTargetMatchesUrl, GuardError } = await import('../../lib/reencryptCore.ts')

function guard(): string {
  const dbUrl = fileEnv.DATABASE_URL
  if (!dbUrl) throw new GuardError('DATABASE_URL is not set in the env file')
  // The app's db client (lib/db/client.ts) connects with DATABASE_URL; an
  // ambient one would override nothing (we set it below) but means the shell
  // is pointed somewhere on purpose — refuse rather than guess.
  if (process.env.DATABASE_URL && process.env.DATABASE_URL !== dbUrl) {
    throw new GuardError('DATABASE_URL in the environment differs from the env file; unset it')
  }
  assertTargetMatchesUrl('dev', dbUrl)
  // assertTargetMatchesUrl accepts the dev ref in the username alone; also
  // require a Supabase host, so a look-alike username elsewhere is refused.
  let host = ''
  try { host = new URL(dbUrl).hostname.toLowerCase() } catch { /* checked above */ }
  if (host !== `db.${DEV_REF}.supabase.co` && !host.endsWith('.pooler.supabase.com')) {
    throw new GuardError('DATABASE_URL host is not a Supabase database host')
  }
  for (const name of ['DATABASE_URL_DIRECT', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_URL']) {
    const v = fileEnv[name]
    if (!v) continue
    if (v.toLowerCase().includes(PROD_REF)) throw new GuardError(`${name} names the prod project`)
    if (!v.toLowerCase().includes(DEV_REF)) throw new GuardError(`${name} does not name the dev project`)
  }
  return DEV_REF
}

try {
  const ref = guard()
  console.log(`target: Supabase project ${ref} (oikos-dev) — env file ${path.relative(process.cwd(), envFile) || envFile}`)
} catch (e) {
  console.error(`✗ refused: ${e instanceof GuardError ? e.message : 'could not check the target'}`)
  console.error('  This script only ever runs against the dev project (CLAUDE.md 環境).')
  process.exit(2)
}
process.env.DATABASE_URL = fileEnv.DATABASE_URL
for (const k of ['ENCRYPTION_KEY', 'ENCRYPTION_KEYS', 'ENCRYPTION_WRITE_KID']) {
  if (fileEnv[k] && !process.env[k]) process.env[k] = fileEnv[k]
}

const { db } = await import('@/lib/db/client')
const S = await import('@/lib/db/schema')
const { and, eq, inArray, or } = await import('drizzle-orm')
const { encrypt, decrypt, aadFor } = await import('@/lib/crypto')
const { convertViaSnapshot, validateTripCurrencySnapshot } = await import('@/lib/trip-currency')
const { buildTripSummaries } = await import('@/lib/tripSummary')
const { recalcGroupBalance } = await import('@/lib/db/queries/balance')
const { getActiveGroupForUser } = await import('@/lib/db/queries/group')
const { localYmd, localTodayISO } = await import('@/lib/local-date')

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type SplitType = 'all_mine' | 'all_theirs' | 'half' | 'weighted'
type Who = 'A' | 'B' // A = Futa (member_a, the capturing account), B = Tari

// ─── Locale content ─────────────────────────────────────────────────────────
// Names and amounts are invented and locally plausible (#1904 §2). Amounts
// are whole units of the ledger's base currency (main ledger amounts are never
// cents, lib/currency.ts). Expense order mirrors the zh-TW ledger's 2026-09
// rows; dayOffset is days before today (see clampOffsets).

interface Expense { key: string; desc: string; amount: number; by: Who; split: SplitType; category: string; asset?: AssetKey; dayOffset: number; time: [number, number] }
interface TripExpense { desc: string; amount: number; currency: 'local' | 'base'; by: Who; split: SplitType; category: string; day: number }
type AssetKey = 'car1' | 'car2' | 'house' | 'child' | 'pet' | 'plant' | 'item'
interface LocaleContent {
  groupName: string
  base: 'usd' | 'cny' | 'jpy'
  copyVars: { item1: string; item2: string; item3: string; plantName: string; tripPlace: string; localCurrency: string; homeCurrency: string }
  rent: (month: number) => string
  expenses: Omit<Expense, 'dayOffset' | 'time'>[]
  assets: {
    car1: string; car2: string; house: string; item: string
    child: { name: string; nickname: string; fullName: string }
    pet: { name: string; species: string; breed: string }
    plant: { species: string; location: string; cost: number }
  }
  trip: { name: string; localCode: string; rate: number; expenses: TripExpense[] }
}

// [dayOffset, hour, minute] per expense slot, as in the zh-TW feed
// (today, yesterday, 2 days ago ×2, 3 ×2, 4 ×2, 5, 6 ×2).
const SLOTS: [number, number, number][] = [
  [0, 18, 0], [1, 20, 15], [2, 15, 30], [2, 10, 0], [3, 21, 10], [3, 16, 0],
  [4, 19, 40], [4, 8, 30], [5, 9, 5], [6, 11, 20], [6, 10, 0],
]

const CONTENT: Record<Locale, LocaleContent> = {
  en: {
    groupName: 'Our ledger',
    base: 'usd',
    copyVars: { item1: 'Dinner', item2: 'the dentist', item3: 'vitamins', plantName: 'Sunny', tripPlace: 'Osaka', localCurrency: 'yen', homeCurrency: 'US dollars' },
    rent: (m) => `Rent for ${new Date(2000, m - 1, 1).toLocaleString('en-US', { month: 'long' })}`,
    expenses: [
      { key: 'pet-food', desc: 'Dog food and treats', amount: 48, by: 'B', split: 'half', category: 'other', asset: 'pet' },
      { key: 'dinner', desc: 'Dinner at the corner place', amount: 62, by: 'A', split: 'half', category: 'dining' },
      { key: 'dentist', desc: 'The dentist, for you', amount: 150, by: 'A', split: 'all_theirs', category: 'health' },
      { key: 'plant-vitamins', desc: "Sunny's vitamins", amount: 14, by: 'B', split: 'half', category: 'other', asset: 'plant' },
      { key: 'movie', desc: 'A night at the movies', amount: 32, by: 'B', split: 'half', category: 'entertainment' },
      { key: 'swim', desc: "Leo's swim class", amount: 90, by: 'A', split: 'half', category: 'education', asset: 'child' },
      { key: 'groceries', desc: "The week's groceries", amount: 145, by: 'B', split: 'half', category: 'dining' },
      { key: 'gas', desc: 'Gas for Rusty', amount: 52, by: 'A', split: 'half', category: 'transit', asset: 'car1' },
      { key: 'train', desc: 'Train to visit family', amount: 68, by: 'A', split: 'half', category: 'transit' },
      { key: 'brunch', desc: 'Weekend brunch', amount: 46, by: 'B', split: 'half', category: 'dining' },
      { key: 'rent', desc: '', amount: 1850, by: 'A', split: 'half', category: 'housing', asset: 'house' },
    ],
    assets: {
      car1: 'Rusty', car2: 'Buddy', house: 'Maple Street', item: 'Commuter bike',
      child: { name: 'Little Leo', nickname: 'Leo', fullName: 'Leo Demo' },
      pet: { name: 'Mochi', species: 'Dog', breed: 'Shiba Inu' },
      plant: { species: 'Succulent', location: 'Living room', cost: 25 },
    },
    trip: {
      name: 'Osaka, 7 days', localCode: 'JPY', rate: 0.0066,
      expenses: [
        { desc: 'Flights', amount: 980, currency: 'base', by: 'A', split: 'half', category: 'transit', day: 0 },
        { desc: 'Hotel, 6 nights', amount: 96000, currency: 'local', by: 'B', split: 'half', category: 'housing', day: 0 },
        { desc: 'Ramen dinner', amount: 3200, currency: 'local', by: 'A', split: 'half', category: 'dining', day: 1 },
        { desc: 'Kuromon Market snacks', amount: 4600, currency: 'local', by: 'B', split: 'half', category: 'dining', day: 2 },
        { desc: 'Train passes', amount: 9000, currency: 'local', by: 'A', split: 'half', category: 'transit', day: 2 },
        { desc: 'Aquarium tickets', amount: 5400, currency: 'local', by: 'B', split: 'half', category: 'entertainment', day: 3 },
        { desc: 'Souvenirs', amount: 8000, currency: 'local', by: 'A', split: 'all_mine', category: 'entertainment', day: 5 },
        { desc: 'Taxi to the airport', amount: 6500, currency: 'local', by: 'B', split: 'half', category: 'transit', day: 6 },
        { desc: 'Travel insurance', amount: 38, currency: 'base', by: 'B', split: 'half', category: 'financial', day: 0 },
      ],
    },
  },
  'zh-CN': {
    groupName: '我们的账本',
    base: 'cny',
    copyVars: { item1: '晚饭', item2: '看牙', item3: '营养液', plantName: '小仙子', tripPlace: '大阪', localCurrency: '日元', homeCurrency: '人民币' },
    rent: (m) => `${m}月房租`,
    expenses: [
      { key: 'pet-food', desc: '狗粮和零食', amount: 260, by: 'B', split: 'half', category: 'other', asset: 'pet' },
      { key: 'dinner', desc: '巷口那家晚饭', amount: 236, by: 'A', split: 'half', category: 'dining' },
      { key: 'dentist', desc: '帮你挂的牙科', amount: 400, by: 'A', split: 'all_theirs', category: 'health' },
      { key: 'plant-vitamins', desc: '小仙子的营养液', amount: 45, by: 'B', split: 'half', category: 'other', asset: 'plant' },
      { key: 'movie', desc: '看了场电影', amount: 120, by: 'B', split: 'half', category: 'entertainment' },
      { key: 'swim', desc: '小元宝的游泳课', amount: 480, by: 'A', split: 'half', category: 'education', asset: 'child' },
      { key: 'groceries', desc: '一周的采买', amount: 520, by: 'B', split: 'half', category: 'dining' },
      { key: 'gas', desc: '小白加油', amount: 300, by: 'A', split: 'half', category: 'transit', asset: 'car1' },
      { key: 'train', desc: '高铁去杭州', amount: 146, by: 'A', split: 'half', category: 'transit' },
      { key: 'brunch', desc: '周末的早午餐', amount: 168, by: 'B', split: 'half', category: 'dining' },
      { key: 'rent', desc: '', amount: 4500, by: 'A', split: 'half', category: 'housing', asset: 'house' },
    ],
    assets: {
      car1: '小白', car2: '阿福', house: '梧桐路', item: '通勤单车',
      child: { name: '小元宝', nickname: '元宝', fullName: '示范元宝' },
      pet: { name: '麻糬', species: '狗', breed: '柴犬' },
      plant: { species: '多肉', location: '客厅', cost: 60 },
    },
    trip: {
      name: '大阪7日', localCode: 'JPY', rate: 0.048,
      expenses: [
        { desc: '机票', amount: 3800, currency: 'base', by: 'A', split: 'half', category: 'transit', day: 0 },
        { desc: '酒店六晚', amount: 96000, currency: 'local', by: 'B', split: 'half', category: 'housing', day: 0 },
        { desc: '拉面晚饭', amount: 3200, currency: 'local', by: 'A', split: 'half', category: 'dining', day: 1 },
        { desc: '黑门市场小吃', amount: 4600, currency: 'local', by: 'B', split: 'half', category: 'dining', day: 2 },
        { desc: '周游卡', amount: 9000, currency: 'local', by: 'A', split: 'half', category: 'transit', day: 2 },
        { desc: '海游馆门票', amount: 5400, currency: 'local', by: 'B', split: 'half', category: 'entertainment', day: 3 },
        { desc: '伴手礼', amount: 8000, currency: 'local', by: 'A', split: 'all_mine', category: 'entertainment', day: 5 },
        { desc: '去机场的出租车', amount: 6500, currency: 'local', by: 'B', split: 'half', category: 'transit', day: 6 },
        { desc: '旅行保险', amount: 120, currency: 'base', by: 'B', split: 'half', category: 'financial', day: 0 },
      ],
    },
  },
  ja: {
    groupName: 'ふたりの家計簿',
    base: 'jpy',
    copyVars: { item1: '夕食', item2: '歯医者', item3: 'サプリ', plantName: 'ぷく', tripPlace: '台北', localCurrency: '台湾ドル', homeCurrency: '円' },
    rent: (m) => `${m}月の家賃`,
    expenses: [
      { key: 'pet-food', desc: 'ドッグフードとおやつ', amount: 4800, by: 'B', split: 'half', category: 'other', asset: 'pet' },
      { key: 'dinner', desc: '角のお店で夕食', amount: 5600, by: 'A', split: 'half', category: 'dining' },
      { key: 'dentist', desc: 'あなたの歯医者代', amount: 3000, by: 'A', split: 'all_theirs', category: 'health' },
      { key: 'plant-vitamins', desc: 'ぷくのサプリ', amount: 1200, by: 'B', split: 'half', category: 'other', asset: 'plant' },
      { key: 'movie', desc: '映画を観た', amount: 3800, by: 'B', split: 'half', category: 'entertainment' },
      { key: 'swim', desc: 'ゆうのスイミング', amount: 8000, by: 'A', split: 'half', category: 'education', asset: 'child' },
      { key: 'groceries', desc: '1 週間分の買い出し', amount: 9800, by: 'B', split: 'half', category: 'dining' },
      { key: 'gas', desc: 'あかのガソリン', amount: 5200, by: 'A', split: 'half', category: 'transit', asset: 'car1' },
      { key: 'train', desc: '新幹線で名古屋へ', amount: 22000, by: 'A', split: 'half', category: 'transit' },
      { key: 'brunch', desc: '週末のブランチ', amount: 3200, by: 'B', split: 'half', category: 'dining' },
      { key: 'rent', desc: '', amount: 98000, by: 'A', split: 'half', category: 'housing', asset: 'house' },
    ],
    assets: {
      car1: 'あか', car2: 'ふくちゃん', house: '桜町の家', item: '通勤用の自転車',
      child: { name: 'ゆうくん', nickname: 'ゆう', fullName: 'デモ ゆう' },
      pet: { name: 'もち', species: '犬', breed: '柴犬' },
      plant: { species: '多肉植物', location: 'リビング', cost: 1500 },
    },
    trip: {
      name: '台北7日間', localCode: 'TWD', rate: 4.7,
      expenses: [
        { desc: '航空券', amount: 64000, currency: 'base', by: 'A', split: 'half', category: 'transit', day: 0 },
        { desc: 'ホテル 6 泊', amount: 21000, currency: 'local', by: 'B', split: 'half', category: 'housing', day: 0 },
        { desc: '小籠包の夕食', amount: 1200, currency: 'local', by: 'A', split: 'half', category: 'dining', day: 1 },
        { desc: '夜市の食べ歩き', amount: 900, currency: 'local', by: 'B', split: 'half', category: 'dining', day: 2 },
        { desc: '悠遊カード', amount: 1000, currency: 'local', by: 'A', split: 'half', category: 'transit', day: 2 },
        { desc: '九份へのツアー', amount: 2400, currency: 'local', by: 'B', split: 'half', category: 'entertainment', day: 3 },
        { desc: 'お土産', amount: 2000, currency: 'local', by: 'A', split: 'all_mine', category: 'entertainment', day: 5 },
        { desc: '空港までのタクシー', amount: 1300, currency: 'local', by: 'B', split: 'half', category: 'transit', day: 6 },
        { desc: '海外旅行保険', amount: 3500, currency: 'base', by: 'B', split: 'half', category: 'financial', day: 0 },
      ],
    },
  },
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Deterministic UUID for one row this script owns. */
function idFor(locale: Locale, key: string): string {
  const h = createHash('sha256').update(`futari-demo-ledger:${locale}:${key}`).digest('hex')
  // RFC 4122 layout, version 8 (custom), variant 10xx.
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

const at = (ymd: string, h: number, m: number) => {
  const [y, mo, d] = ymd.split('-').map(Number)
  return new Date(y, mo - 1, d, h, m) // local time of the machine that captures
}
const addDays = (ymd: string, n: number) => {
  const [y, mo, d] = ymd.split('-').map(Number)
  return localYmd(new Date(y, mo - 1, d + n))
}

const TODAY = localTodayISO()
const DAY_OF_MONTH = Number(TODAY.slice(8, 10))
// The zh-TW feed showed one month header ("2026年9月 · 11 筆"). Early in a
// month the 6-day spread would split the feed into two months, so offsets are
// clamped to stay inside the current month (several rows then share a day).
const clampOffsets = DAY_OF_MONTH < 7

interface Plan {
  locale: Locale
  ids: Record<string, string>
  group: typeof S.oikosGroups.$inferInsert
  epoch: typeof S.groupEpochs.$inferInsert
  assets: (typeof S.assets.$inferInsert)[]
  details: { car: (typeof S.carDetails.$inferInsert)[]; house: (typeof S.houseDetails.$inferInsert)[]; child: (typeof S.childDetails.$inferInsert)[]; pet: (typeof S.petDetails.$inferInsert)[]; plant: (typeof S.plantDetails.$inferInsert)[] }
  encrypted: { table: string; column: string; pk: string; plaintext: string }[]
  cash: (typeof S.cashTransactions.$inferInsert)[]
  trip: typeof S.trips.$inferInsert
  tripExpenses: (typeof S.tripExpenses.$inferInsert)[]
  demoData: Record<string, unknown>
}

function buildPlan(locale: Locale, members: { A: string; B: string }, inactiveAt: Date): Plan {
  const c = CONTENT[locale]
  const id = (k: string) => idFor(locale, k)
  const who = (w: Who) => members[w]
  const BASE = c.base.toUpperCase()
  const groupId = id('group')
  const epochId = id('epoch')

  const assetIds: Record<AssetKey, string> = {
    car1: id('asset:car1'), car2: id('asset:car2'), house: id('asset:house'), child: id('asset:child'),
    pet: id('asset:pet'), plant: id('asset:plant'), item: id('asset:item'),
  }
  const created = (n: number) => new Date(Date.parse('2026-05-12T00:00:00Z') + n * 60000) // display-irrelevant, stable order
  const assets: Plan['assets'] = [
    { id: assetIds.house, groupId, type: 'house', name: c.assets.house, createdAt: created(0) },
    { id: assetIds.car1, groupId, type: 'car', name: c.assets.car1, createdAt: created(1) },
    { id: assetIds.car2, groupId, type: 'car', name: c.assets.car2, createdAt: created(2) },
    { id: assetIds.child, groupId, type: 'child', name: c.assets.child.name, createdAt: created(3) },
    { id: assetIds.pet, groupId, type: 'pet', name: c.assets.pet.name, createdAt: created(4) },
    { id: assetIds.plant, groupId, type: 'plant', name: c.copyVars.plantName, createdAt: created(5) },
    { id: assetIds.item, groupId, type: 'item', name: c.assets.item, templateKey: 'general', templateFields: {}, createdAt: created(6) },
  ]
  // Encrypted columns (lib/crypto.ts ENCRYPTED_COLUMNS) this ledger fills.
  // Plates are "DEMO 001"-style so no real plate is ever stored; the app masks
  // them on the list anyway. The child's full name is invented.
  const encrypted: Plan['encrypted'] = [
    { table: 'Assets', column: 'name_encrypted', pk: assetIds.child, plaintext: c.assets.child.fullName },
    { table: 'CarDetails', column: 'plate_encrypted', pk: assetIds.car1, plaintext: 'DEMO 001' },
    { table: 'CarDetails', column: 'plate_encrypted', pk: assetIds.car2, plaintext: 'DEMO 002' },
  ]
  const details: Plan['details'] = {
    car: [
      { assetId: assetIds.car1, purchasedAt: '2025-12-01', fuelType: '95', color: '#7B2525', year: 2019, brand: 'Toyota', model: 'Corolla Altis', primaryUserId: null },
      { assetId: assetIds.car2, purchasedAt: '2026-05-04', fuelType: '95', color: '#C8A97A', year: 2019, brand: 'Toyota', model: 'Sienta', primaryUserId: null },
    ],
    house: [{ assetId: assetIds.house, owner: members.A }],
    child: [{ assetId: assetIds.child, birthday: '2022-01-03', gender: 'male', nickname: c.assets.child.nickname, bloodType: 'A' }],
    pet: [{ assetId: assetIds.pet, species: c.assets.pet.species, breed: c.assets.pet.breed, sex: 'male', birthDate: '2026-02-04', adoptedDate: '2026-05-06', weightG: 9500 }],
    plant: [{ assetId: assetIds.plant, species: c.assets.plant.species, location: c.assets.plant.location, sproutedAt: PLANT_SPROUTED_AT, cost: c.assets.plant.cost, waterEvery: 7 }],
  }

  const cash: Plan['cash'] = c.expenses.map((e, i) => {
    const [off0, h, m] = SLOTS[i]
    const off = clampOffsets ? Math.min(off0, DAY_OF_MONTH - 1) : off0
    const day = addDays(TODAY, -off)
    return {
      id: id(`cash:${e.key}`), groupId, paidBy: who(e.by), amount: e.amount, splitType: e.split,
      description: e.key === 'rent' ? c.rent(Number(day.slice(5, 7))) : e.desc,
      category: e.category, assetId: e.asset ? assetIds[e.asset] : null, status: 'settled' as const,
      transactedAt: at(day, h, m),
    }
  })

  // An ended 7-day trip, about six weeks back.
  const tripId = id('trip')
  const tripStart = addDays(TODAY, -45)
  const tripEnd = addDays(tripStart, 6)
  const endedAt = at(addDays(tripEnd, 1), 20, 0)
  const snapshot = validateTripCurrencySnapshot({
    default: BASE,
    entries: [{ code: c.trip.localCode, rate: c.trip.rate, label: null }, { code: BASE, rate: 1, label: null }],
  })
  const tripExpenses: Plan['tripExpenses'] = c.trip.expenses.map((e, i) => {
    const local = e.currency === 'local'
    const amount = local ? convertViaSnapshot(e.amount, c.trip.localCode, BASE, snapshot) : e.amount
    if (amount == null) throw new Error(`no rate for ${c.trip.localCode}`)
    return {
      id: id(`trip-expense:${i}`), tripId, paidBy: who(e.by), amount,
      originalCurrency: local ? c.trip.localCode : null, originalAmount: local ? e.amount : null,
      category: e.category, splitType: e.split, splitRatio: null, description: e.desc,
      transactedAt: at(addDays(tripStart, e.day), 12 + i, 0),
    }
  })
  // The fold endTrip writes (lib/trip/endTripInTx.ts), from the app's own math.
  // Deterministic ids instead of the default, so --remove can find them.
  const summaries = buildTripSummaries({
    expenses: tripExpenses.map((t) => ({ amount: t.amount, paidBy: t.paidBy, splitType: t.splitType as SplitType, splitRatio: t.splitRatio ?? null })),
    memberA: members.A,
    memberB: members.B,
  })
  summaries.forEach((s, i) => cash.push({
    id: id(`trip-summary:${i}`), groupId, paidBy: s.paidBy, amount: s.amount, splitType: s.splitType,
    splitRatioA: s.splitRatioA, description: `${c.trip.name} 結算`, category: 'entertainment',
    status: 'settled', transactedAt: endedAt, tripId,
  }))

  const ids: Record<string, string> = { group: groupId, epoch: epochId, trip: tripId }
  return {
    locale, ids, encrypted, assets, details, cash, tripExpenses,
    group: {
      id: groupId, name: c.groupName, memberA: members.A, memberB: members.B, defaultSplitRatioA: 50,
      guardianBetaEnabled: true, baseCurrency: c.base, currentEpochStartedAt: inactiveAt, createdAt: inactiveAt,
    },
    epoch: { id: epochId, groupId, startedAt: inactiveAt, memberAId: members.A, memberBId: members.B },
    trip: {
      id: tripId, groupId, epochId, name: c.trip.name, startDate: tripStart, endDate: tripEnd,
      defaultCurrency: BASE, status: 'ended', endedAt, rateSnapshot: snapshot,
    },
    demoData: {
      locale, groupId, groupName: c.groupName, tripId, tripName: c.trip.name, baseCurrency: BASE,
      tripCurrencies: [c.trip.localCode, BASE], plantName: c.copyVars.plantName, plantSproutedAt: PLANT_SPROUTED_AT,
      seededOn: TODAY, copyVars: c.copyVars,
    },
  }
}

const allIdsOf = (p: Plan) => ({
  cash: p.cash.map((r) => r.id!),
  tripExpenses: p.tripExpenses.map((r) => r.id!),
  assets: p.assets.map((r) => r.id!),
})

async function existing(tx: Tx | typeof db, p: Plan) {
  const ids = allIdsOf(p)
  const [g] = await tx.select({ id: S.oikosGroups.id, at: S.oikosGroups.currentEpochStartedAt }).from(S.oikosGroups).where(eq(S.oikosGroups.id, p.ids.group))
  const cash = await tx.select({ id: S.cashTransactions.id }).from(S.cashTransactions).where(eq(S.cashTransactions.groupId, p.ids.group))
  const ours = new Set(ids.cash)
  return { group: g ?? null, cashOurs: cash.filter((r) => ours.has(r.id)).length, cashForeign: cash.filter((r) => !ours.has(r.id)).length }
}

async function removeLocale(tx: Tx, p: Plan) {
  const ids = allIdsOf(p)
  // Children first; every delete is by this script's own ids.
  await tx.delete(S.cashTransactions).where(inArray(S.cashTransactions.id, ids.cash))
  await tx.delete(S.tripExpenses).where(inArray(S.tripExpenses.id, ids.tripExpenses))
  await tx.delete(S.trips).where(eq(S.trips.id, p.ids.trip))
  await tx.delete(S.carDetails).where(inArray(S.carDetails.assetId, ids.assets))
  await tx.delete(S.houseDetails).where(inArray(S.houseDetails.assetId, ids.assets))
  await tx.delete(S.childDetails).where(inArray(S.childDetails.assetId, ids.assets))
  await tx.delete(S.petDetails).where(inArray(S.petDetails.assetId, ids.assets))
  await tx.delete(S.plantDetails).where(inArray(S.plantDetails.assetId, ids.assets))
  await tx.delete(S.assets).where(inArray(S.assets.id, ids.assets))
  await tx.delete(S.groupBalance).where(eq(S.groupBalance.groupId, p.ids.group))
  await tx.delete(S.groupEpochs).where(eq(S.groupEpochs.id, p.ids.epoch))
  await tx.delete(S.oikosGroups).where(eq(S.oikosGroups.id, p.ids.group))
}

async function insertLocale(tx: Tx, p: Plan) {
  const enc = (table: string, column: string, pk: string) => {
    const e = p.encrypted.find((x) => x.table === table && x.column === column && x.pk === pk)
    return e ? encrypt(e.plaintext, aadFor(table as never, column as never, pk)) : null
  }
  await tx.insert(S.oikosGroups).values(p.group)
  await tx.insert(S.groupEpochs).values(p.epoch)
  await tx.insert(S.groupBalance).values({ groupId: p.ids.group, balance: 0, version: 0 })
  await tx.insert(S.assets).values(p.assets.map((a) => ({ ...a, nameEncrypted: enc('Assets', 'name_encrypted', a.id!) })))
  await tx.insert(S.carDetails).values(p.details.car.map((d) => ({ ...d, plateEncrypted: enc('CarDetails', 'plate_encrypted', d.assetId) })))
  await tx.insert(S.houseDetails).values(p.details.house)
  await tx.insert(S.childDetails).values(p.details.child)
  await tx.insert(S.petDetails).values(p.details.pet)
  await tx.insert(S.plantDetails).values(p.details.plant)
  await tx.insert(S.trips).values(p.trip)
  await tx.insert(S.tripExpenses).values(p.tripExpenses)
  await tx.insert(S.cashTransactions).values(p.cash)
  await recalcGroupBalance(p.ids.group, tx)
}

// ─── Printing ───────────────────────────────────────────────────────────────

const ymdOf = (d: Date | string | null | undefined) => (d instanceof Date ? `${localYmd(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : String(d ?? ''))
const who = (members: { A: string; B: string }, id: string) => (id === members.A ? 'Futa' : id === members.B ? 'Tari' : id)

function printPlan(p: Plan, members: { A: string; B: string }) {
  const BASE = p.group.baseCurrency!.toUpperCase()
  console.log(`  OikosGroups ${p.ids.group}  "${p.group.name}"  base ${BASE}  member_a Futa, member_b Tari  current_epoch_started_at ${p.group.currentEpochStartedAt!.toISOString()}`)
  console.log(`  GroupEpochs ${p.ids.epoch}  open chapter from ${p.epoch.startedAt!.toISOString()}`)
  console.log(`  GroupBalance (cache)  recomputed by recalcGroupBalance after the inserts`)
  console.log(`  Assets ×${p.assets.length}:`)
  for (const a of p.assets) {
    const encCols = p.encrypted.filter((e) => e.pk === a.id).map((e) => `${e.table}.${e.column}`)
    console.log(`    ${a.id}  ${a.type.padEnd(5)}  "${a.name}"${encCols.length ? `  [encrypted: ${encCols.join(', ')}]` : ''}`)
  }
  const pl = p.details.plant[0]
  console.log(`  PlantDetails  species "${pl.species}", location "${pl.location}", sprouted_at ${pl.sproutedAt}, water every ${pl.waterEvery} days`)
  console.log(`  CashTransactions ×${p.cash.length} (amounts in ${BASE}):`)
  for (const r of p.cash) {
    const split = r.splitType === 'weighted' ? `weighted A ${r.splitRatioA}%` : r.splitType
    console.log(`    ${ymdOf(r.transactedAt as Date)}  ${String(r.amount).padStart(6)}  ${who(members, r.paidBy).padEnd(4)}  ${split.padEnd(15)}  ${r.category.padEnd(13)}  ${r.description}${r.tripId ? '  (trip fold)' : ''}`)
  }
  console.log(`  Trips ${p.ids.trip}  "${p.trip.name}"  ${p.trip.startDate} → ${p.trip.endDate}  ended ${ymdOf(p.trip.endedAt as Date)}  currencies ${JSON.stringify(p.trip.rateSnapshot)}`)
  console.log(`  TripExpenses ×${p.tripExpenses.length}:`)
  for (const t of p.tripExpenses) {
    const orig = t.originalCurrency ? `${t.originalCurrency} ${t.originalAmount} → ` : ''
    console.log(`    ${ymdOf(t.transactedAt as Date)}  ${orig}${BASE} ${t.amount}  ${who(members, t.paidBy).padEnd(4)}  ${t.splitType.padEnd(8)}  ${t.description}`)
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  // Read-only context: the demo members and the timestamps the switch is placed around.
  const [zh] = await db.select().from(S.oikosGroups).where(eq(S.oikosGroups.id, ZH_TW_GROUP_ID))
  if (!zh || !zh.memberB) throw new Error(`zh-TW demo ledger ${ZH_TW_GROUP_ID} not found (or has no member_b) on this database`)
  const members = { A: zh.memberA, B: zh.memberB }
  const profiles = await db.select({ id: S.profiles.id, name: S.profiles.displayName, hidden: S.profiles.avatarHidden }).from(S.profiles).where(inArray(S.profiles.id, [members.A, members.B]))
  const byId = new Map(profiles.map((p) => [p.id, p]))
  for (const [slot, expected] of [['A', 'Futa'], ['B', 'Tari']] as const) {
    const p = byId.get(members[slot])
    if (!p || p.name !== expected || !p.hidden) {
      throw new Error(`member_${slot.toLowerCase()} of the zh-TW demo ledger is not the demo profile "${expected}" with avatar_hidden — refusing to attach ledgers to it`)
    }
  }
  const ourGroupIds = LOCALES.map((l) => idFor(l, 'group'))
  const others = (await db.select({ id: S.oikosGroups.id, at: S.oikosGroups.currentEpochStartedAt }).from(S.oikosGroups)
    .where(or(inArray(S.oikosGroups.memberA, [members.A, members.B]), inArray(S.oikosGroups.memberB, [members.A, members.B]))))
    .filter((g) => !ourGroupIds.includes(g.id))
  const oldest = new Date(Math.min(...others.map((g) => g.at.getTime())))
  const newest = new Date(Math.max(...others.map((g) => g.at.getTime())))
  const INACTIVE_AT = new Date(oldest.getTime() - 24 * 3600 * 1000)
  const ACTIVE_AT = new Date(newest.getTime() + 60 * 1000)

  console.log(`demo members: Futa ${members.A} (member_a), Tari ${members.B} (member_b); both avatar_hidden`)
  console.log(`their other ledgers: ${others.length} (incl. zh-TW ${ZH_TW_GROUP_ID}); newest current_epoch_started_at ${newest.toISOString()}`)
  console.log(`switch positions: active ${ACTIVE_AT.toISOString()}, inactive ${INACTIVE_AT.toISOString()}`)
  console.log(`today (this machine's zone, ${Intl.DateTimeFormat().resolvedOptions().timeZone}): ${TODAY}${clampOffsets ? ` — day ${DAY_OF_MONTH} of the month: expense dates are clamped into this month so the feed keeps one month header` : ''}`)
  const before = await getActiveGroupForUser(members.A)
  console.log(`app shows Futa today: ${before?.id} "${before?.name}"`)

  // Encryption: prove the keyring encrypts and reads back (nothing stored).
  try {
    const ctx = aadFor('Assets', 'name_encrypted', idFor('en', 'asset:child'))
    if (decrypt(encrypt('probe', ctx), ctx) !== 'probe') throw new Error('mismatch')
    console.log('encryption keyring: encrypt/decrypt round trip ok')
  } catch {
    if (mode === 'apply') throw new Error('encryption keyring not usable (ENCRYPTION_KEYS / ENCRYPTION_WRITE_KID in the env file)')
    console.log('encryption keyring: NOT usable — --apply would refuse')
  }

  const plans = locales.map((l) => buildPlan(l, members, INACTIVE_AT))

  if (mode === 'activate') {
    const target = activateTarget!
    const present = (await db.select({ id: S.oikosGroups.id }).from(S.oikosGroups).where(inArray(S.oikosGroups.id, ourGroupIds))).map((g) => g.id)
    if (target !== 'zh-TW' && !present.includes(idFor(target as Locale, 'group'))) throw new Error(`the ${target} ledger is not seeded; run --apply --locale=${target} first`)
    console.log(`\n${write ? 'ACTIVATE' : 'DRY RUN — would activate'} ${target}:`)
    for (const l of LOCALES) {
      const gid = idFor(l, 'group')
      if (!present.includes(gid)) continue
      console.log(`  UPDATE "OikosGroups" SET current_epoch_started_at = ${(l === target ? ACTIVE_AT : INACTIVE_AT).toISOString()} WHERE id = ${gid}  (${l})`)
    }
    if (!write) return 0
    await db.transaction(async (tx) => {
      for (const l of LOCALES) {
        const gid = idFor(l, 'group')
        if (!present.includes(gid)) continue
        await tx.update(S.oikosGroups).set({ currentEpochStartedAt: l === target ? ACTIVE_AT : INACTIVE_AT }).where(eq(S.oikosGroups.id, gid))
      }
    })
    const after = await getActiveGroupForUser(members.A)
    const want = target === 'zh-TW' ? ZH_TW_GROUP_ID : idFor(target as Locale, 'group')
    console.log(`app shows Futa now: ${after?.id} "${after?.name}"`)
    if (after?.id !== want) throw new Error(`expected ${want} to be active`)
    return 0
  }

  for (const p of plans) {
    const ex = await existing(db, p)
    const state = ex.group ? `exists (${ex.cashOurs} of its expenses are ours, ${ex.cashForeign} are not)` : 'not seeded'
    console.log(`\n── ${p.locale}: ${state}`)
    if (mode === 'remove') {
      if (!ex.group) { console.log('  nothing to remove'); continue }
      console.log(`  ${write ? 'DELETE' : 'would DELETE'} by id: ${p.cash.length} CashTransactions, ${p.tripExpenses.length} TripExpenses, 1 Trips, ${p.assets.length} Assets + details, GroupBalance, GroupEpochs ${p.ids.epoch}, OikosGroups ${p.ids.group}`)
      console.log(`  ${write ? 'delete' : 'would delete'} ${path.relative(process.cwd(), path.join(DEMO_DATA_DIR, `${p.locale}.json`))} and ${p.locale}.capture.json`)
      if (ex.cashForeign) console.log(`  ⚠ ${ex.cashForeign} expense(s) on this ledger were not created by this script: the delete will fail and roll back`)
      continue
    }
    console.log(`  ${ex.group ? (write ? 'RE-CREATE (delete own rows, insert fresh)' : 'would RE-CREATE (delete own rows, insert fresh)') : (write ? 'INSERT' : 'would INSERT')}:`)
    printPlan(p, members)
    console.log(`  ${write ? 'write' : 'would write'} ${path.relative(process.cwd(), path.join(DEMO_DATA_DIR, `${p.locale}.json`))}:`)
    console.log(JSON.stringify(p.demoData, null, 2).replace(/^/gm, '    '))
  }

  if (!write) {
    console.log(`\nDRY RUN: nothing was written (database or files). ${mode === 'plan' ? 'Pass --apply, --remove or --activate=<locale> to write.' : 'Drop --dry-run to write.'}`)
    return 0
  }

  for (const p of plans) {
    const ex = await existing(db, p)
    if (mode === 'remove' && !ex.group) continue
    try {
      await db.transaction(async (tx) => {
        if (ex.group) await removeLocale(tx, p)
        if (mode === 'apply') await insertLocale(tx, p)
      })
    } catch (e) {
      const code = (e as { code?: string; cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code
      console.error(`✗ ${p.locale}: rolled back (${code === '23503' ? 'rows not created by this script still point at this ledger' : `database error ${code ?? 'unknown'}`}); nothing changed for ${p.locale}`)
      return 1
    }
    const file = path.join(DEMO_DATA_DIR, `${p.locale}.json`)
    if (mode === 'apply') {
      mkdirSync(DEMO_DATA_DIR, { recursive: true })
      writeFileSync(file, JSON.stringify(p.demoData, null, 2) + '\n')
      // A capture of the previous seeding no longer matches this one.
      rmSync(path.join(DEMO_DATA_DIR, `${p.locale}.capture.json`), { force: true })
      console.log(`✓ ${p.locale}: seeded ${p.ids.group}; wrote ${path.relative(process.cwd(), file)}`)
    } else {
      rmSync(file, { force: true })
      rmSync(path.join(DEMO_DATA_DIR, `${p.locale}.capture.json`), { force: true })
      console.log(`✓ ${p.locale}: removed`)
    }
  }
  const after = await getActiveGroupForUser(members.A)
  console.log(`app shows Futa now: ${after?.id} "${after?.name}"${mode === 'apply' ? ' (seeded ledgers start inactive; capture-screens --locale switches)' : ''}`)
  return 0
}

let code = 1
try {
  code = await main()
} catch (e) {
  console.error(`✗ ${e instanceof Error ? e.message : 'failed'}`)
} finally {
  // lib/db/client keeps a pool open; end the process explicitly.
  process.exit(code)
}
