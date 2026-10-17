import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ─── #1782 — 0099 redefines process_account_deletions: 0096's body + markers ─
//
// The deletion body is long; a copy that drifts from 0096 by one line changes
// what an account deletion keeps or destroys, and nothing errors until a real
// deletion runs. This compares the text: the only lines that may differ are
// the four that gain a marker assignment, and each must be 0096's line with
// exactly that assignment added. The rollback file must restore 0096's and
// 0088's bodies verbatim, and drop the columns only after both functions.
// ──────────────────────────────────────────────────────────────────────────

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

/** The CREATE OR REPLACE … through the GRANT of process_account_deletions in `sql`. */
function deletionBlock(sql: string): string[] {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.process_account_deletions()')
  const grant = 'GRANT EXECUTE ON FUNCTION public.process_account_deletions() TO postgres, service_role;'
  const end = sql.indexOf(grant, start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return sql.slice(start, end + grant.length).split('\n')
}

const ADDED: [string, string][] = [
  ["        SET profile_id = NULL, display_name = '已離開的夥伴',",
    "        SET profile_id = NULL, display_name = '已離開的夥伴', display_name_is_left_label = true,"],
  [`      UPDATE "GroupEpochs" SET member_a_name = '已離開的夥伴' WHERE member_a_id = v_uid;`,
    `      UPDATE "GroupEpochs" SET member_a_name = '已離開的夥伴', member_a_name_is_left_label = true WHERE member_a_id = v_uid;`],
  [`      UPDATE "GroupEpochs" SET member_b_name = '已離開的夥伴' WHERE member_b_id = v_uid;`,
    `      UPDATE "GroupEpochs" SET member_b_name = '已離開的夥伴', member_b_name_is_left_label = true WHERE member_b_id = v_uid;`],
  ["        SET display_name = '已離開的夥伴', avatar_url = NULL, deletion_requested_at = NULL",
    "        SET display_name = '已離開的夥伴', is_tombstone = true, avatar_url = NULL, deletion_requested_at = NULL"],
]

describe('0099 process_account_deletions vs 0096', () => {
  const v96 = deletionBlock(read('drizzle/0096_deletion_keeps_shared_chapter.sql'))
  const v99 = deletionBlock(read('drizzle/0099_left_label_marker.sql'))

  it('same number of lines, and only the four marker lines differ — each exactly as 0096 plus its assignment', () => {
    expect(v99).toHaveLength(v96.length)
    const diffs = v96.map((line, i) => [line, v99[i]] as [string, string]).filter(([a, b]) => a !== b)
    expect(diffs).toEqual(ADDED)
  })

  it('keeps 0096\'s header and grants (SECURITY DEFINER, pinned search_path, owner, EXECUTE)', () => {
    const text = v99.join('\n')
    expect(text).toContain('LANGUAGE plpgsql\nSECURITY DEFINER\nSET search_path = public, pg_temp\nAS $fn$')
    expect(text).toContain('ALTER FUNCTION public.process_account_deletions() OWNER TO postgres;')
    expect(text).toContain('REVOKE EXECUTE ON FUNCTION public.process_account_deletions() FROM PUBLIC, anon, authenticated;')
  })
})

describe('0099 snapshot_epoch_member_names', () => {
  const sql = read('drizzle/0099_left_label_marker.sql')
  it('stays SECURITY INVOKER with a pinned search_path, EXECUTE revoked; the marker comes from a COALESCEd subquery', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.snapshot_epoch_member_names()\nRETURNS trigger\nLANGUAGE plpgsql\nSECURITY INVOKER\nSET search_path = public, pg_temp')
    expect(sql).toContain('REVOKE EXECUTE ON FUNCTION public.snapshot_epoch_member_names() FROM PUBLIC, anon, authenticated;')
    expect(sql).toContain('NEW.member_a_name_is_left_label := COALESCE(\n      (SELECT p.is_tombstone FROM "Profiles" p WHERE p.id = NEW.member_a_id), false);')
    expect(sql).toContain('NEW.member_b_name_is_left_label := COALESCE(\n      (SELECT p.is_tombstone FROM "Profiles" p WHERE p.id = NEW.member_b_id), false);')
    // No grant to a client role anywhere in the migration.
    expect(sql).not.toMatch(/GRANT[^;]*\b(anon|authenticated)\b/)
  })
})

describe('scripts/rollback/0099_left_label_marker.down.sql', () => {
  const down = read('scripts/rollback/0099_left_label_marker.down.sql')
  const strip = (s: string) => s.split('\n').filter((l) => l !== '--> statement-breakpoint').join('\n')

  it('restores 0096\'s deletion body and 0088\'s trigger body verbatim', () => {
    expect(down).toContain(strip(deletionBlock(read('drizzle/0096_deletion_keeps_shared_chapter.sql')).join('\n')))
    const v88 = read('drizzle/0088_epoch_name_snapshot.sql')
    const s = v88.indexOf('CREATE OR REPLACE FUNCTION public.snapshot_epoch_member_names()')
    const revoke = 'REVOKE EXECUTE ON FUNCTION public.snapshot_epoch_member_names() FROM PUBLIC, anon, authenticated;'
    expect(down).toContain(strip(v88.slice(s, v88.indexOf(revoke, s) + revoke.length)))
  })

  it('drops the columns only after both functions are restored', () => {
    const lastFn = Math.max(
      down.lastIndexOf('GRANT EXECUTE ON FUNCTION public.process_account_deletions()'),
      down.lastIndexOf('REVOKE EXECUTE ON FUNCTION public.snapshot_epoch_member_names()'),
    )
    const firstDrop = down.indexOf('DROP COLUMN')
    expect(lastFn).toBeGreaterThan(-1)
    expect(firstDrop).toBeGreaterThan(lastFn)
    expect(down.match(/DROP COLUMN IF EXISTS/g)).toHaveLength(4)
  })
})
