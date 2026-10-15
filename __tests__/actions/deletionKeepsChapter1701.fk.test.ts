import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Sql } from 'postgres'
import { createStandInDb, dropStandInDb, isLocalUrl } from './_supabaseStandIn'

// ─── 0096: every foreign key into what _prune_ledger deletes is handled (#1701) ─
//
// LOCAL THROWAWAY SERVER ONLY (creates a stand-in database migrated through
// 0096 on the local server DATABASE_URL points at; skips otherwise).
//
//   DATABASE_URL=postgres://postgres:<pw>@localhost:<port>/postgres \
//     npx vitest run __tests__/actions/deletionKeepsChapter1701.fk.test.ts
//
// Run stand-in suites one file at a time (`--no-file-parallelism` when
// naming several): two createStandInDb migrating at once collide on the
// cluster-wide `ALTER ROLE futari_app` (`tuple concurrently updated`).
//
// _prune_ledger deletes rows from many tables of an orphan ledger, children
// first, and keeps a parent whenever a kept row references it. A foreign key
// added later into one of those tables (a new column pointing at Trips,
// Assets, …) is not in that order. Failure look: nothing errors at deploy;
// the next account deletion of a stayer with a past shared chapter fails
// every night with `process_account_deletions: failed for <uuid>` and the
// account is never deleted (the #1377 look), or a sweep WARNs forever and
// the orphan is never purged.
//
// When this fails: read the new FK, decide in _prune_ledger whether the child
// row is deleted before the parent or keeps the parent (FK closure), add a
// row of that kind to _deletionWorld1701.ts, then add the FK below.
// ──────────────────────────────────────────────────────────────────────────────

const adminUrl = process.env.DATABASE_URL ?? ''
const isLocalDb = isLocalUrl(adminUrl)
const postgres = (await import('postgres')).default

/**
 * Every FK into a table _prune_ledger deletes from (Profiles excepted: the
 * purge deletes a tombstone only in its own foreign_key_violation block, so
 * any reference just keeps it). `child.column -> parent (on delete)` and how
 * the prune handles it.
 */
const HANDLED: Record<string, string> = {
  // Assets: details deleted first; the rest keep the asset (closure) or go first.
  '"CarDetails".asset_id -> "Assets" a': 'all details deleted before Assets',
  '"ChildDetails".asset_id -> "Assets" a': 'all details deleted before Assets',
  '"HouseDetails".asset_id -> "Assets" a': 'all details deleted before Assets',
  '"PetDetails".asset_id -> "Assets" a': 'all details deleted before Assets',
  '"PlantDetails".asset_id -> "Assets" a': 'all details deleted before Assets',
  '"InsuranceDetails".asset_id -> "Assets" a': 'all details deleted before Assets',
  '"InsuranceDetails".insured_child_id -> "Assets" a': 'InsuranceDetails deleted before Assets',
  '"InsuranceDetails".vehicle_id -> "Assets" n': 'InsuranceDetails deleted before Assets',
  '"CashTransactions".asset_id -> "Assets" a': 'kept tx keeps its asset (v_assets closure); others deleted first',
  '"IncomeTransactions".asset_id -> "Assets" a': 'kept tx keeps its asset (v_assets closure); others deleted first',
  '"FuelLogs".asset_id -> "Assets" a': 'kept fuel log keeps its asset (closure); others deleted first',
  '"RecurringExpenseRules".asset_id -> "Assets" a': 'kept rule keeps its asset (closure); others deleted first',
  '"RecurringIncomeRules".asset_id -> "Assets" a': 'kept rule keeps its asset (closure); others deleted first',
  // Transactions: pendings first (kept only with their tx).
  '"PendingExpenseOccurrences".resolved_tx_id -> "CashTransactions" a': 'pending kept only if its tx is kept; deleted before CashTransactions',
  '"PendingIncomeOccurrences".resolved_tx_id -> "IncomeTransactions" a': 'pending kept only if its tx is kept; deleted before IncomeTransactions',
  '"CashTransactions".fuel_log_id -> "FuelLogs" a': 'kept tx keeps its fuel log (v_fuel closure); others deleted first',
  // Import files: links nulled, then all batches go.
  '"CashTransactions".import_batch_id -> "ImportBatches" a': 'import_batch_id set NULL before ImportBatches',
  '"IncomeTransactions".import_batch_id -> "ImportBatches" a': 'import_batch_id set NULL before ImportBatches',
  '"ImportErrors".batch_id -> "ImportBatches" c': 'cascade',
  '"InvoiceImportRuns".credential_id -> "InvoiceCredentials" n': 'runs deleted first (and SET NULL)',
  // Outings: subtree children-first (0066 order), outings of kept chapters kept whole.
  '"OutingExpenseShares".expense_id -> "OutingExpenses" a': 'shares deleted first',
  '"OutingExpenseShares".participant_id -> "OutingParticipants" a': 'shares deleted first',
  '"OutingExpenses".entered_by_participant_id -> "OutingParticipants" a': 'expenses deleted before participants',
  '"OutingExpenses".paid_by_participant_id -> "OutingParticipants" a': 'expenses deleted before participants',
  '"OutingSettlements".from_participant_id -> "OutingParticipants" a': 'settlements deleted before participants',
  '"OutingSettlements".to_participant_id -> "OutingParticipants" a': 'settlements deleted before participants',
  '"OutingExpenses".outing_id -> "Outings" a': 'subtree deleted before Outings',
  '"OutingParticipants".outing_id -> "Outings" a': 'subtree deleted before Outings',
  '"OutingSettlements".outing_id -> "Outings" a': 'subtree deleted before Outings',
  '"PartnerQuizAnswers".session_id -> "PartnerQuizSessions" a': 'answers deleted first',
  // Rules: pendings cascade, and are decided before the rules anyway.
  '"PendingExpenseOccurrences".rule_id -> "RecurringExpenseRules" c': 'pending kept only with its rule; cascade',
  '"PendingIncomeOccurrences".rule_id -> "RecurringIncomeRules" c': 'pending kept only with its rule; cascade',
  // Trips: trip expenses outside kept chapters first; a kept tx keeps its trip.
  '"CashTransactions".trip_id -> "Trips" a': 'kept tx keeps its trip (v_trips closure); others deleted first',
  '"TripExpenses".trip_id -> "Trips" a': 'expenses of non-kept trips deleted first',
}

let url = ''
let pg: Sql

describe.skipIf(!isLocalDb)('0096 — FK catalog of _prune_ledger (#1701 acceptance k)', () => {
  beforeAll(async () => {
    url = await createStandInDb(adminUrl, '0096')
    pg = postgres(url, { max: 1, onnotice: () => {} })
  }, 180_000)
  afterAll(async () => {
    await pg?.end()
    if (url) await dropStandInDb(adminUrl, url)
  })

  it('every FK into a table the prune deletes from is listed and handled', async () => {
    const [{ src }] = await pg<{ src: string }[]>`
      SELECT prosrc AS src FROM pg_proc WHERE oid = 'public._prune_ledger(uuid, uuid)'::regprocedure`
    const deleted = [...new Set([...src.matchAll(/DELETE FROM "([A-Za-z]+)"/g)].map((m) => m[1]))]
      .filter((t) => t !== 'Profiles').sort()
    // Guard the parse itself: these must be among them.
    for (const t of ['Assets', 'Trips', 'CashTransactions', 'Outings', 'ImportBatches', 'MonthlyReviewMessages']) {
      expect(deleted).toContain(t)
    }
    const fks = await pg<{ fk: string }[]>`
      SELECT c.conrelid::regclass::text || '.' ||
             (SELECT string_agg(a.attname, ',' ORDER BY a.attnum) FROM pg_attribute a
               WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey))
             || ' -> ' || c.confrelid::regclass::text || ' ' || c.confdeltype::text AS fk
        FROM pg_constraint c
       WHERE c.contype = 'f'
         AND c.confrelid IN (SELECT ('public.' || quote_ident(t))::regclass FROM unnest(${deleted}::text[]) t)
       ORDER BY 1`
    expect(fks.map((r) => r.fk).sort()).toEqual(Object.keys(HANDLED).sort())
  })

  it('every child table of those FKs is touched by the prune (deleted or its link cleared)', async () => {
    const [{ src }] = await pg<{ src: string }[]>`
      SELECT prosrc AS src FROM pg_proc WHERE oid = 'public._prune_ledger(uuid, uuid)'::regprocedure`
    const children = [...new Set(Object.keys(HANDLED).map((k) => k.slice(1, k.indexOf('"', 1))))]
    const untouched = children.filter((t) => !new RegExp(`(DELETE FROM|UPDATE) "${t}"`).test(src))
    // ImportErrors goes by cascade with its batch.
    expect(untouched).toEqual(['ImportErrors'])
  })
})
