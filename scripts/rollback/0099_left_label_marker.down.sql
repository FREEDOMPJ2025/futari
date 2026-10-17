-- ROLLBACK for drizzle/0099_left_label_marker.sql — MANUAL ONLY, NEVER RUN AUTOMATICALLY.
-- Not a drizzle migration: drizzle-kit only runs files listed in drizzle/meta/_journal.json.
--
-- ORDER (hard): revert the code FIRST (the code reads the marker columns this
-- drops; with the columns gone every dashboard request fails with "column
-- does not exist"), THEN run this file. Inside this file the two functions
-- are restored BEFORE the columns are dropped: the other order leaves the
-- 0099 trigger function assigning NEW.member_a_name_is_left_label on a table
-- without the column (every chapter close fails), and the 0099 deletion body
-- writing columns that no longer exist (every deletion WARNs and the user is
-- never deleted, the #1377 shape).
--
-- What it does:
--   1. snapshot_epoch_member_names → 0088's body, byte for byte (header,
--      SECURITY INVOKER, search_path, REVOKE). Expected md5(prosrc) after:
--      ec5e7a66c099e3b9f5d60f3727dfdbff
--   2. process_account_deletions → 0096's body, byte for byte (header, OWNER,
--      REVOKE, GRANT). Expected md5(prosrc) after:
--      c50c4c1d2f495112c7e7b6df72234014
--   3. Drops the four marker columns.
-- Data: the markers are lost; the literal 「已離開的夥伴」 is still in every
-- name slot it was written to, so the screens go back to how they were before
-- #1782 (zh-TW literal in every language). Nothing else changes.
--
-- Run: psql "$DATABASE_URL_DIRECT" -1 -v ON_ERROR_STOP=1 -f scripts/rollback/0099_left_label_marker.down.sql
-- Apply window: outside 16:00-17:30 UTC and not at 15:00 UTC.
-- Post-check:
--   SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.process_account_deletions()'::regprocedure;
--   SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.snapshot_epoch_member_names()'::regprocedure;
--   SELECT count(*) FROM information_schema.columns
--    WHERE table_schema = 'public'
--      AND column_name IN ('member_a_name_is_left_label', 'member_b_name_is_left_label',
--                          'display_name_is_left_label', 'is_tombstone');   -- 0

CREATE OR REPLACE FUNCTION public.snapshot_epoch_member_names()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF NEW.ended_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- Only the close itself (NULL -> not NULL). A re-close keeps the snapshot.
    IF OLD.ended_at IS NOT NULL THEN
      RETURN NEW;
    END IF;
  END IF;
  -- Never overwrite: a slot that already holds a name keeps it.
  IF NEW.member_a_name IS NULL THEN
    SELECT p.display_name INTO NEW.member_a_name
      FROM "Profiles" p WHERE p.id = NEW.member_a_id;
  END IF;
  IF NEW.member_b_id IS NOT NULL AND NEW.member_b_name IS NULL THEN
    SELECT p.display_name INTO NEW.member_b_name
      FROM "Profiles" p WHERE p.id = NEW.member_b_id;
  END IF;
  RETURN NEW;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.snapshot_epoch_member_names() FROM PUBLIC, anon, authenticated;

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
ALTER FUNCTION public.process_account_deletions() OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.process_account_deletions() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_account_deletions() TO postgres, service_role;

ALTER TABLE "GroupEpochs" DROP COLUMN IF EXISTS "member_a_name_is_left_label";
ALTER TABLE "GroupEpochs" DROP COLUMN IF EXISTS "member_b_name_is_left_label";
ALTER TABLE "OutingParticipants" DROP COLUMN IF EXISTS "display_name_is_left_label";
ALTER TABLE "Profiles" DROP COLUMN IF EXISTS "is_tombstone";
