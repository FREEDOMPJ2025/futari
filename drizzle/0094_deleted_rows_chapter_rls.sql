-- 0094 — rows deleted / processed in a chapter the viewer was not in stop at the chapter (#1531)
--
-- Withdraws, for these five tables, 0080's note "Not chapter-scoped, by
-- product design (ledger-scoped — a later partner sees them in the app too):
-- Assets, recurring rules, pending occurrences". That held for their LIVE
-- rows only. Rows deleted (or, for pendings, skipped / confirmed) in an
-- earlier chapter are never shown by the app, yet a partner who joined later
-- could still read them with their own session: GET /rest/v1/Assets returned
-- the names / notes / template fields of 愛物 deleted before they joined
-- (0075's column grants), and the rule / pending tables leaked the existence
-- and count of such rows (0080 left SELECT (id, group_id)). Realtime runs the
-- same policies (realtime.apply_rls re-selects the row as the subscriber).
-- 0080's rationale for GroupBalance, OikosGroups and PushTokens is unchanged.
--
-- Rule (the viewer = the caller, auth.uid(); same window as 0080's
-- viewer_in_chapter / lib/db/queries/_predicates.ts › viewerChaptersClause):
--   * Assets, RecurringIncomeRules, RecurringExpenseRules: a row with
--     deleted_at set is visible only if the viewer was in the chapter that
--     contains deleted_at. Live rows (deleted_at IS NULL) are unchanged —
--     paused rules too (0086's paused former-member rules are not deleted).
--     Assets keeps 0079's frozen-copy check: a deleted frozen copy must pass
--     BOTH checks.
--   * PendingIncomeOccurrences, PendingExpenseOccurrences (no deleted_at;
--     deleted cards are hard-deleted): a skipped row is visible only if the
--     viewer was in the chapter that contains skipped_at; a confirmed row
--     (resolved_tx_id set, no timestamp) is visible only if the viewer can
--     read the transaction it was recorded as. That sub-select runs as the
--     caller, so it inherits 0080's chapter policy on IncomeTransactions /
--     CashTransactions (resolved_tx_id references IncomeTransactions for
--     income pendings, CashTransactions for expense pendings — 0016, 0021).
--     Unprocessed rows are unchanged.
--
-- Why "deleted_at IS NULL OR viewer_in_chapter(…)" and not "deleted_at IS
-- NULL": the soft-delete / skip / confirm itself reaches current members as a
-- Realtime UPDATE frame, which realtime.apply_rls delivers only if the
-- subscriber can SELECT the committed (already deleted) row.
-- AssetDetailClient / SavingsView redirect on that frame's deleted_at, and
-- the dashboard refreshes on the rule / pending frames. A write made now is
-- in the current chapter, so both current members still get it.
--
-- What this does
--   REPLACES (DROP + CREATE, same names — never an added policy: permissive
--   policies are OR-ed, so an extra one could only widen access) the SELECT
--   policy of the five tables: the previous condition (0079's for Assets,
--   0045's for the other four) AND the rule above, now TO authenticated.
--   Every column is table-qualified (an unqualified column inside a
--   sub-select would bind to the sub-selected table's own column, with no
--   error). Reuses public.viewer_in_chapter (0080); no new function, no grant
--   change: a policy may read deleted_at / skipped_at / resolved_tx_id
--   although authenticated has SELECT only on (id, group_id) — column
--   privileges are checked for the query, not for the policy's own table
--   (checked on the PG 17 stand-in, #1531 step 1). The sub-selected
--   IncomeTransactions / CashTransactions keep their table SELECT (0080).
--   Server Drizzle (futari_app, BYPASSRLS), service_role, futari_backup and
--   the SECURITY DEFINER jobs (owner postgres) are unaffected.
--
-- What failure looks like
--   * Too tight (e.g. viewer_in_chapter loses EXECUTE, or a write starts
--     stamping a timestamp outside the current chapter): nothing errors; the
--     delete / skip / confirm frame silently stops reaching the other member,
--     so an open 愛物 page does not redirect and the dashboard does not
--     refresh until a reload (reloads read server-side and are fine).
--   * Too loose (a later migration re-creates one of these policies without
--     the chapter clause, or adds a permissive SELECT policy): nothing errors;
--     a later partner reads 愛物 deleted before they joined again.
--   * A ledger with no GroupEpochs row: its deleted / processed rows become
--     invisible to its members on the Data API and Realtime (fails closed;
--     0080's pre-check found none).
--
-- Order: runs after 0093 (journal: strictly increasing `when`). Independent
-- of the app code: the app does not read these tables through RLS.
--
-- Manual apply (dev):  psql "$DATABASE_URL_DIRECT" -1 -v ON_ERROR_STOP=1 -f drizzle/0094_deleted_rows_chapter_rls.sql
-- Post-check (read the catalog, not tool output):
--   SELECT tablename, policyname, cmd, permissive, roles, qual FROM pg_policies
--    WHERE schemaname = 'public' AND tablename IN ('Assets', 'RecurringIncomeRules',
--      'RecurringExpenseRules', 'PendingIncomeOccurrences', 'PendingExpenseOccurrences')
--    ORDER BY 1, 2;
--     → exactly one policy per table (the five names below), SELECT,
--       PERMISSIVE, {authenticated}, qual mentions viewer_in_chapter
--       (Assets also frozen_copy_visible; pendings also the transaction table).
--   The anon / authenticated privilege matrix is unchanged
--   (__tests__/actions/dataApiGrants1518.test.ts).
--
-- Rollback: scripts/rollback/0094_deleted_rows_chapter_rls.down.sql (restores
-- the five previous policies verbatim).
-- Idempotent: safe to re-apply.

DROP POLICY IF EXISTS "assets_group_member_select" ON "Assets";
--> statement-breakpoint
CREATE POLICY "assets_group_member_select" ON "Assets" FOR SELECT TO authenticated
  USING (
    "Assets"."group_id" IN (
      SELECT "OikosGroups"."id" FROM "OikosGroups"
      WHERE "OikosGroups"."member_a" = (select auth.uid()) OR "OikosGroups"."member_b" = (select auth.uid())
    )
    AND (
      "Assets"."frozen_at" IS NULL
      OR public.frozen_copy_visible("Assets"."group_id", "Assets"."frozen_at")
    )
    AND (
      "Assets"."deleted_at" IS NULL
      OR public.viewer_in_chapter("Assets"."group_id", "Assets"."deleted_at")
    )
  );
--> statement-breakpoint
DROP POLICY IF EXISTS "rules_group_member_select" ON "RecurringIncomeRules";
--> statement-breakpoint
CREATE POLICY "rules_group_member_select" ON "RecurringIncomeRules" FOR SELECT TO authenticated
  USING (
    "RecurringIncomeRules"."group_id" IN (
      SELECT "OikosGroups"."id" FROM "OikosGroups"
      WHERE "OikosGroups"."member_a" = (select auth.uid()) OR "OikosGroups"."member_b" = (select auth.uid())
    )
    AND (
      "RecurringIncomeRules"."deleted_at" IS NULL
      OR public.viewer_in_chapter("RecurringIncomeRules"."group_id", "RecurringIncomeRules"."deleted_at")
    )
  );
--> statement-breakpoint
DROP POLICY IF EXISTS "expense_rules_group_member_select" ON "RecurringExpenseRules";
--> statement-breakpoint
CREATE POLICY "expense_rules_group_member_select" ON "RecurringExpenseRules" FOR SELECT TO authenticated
  USING (
    "RecurringExpenseRules"."group_id" IN (
      SELECT "OikosGroups"."id" FROM "OikosGroups"
      WHERE "OikosGroups"."member_a" = (select auth.uid()) OR "OikosGroups"."member_b" = (select auth.uid())
    )
    AND (
      "RecurringExpenseRules"."deleted_at" IS NULL
      OR public.viewer_in_chapter("RecurringExpenseRules"."group_id", "RecurringExpenseRules"."deleted_at")
    )
  );
--> statement-breakpoint
DROP POLICY IF EXISTS "pendings_group_member_select" ON "PendingIncomeOccurrences";
--> statement-breakpoint
CREATE POLICY "pendings_group_member_select" ON "PendingIncomeOccurrences" FOR SELECT TO authenticated
  USING (
    "PendingIncomeOccurrences"."group_id" IN (
      SELECT "OikosGroups"."id" FROM "OikosGroups"
      WHERE "OikosGroups"."member_a" = (select auth.uid()) OR "OikosGroups"."member_b" = (select auth.uid())
    )
    AND (
      "PendingIncomeOccurrences"."skipped_at" IS NULL
      OR public.viewer_in_chapter("PendingIncomeOccurrences"."group_id", "PendingIncomeOccurrences"."skipped_at")
    )
    AND (
      "PendingIncomeOccurrences"."resolved_tx_id" IS NULL
      OR EXISTS (
        SELECT 1 FROM "IncomeTransactions"
         WHERE "IncomeTransactions"."id" = "PendingIncomeOccurrences"."resolved_tx_id"
      )
    )
  );
--> statement-breakpoint
DROP POLICY IF EXISTS "expense_pendings_group_member_select" ON "PendingExpenseOccurrences";
--> statement-breakpoint
CREATE POLICY "expense_pendings_group_member_select" ON "PendingExpenseOccurrences" FOR SELECT TO authenticated
  USING (
    "PendingExpenseOccurrences"."group_id" IN (
      SELECT "OikosGroups"."id" FROM "OikosGroups"
      WHERE "OikosGroups"."member_a" = (select auth.uid()) OR "OikosGroups"."member_b" = (select auth.uid())
    )
    AND (
      "PendingExpenseOccurrences"."skipped_at" IS NULL
      OR public.viewer_in_chapter("PendingExpenseOccurrences"."group_id", "PendingExpenseOccurrences"."skipped_at")
    )
    AND (
      "PendingExpenseOccurrences"."resolved_tx_id" IS NULL
      OR EXISTS (
        SELECT 1 FROM "CashTransactions"
         WHERE "CashTransactions"."id" = "PendingExpenseOccurrences"."resolved_tx_id"
      )
    )
  );
