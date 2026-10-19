// The CSV export's scope (#1460): every chapter the viewer may look back at,
// across ledgers, and the expense / income / settlement rows recorded in
// them. Why this scope, what is left out and the known limits:
// docs/superpowers/specs/csv-export-design.md.
import { sql, type SQL } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { withChapterNames } from '@/lib/db/queries/epoch'
import { leftAwareName } from '@/lib/leftPartnerLabel'
import type { SplitType } from '@/lib/balance'
import { viewerShares, type Slot, type ViewerShares } from '@/lib/exportShares'

export type ExportRowKind = 'expense' | 'income' | 'settlement'

/**
 * The chapters `viewerId` may export, as a WHERE over `"GroupEpochs" e` joined
 * to `"OikosGroups" g` — the #1612 look-back rule ({@link listEpochsForViewer}
 * / `pinAcceptable` in epoch.ts), resolved here from the viewer id alone:
 * the viewer is named on the chapter, its group still exists (the inner join),
 * and the viewer is still a member of that group OR the chapter is closed.
 *
 * Never widen this with a group id from a request or with OikosGroups
 * membership alone: a ledger's open chapter belongs to whoever is in it now,
 * and a chapter the viewer was never named on belongs to other people. The
 * failure is silent — the CSV just carries their rows.
 */
function exportableChapterWhere(viewerId: string): SQL {
  return sql`(e."member_a_id" = ${viewerId}::uuid OR e."member_b_id" = ${viewerId}::uuid)
    AND (g."member_a" = ${viewerId}::uuid OR g."member_b" = ${viewerId}::uuid OR e."ended_at" IS NOT NULL)`
}

const ISO_UTC = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`
const TAIPEI_YMD = `'YYYY-MM-DD'`

export interface ExportChapter {
  id: string
  groupId: string
  /** Asia/Taipei calendar dates, for the CSV's 章節 column. */
  startDate: string
  endDate: string | null
  memberAId: string
  memberBId: string | null
  /** Closed chapter: the snapshot frozen at its close (null: none taken).
   *  Open chapter: the live name. Never a live name for a closed chapter.
   *  #1782 — a slot marked as the left label is the export locale's label
   *  (the file leaves the app, so it must read in the viewer's language). */
  memberAName: string | null
  memberBName: string | null
  /** Trusted current slot of each person (see lib/exportShares.ts). */
  memberASlotNow: Slot | null
  memberBSlotNow: Slot | null
  /** The group's base currency TODAY (no history is kept — documented limit). */
  baseCurrency: string
}

interface ChapterDbRow extends Record<string, unknown> {
  id: string
  group_id: string
  start_date: string
  end_date: string | null
  ended_at_iso: string | null
  member_a_id: string
  member_b_id: string | null
  member_a_name: string | null
  member_b_name: string | null
  member_a_name_is_left_label: boolean
  member_b_name_is_left_label: boolean
  a_slot: Slot | null
  b_slot: Slot | null
  base_currency: string
}

export interface ExportDbRow {
  kind: ExportRowKind
  id: string
  groupId: string
  chapterId: string
  /** Event date (expense / settlement: Asia/Taipei day of transacted_at /
   *  settled_at; income: occurred_at), YYYY-MM-DD. */
  date: string
  description: string | null
  amount: number
  originalAmount: number | null
  originalCurrency: string | null
  category: string | null
  /** paid_by (expense, settlement) or recipient_id (income). */
  personId: string
  splitType: SplitType | null
  splitRatioA: number | null
  status: 'settled' | 'pending' | null
  notes: string | null
}

interface RowDbRow extends Record<string, unknown> {
  kind: ExportRowKind
  id: string
  group_id: string
  chapter_id: string
  event_date: string
  description: string | null
  amount: number
  original_amount: number | null
  original_currency: string | null
  category: string | null
  person_id: string
  split_type: SplitType | null
  split_ratio_a: number | null
  status: 'settled' | 'pending' | null
  notes: string | null
}

/** One CSV line before labels: everything resolved for the viewer. */
export interface ExportLedgerRow {
  kind: ExportRowKind
  date: string
  description: string | null
  amount: number
  currency: string
  originalAmount: number | null
  originalCurrency: string | null
  category: string | null
  /** Payer (expense, settlement) or recipient (income); null ⇒ neutral label. */
  personName: string | null
  /** Settlement only: who received it. `undefined` ⇒ blank cell (not a
   *  settlement, or nobody to name); null ⇒ neutral label. */
  toName: string | null | undefined
  shares: ViewerShares | null
  status: 'settled' | 'pending' | null
  notes: string | null
  chapter: {
    startDate: string
    endDate: string | null
    /** The other person of the chapter; `undefined` for a solo chapter,
     *  null when no name was recorded (neutral label). */
    partnerName: string | null | undefined
  }
}

export interface LedgerExport {
  rows: ExportLedgerRow[]
  /** Raw rows with their group / chapter ids — for tests and the audit counts. */
  dbRows: ExportDbRow[]
  chapters: ExportChapter[]
}

/**
 * Everything `viewerId` exports, read in one REPEATABLE READ, read-only
 * transaction so the chapter list and the rows describe the same moment.
 *
 * Rows: active (`deleted_at IS NULL`) CashTransactions — pending included,
 * trip summary rows included, TripExpenses never (they are folded into those
 * summaries; exporting both would count a trip twice) — IncomeTransactions
 * and Settlements, of every exportable chapter.
 *
 * A row belongs to the chapter its `created_at` falls in; a row older than its
 * ledger's FIRST chapter belongs to that first chapter (the rule of
 * `viewerChaptersClause`, applied per group: `is_first` is computed over all
 * of the group's chapters, not only the exportable ones). So each row lands in
 * at most one chapter and is exported at most once; a row whose chapter is not
 * exportable for the viewer is not exported.
 *
 * Order: event date desc, then created_at desc.
 */
export async function getLedgerExportForViewer(
  viewerId: string,
  /** #1782 — `t.common.leftPartnerLabel` of the locale the file is exported
   *  in: a marked name slot is written as this. */
  leftPartnerLabel: string,
): Promise<LedgerExport> {
  return db.transaction(async (tx) => {
    const chapterRows = await tx.execute<ChapterDbRow>(sql`
      SELECT
        e."id", e."group_id",
        to_char(e."started_at" AT TIME ZONE 'Asia/Taipei', ${sql.raw(TAIPEI_YMD)}) AS start_date,
        to_char(e."ended_at" AT TIME ZONE 'Asia/Taipei', ${sql.raw(TAIPEI_YMD)}) AS end_date,
        to_char(e."ended_at" AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) AS ended_at_iso,
        e."member_a_id", e."member_b_id", e."member_a_name", e."member_b_name",
        e."member_a_name_is_left_label", e."member_b_name_is_left_label",
        g."base_currency"::text AS base_currency,
        -- A person's slot is trusted only if they are named on EVERY chapter
        -- of the ledger from this one through the open one, and hold a slot
        -- now (lib/exportShares.ts says why).
        CASE WHEN NOT EXISTS (
               SELECT 1 FROM "GroupEpochs" le
               WHERE le."group_id" = e."group_id" AND le."started_at" >= e."started_at"
                 AND le."member_a_id" IS DISTINCT FROM e."member_a_id"
                 AND le."member_b_id" IS DISTINCT FROM e."member_a_id")
             THEN CASE WHEN g."member_a" = e."member_a_id" THEN 'a'
                       WHEN g."member_b" = e."member_a_id" THEN 'b' END
        END AS a_slot,
        CASE WHEN e."member_b_id" IS NOT NULL AND NOT EXISTS (
               SELECT 1 FROM "GroupEpochs" le
               WHERE le."group_id" = e."group_id" AND le."started_at" >= e."started_at"
                 AND le."member_a_id" IS DISTINCT FROM e."member_b_id"
                 AND le."member_b_id" IS DISTINCT FROM e."member_b_id")
             THEN CASE WHEN g."member_a" = e."member_b_id" THEN 'a'
                       WHEN g."member_b" = e."member_b_id" THEN 'b' END
        END AS b_slot
      FROM "GroupEpochs" e
      JOIN "OikosGroups" g ON g."id" = e."group_id"
      WHERE ${exportableChapterWhere(viewerId)}
    `)

    const rowRows = await tx.execute<RowDbRow>(sql`
      WITH q AS (
        SELECT e."id", e."group_id", e."started_at", e."ended_at",
               e."started_at" = (
                 SELECT min(fe."started_at") FROM "GroupEpochs" fe WHERE fe."group_id" = e."group_id"
               ) AS is_first
        FROM "GroupEpochs" e
        JOIN "OikosGroups" g ON g."id" = e."group_id"
        WHERE ${exportableChapterWhere(viewerId)}
      ),
      r AS (
        SELECT 'expense'::text AS kind, ct."id", ct."group_id", ct."created_at",
               to_char(ct."transacted_at" AT TIME ZONE 'Asia/Taipei', ${sql.raw(TAIPEI_YMD)}) AS event_date,
               ct."description" AS description, ct."amount",
               ct."original_amount", ct."original_currency"::text AS original_currency,
               ct."category", ct."paid_by" AS person_id,
               ct."split_type"::text AS split_type, ct."split_ratio_a",
               ct."status"::text AS status, ct."notes" AS notes
        FROM "CashTransactions" ct
        WHERE ct."deleted_at" IS NULL AND ct."group_id" IN (SELECT q."group_id" FROM q)
        UNION ALL
        SELECT 'income', it."id", it."group_id", it."created_at",
               to_char(it."occurred_at", ${sql.raw(TAIPEI_YMD)}),
               it."source", it."amount",
               it."original_amount", it."original_currency"::text,
               it."category", it."recipient_id",
               NULL, NULL, NULL, NULL
        FROM "IncomeTransactions" it
        WHERE it."deleted_at" IS NULL AND it."group_id" IN (SELECT q."group_id" FROM q)
        UNION ALL
        SELECT 'settlement', s."id", s."group_id", s."created_at",
               to_char(s."settled_at" AT TIME ZONE 'Asia/Taipei', ${sql.raw(TAIPEI_YMD)}),
               NULL, s."amount",
               NULL, NULL,
               NULL, s."paid_by",
               NULL, NULL, NULL, s."note"
        FROM "Settlements" s
        WHERE s."deleted_at" IS NULL AND s."group_id" IN (SELECT q."group_id" FROM q)
      )
      SELECT r."kind", r."id", r."group_id", ch."id" AS chapter_id, r."event_date",
             r."description", r."amount", r."original_amount", r."original_currency",
             r."category", r."person_id", r."split_type", r."split_ratio_a",
             r."status", r."notes"
      FROM r
      JOIN LATERAL (
        SELECT q."id" FROM q
        WHERE q."group_id" = r."group_id"
          AND (q."ended_at" IS NULL OR r."created_at" < q."ended_at")
          AND (r."created_at" >= q."started_at" OR q.is_first)
        ORDER BY q."started_at" DESC
        LIMIT 1
      ) ch ON true
      ORDER BY r."event_date" DESC, r."created_at" DESC, r."id"
    `)

    // #1604 / #1612: closed chapter → snapshot (or null), open → live name.
    const named = await withChapterNames(
      Array.from(chapterRows, (c) => ({
        ...c,
        endedAt: c.ended_at_iso ? new Date(c.ended_at_iso) : null,
        memberAId: c.member_a_id,
        memberBId: c.member_b_id,
        memberAName: c.member_a_name,
        memberBName: c.member_b_name,
        memberANameIsLeftLabel: c.member_a_name_is_left_label,
        memberBNameIsLeftLabel: c.member_b_name_is_left_label,
      })),
      tx,
    )
    const chapters: ExportChapter[] = named.map((c) => ({
      id: c.id,
      groupId: c.group_id,
      startDate: c.start_date,
      endDate: c.end_date,
      memberAId: c.memberAId,
      memberBId: c.memberBId,
      memberAName: leftAwareName(c.memberAName, leftPartnerLabel),
      memberBName: leftAwareName(c.memberBName, leftPartnerLabel),
      memberASlotNow: c.a_slot,
      memberBSlotNow: c.b_slot,
      baseCurrency: c.base_currency,
    }))

    const dbRows: ExportDbRow[] = Array.from(rowRows, (r) => ({
      kind: r.kind,
      id: r.id,
      groupId: r.group_id,
      chapterId: r.chapter_id,
      date: r.event_date,
      description: r.description,
      amount: Number(r.amount),
      originalAmount: r.original_amount === null ? null : Number(r.original_amount),
      originalCurrency: r.original_currency,
      category: r.category,
      personId: r.person_id,
      splitType: r.split_type,
      splitRatioA: r.split_ratio_a === null ? null : Number(r.split_ratio_a),
      status: r.status,
      notes: r.notes,
    }))

    return { rows: resolveExportRows(dbRows, chapters, viewerId), dbRows, chapters }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

/** The name of `personId` as the chapter recorded it; null if they are not in it. */
function nameInChapter(chapter: ExportChapter, personId: string): string | null {
  if (personId === chapter.memberAId) return chapter.memberAName
  if (personId === chapter.memberBId) return chapter.memberBName
  return null
}

/**
 * Per-row names and shares. Pure apart from its inputs; exported for tests.
 * A row whose chapter is missing from `chapters` is dropped (fails closed).
 */
export function resolveExportRows(
  dbRows: readonly ExportDbRow[],
  chapters: readonly ExportChapter[],
  viewerId: string,
): ExportLedgerRow[] {
  const byId = new Map(chapters.map((c) => [c.id, c]))
  const out: ExportLedgerRow[] = []
  for (const r of dbRows) {
    const ch = byId.get(r.chapterId)
    if (!ch) continue

    const viewerIsA = ch.memberAId === viewerId
    const partnerName = viewerIsA
      ? (ch.memberBId ? ch.memberBName : undefined)
      : ch.memberAName

    let toName: string | null | undefined
    if (r.kind === 'settlement') {
      const other = r.personId === ch.memberAId ? ch.memberBId
        : r.personId === ch.memberBId ? ch.memberAId
        : null
      toName = other ? nameInChapter(ch, other) : undefined
    }

    out.push({
      kind: r.kind,
      date: r.date,
      description: r.description,
      amount: r.amount,
      currency: ch.baseCurrency,
      originalAmount: r.originalAmount,
      originalCurrency: r.originalCurrency,
      category: r.category,
      personName: nameInChapter(ch, r.personId),
      toName,
      shares: r.kind === 'expense' && r.splitType
        ? viewerShares({ splitType: r.splitType, splitRatioA: r.splitRatioA, paidBy: r.personId }, ch, viewerId)
        : null,
      status: r.kind === 'expense' ? r.status : null,
      notes: r.notes,
      chapter: { startDate: ch.startDate, endDate: ch.endDate, partnerName },
    })
  }
  return out
}
