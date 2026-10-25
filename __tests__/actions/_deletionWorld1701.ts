// ─── #1701 fixtures: a stayer, a leaver and a shared chapter ───────────────
//
// Shared by the 0096 suites (deletionKeepsChapter1701*.test.ts). Everything
// is raw SQL on a local stand-in database (createStandInDb), so it can call
// the SECURITY DEFINER jobs and write auth.users. Every row the fixture
// inserts is recorded (table, label, key column, id), so a test can ask
// "which of these still exist" and compare against the expected labels.
//
// Timeline of `world()` (fixed dates; the run must happen after 2026-07-20):
//   E0  D alone        2026-01-10 → 2026-02-10   (the ledger's first chapter)
//   E1  D + X          2026-02-10 → 2026-07-20   (the shared chapter)
//   E2  D alone        2026-07-20 → open         (after X left)
//   NX  X's own ledger from 2026-07-20, untouched by everything here.
// Labels say where a row sits: *Pre = E0, *In = E1, *Post = E2.

import { createHash, randomUUID } from 'node:crypto'
import type { Sql, TransactionSql } from 'postgres'

export const TOMB = '已離開的夥伴'

type Db = Sql | TransactionSql

export interface Recorded {
  table: string
  label: string
  key: string
  id: string
}

export class Recorder {
  rows: Recorded[] = []
  constructor(private sql: Db) {}

  /** INSERT a row, record it under `label`, return its key (id by default). */
  async ins(table: string, label: string, row: Record<string, unknown>, key = 'id'): Promise<string> {
    const s = this.sql
    const [r] = await s<{ k: string }[]>`
      INSERT INTO ${s(table)} ${s(row as Record<string, never>)} RETURNING ${s(key)}::text AS k`
    this.rows.push({ table, label, key, id: r.k })
    return r.k
  }

  /** Labels of recorded rows that still exist, per table (sorted). */
  async surviving(tables?: string[]): Promise<Record<string, string[]>> {
    const out: Record<string, string[]> = {}
    for (const r of this.rows) {
      if (tables && !tables.includes(r.table)) continue
      const s = this.sql
      const [{ n }] = await s<{ n: number }[]>`
        SELECT count(*)::int AS n FROM ${s(r.table)} WHERE ${s(r.key)}::text = ${r.id}`
      if (n > 0) (out[r.table] ??= []).push(r.label)
    }
    for (const k of Object.keys(out)) out[k].sort()
    return out
  }

  /** label → md5 of the whole row, for every recorded row that still exists. */
  async fingerprint(): Promise<Record<string, string>> {
    const out: Record<string, string> = {}
    for (const r of this.rows) {
      const s = this.sql
      const rows = await s<{ h: string }[]>`
        SELECT md5(x::text) AS h FROM ${s(r.table)} x WHERE ${s(r.key)}::text = ${r.id}`
      if (rows.length > 0) out[`${r.table}:${r.label}`] = rows.map((x) => x.h).sort().join(',')
    }
    return out
  }

  id(label: string): string {
    const r = this.rows.find((x) => x.label === label)
    if (!r) throw new Error(`no recorded row ${label}`)
    return r.id
  }
}

/** A Profiles row, plus its auth.users row unless `alive: false`. */
export async function person(sql: Db, name: string, alive = true): Promise<string> {
  const id = randomUUID()
  if (alive) {
    // handle_new_user (on_auth_user_created) inserts the Profiles row.
    await sql`
      INSERT INTO auth.users (id, email, raw_user_meta_data)
      VALUES (${id}, ${`${id}@example.invalid`}, jsonb_build_object('full_name', ${name}::text))`
  }
  await sql`
    INSERT INTO "Profiles" (id, display_name) VALUES (${id}, ${name})
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`
  return id
}

/** Ask for deletion `daysAgo` days ago (15 = due now; 1 = pending, not due). */
export async function requestDeletion(sql: Db, id: string, daysAgo = 15) {
  await sql`UPDATE "Profiles" SET deletion_requested_at = now() - make_interval(days => ${daysAgo}) WHERE id = ${id}`
}

export interface EpochSpec {
  label: string
  start: string
  end: string | null
  a: string
  b: string | null
}

/** A ledger whose GroupEpochs rows are `epochs` (the last one decides the members). */
export async function ledger(rec: Recorder, sql: Db, label: string, name: string, epochs: EpochSpec[], balance = 0) {
  const last = epochs[epochs.length - 1]
  const open = last.end === null
  const g = await rec.ins('OikosGroups', label, {
    name,
    member_a: last.a,
    member_b: open ? last.b : null,
    current_epoch_started_at: new Date(last.start),
  })
  await sql`INSERT INTO "GroupBalance" (group_id, balance, version) VALUES (${g}, ${balance}, 0)`
  const ids: Record<string, string> = {}
  for (const e of epochs) {
    ids[e.label] = await rec.ins('GroupEpochs', e.label, {
      group_id: g, started_at: new Date(e.start), ended_at: e.end ? new Date(e.end) : null,
      member_a_id: e.a, member_b_id: e.b,
    })
  }
  return { g, epochs: ids }
}

export const at = (iso: string) => new Date(iso)

/** CashTransactions row. */
export function cash(rec: Recorder, g: string, label: string, paidBy: string, created: string,
  extra: Record<string, unknown> = {}) {
  return rec.ins('CashTransactions', label, {
    group_id: g, paid_by: paidBy, amount: 1000, split_type: 'half', description: `d ${label}`,
    category: 'dining', transacted_at: at(created), created_at: at(created), ...extra,
  })
}

export interface World {
  rec: Recorder
  D: string
  X: string
  G: string
  NX: string
  E0: string
  E1: string
  E2: string
}

/**
 * The main #1701 world. D stays in G after X left; D is the one who will be
 * deleted. Every kind of row the prune decides on, on both sides of E1.
 */
export async function world(sql: Db, tag: string, opts: { xAlive?: boolean } = {}): Promise<World> {
  const rec = new Recorder(sql)
  const D = await person(sql, `${tag} D real name`)
  const X = await person(sql, `${tag} X`, opts.xAlive !== false)

  const { g: G, epochs } = await ledger(rec, sql, 'G', `${tag} D 的家計簿`, [
    { label: 'E0', start: '2026-01-10T00:00:00Z', end: '2026-02-10T00:00:00Z', a: D, b: null },
    { label: 'E1', start: '2026-02-10T00:00:00Z', end: '2026-07-20T00:00:00Z', a: D, b: X },
    { label: 'E2', start: '2026-07-20T00:00:00Z', end: null, a: D, b: null },
  ], 500)
  const { g: NX } = await ledger(rec, sql, 'NX', `${tag} X ledger`, [
    { label: 'NX0', start: '2026-07-20T00:00:00Z', end: null, a: X, b: null },
  ])
  await cash(rec, NX, 'nxOwn', X, '2026-08-01T00:00:00Z', { split_type: 'all_mine' })
  const { E0, E1, E2 } = epochs

  // ── assets ──
  const asset = (label: string, type: string, created: string, extra: Record<string, unknown> = {}) =>
    rec.ins('Assets', label, {
      group_id: G, type, name: `n ${label}`, created_at: at(created), notes: `note ${label}`,
      template_fields: { secret: label }, name_encrypted: `enc ${label}`, ...extra,
    })
  const carPre = await asset('carPre', 'car', '2026-01-15T00:00:00Z')
  await rec.ins('CarDetails', 'carPre.details', { asset_id: carPre, plate_encrypted: 'enc plate', primary_user_id: D }, 'asset_id')
  const childPre = await asset('childPre', 'child', '2026-01-20T00:00:00Z')
  await rec.ins('ChildDetails', 'childPre.details', { asset_id: childPre, id_number_encrypted: 'enc id', nickname: 'nick' }, 'asset_id')
  const petIn = await asset('petIn', 'pet', '2026-03-01T00:00:00Z')
  await rec.ins('PetDetails', 'petIn.details', { asset_id: petIn, chip_no: 'chip' }, 'asset_id')
  const childPost = await asset('childPost', 'child', '2026-08-02T00:00:00Z')
  await rec.ins('ChildDetails', 'childPost.details', { asset_id: childPost, id_number_encrypted: 'enc id2' }, 'asset_id')
  const carPost = await asset('carPost', 'car', '2026-08-03T00:00:00Z')
  // Kept policy whose insured child and linked car were created after E1.
  const insIn = await asset('insIn', 'insurance', '2026-03-02T00:00:00Z')
  await rec.ins('InsuranceDetails', 'insIn.details', {
    asset_id: insIn, currency: 'twd', insured_type: 'child', insured_child_id: childPost, vehicle_id: carPost,
    policy_number: 'secret policy', insured_user_id: X,
  }, 'asset_id')
  const houseDelIn = await asset('houseDelIn', 'house', '2026-01-12T00:00:00Z', { deleted_at: at('2026-04-01T00:00:00Z') })
  await rec.ins('HouseDetails', 'houseDelIn.details', { asset_id: houseDelIn, owner: D, address_encrypted: 'enc addr' }, 'asset_id')
  const plantDelPost = await asset('plantDelPost', 'plant', '2026-03-03T00:00:00Z', { deleted_at: at('2026-08-04T00:00:00Z') })
  await rec.ins('PlantDetails', 'plantDelPost.details', { asset_id: plantDelPost, location: 'loc' }, 'asset_id')
  // Deleted after E1, but a kept transaction points at it: kept by FK closure.
  const itemRef = await asset('itemRefByKeptTx', 'item', '2026-03-05T00:00:00Z', { deleted_at: at('2026-08-05T00:00:00Z') })

  // ── fuel logs ──
  const fuelIn = await rec.ins('FuelLogs', 'fuelIn', {
    asset_id: carPre, liters: '30', fuel_type: '95', odometer: 100, logged_at: at('2026-03-10T00:00:00Z'), created_at: at('2026-03-10T00:00:00Z'),
  })
  await rec.ins('FuelLogs', 'fuelPost', {
    asset_id: carPre, liters: '31', fuel_type: '95', odometer: 200, logged_at: at('2026-08-10T00:00:00Z'), created_at: at('2026-08-10T00:00:00Z'),
  })
  // #1706 — a fuel log older than E1 (written in E0) and a kept E1 transaction
  // pointing at it (an edit of an older fuel record is a new row that keeps
  // fuel_log_id): kept only by the FK closure. Without the closure the prune's
  // DELETE FROM "FuelLogs" hits CashTransactions.fuel_log_id and raises.
  const fuelPreRef = await rec.ins('FuelLogs', 'fuelPreRef', {
    asset_id: carPre, liters: '29', fuel_type: '95', odometer: 50, logged_at: at('2026-01-18T00:00:00Z'), created_at: at('2026-01-18T00:00:00Z'),
  })
  // Older than E1 and referenced by nothing kept: the lower bound removes it.
  await rec.ins('FuelLogs', 'fuelPre', {
    asset_id: carPre, liters: '28', fuel_type: '95', odometer: 40, logged_at: at('2026-01-19T00:00:00Z'), created_at: at('2026-01-19T00:00:00Z'),
  })

  // ── trips ──
  const trip = (label: string, epoch: string, created: string) => rec.ins('Trips', label, {
    group_id: G, epoch_id: epoch, name: `trip ${label}`, start_date: created.slice(0, 10), created_at: at(created),
    cover_photo_url: `https://example.invalid/${label}.jpg`, budget_amount: 9000, budget_currency: 'TWD',
  })
  const tPre = await trip('tripPre', E0, '2026-01-25T00:00:00Z')
  const tIn = await trip('tripIn', E1, '2026-05-01T00:00:00Z')
  const tPost = await trip('tripPost', E2, '2026-08-06T00:00:00Z')
  const te = (label: string, tripId: string, created: string) => rec.ins('TripExpenses', label, {
    trip_id: tripId, paid_by: D, amount: 100, category: 'dining', split_type: 'half', description: `te ${label}`, created_at: at(created),
  })
  await te('tePre', tPre, '2026-01-26T00:00:00Z')
  await te('teIn', tIn, '2026-05-02T00:00:00Z')
  await te('teInLate', tIn, '2026-08-07T00:00:00Z') // added after E1 to a trip of E1: the trip page shows it
  await te('tePost', tPost, '2026-08-07T00:00:00Z')

  // ── import batches ──
  const batchIn = await rec.ins('ImportBatches', 'batchIn', {
    group_id: G, imported_by: X, source: 'futari_generic', file_name: 'x-bank.csv', total_rows: 2, created_at: at('2026-04-08T00:00:00Z'),
  })
  await rec.ins('ImportErrors', 'batchIn.error', { batch_id: batchIn, row_number: 2, raw_row: { raw: 'secret row' }, error_type: 'parse_error' })
  const batchPost = await rec.ins('ImportBatches', 'batchPost', {
    group_id: G, imported_by: D, source: 'futari_generic', file_name: 'd.csv', total_rows: 1, created_at: at('2026-08-03T00:00:00Z'),
  })

  // ── cash ──
  await cash(rec, G, 'cashPre', D, '2026-01-20T00:00:00Z')
  await cash(rec, G, 'cashInD', D, '2026-03-05T00:00:00Z')
  await cash(rec, G, 'cashInX', X, '2026-04-05T00:00:00Z', { asset_id: itemRef, notes: 'typed by X' })
  await cash(rec, G, 'cashInDeleted', X, '2026-04-06T00:00:00Z', { deleted_at: at('2026-04-07T00:00:00Z') })
  await cash(rec, G, 'cashInImported', X, '2026-04-08T00:00:00Z', { import_batch_id: batchIn })
  await cash(rec, G, 'cashInTripPre', D, '2026-05-01T00:00:00Z', { trip_id: tPre })
  await cash(rec, G, 'cashInTripIn', X, '2026-05-02T00:00:00Z', { trip_id: tIn })
  await cash(rec, G, 'cashInFuel', D, '2026-03-10T00:00:00Z', { asset_id: carPre, fuel_log_id: fuelIn })
  await cash(rec, G, 'cashInFuelOld', D, '2026-03-12T00:00:00Z', { asset_id: carPre, fuel_log_id: fuelPreRef })
  const cashResIn = await cash(rec, G, 'cashResolvedIn', D, '2026-03-15T00:00:00Z')
  const cashResPost = await cash(rec, G, 'cashResolvedPost', D, '2026-08-15T00:00:00Z')
  await cash(rec, G, 'cashPost', D, '2026-08-01T00:00:00Z')
  await cash(rec, G, 'cashPostTrip', D, '2026-08-02T00:00:00Z', { trip_id: tPost })
  await cash(rec, G, 'cashPostImported', D, '2026-08-03T00:00:00Z', { import_batch_id: batchPost })

  // ── income ──
  const income = (label: string, who: string, created: string, extra: Record<string, unknown> = {}) =>
    rec.ins('IncomeTransactions', label, {
      group_id: G, recipient_id: who, amount: 700, category: 'salary', source: `s ${label}`,
      occurred_at: created.slice(0, 10), created_at: at(created), ...extra,
    })
  await income('incomeIn', X, '2026-03-20T00:00:00Z', { import_batch_id: batchIn })
  const incResIn = await income('incomeResolvedIn', D, '2026-03-21T00:00:00Z')
  await income('incomePost', D, '2026-08-20T00:00:00Z')
  await income('incomePre', D, '2026-01-21T00:00:00Z') // E0: before E1, which is not the earliest chapter

  // ── settlements ──
  const settle = (label: string, created: string) => rec.ins('Settlements', label, {
    group_id: G, paid_by: X, amount: 300, settled_at: at(created), created_at: at(created), note: `note ${label}`,
  })
  await settle('settleIn', '2026-05-10T00:00:00Z')
  await settle('settlePost', '2026-08-10T00:00:00Z')
  await settle('settlePre', '2026-01-22T00:00:00Z') // E0, as incomePre

  // ── recurring rules + pendings ──
  const eRule = (label: string, created: string, extra: Record<string, unknown> = {}) => rec.ins('RecurringExpenseRules', label, {
    group_id: G, paid_by: D, amount: 300, split_type: 'half', description: `r ${label}`, category: 'housing',
    interval_months: 1, day_of_month: 1, starts_on: '2026-01-01', next_occurrence_at: '2026-01-01', created_at: at(created), ...extra,
  })
  const rPre = await eRule('rulePre', '2026-01-11T00:00:00Z', { asset_id: carPre })
  await eRule('ruleIn', '2026-03-01T00:00:00Z')
  await eRule('ruleDelIn', '2026-03-02T00:00:00Z', { deleted_at: at('2026-04-02T00:00:00Z') })
  await eRule('ruleDelPost', '2026-03-03T00:00:00Z', { deleted_at: at('2026-08-03T00:00:00Z') })
  const rPost = await eRule('rulePost', '2026-08-04T00:00:00Z')
  const iRule = (label: string, created: string) => rec.ins('RecurringIncomeRules', label, {
    group_id: G, recipient_id: D, amount: 700, category: 'salary', source: `ir ${label}`,
    interval_months: 1, day_of_month: 1, starts_on: '2026-01-01', next_occurrence_at: '2026-01-01', created_at: at(created),
  })
  const irIn = await iRule('incomeRuleIn', '2026-03-01T00:00:00Z')
  await iRule('incomeRulePost', '2026-08-04T00:00:00Z')

  const pend = (label: string, rule: string, period: string, extra: Record<string, unknown> = {}) => rec.ins('PendingExpenseOccurrences', label, {
    group_id: G, rule_id: rule, period_start: period, proposed_amount: 300, proposed_date: period,
    proposed_description: 'p', proposed_paid_by: D, proposed_split_type: 'half', ...extra,
  })
  await pend('pendResolvedIn', rPre, '2026-03-01', { resolved_tx_id: cashResIn })
  await pend('pendResolvedPost', rPre, '2026-08-01', { resolved_tx_id: cashResPost })
  await pend('pendSkippedIn', rPre, '2026-04-01', { skipped_at: at('2026-04-10T00:00:00Z') })
  await pend('pendSkippedPost', rPre, '2026-09-01', { skipped_at: at('2026-09-10T00:00:00Z') })
  await pend('pendOpen', rPre, '2026-10-01')
  await pend('pendOpenRulePost', rPost, '2026-09-01')
  const pendInc = (label: string, period: string, extra: Record<string, unknown> = {}) => rec.ins('PendingIncomeOccurrences', label, {
    group_id: G, rule_id: irIn, period_start: period, proposed_amount: 700, proposed_date: period, ...extra,
  })
  await pendInc('pendIncResolvedIn', '2026-03-01', { resolved_tx_id: incResIn })
  await pendInc('pendIncOpen', '2026-10-01')

  // ── outings ──
  const outing = async (label: string, epoch: string, created: string) => {
    const o = await rec.ins('Outings', label, {
      group_id: G, epoch_id: epoch, created_by: D, name: `outing ${label}`, currency: 'twd', created_at: at(created),
      share_token_hash: `hash ${label}`, share_token_encrypted: `enc ${label}`, share_token_rotated_at: at(created),
    })
    const pD = await rec.ins('OutingParticipants', `${label}.pD`, { outing_id: o, display_name: `${tag} D real name`, profile_id: D })
    const pX = await rec.ins('OutingParticipants', `${label}.pX`, { outing_id: o, display_name: `${tag} X`, profile_id: X })
    const pF = await rec.ins('OutingParticipants', `${label}.pF`, {
      outing_id: o, display_name: 'friend', claim_token_hash: `claim ${label}`, claimed_at: at(created),
    })
    const e = await rec.ins('OutingExpenses', `${label}.expense`, {
      outing_id: o, paid_by_participant_id: pX, entered_by_participant_id: pX, amount: 900, description: 'bbq', created_at: at(created),
    })
    for (const [k, p] of [['pD', pD], ['pX', pX], ['pF', pF]] as const) {
      await rec.ins('OutingExpenseShares', `${label}.share.${k}`, { expense_id: e, participant_id: p, share_amount: 300 })
    }
    await rec.ins('OutingSettlements', `${label}.settlement`, {
      outing_id: o, from_participant_id: pF, to_participant_id: pX, amount: 300, created_at: at(created),
    })
  }
  await outing('outingIn', E1, '2026-06-01T00:00:00Z')
  await outing('outingPost', E2, '2026-08-08T00:00:00Z')

  // ── monthly review ──
  const snap = (label: string, year: number, month: number) => rec.ins('MonthlyReviewSnapshots', label, {
    group_id: G, year, month, largest_expense_amount: 1000, largest_expense_description: 'big',
    largest_expense_paid_by: D, largest_expense_paid_by_name: `${tag} D real name`,
  })
  await snap('snapApr', 2026, 4) // whole month inside E1
  await snap('snapJan', 2026, 1) // straddles E0 / nothing
  await snap('snapSep', 2026, 9) // inside E2
  // #1706 — months that straddle E1's edges: a review shows a month only if it
  // lies WHOLLY inside the chapter, so neither is kept (a rule widened by a
  // month would keep both).
  await snap('snapFeb', 2026, 2) // Feb 1 → Mar 1; E1 starts Feb 10
  await snap('snapJul', 2026, 7) // Jul 1 → Aug 1; E1 ends Jul 20
  const msg = (label: string, who: string, year: number, month: number, created: string) =>
    rec.ins('MonthlyReviewMessages', label, { group_id: G, member_id: who, year, month, body: `b ${label}`, created_at: at(created) })
  await msg('msgAprX', X, 2026, 4, '2026-05-02T00:00:00Z')
  await msg('msgAprD', D, 2026, 4, '2026-05-03T00:00:00Z')
  await msg('msgMayDLate', D, 2026, 5, '2026-08-01T00:00:00Z') // written after E1 closed
  await msg('msgSepD', D, 2026, 9, '2026-10-01T00:00:00Z')
  await msg('msgJanX', X, 2026, 1, '2026-03-01T00:00:00Z') // month outside E1
  // Right author, written inside E1, but for a month that straddles E1's end:
  // only the month rule drops it.
  await msg('msgJulX', X, 2026, 7, '2026-07-10T00:00:00Z')

  // ── things that never survive in an orphan ──
  const quiz = await rec.ins('PartnerQuizSessions', 'quizIn', { group_id: G, epoch_id: E1, question_keys: ['q1'] })
  await rec.ins('PartnerQuizAnswers', 'quizIn.answer', { session_id: quiz, member_id: X, question_key: 'q1', choice_key: 'a' })
  await rec.ins('GroupInvites', 'inviteOpen', {
    group_id: G, invited_by: D, expires_at: at('2099-01-01T00:00:00Z'), token_hash: `tok ${tag}`,
  })
  const cred = await rec.ins('InvoiceCredentials', 'invoiceCred', {
    group_id: G, user_id: D, barcode: '/ABC1234', verification_code_encrypted: 'enc code',
  })
  await rec.ins('InvoiceImportRuns', 'invoiceRun', {
    group_id: G, user_id: D, credential_id: cred, range_start: '2026-08-01', range_end: '2026-08-31',
  })
  await rec.ins('InvoiceImportSnapshots', 'invoiceSnap', {
    group_id: G, invoice_number: `AB${tag.replace(/\W/g, '').slice(0, 8)}`, imported_amount: 1, imported_description: 'x',
    imported_category: 'other', invoice_date: '2026-08-01', merchant_name: 'shop',
  }, 'invoice_number')
  await rec.ins('CurrencyRates', 'rate', { group_id: G, from_currency: 'usd', to_currency: 'twd', rate: '31.5' }, 'group_id')
  // Well-formed per platform, so this world still builds once 0101's CHECK is
  // in (#1827): APNs = 64 hex, FCM = [A-Za-z0-9_:-]. Derived from `tag` so
  // each world's tokens differ.
  const tokenHex = (who: string) => createHash('sha256').update(`${who} ${tag}`).digest('hex')
  await rec.ins('PushTokens', 'pushD', { user_id: D, group_id: G, platform: 'apns', token: tokenHex('tD') })
  await rec.ins('PushTokens', 'pushX', { user_id: X, group_id: G, platform: 'fcm', token: `tX:${tokenHex('tX')}` })

  return { rec, D, X, G, NX, E0, E1, E2 }
}

/** What each table of `world()` keeps after D's deletion while X is alive. */
export const KEPT_AFTER_D: Record<string, string[]> = {
  OikosGroups: ['G', 'NX'],
  GroupEpochs: ['E0', 'E1', 'E2', 'NX0'],
  Assets: ['carPre', 'childPre', 'houseDelIn', 'insIn', 'itemRefByKeptTx', 'petIn'],
  FuelLogs: ['fuelIn', 'fuelPreRef'],
  Trips: ['tripIn', 'tripPre'],
  TripExpenses: ['teIn', 'teInLate'],
  CashTransactions: [
    'cashInD', 'cashInDeleted', 'cashInFuel', 'cashInFuelOld', 'cashInImported', 'cashInTripIn', 'cashInTripPre', 'cashInX',
    'cashResolvedIn', 'nxOwn',
  ],
  IncomeTransactions: ['incomeIn', 'incomeResolvedIn'],
  Settlements: ['settleIn'],
  RecurringExpenseRules: ['ruleDelIn', 'ruleIn', 'rulePre'],
  RecurringIncomeRules: ['incomeRuleIn'],
  PendingExpenseOccurrences: ['pendResolvedIn', 'pendSkippedIn'],
  PendingIncomeOccurrences: ['pendIncResolvedIn'],
  Outings: ['outingIn'],
  OutingParticipants: ['outingIn.pD', 'outingIn.pF', 'outingIn.pX'],
  OutingExpenses: ['outingIn.expense'],
  OutingExpenseShares: ['outingIn.share.pD', 'outingIn.share.pF', 'outingIn.share.pX'],
  OutingSettlements: ['outingIn.settlement'],
  MonthlyReviewSnapshots: ['snapApr'],
  MonthlyReviewMessages: ['msgAprD', 'msgAprX'],
}

/** Every public table with a group_id column, for "0 rows of this ledger" checks. */
export async function groupScopedTables(sql: Db): Promise<string[]> {
  const rows = await sql<{ t: string }[]>`
    SELECT c.table_name AS t FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = 'public' AND c.column_name = 'group_id' AND t.table_type = 'BASE TABLE'
     ORDER BY 1`
  return rows.map((r) => r.t)
}

/** Rows of ledger `g` in every group_id table (only non-zero counts). */
export async function ledgerRowCounts(sql: Db, g: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const t of await groupScopedTables(sql)) {
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ${sql(t)} WHERE group_id = ${g}`
    if (n > 0) out[t] = n
  }
  const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM "OikosGroups" WHERE id = ${g}`
  if (n > 0) out.OikosGroups = n
  return out
}
