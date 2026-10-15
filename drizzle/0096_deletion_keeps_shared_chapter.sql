-- 0096: the stayer's account deletion keeps the shared chapter for the person
-- who left (#1701).
-- positioning: docs/superpowers/specs/account-deletion-design.md (owner
-- decisions 2026-10-15 ① and ②; reverses the 2026-10-13 accepted trade-off).
-- plan: crew plans/v173/plan-1701.md rev3, slice S1.
--
-- Why: since #1611 a voluntary leave leaves the shared chapter in the
-- stayer's ledger. When the stayer later deleted their account alone in that
-- ledger, process_account_deletions took the solo branch and ran
-- _delete_group_cascade: the whole ledger went, and the person who had left
-- lost the chapter they could still look back on and export.
-- Failure looked like: nothing errors; the leaver opens 過去的時光 and the
-- chapter is gone.
--
-- Definitions (the plan's; every rule mirrors the reader X uses, never a
-- looser one):
--   alive        = an auth.users row exists (pending deletion counts).
--   kept chapter = a closed GroupEpochs row E of ledger G with a member X who
--                  is alive and is not a current member of G (and is not the
--                  user being deleted right now).
--   orphan       = OikosGroups.member_a has no auth.users row and member_b IS
--                  NULL. An orphan has no open chapter: it is the one allowed
--                  exception to "one open GroupEpochs row per group".
--   visible to E (a row survives if it is visible to ANY kept chapter):
--     CashTransactions / IncomeTransactions / Settlements / FuelLogs:
--       created_at in [E.started_at, E.ended_at); the ledger's earliest
--       chapter is unbounded below (viewer_in_chapter, 0080).
--     Trips / Outings: epoch_id = E. Outing subtree follows its outing.
--     TripExpenses: only under a trip whose epoch_id is a kept chapter.
--     Assets / recurring rules: created_at < E.ended_at AND (deleted_at IS
--       NULL OR deleted_at in E's window) — lib/pinnedChapterScope.ts + 0094.
--     Pending occurrences: unprocessed never; skipped by skipped_at in E's
--       window (0094); resolved iff its transaction is kept; and always only
--       while its rule is kept (rule_id is ON DELETE CASCADE).
--     MonthlyReviewSnapshots: the whole Asia/Taipei month inside E (0093 /
--       isMonthInChapter, millisecond-truncated bounds).
--     MonthlyReviewMessages: the reader's rule (loadChapterReviewMessages):
--       month inside E, author is one of E's members, created_at in
--       [E.started_at, E.ended_at).
--   FK closure: a parent referenced by a kept row is kept — Trips via
--   CashTransactions.trip_id, FuelLogs via CashTransactions.fuel_log_id,
--   Assets via the asset_id of kept transactions, fuel logs and rules.
--
-- What this migration does:
--   1. public._prune_ledger(p_group, p_deleter DEFAULT NULL). The one core
--      every path uses; idempotent. Locks Outings then the OikosGroups row
--      (0069's order), re-checks that the ledger is an orphan (or is being
--      made one: member_a = p_deleter AND member_b IS NULL) and RAISEs if not.
--      No kept chapter → _delete_group_cascade + best-effort delete of every
--      former member's tombstone Profiles row that no longer has a reference.
--      Otherwise, children first:
--        - unconditionally: GroupInvites (acceptInvite needs member_a =
--          invited_by, so a live invite into an orphan must not exist),
--          PartnerQuiz*, InvoiceImportRuns / Snapshots / Credentials,
--          unprocessed pending occurrences, CurrencyRates, PushTokens;
--        - ImportBatches: import_batch_id set NULL on the kept transactions,
--          then every batch (ImportErrors cascade). File names and raw rows
--          have no reader in a look-back;
--        - every row not visible to a kept chapter (FK closure above);
--        - every *Details row (Car, House, Child, Pet, Plant, Insurance) of
--          the ledger's assets, and on the kept assets notes, template_fields
--          and name_encrypted set NULL. A former member sees an asset's name
--          and that chapter's money only (assets/[id]/page.tsx); details and
--          encrypted fields have no reader once nobody is a current member.
--          With InsuranceDetails gone, insured_child_id / vehicle_id never
--          block an asset delete;
--        - a trip kept ONLY by closure (a kept transaction tagged to a trip of
--          another chapter): all its TripExpenses deleted, cover_photo_url /
--          budget_amount / budget_currency NULL (Trips has no other free text;
--          the name is what the tag shows);
--        - kept outings: share_token_hash / _encrypted / _rotated_at NULL,
--          so the share link stops working. Friends who already claimed a
--          participant slot keep it (same as today's paired deletion);
--        - kept recurring rules: paused (COALESCE keeps an earlier paused_at),
--          so the generate-pending-* crons never write into an orphan;
--        - OikosGroups.name = '家計簿' (0090's neutral name), the swap proposal
--          cleared, GroupBalance.balance = 0 (version + 1);
--        - MonthlyReviewSnapshots.largest_expense_paid_by_name NULL (0089
--          already cleared it; defence for a stray value).
--      Every write is conditional, so a second run changes nothing.
--   2. process_account_deletions: CREATE OR REPLACE. 0088's body verbatim
--      (including the name-scrub block) except three places marked #1701:
--        a. solo branch: close the user's open chapter at clock_timestamp()
--           (the name-snapshot trigger fires; the scrub block below then turns
--           the user's slots into 「已離開的夥伴」), then _prune_ledger(G, user).
--           With no kept chapter that is today's cascade. NOT in a sub-block
--           on purpose: a failure must not fall through to a cascade (that
--           would destroy the other person's chapter), so the user's whole
--           block rolls back — the #1377 failure mode, see below;
--        b. after DELETE FROM auth.users: every orphan ledger in which the
--           user appears on a closed chapter is pruned, each in its own
--           sub-block (a failing prune only WARNs; the user's deletion still
--           completes). This is how a chapter goes once its last alive former
--           member is deleted, and the ledger when none remain;
--        c. after the user loop: sweep_orphan_ledgers(), in a sub-block.
--   3. public.sweep_orphan_ledgers(): _prune_ledger over every orphan, each in
--      its own sub-block; returns how many ran without error. Scheduled as its
--      own pg_cron job `sweep-orphan-ledgers` at 15:00 UTC (outside the
--      16:00-17:30 UTC window of the other jobs), so orphans still converge
--      if the processor body is rolled back.
--   4. monthly-review-snapshot cron: 0061's command verbatim plus an orphan
--      skip in both statements (no snapshot computed, no message locked in an
--      orphan). The other crons need no change: generate-pending-* skip paused
--      rules (and an orphan's kept rules are paused), notify-recurring-push
--      reads unprocessed pendings and PushTokens (both deleted),
--      cleanup-soft-deleted only deletes.
--   5. Hygiene: SET search_path = public, pg_temp on every function; owner
--      postgres; the two new functions have NO grant (REVOKE ALL from PUBLIC,
--      anon, authenticated, service_role) — only postgres (the cron, the
--      processor's owner) runs them. process_account_deletions keeps 0088's
--      grants (postgres, service_role). auth.users always schema-qualified.
--
-- What failure looks like:
--   * A prune that raises in the solo branch: no error anywhere a person
--     sees; the stayer's account is still there after 14 days, with one
--     `process_account_deletions: failed for <uid>` WARNING every day (the
--     #1377 shape). Detect: deletion requests older than 15 days must be 0
--     (runbook invariant). Prevent: a new FK into a table _prune_ledger
--     deletes from fails __tests__/actions/deletionKeepsChapter1701.fk.test.ts.
--   * A prune that raises in step 2b or the sweep: the deleted user is gone,
--     but the orphan keeps rows nobody can see; one
--     `prune of <gid> ... failed` / `sweep_orphan_ledgers: failed for <gid>`
--     WARNING per run. Detect: "orphans with no alive former member = 0".
--   * A rule here looser than the app's reader: nothing errors; the orphan
--     keeps at-rest data the former member never sees (detect: "orphan
--     *_encrypted = 0"). Tighter: the former member opens the chapter and a
--     row they remember is missing.
--
-- Pre-check (prod, read-only; run first). Under 0088 no orphan should exist:
--   SELECT count(*) FROM "OikosGroups" g
--    WHERE g.member_b IS NULL AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = g.member_a);  → 0
--   If it is not 0, stop: the first sweep would prune those ledgers.
-- Apply window: OUTSIDE 16:00-17:30 UTC (deletion cron 16:30 UTC) and not at
-- 15:00 UTC; ships with 0095 in v1.7.3's second prod run. Independent of the
-- app code (no schema change).
-- Post-check: SELECT jobname, schedule FROM cron.job WHERE jobname IN
--   ('sweep-orphan-ledgers', 'monthly-review-snapshot');  → '0 15 * * *', '5 16 1 * *'
--
-- Idempotent: CREATE OR REPLACE, REVOKE, ALTER OWNER, cron.schedule (replaces
-- the command of an existing job name).
-- Rollback: scripts/rollback/0096_deletion_keeps_shared_chapter.down.sql
-- restores 0088's processor body and leaves _prune_ledger, sweep_orphan_ledgers,
-- the sweep-orphan-ledgers job and the monthly-review orphan skip in place.
-- Data pruned from an orphan is forward-only.

CREATE OR REPLACE FUNCTION public._prune_ledger(p_group uuid, p_deleter uuid DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_grp "OikosGroups"%ROWTYPE;
  v_kept uuid[];
  v_first timestamptz;
  v_cash uuid[];
  v_income uuid[];
  v_trips_epoch uuid[];
  v_trips uuid[];
  v_fuel uuid[];
  v_erules uuid[];
  v_irules uuid[];
  v_assets uuid[];
  v_people uuid[];
  v_pid uuid;
BEGIN
  -- 0069's lock order: Outings before OikosGroups.
  PERFORM 1 FROM "Outings" WHERE group_id = p_group ORDER BY id FOR UPDATE;
  SELECT * INTO v_grp FROM "OikosGroups" WHERE id = p_group FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN 'gone';
  END IF;
  IF v_grp.member_b IS NOT NULL
     OR NOT (
       (p_deleter IS NOT NULL AND v_grp.member_a = p_deleter)
       OR NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = v_grp.member_a)
     ) THEN
    RAISE EXCEPTION '_prune_ledger: % is not an orphan ledger', p_group;
  END IF;

  v_kept := ARRAY(
    SELECT e.id FROM "GroupEpochs" e
     WHERE e.group_id = p_group AND e.ended_at IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM auth.users u
          WHERE (u.id = e.member_a_id OR u.id = e.member_b_id)
            AND u.id IS DISTINCT FROM p_deleter
            AND u.id <> v_grp.member_a
            AND u.id IS DISTINCT FROM v_grp.member_b
       )
     ORDER BY e.started_at);

  IF cardinality(v_kept) = 0 THEN
    v_people := ARRAY(
      SELECT DISTINCT x.id FROM (
        SELECT e.member_a_id AS id FROM "GroupEpochs" e WHERE e.group_id = p_group
        UNION SELECT e.member_b_id FROM "GroupEpochs" e WHERE e.group_id = p_group AND e.member_b_id IS NOT NULL
        UNION SELECT v_grp.member_a
      ) x
      WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = x.id));
    PERFORM public._delete_group_cascade(p_group);
    -- Tombstones nobody references any more. Own block each: a reference
    -- elsewhere (another ledger, a kept chapter) keeps that row.
    FOREACH v_pid IN ARRAY v_people LOOP
      BEGIN
        DELETE FROM "Profiles" p WHERE p.id = v_pid
          AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.id);
      EXCEPTION WHEN foreign_key_violation THEN
        NULL;
      END;
    END LOOP;
    RETURN 'purged';
  END IF;

  v_first := (SELECT min(e.started_at) FROM "GroupEpochs" e WHERE e.group_id = p_group);

  -- ─── unconditional ────────────────────────────────────────────────────────
  DELETE FROM "GroupInvites" WHERE group_id = p_group;
  DELETE FROM "PartnerQuizAnswers" WHERE session_id IN (SELECT id FROM "PartnerQuizSessions" WHERE group_id = p_group);
  DELETE FROM "PartnerQuizSessions" WHERE group_id = p_group;
  DELETE FROM "InvoiceImportRuns"      WHERE group_id = p_group;
  DELETE FROM "InvoiceImportSnapshots" WHERE group_id = p_group;
  DELETE FROM "InvoiceCredentials"     WHERE group_id = p_group;
  DELETE FROM "PendingExpenseOccurrences" WHERE group_id = p_group AND skipped_at IS NULL AND resolved_tx_id IS NULL;
  DELETE FROM "PendingIncomeOccurrences"  WHERE group_id = p_group AND skipped_at IS NULL AND resolved_tx_id IS NULL;
  DELETE FROM "CurrencyRates" WHERE group_id = p_group;
  DELETE FROM "PushTokens"    WHERE group_id = p_group;

  -- ─── what the kept chapters show ──────────────────────────────────────────
  v_cash := ARRAY(
    SELECT t.id FROM "CashTransactions" t
     WHERE t.group_id = p_group
       AND EXISTS (SELECT 1 FROM "GroupEpochs" k WHERE k.id = ANY (v_kept)
                    AND t.created_at < k.ended_at
                    AND (t.created_at >= k.started_at OR k.started_at = v_first)));
  v_income := ARRAY(
    SELECT t.id FROM "IncomeTransactions" t
     WHERE t.group_id = p_group
       AND EXISTS (SELECT 1 FROM "GroupEpochs" k WHERE k.id = ANY (v_kept)
                    AND t.created_at < k.ended_at
                    AND (t.created_at >= k.started_at OR k.started_at = v_first)));
  v_trips_epoch := ARRAY(SELECT id FROM "Trips" WHERE group_id = p_group AND epoch_id = ANY (v_kept));
  v_trips := ARRAY(
    SELECT unnest(v_trips_epoch)
    UNION
    SELECT t.trip_id FROM "CashTransactions" t WHERE t.id = ANY (v_cash) AND t.trip_id IS NOT NULL);
  v_fuel := ARRAY(
    SELECT f.id FROM "FuelLogs" f JOIN "Assets" a ON a.id = f.asset_id
     WHERE a.group_id = p_group
       AND EXISTS (SELECT 1 FROM "GroupEpochs" k WHERE k.id = ANY (v_kept)
                    AND f.created_at < k.ended_at
                    AND (f.created_at >= k.started_at OR k.started_at = v_first))
    UNION
    SELECT t.fuel_log_id FROM "CashTransactions" t WHERE t.id = ANY (v_cash) AND t.fuel_log_id IS NOT NULL);
  v_erules := ARRAY(
    SELECT r.id FROM "RecurringExpenseRules" r
     WHERE r.group_id = p_group
       AND EXISTS (SELECT 1 FROM "GroupEpochs" k WHERE k.id = ANY (v_kept)
                    AND r.created_at < k.ended_at
                    AND (r.deleted_at IS NULL
                         OR (r.deleted_at < k.ended_at
                             AND (r.deleted_at >= k.started_at OR k.started_at = v_first)))));
  v_irules := ARRAY(
    SELECT r.id FROM "RecurringIncomeRules" r
     WHERE r.group_id = p_group
       AND EXISTS (SELECT 1 FROM "GroupEpochs" k WHERE k.id = ANY (v_kept)
                    AND r.created_at < k.ended_at
                    AND (r.deleted_at IS NULL
                         OR (r.deleted_at < k.ended_at
                             AND (r.deleted_at >= k.started_at OR k.started_at = v_first)))));
  v_assets := ARRAY(
    SELECT a.id FROM "Assets" a
     WHERE a.group_id = p_group
       AND EXISTS (SELECT 1 FROM "GroupEpochs" k WHERE k.id = ANY (v_kept)
                    AND a.created_at < k.ended_at
                    AND (a.deleted_at IS NULL
                         OR (a.deleted_at < k.ended_at
                             AND (a.deleted_at >= k.started_at OR k.started_at = v_first))))
    UNION SELECT t.asset_id FROM "CashTransactions" t WHERE t.id = ANY (v_cash) AND t.asset_id IS NOT NULL
    UNION SELECT t.asset_id FROM "IncomeTransactions" t WHERE t.id = ANY (v_income) AND t.asset_id IS NOT NULL
    UNION SELECT f.asset_id FROM "FuelLogs" f WHERE f.id = ANY (v_fuel)
    UNION SELECT r.asset_id FROM "RecurringExpenseRules" r WHERE r.id = ANY (v_erules) AND r.asset_id IS NOT NULL
    UNION SELECT r.asset_id FROM "RecurringIncomeRules" r WHERE r.id = ANY (v_irules) AND r.asset_id IS NOT NULL);

  -- ─── delete the rest, children first ──────────────────────────────────────
  -- Pendings before their transactions (resolved_tx_id has no ON DELETE).
  DELETE FROM "PendingExpenseOccurrences" p
   WHERE p.group_id = p_group
     AND NOT (
       p.rule_id = ANY (v_erules)
       AND ((p.resolved_tx_id IS NOT NULL AND p.resolved_tx_id = ANY (v_cash))
            OR (p.resolved_tx_id IS NULL AND p.skipped_at IS NOT NULL
                AND EXISTS (SELECT 1 FROM "GroupEpochs" k WHERE k.id = ANY (v_kept)
                             AND p.skipped_at < k.ended_at
                             AND (p.skipped_at >= k.started_at OR k.started_at = v_first)))));
  DELETE FROM "PendingIncomeOccurrences" p
   WHERE p.group_id = p_group
     AND NOT (
       p.rule_id = ANY (v_irules)
       AND ((p.resolved_tx_id IS NOT NULL AND p.resolved_tx_id = ANY (v_income))
            OR (p.resolved_tx_id IS NULL AND p.skipped_at IS NOT NULL
                AND EXISTS (SELECT 1 FROM "GroupEpochs" k WHERE k.id = ANY (v_kept)
                             AND p.skipped_at < k.ended_at
                             AND (p.skipped_at >= k.started_at OR k.started_at = v_first)))));
  -- Trip expenses live only under a trip of a kept chapter.
  DELETE FROM "TripExpenses"
   WHERE trip_id IN (SELECT id FROM "Trips" WHERE group_id = p_group)
     AND NOT trip_id = ANY (v_trips_epoch);
  DELETE FROM "CashTransactions"   WHERE group_id = p_group AND NOT id = ANY (v_cash);
  DELETE FROM "IncomeTransactions" WHERE group_id = p_group AND NOT id = ANY (v_income);
  DELETE FROM "Settlements" s
   WHERE s.group_id = p_group
     AND NOT EXISTS (SELECT 1 FROM "GroupEpochs" k WHERE k.id = ANY (v_kept)
                      AND s.created_at < k.ended_at
                      AND (s.created_at >= k.started_at OR k.started_at = v_first));
  -- Import files: no reader in a look-back.
  UPDATE "CashTransactions"   SET import_batch_id = NULL WHERE group_id = p_group AND import_batch_id IS NOT NULL;
  UPDATE "IncomeTransactions" SET import_batch_id = NULL WHERE group_id = p_group AND import_batch_id IS NOT NULL;
  DELETE FROM "ImportBatches" WHERE group_id = p_group;
  DELETE FROM "FuelLogs"
   WHERE asset_id IN (SELECT id FROM "Assets" WHERE group_id = p_group)
     AND NOT id = ANY (v_fuel);
  DELETE FROM "RecurringExpenseRules" WHERE group_id = p_group AND NOT id = ANY (v_erules);
  DELETE FROM "RecurringIncomeRules"  WHERE group_id = p_group AND NOT id = ANY (v_irules);
  -- Every details row, kept asset or not (no reader for a former member).
  DELETE FROM "InsuranceDetails" WHERE asset_id IN (SELECT id FROM "Assets" WHERE group_id = p_group);
  DELETE FROM "CarDetails"   WHERE asset_id IN (SELECT id FROM "Assets" WHERE group_id = p_group);
  DELETE FROM "HouseDetails" WHERE asset_id IN (SELECT id FROM "Assets" WHERE group_id = p_group);
  DELETE FROM "ChildDetails" WHERE asset_id IN (SELECT id FROM "Assets" WHERE group_id = p_group);
  DELETE FROM "PetDetails"   WHERE asset_id IN (SELECT id FROM "Assets" WHERE group_id = p_group);
  DELETE FROM "PlantDetails" WHERE asset_id IN (SELECT id FROM "Assets" WHERE group_id = p_group);
  DELETE FROM "Assets" WHERE group_id = p_group AND NOT id = ANY (v_assets);
  DELETE FROM "Trips"  WHERE group_id = p_group AND NOT id = ANY (v_trips);
  -- Outing subtree of outings outside every kept chapter (0066's order).
  DELETE FROM "OutingExpenseShares" WHERE expense_id IN (
    SELECT e.id FROM "OutingExpenses" e JOIN "Outings" o ON o.id = e.outing_id
     WHERE o.group_id = p_group AND NOT o.epoch_id = ANY (v_kept));
  DELETE FROM "OutingExpenses"     WHERE outing_id IN (SELECT id FROM "Outings" WHERE group_id = p_group AND NOT epoch_id = ANY (v_kept));
  DELETE FROM "OutingSettlements"  WHERE outing_id IN (SELECT id FROM "Outings" WHERE group_id = p_group AND NOT epoch_id = ANY (v_kept));
  DELETE FROM "OutingParticipants" WHERE outing_id IN (SELECT id FROM "Outings" WHERE group_id = p_group AND NOT epoch_id = ANY (v_kept));
  DELETE FROM "Outings" WHERE group_id = p_group AND NOT epoch_id = ANY (v_kept);
  -- Reviews: the 0093 month rule; messages also the reader's author + created_at rule.
  DELETE FROM "MonthlyReviewSnapshots" s
   WHERE s.group_id = p_group
     AND NOT EXISTS (SELECT 1 FROM "GroupEpochs" k WHERE k.id = ANY (v_kept)
                      AND make_timestamptz(s.year, s.month, 1, 0, 0, 0, 'Asia/Taipei') >= date_trunc('milliseconds', k.started_at)
                      AND make_timestamptz(s.year, s.month, 1, 0, 0, 0, 'Asia/Taipei') + interval '1 month'
                          <= date_trunc('milliseconds', k.ended_at));
  DELETE FROM "MonthlyReviewMessages" m
   WHERE m.group_id = p_group
     AND NOT EXISTS (SELECT 1 FROM "GroupEpochs" k WHERE k.id = ANY (v_kept)
                      AND (m.member_id = k.member_a_id OR m.member_id = k.member_b_id)
                      AND m.created_at >= k.started_at AND m.created_at < k.ended_at
                      AND make_timestamptz(m.year, m.month, 1, 0, 0, 0, 'Asia/Taipei') >= date_trunc('milliseconds', k.started_at)
                      AND make_timestamptz(m.year, m.month, 1, 0, 0, 0, 'Asia/Taipei') + interval '1 month'
                          <= date_trunc('milliseconds', k.ended_at));

  -- ─── scrub what stays ─────────────────────────────────────────────────────
  UPDATE "Assets" SET notes = NULL, template_fields = NULL, name_encrypted = NULL
   WHERE group_id = p_group
     AND (notes IS NOT NULL OR template_fields IS NOT NULL OR name_encrypted IS NOT NULL);
  UPDATE "Trips" SET cover_photo_url = NULL, budget_amount = NULL, budget_currency = NULL
   WHERE group_id = p_group AND NOT id = ANY (v_trips_epoch)
     AND (cover_photo_url IS NOT NULL OR budget_amount IS NOT NULL OR budget_currency IS NOT NULL);
  UPDATE "Outings" SET share_token_hash = NULL, share_token_encrypted = NULL, share_token_rotated_at = NULL
   WHERE group_id = p_group
     AND (share_token_hash IS NOT NULL OR share_token_encrypted IS NOT NULL OR share_token_rotated_at IS NOT NULL);
  UPDATE "RecurringExpenseRules" SET paused_at = clock_timestamp()
   WHERE group_id = p_group AND paused_at IS NULL;
  UPDATE "RecurringIncomeRules"  SET paused_at = clock_timestamp()
   WHERE group_id = p_group AND paused_at IS NULL;
  UPDATE "MonthlyReviewSnapshots" SET largest_expense_paid_by_name = NULL
   WHERE group_id = p_group AND largest_expense_paid_by_name IS NOT NULL;
  UPDATE "OikosGroups"
     SET name = '家計簿', pending_swap_proposed_by = NULL, pending_swap_expires_at = NULL
   WHERE id = p_group
     AND (name <> '家計簿' OR pending_swap_proposed_by IS NOT NULL OR pending_swap_expires_at IS NOT NULL);
  UPDATE "GroupBalance" SET balance = 0, version = version + 1
   WHERE group_id = p_group AND balance <> 0;

  RETURN 'pruned';
END;
$fn$;
--> statement-breakpoint
ALTER FUNCTION public._prune_ledger(uuid, uuid) OWNER TO postgres;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public._prune_ledger(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.sweep_orphan_ledgers()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_gid uuid;
  v_n integer := 0;
BEGIN
  FOR v_gid IN
    SELECT g.id FROM "OikosGroups" g
     WHERE g.member_b IS NULL
       AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = g.member_a)
     ORDER BY g.id
  LOOP
    BEGIN
      PERFORM public._prune_ledger(v_gid);
      v_n := v_n + 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'sweep_orphan_ledgers: failed for %: %', v_gid, SQLERRM;
    END;
  END LOOP;
  RETURN v_n;
END;
$fn$;
--> statement-breakpoint
ALTER FUNCTION public.sweep_orphan_ledgers() OWNER TO postgres;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.sweep_orphan_ledgers() FROM PUBLIC, anon, authenticated, service_role;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.process_account_deletions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid uuid;
  v_gid uuid;
  v_grp "OikosGroups"%ROWTYPE;
  v_partner uuid;
  v_boundary timestamptz;
  v_count integer := 0;
  v_gids uuid[];
  v_attempts integer;
  v_orphan uuid;
BEGIN
  FOR v_uid IN
    SELECT id FROM "Profiles"
    WHERE deletion_requested_at IS NOT NULL
      AND deletion_requested_at < now() - interval '14 days'
  LOOP
    BEGIN
      -- #1433: the scan below is not locked. A group the user joined or
      -- created after it (leaveGroup's new solo ledger, a partner's ledger
      -- through acceptInvite) was never visited. Once this attempt holds its
      -- locks, re-read; if such a group exists, roll the attempt back (which
      -- releases its locks) and start over from a fresh scan, so every attempt
      -- still locks in 0069's order: ascending id, Outings before OikosGroups.
      v_attempts := 0;
      LOOP
        BEGIN
          v_gids := ARRAY(
            SELECT id FROM "OikosGroups" WHERE member_a = v_uid OR member_b = v_uid ORDER BY id
          );
          FOREACH v_gid IN ARRAY v_gids
          LOOP
            -- #1427: Outings before OikosGroups, the order the outing actions use.
            -- The solo branch deletes these rows (_delete_group_cascade).
            PERFORM 1 FROM "Outings" WHERE group_id = v_gid ORDER BY id FOR UPDATE;

            -- Lock, then decide from the locked row: membership may have changed
            -- since the unlocked scan above.
            SELECT * INTO v_grp FROM "OikosGroups" WHERE id = v_gid FOR NO KEY UPDATE;
            CONTINUE WHEN NOT FOUND
              OR (v_grp.member_a IS DISTINCT FROM v_uid AND v_grp.member_b IS DISTINCT FROM v_uid);

            IF v_grp.member_b IS NULL THEN
              -- #1701: close the user's open chapter, then keep every closed
              -- chapter an alive former member can still look back on
              -- (_prune_ledger cascades the whole ledger when there is none —
              -- the behaviour before #1701). Deliberately NOT in a sub-block:
              -- a failure must roll this user back, never fall through to a
              -- cascade that would destroy the other person's chapter.
              UPDATE "GroupEpochs" SET ended_at = clock_timestamp()
                WHERE group_id = v_grp.id AND ended_at IS NULL;
              PERFORM public._prune_ledger(v_grp.id, v_uid);
            ELSE
              PERFORM 1 FROM "GroupEpochs"
                WHERE group_id = v_grp.id AND ended_at IS NULL
                FOR NO KEY UPDATE;
              v_boundary := clock_timestamp();
              v_partner := CASE WHEN v_grp.member_a = v_uid THEN v_grp.member_b ELSE v_grp.member_a END;

              -- #1588: the leaving user's recurring rules stop here, the same
              -- steps as removePartner (actions/membership.ts) and the data
              -- repair below. Pause by person (COALESCE keeps an earlier
              -- paused_at); delete the unprocessed cards of those rules
              -- whatever their earlier paused state (skipped / resolved cards
              -- and written transactions stay); reset stale payer snapshots
              -- on the partner's rules to the rule's payer.
              UPDATE "RecurringIncomeRules"
                SET paused_at = COALESCE(paused_at, v_boundary)
                WHERE group_id = v_grp.id AND recipient_id = v_uid AND deleted_at IS NULL;
              UPDATE "RecurringExpenseRules"
                SET paused_at = COALESCE(paused_at, v_boundary)
                WHERE group_id = v_grp.id AND paid_by = v_uid AND deleted_at IS NULL;
              DELETE FROM "PendingIncomeOccurrences"
                WHERE group_id = v_grp.id AND skipped_at IS NULL AND resolved_tx_id IS NULL
                  AND rule_id IN (
                    SELECT id FROM "RecurringIncomeRules"
                    WHERE group_id = v_grp.id AND recipient_id = v_uid AND deleted_at IS NULL);
              DELETE FROM "PendingExpenseOccurrences"
                WHERE group_id = v_grp.id AND skipped_at IS NULL AND resolved_tx_id IS NULL
                  AND rule_id IN (
                    SELECT id FROM "RecurringExpenseRules"
                    WHERE group_id = v_grp.id AND paid_by = v_uid AND deleted_at IS NULL);
              UPDATE "PendingExpenseOccurrences" p
                SET proposed_paid_by = r.paid_by
                FROM "RecurringExpenseRules" r
                WHERE r.id = p.rule_id AND p.group_id = v_grp.id
                  AND p.skipped_at IS NULL AND p.resolved_tx_id IS NULL
                  AND p.proposed_paid_by = v_uid AND r.paid_by = v_partner;

              IF v_grp.member_a = v_uid THEN
                UPDATE "OikosGroups"
                SET member_a = v_partner,
                    member_b = NULL,
                    default_split_ratio_a = CASE WHEN default_split_ratio_a IS NOT NULL
                                                 THEN 100 - default_split_ratio_a ELSE NULL END,
                    pending_swap_proposed_by = NULL,
                    pending_swap_expires_at = NULL,
                    current_epoch_started_at = v_boundary
                WHERE id = v_grp.id;

                UPDATE "CashTransactions"      SET split_ratio_a = 100 - split_ratio_a
                  WHERE group_id = v_grp.id AND split_ratio_a IS NOT NULL;
                UPDATE "RecurringExpenseRules" SET split_ratio_a = 100 - split_ratio_a
                  WHERE group_id = v_grp.id AND split_ratio_a IS NOT NULL;
                UPDATE "PendingExpenseOccurrences" SET proposed_split_ratio_a = 100 - proposed_split_ratio_a
                  WHERE group_id = v_grp.id AND proposed_split_ratio_a IS NOT NULL;
              ELSE
                UPDATE "OikosGroups"
                SET member_b = NULL,
                    pending_swap_proposed_by = NULL,
                    pending_swap_expires_at = NULL,
                    current_epoch_started_at = v_boundary
                WHERE id = v_grp.id;
              END IF;

              UPDATE "GroupEpochs" SET ended_at = v_boundary
                WHERE group_id = v_grp.id AND ended_at IS NULL;
              INSERT INTO "GroupEpochs" (group_id, started_at, member_a_id, member_b_id)
                VALUES (v_grp.id, v_boundary, v_partner, NULL);

              UPDATE "GroupInvites" SET revoked_at = v_boundary
                WHERE group_id = v_grp.id AND accepted_at IS NULL AND revoked_at IS NULL;

              UPDATE "GroupBalance" SET balance = 0, version = version + 1 WHERE group_id = v_grp.id;
            END IF;
          END LOOP;

          -- #1449: the user's own row, last (groups -> chapters -> Profiles,
          -- lockForEpochClose's order). An acceptInvite / createGroup holding
          -- it commits before the re-read below, which then sees the ledger it
          -- added; one that comes later waits until this transaction commits
          -- and finds the account gone (profile_is_live, app side).
          PERFORM 1 FROM "Profiles" WHERE id = v_uid FOR UPDATE;

          -- The groups locked above cannot gain the user while this holds
          -- their locks; a group outside them can only have committed since
          -- the scan.
          EXIT WHEN NOT EXISTS (
            SELECT 1 FROM "OikosGroups"
            WHERE (member_a = v_uid OR member_b = v_uid) AND id <> ALL (v_gids)
          );
          v_attempts := v_attempts + 1;
          IF v_attempts >= 3 THEN
            RAISE EXCEPTION 'groups kept changing during % attempts', v_attempts;
          END IF;
          RAISE EXCEPTION USING ERRCODE = 'OK433';
        EXCEPTION WHEN SQLSTATE 'OK433' THEN
          NULL;
        END;
      END LOOP;

      DELETE FROM "PushTokens" WHERE user_id = v_uid;
      -- Hard delete: the user is gone. Their runs stay (credential_id SET NULL).
      DELETE FROM "InvoiceCredentials" WHERE user_id = v_uid;
      -- #1558: clear claim_token_hash so the slot's old cookie stops working,
      -- and keep claimed_at non-NULL so the slot is never claimable again. A
      -- slot bound without a claim (a Futari member's own row) has no
      -- claimed_at; without the COALESCE it would come out of this UPDATE
      -- looking unclaimed (profile_id, claim_token_hash and claimed_at all
      -- NULL), and anyone holding the share link could take it over.
      UPDATE "OutingParticipants"
        SET profile_id = NULL, display_name = '已離開的夥伴',
            claim_token_hash = NULL, claimed_at = COALESCE(claimed_at, now())
        WHERE profile_id = v_uid;
      -- #1604: the user's name, frozen on every chapter they were in
      -- (0088), becomes 「已離開的夥伴」 in every group: their current one, one
      -- they left long ago, and a chapter their partner closed during the
      -- grace period. After the retry loop, so a rolled-back attempt cannot
      -- undo it; inside this user's block, so a failure undoes it with the rest.
      UPDATE "GroupEpochs" SET member_a_name = '已離開的夥伴' WHERE member_a_id = v_uid;
      UPDATE "GroupEpochs" SET member_b_name = '已離開的夥伴' WHERE member_b_id = v_uid;

      DELETE FROM auth.users WHERE id = v_uid;

      -- #1701: a chapter stays only while one of its former members is alive.
      -- Now that this user is gone, prune every orphan ledger they appear in
      -- on a closed chapter (their own solo ledger just pruned above too; a
      -- second prune is a no-op). Own block each: a failing prune WARNs and
      -- never blocks this user's deletion; sweep_orphan_ledgers retries it.
      FOR v_orphan IN
        SELECT DISTINCT e.group_id FROM "GroupEpochs" e
          JOIN "OikosGroups" g ON g.id = e.group_id
         WHERE (e.member_a_id = v_uid OR e.member_b_id = v_uid)
           AND e.ended_at IS NOT NULL
           AND g.member_b IS NULL
           AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = g.member_a)
         ORDER BY e.group_id
      LOOP
        BEGIN
          PERFORM public._prune_ledger(v_orphan);
        EXCEPTION WHEN OTHERS THEN
          RAISE WARNING 'process_account_deletions: prune of % after % failed: %', v_orphan, v_uid, SQLERRM;
        END;
      END LOOP;

      -- Delete the profile if nothing references it any more; otherwise keep a
      -- scrubbed tombstone so the partner's ledger still resolves. Own block:
      -- the FK error must roll back only this DELETE, not the user's deletion.
      BEGIN
        DELETE FROM "Profiles" WHERE id = v_uid;
      EXCEPTION WHEN foreign_key_violation THEN
        UPDATE "Profiles"
        SET display_name = '已離開的夥伴', avatar_url = NULL, deletion_requested_at = NULL
        WHERE id = v_uid;
      END;

      v_count := v_count + 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'process_account_deletions: failed for %: %', v_uid, SQLERRM;
    END;
  END LOOP;

  -- #1701: every orphan, every run (also its own cron job). Own block: a
  -- failure here must not undo the deletions above.
  BEGIN
    PERFORM public.sweep_orphan_ledgers();
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'process_account_deletions: sweep_orphan_ledgers failed: %', SQLERRM;
  END;

  RETURN v_count;
END;
$fn$;
--> statement-breakpoint
ALTER FUNCTION public.process_account_deletions() OWNER TO postgres;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.process_account_deletions() FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.process_account_deletions() TO postgres, service_role;
--> statement-breakpoint

-- sweep-orphan-ledgers: daily 15:00 UTC (23:00 Asia/Taipei), outside the
-- 16:00-17:30 UTC window. Owned by whoever runs this migration (postgres).
SELECT cron.schedule('sweep-orphan-ledgers', '0 15 * * *', $$
  SELECT public.sweep_orphan_ledgers();
$$);
--> statement-breakpoint

-- monthly-review-snapshot: 0061's command, plus the orphan skip (#1701) in
-- both statements. An orphan is read-only history: no new snapshot, no lock.
SELECT cron.schedule('monthly-review-snapshot', '5 16 1 * *', $$
  WITH target AS (
    SELECT EXTRACT(YEAR  FROM (date_trunc('month', NOW() AT TIME ZONE 'Asia/Taipei') - INTERVAL '1 day'))::integer AS y,
           EXTRACT(MONTH FROM (date_trunc('month', NOW() AT TIME ZONE 'Asia/Taipei') - INTERVAL '1 day'))::integer AS m
  ),
  computed AS (
    SELECT compute_monthly_review_snapshot(g.id, target.y, target.m)
      FROM "OikosGroups" g, target
     WHERE NOT (g.member_b IS NULL
                AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = g.member_a))
  )
  SELECT 1 FROM computed;

  -- Lock all messages addressed to the just-completed month. Idempotent:
  -- WHERE locked_at IS NULL.
  UPDATE "MonthlyReviewMessages" m
     SET locked_at = NOW()
    FROM (
      SELECT EXTRACT(YEAR  FROM (date_trunc('month', NOW() AT TIME ZONE 'Asia/Taipei') - INTERVAL '1 day'))::integer AS y,
             EXTRACT(MONTH FROM (date_trunc('month', NOW() AT TIME ZONE 'Asia/Taipei') - INTERVAL '1 day'))::integer AS m
    ) target
   WHERE m.year = target.y
     AND m.month = target.m
     AND m.locked_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM "OikosGroups" g
        WHERE g.id = m.group_id AND g.member_b IS NULL
          AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = g.member_a));
$$);
