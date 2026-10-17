// 匯出的範圍（viewer 可以回看的每一段章節、跨帳本；支出含 pending、進帳、結算）、
// 分攤欄的規則與已知限制，見 docs/superpowers/specs/csv-export-design.md。
import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/supabase/server'
import { getLedgerExportForViewer } from '@/lib/db/queries/export'
import { getTranslations } from '@/lib/i18n/t'
import { buildExportFilename, buildTransactionsCsv, exportLabelsFor } from '@/lib/csv/transactions'
import { captureServer } from '@/lib/analytics/server'

export const dynamic = 'force-dynamic'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // Trust boundary (#1460): the scope is resolved from the signed-in user's id
  // alone, inside the query — the chapters they may look back at (#1612 rule),
  // in any ledger. Nothing from the request widens it, and no active ledger is
  // required: a removed partner with no ledger exports the closed chapters
  // they were in, and someone with none gets a header-only file.
  // #1782 — a name slot marked as the left label is written in the export's
  // language (the same locale as the column headers).
  const t = await getTranslations()
  const ledger = await getLedgerExportForViewer(user.id, t.common.leftPartnerLabel)

  const csv = buildTransactionsCsv(ledger.rows, exportLabelsFor(t))
  const filename = buildExportFilename(t.csvExport.filenamePrefix)

  // Audit trail: who exported and how much, per kind. Never the content, and
  // no ids — the chapters can belong to ledgers other people use now.
  // captureServer never throws and only sends from the prod deploy.
  const count = (kind: string) => ledger.rows.filter((r) => r.kind === kind).length
  await captureServer(user.id, 'transactions_exported', {
    row_count: ledger.rows.length,
    expense_count: count('expense'),
    income_count: count('income'),
    settlement_count: count('settlement'),
    chapter_count: ledger.chapters.length,
    group_count: new Set(ledger.chapters.map((c) => c.groupId)).size,
  })

  return new NextResponse(csv, {
    status: 200,
    headers: {
      // text/csv with explicit utf-8 charset; the leading BOM still helps Excel.
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  })
}
