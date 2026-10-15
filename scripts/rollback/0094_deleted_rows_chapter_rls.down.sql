-- ROLLBACK for drizzle/0094_deleted_rows_chapter_rls.sql — MANUAL ONLY, NEVER RUN AUTOMATICALLY.
-- Not a drizzle migration: drizzle-kit only runs files listed in drizzle/meta/_journal.json.
--
-- Usable on prod. This is the lever for "the other member stopped getting the
-- delete / skip / confirm live update after 0094" (an open 愛物 page does not
-- redirect, the dashboard does not refresh until a reload).
--
-- What it does:
--   1. Restores the five SELECT policies to their pre-0094 text, copied
--      verbatim: assets_group_member_select from
--      drizzle/0079_frozen_copy_visibility.sql (membership AND the frozen-copy
--      check); rules_group_member_select, expense_rules_group_member_select,
--      pendings_group_member_select, expense_pendings_group_member_select from
--      drizzle/0045_rls_auth_uid_initplan.sql (membership only). Like those,
--      without a TO clause (role PUBLIC); anon holds no grant on these tables
--      since 0080, so that is not wider in effect.
--   2. Removes 0094's row from drizzle.__drizzle_migrations, so the next
--      `db:migrate` re-applies 0094 (fix the cause first). Roll back any
--      migration recorded after 0094 first: drizzle-kit only applies journal
--      entries newer than the newest recorded one.
--   0094 changed no grant and created no function, so there is nothing else
--   to restore; the anon / authenticated privilege matrix stays exactly 0080's.
--
-- What comes back: #1531 — a partner who joined a ledger later can read, with
-- their own session, 愛物 (names, notes, template fields) deleted before they
-- joined, and the existence of recurring rules / pendings deleted, skipped or
-- confirmed before they joined. Failure look: nothing errors.
--
-- Run inside one transaction:  psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f <this file>

-- 1. policies
DROP POLICY IF EXISTS "assets_group_member_select" ON "Assets";
CREATE POLICY "assets_group_member_select" ON "Assets" FOR SELECT
  USING (
    "Assets"."group_id" IN (
      SELECT "OikosGroups"."id" FROM "OikosGroups"
      WHERE "OikosGroups"."member_a" = (select auth.uid()) OR "OikosGroups"."member_b" = (select auth.uid())
    )
    AND (
      "Assets"."frozen_at" IS NULL
      OR public.frozen_copy_visible("Assets"."group_id", "Assets"."frozen_at")
    )
  );

DROP POLICY IF EXISTS "rules_group_member_select" ON "RecurringIncomeRules";
CREATE POLICY "rules_group_member_select" ON "RecurringIncomeRules" FOR SELECT
  USING (group_id IN (
    SELECT id FROM "OikosGroups"
    WHERE member_a = (select auth.uid()) OR member_b = (select auth.uid())
  ));

DROP POLICY IF EXISTS "pendings_group_member_select" ON "PendingIncomeOccurrences";
CREATE POLICY "pendings_group_member_select" ON "PendingIncomeOccurrences" FOR SELECT
  USING (group_id IN (
    SELECT id FROM "OikosGroups"
    WHERE member_a = (select auth.uid()) OR member_b = (select auth.uid())
  ));

DROP POLICY IF EXISTS "expense_rules_group_member_select" ON "RecurringExpenseRules";
CREATE POLICY "expense_rules_group_member_select" ON "RecurringExpenseRules" FOR SELECT
  USING (group_id IN (
    SELECT id FROM "OikosGroups"
    WHERE member_a = (select auth.uid()) OR member_b = (select auth.uid())
  ));

DROP POLICY IF EXISTS "expense_pendings_group_member_select" ON "PendingExpenseOccurrences";
CREATE POLICY "expense_pendings_group_member_select" ON "PendingExpenseOccurrences" FOR SELECT
  USING (group_id IN (
    SELECT id FROM "OikosGroups"
    WHERE member_a = (select auth.uid()) OR member_b = (select auth.uid())
  ));

-- 2. migration bookkeeping
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1785000000000;
