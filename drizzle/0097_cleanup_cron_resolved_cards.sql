-- 0097: the weekly cleanup no longer trips over confirmed recurring cards
-- (#1689).
-- positioning: docs/superpowers/specs/recurring-design.md (the confirmed card's
-- resolved_tx_id is an audit pointer, nothing reads the transaction through it).
-- issue: #1689 (option A of the plan: the cron removes the cards itself).
--
-- Why: PendingExpenseOccurrences.resolved_tx_id -> CashTransactions.id and
-- PendingIncomeOccurrences.resolved_tx_id -> IncomeTransactions.id have no ON
-- DELETE (0021, 0016). A card is written once, at confirmation. "Editing" a
-- transaction is soft-delete + insert, so after an edit the confirmed card
-- keeps pointing at the soft-deleted old row. A year later the cleanup cron's
-- first statement (DELETE FROM "CashTransactions" WHERE deleted_at < ...) hits
-- the FK (23503). The cron command runs as one transaction, so the whole thing
-- rolls back: no table is cleaned that week, and the same happens every week
-- after. The cron only ever removed SKIPPED cards (skipped_at > 90 days);
-- confirmed cards were never removed.
--
-- Fix: the command deletes, first, the confirmed cards whose transaction it is
-- about to purge. The rest of the command is 0069's body verbatim (copy from
-- the highest-numbered owner, never an older one: see 0066 / #1376). Nothing
-- else changes: no schema, no app code, "pending" still means
-- skipped_at IS NULL AND resolved_tx_id IS NULL.
--
-- Who reads a non-NULL resolved_tx_id, and why none of them cares about a card
-- whose transaction was soft-deleted over a year ago:
--   - 0093 compute_monthly_review_snapshot, card 3: joins the transaction and
--     requires t.deleted_at IS NULL, so such a card is never counted; and a
--     snapshot is write-once, the month it covers closed long ago.
--   - 0094 SELECT RLS on both pending tables: "resolved_tx_id IS NULL OR the
--     transaction is visible". It only decides whether the card is visible; the
--     card going away makes nothing wrong.
--   - actions/membership.ts leaveGroup: deletes cards with resolved_tx_id IS NOT
--     NULL. A deleter, it does not need the card to exist.
-- The card generator (0064) never re-creates a purged period: next_occurrence_at
-- has long moved past it, and ON CONFLICT (rule_id, period_start) DO NOTHING.
-- Account deletion (0096) already deletes cards before transactions.
--
-- Failure looked like (if this regresses): nothing errors in the app.
-- cron.job_run_details shows cleanup-soft-deleted failing every Sunday with
-- 23503, and soft-deleted rows (including transactions past the year) are never
-- purged, contradicting the privacy policy ("removed about 1 year later").
-- Prod had 0 such rows when this was written (2026-10-17); the earliest
-- possible first failure was 2027-05.
--
-- Rollback: reschedule 0069's body in a new migration. The two added
-- statements delete only year-old confirmed cards nobody reads.
DO $$
BEGIN
  PERFORM cron.unschedule('cleanup-soft-deleted');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
--> statement-breakpoint

SELECT cron.schedule('cleanup-soft-deleted', '0 3 * * 0', $$
  DELETE FROM "PendingExpenseOccurrences" WHERE resolved_tx_id IN (SELECT id FROM "CashTransactions"   WHERE deleted_at < NOW() - INTERVAL '1 year');
  DELETE FROM "PendingIncomeOccurrences"  WHERE resolved_tx_id IN (SELECT id FROM "IncomeTransactions" WHERE deleted_at < NOW() - INTERVAL '1 year');
  DELETE FROM "CashTransactions"          WHERE deleted_at < NOW() - INTERVAL '1 year';
  DELETE FROM "Settlements"               WHERE deleted_at < NOW() - INTERVAL '1 year';
  DELETE FROM "FuelLogs"                  WHERE deleted_at < NOW() - INTERVAL '1 year';
  DELETE FROM "IncomeTransactions"        WHERE deleted_at < NOW() - INTERVAL '1 year';
  DELETE FROM "RecurringIncomeRules"      WHERE deleted_at < NOW() - INTERVAL '1 year';
  DELETE FROM "PendingIncomeOccurrences"  WHERE skipped_at < NOW() - INTERVAL '90 days';
  DELETE FROM "RecurringExpenseRules"     WHERE deleted_at < NOW() - INTERVAL '1 year';
  DELETE FROM "PendingExpenseOccurrences" WHERE skipped_at < NOW() - INTERVAL '90 days';
  DELETE FROM "OutingExpenseShares" WHERE expense_id IN (
    SELECT e.id FROM "OutingExpenses" e JOIN "Outings" o ON o.id = e.outing_id
    WHERE e.deleted_at < NOW() - INTERVAL '1 year' OR o.deleted_at < NOW() - INTERVAL '1 year');
  DELETE FROM "OutingExpenses" WHERE deleted_at < NOW() - INTERVAL '1 year'
    OR outing_id IN (SELECT id FROM "Outings" WHERE deleted_at < NOW() - INTERVAL '1 year');
  DELETE FROM "OutingSettlements" WHERE deleted_at < NOW() - INTERVAL '1 year'
    OR outing_id IN (SELECT id FROM "Outings" WHERE deleted_at < NOW() - INTERVAL '1 year');
  DELETE FROM "OutingParticipants"
    WHERE outing_id IN (SELECT id FROM "Outings" WHERE deleted_at < NOW() - INTERVAL '1 year');
  DELETE FROM "Outings"                   WHERE deleted_at < NOW() - INTERVAL '1 year';
  DELETE FROM "InvoiceCredentials"        WHERE deleted_at < NOW() - INTERVAL '30 days';
  DELETE FROM "InvoiceImportRuns"         WHERE started_at < NOW() - INTERVAL '1 year';
$$);
