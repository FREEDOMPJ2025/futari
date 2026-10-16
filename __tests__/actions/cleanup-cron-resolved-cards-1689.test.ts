import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import postgres from 'postgres'
import { loadEnvLocal } from '../outing/_setup'
import { seedAuthUsers, deleteAuthUsers } from './_authUser'

// ─── #1689: the weekly cleanup survives confirmed recurring cards ───────────
//
// Integration test against the real DEV database (admin connection). Needs
// 0097 applied only for the last test; the first two run the migration files'
// own bodies inside transactions that always roll back, so the live cron job
// is never touched. Excluded from CI with the rest of __tests__/actions/**.
//
// Failure looked like: the app shows nothing; cron.job_run_details has
// cleanup-soft-deleted failing every Sunday with 23503, and soft-deleted rows
// are never purged.
//
// The negative control is permanent: 0069's body (the one this replaced) must
// still fail with 23503 on the same data 0097's body cleans. If it ever stops
// failing, the fixture no longer builds the shape the bug needs and the green
// result for 0097 means nothing.
// ──────────────────────────────────────────────────────────────────────────────

loadEnvLocal()
vi.setConfig({ testTimeout: 60_000 })

const MIG_0069 = readFileSync(resolve(__dirname, '../../drizzle/0069_invoice_credential_retention.sql'), 'utf-8')
const MIG_0097 = readFileSync(resolve(__dirname, '../../drizzle/0097_cleanup_cron_resolved_cards.sql'), 'utf-8')
const CRON_RE = /cron\.schedule\('cleanup-soft-deleted', '0 3 \* \* 0', \$\$([\s\S]*?)\$\$\);/
const CRON_0069 = CRON_RE.exec(MIG_0069)![1]
const CRON_0097 = CRON_RE.exec(MIG_0097)![1]

const ROLLBACK = new Error('rollback')
let pg: postgres.Sql

const uA = randomUUID()
const uB = randomUUID()
let groupId = ''

// Everything the suite inserts, by id, so teardown is exact.
const ids = {
  txOld: '', txNew: '', txYoung: '',
  inOld: '', inNew: '', inYoung: '',
  cardOld: '', cardYoung: '', incCardOld: '', incCardYoung: '',
  settlement: '', ruleE: '', ruleI: '',
}

/** Runs `body` in a transaction on the admin connection and always rolls back. */
async function inRolledBackTx(body: (tx: postgres.TransactionSql) => Promise<void>) {
  await expect(pg.begin(async (tx) => {
    await body(tx)
    throw ROLLBACK
  })).rejects.toBe(ROLLBACK)
}

const count = async (tx: postgres.Sql | postgres.TransactionSql, table: string, id: string) => {
  const [r] = await tx.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${table}" WHERE id = $1`, [id])
  return r.n
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL_DIRECT!
  expect(new URL(url).username).toContain('ufhcprrauwsxdmscbkrf') // dev project, never prod
  pg = postgres(url, { max: 1, prepare: false, onnotice: () => {} })

  await pg`INSERT INTO "Profiles" (id, display_name) VALUES (${uA}, '我'), (${uB}, '伴')`
  await seedAuthUsers([{ id: uA, displayName: '我' }, { id: uB, displayName: '伴' }])
  const [g] = await pg<{ id: string }[]>`
    INSERT INTO "OikosGroups" (name, member_a, member_b, current_epoch_started_at, base_currency)
    VALUES ('TEST_1689', ${uA}, ${uB}, now() - interval '30 months', 'twd') RETURNING id`
  groupId = g.id
  await pg`INSERT INTO "GroupEpochs" (group_id, started_at, ended_at, member_a_id, member_b_id)
           VALUES (${groupId}, now() - interval '30 months', NULL, ${uA}, ${uB})`
  await pg`INSERT INTO "GroupBalance" (group_id, balance) VALUES (${groupId}, 0)`

  const [re] = await pg<{ id: string }[]>`
    INSERT INTO "RecurringExpenseRules"
      (group_id, paid_by, amount, split_type, description, category, day_of_month, starts_on, next_occurrence_at)
    VALUES (${groupId}, ${uA}, 100, 'half', 'TEST_1689', 'housing', 1, '2025-01-01', '2030-01-01') RETURNING id`
  const [ri] = await pg<{ id: string }[]>`
    INSERT INTO "RecurringIncomeRules"
      (group_id, recipient_id, amount, category, day_of_month, starts_on, next_occurrence_at)
    VALUES (${groupId}, ${uA}, 100, 'salary', 1, '2025-01-01', '2030-01-01') RETURNING id`
  ids.ruleE = re.id
  ids.ruleI = ri.id

  const cashTx = async (deletedAgo: string | null) => {
    const [t] = await pg<{ id: string }[]>`
      INSERT INTO "CashTransactions"
        (group_id, paid_by, amount, split_type, description, category, transacted_at, deleted_at)
      VALUES (${groupId}, ${uA}, 100, 'half', 'TEST_1689', 'housing', now() - interval '14 months',
              ${deletedAgo === null ? null : pg`now() - ${deletedAgo}::interval`}) RETURNING id`
    return t.id
  }
  const incomeTx = async (deletedAgo: string | null) => {
    const [t] = await pg<{ id: string }[]>`
      INSERT INTO "IncomeTransactions" (group_id, recipient_id, amount, category, occurred_at, deleted_at)
      VALUES (${groupId}, ${uA}, 100, 'salary', now()::date - 420,
              ${deletedAgo === null ? null : pg`now() - ${deletedAgo}::interval`}) RETURNING id`
    return t.id
  }
  const expenseCard = async (period: string, txId: string) => {
    const [c] = await pg<{ id: string }[]>`
      INSERT INTO "PendingExpenseOccurrences"
        (group_id, rule_id, period_start, proposed_amount, proposed_date, proposed_description,
         proposed_paid_by, proposed_split_type, resolved_tx_id)
      VALUES (${groupId}, ${ids.ruleE}, ${period}, 100, ${period}, 'TEST_1689', ${uA}, 'half', ${txId})
      RETURNING id`
    return c.id
  }
  const incomeCard = async (period: string, txId: string) => {
    const [c] = await pg<{ id: string }[]>`
      INSERT INTO "PendingIncomeOccurrences"
        (group_id, rule_id, period_start, proposed_amount, proposed_date, resolved_tx_id)
      VALUES (${groupId}, ${ids.ruleI}, ${period}, 100, ${period}, ${txId}) RETURNING id`
    return c.id
  }

  // The bug's shape: confirm (card -> tx), then "edit" = soft-delete the old
  // row and insert a new one. The card keeps pointing at the soft-deleted old
  // row; the old row's deleted_at is 13 months ago.
  ids.txOld = await cashTx('13 months')
  ids.txNew = await cashTx(null)
  ids.cardOld = await expenseCard('2025-08-01', ids.txOld)
  ids.inOld = await incomeTx('13 months')
  ids.inNew = await incomeTx(null)
  ids.incCardOld = await incomeCard('2025-08-01', ids.inOld)

  // Control for "must NOT be deleted": the same shape, soft-deleted 6 months ago.
  ids.txYoung = await cashTx('6 months')
  ids.cardYoung = await expenseCard('2025-09-01', ids.txYoung)
  ids.inYoung = await incomeTx('6 months')
  ids.incCardYoung = await incomeCard('2025-09-01', ids.inYoung)

  // Another table the same command cleans: proves the rest of it ran.
  const [s] = await pg<{ id: string }[]>`
    INSERT INTO "Settlements" (group_id, paid_by, amount, settled_at, deleted_at)
    VALUES (${groupId}, ${uA}, 50, now() - interval '14 months', now() - interval '13 months') RETURNING id`
  ids.settlement = s.id
})

afterAll(async () => {
  try {
    if (pg && groupId) {
      await pg`DELETE FROM "PendingExpenseOccurrences" WHERE group_id = ${groupId}`
      await pg`DELETE FROM "PendingIncomeOccurrences" WHERE group_id = ${groupId}`
      await pg`DELETE FROM "CashTransactions" WHERE group_id = ${groupId}`
      await pg`DELETE FROM "IncomeTransactions" WHERE group_id = ${groupId}`
      await pg`DELETE FROM "Settlements" WHERE group_id = ${groupId}`
      await pg`DELETE FROM "RecurringExpenseRules" WHERE group_id = ${groupId}`
      await pg`DELETE FROM "RecurringIncomeRules" WHERE group_id = ${groupId}`
      await pg`DELETE FROM "GroupBalance" WHERE group_id = ${groupId}`
      await pg`DELETE FROM "GroupEpochs" WHERE group_id = ${groupId}`
      await pg`DELETE FROM "OikosGroups" WHERE id = ${groupId}`
      await pg`DELETE FROM "Profiles" WHERE id IN (${uA}, ${uB})`
      const [{ n }] = await pg<{ n: number }[]>`
        SELECT (SELECT count(*) FROM "CashTransactions" WHERE group_id = ${groupId})
             + (SELECT count(*) FROM "PendingExpenseOccurrences" WHERE group_id = ${groupId})
             + (SELECT count(*) FROM "OikosGroups" WHERE id = ${groupId}) AS n`
      console.log(`[#1689] leftover rows for the test ledger: ${n}`)
      expect(Number(n)).toBe(0)
    }
  } finally {
    await deleteAuthUsers([uA, uB])
    await pg?.end()
  }
})

describe('#1689 cleanup-soft-deleted vs. confirmed recurring cards', () => {
  it('fixture: the cards point at soft-deleted transactions', async () => {
    const rows = await pg<{ n: number }[]>`
      SELECT count(*)::int AS n FROM "PendingExpenseOccurrences" p
      JOIN "CashTransactions" t ON t.id = p.resolved_tx_id
      WHERE p.group_id = ${groupId} AND t.deleted_at IS NOT NULL`
    expect(rows[0].n).toBe(2)
  })

  it('negative control: 0069 body fails with 23503 on this data', async () => {
    let code: string | undefined
    await expect(pg.begin(async (tx) => {
      try {
        await tx.unsafe(CRON_0069)
      } catch (e) {
        code = (e as { code?: string }).code
        throw e
      }
    })).rejects.toThrow()
    expect(code).toBe('23503')
    // Nothing was left behind: the failed command rolled back as one.
    expect(await count(pg, 'CashTransactions', ids.txOld)).toBe(1)
    expect(await count(pg, 'Settlements', ids.settlement)).toBe(1)
  })

  it('0097 body succeeds on the same data and purges only what is past the year', async () => {
    await inRolledBackTx(async (tx) => {
      await tx.unsafe(CRON_0097)
      // Past the year: transactions, their cards, and an unrelated table.
      expect(await count(tx, 'CashTransactions', ids.txOld)).toBe(0)
      expect(await count(tx, 'PendingExpenseOccurrences', ids.cardOld)).toBe(0)
      expect(await count(tx, 'IncomeTransactions', ids.inOld)).toBe(0)
      expect(await count(tx, 'PendingIncomeOccurrences', ids.incCardOld)).toBe(0)
      expect(await count(tx, 'Settlements', ids.settlement)).toBe(0)
      // The edited-in replacement rows stay.
      expect(await count(tx, 'CashTransactions', ids.txNew)).toBe(1)
      expect(await count(tx, 'IncomeTransactions', ids.inNew)).toBe(1)
      // Soft-deleted less than a year ago: transaction and card both stay.
      expect(await count(tx, 'CashTransactions', ids.txYoung)).toBe(1)
      expect(await count(tx, 'PendingExpenseOccurrences', ids.cardYoung)).toBe(1)
      expect(await count(tx, 'IncomeTransactions', ids.inYoung)).toBe(1)
      expect(await count(tx, 'PendingIncomeOccurrences', ids.incCardYoung)).toBe(1)
    })
    // The rollback restored everything.
    expect(await count(pg, 'CashTransactions', ids.txOld)).toBe(1)
  })

  it('the live cron job runs 0097 body (needs 0097 applied)', async () => {
    const [job] = await pg<{ command: string }[]>`
      SELECT command FROM cron.job WHERE jobname = 'cleanup-soft-deleted'`
    expect(job.command).toBe(CRON_0097)
  })
})
