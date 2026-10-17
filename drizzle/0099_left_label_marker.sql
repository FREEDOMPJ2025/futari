-- 0099: the 「已離開的夥伴」 label is a system marker, shown in the viewer's
-- language (#1782).
-- positioning: docs/superpowers/specs/after-leaving-design.md (「人：停在當時」),
-- docs/superpowers/specs/account-deletion-design.md.
-- plan: #1782 rev 2 (direction B) + owner decision 2026-10-17 ((b) styling +
-- (a) reserved names).
--
-- Why: account deletion (0096) and #1619 (hideNameInLeftLedgers) write the
-- zh-TW literal 「已離開的夥伴」 into name slots. A viewer in en / ja / zh-CN
-- read it untranslated, and nothing told a system-written label apart from a
-- person who had chosen that name for themself.
-- Failure looked like: nothing errors; an English viewer sees 已離開的夥伴 in
-- the chapter list, the CSV and the outing list.
--
-- What this migration does:
--   1. Four marker columns, boolean NOT NULL DEFAULT false (PG 11+: no table
--      rewrite):
--        GroupEpochs.member_a_name_is_left_label / member_b_name_is_left_label
--        OutingParticipants.display_name_is_left_label
--        Profiles.is_tombstone  (the row is an account-deletion tombstone)
--      The marker is the ONLY thing a reader decides on. The literal stays in
--      the name column as a fallback (old code during the deploy gap, ad-hoc
--      SQL); a slot whose marker is false is shown as written, even when it
--      reads 「已離開的夥伴」. No grant: anon / authenticated hold no privilege
--      on these three tables (0080, 0066), ADD COLUMN adds none, none of them
--      is in supabase_realtime.
--   2. snapshot_epoch_member_names (0088's trigger function): when it copies
--      Profiles.display_name into a NULL slot, it copies Profiles.is_tombstone
--      into that slot's marker in the same branch. COALESCE over a subquery so
--      a missing Profiles row leaves the marker false (the FK makes that
--      unreachable; a SELECT ... INTO would write NULL into a NOT NULL column).
--      Still SECURITY INVOKER, search_path pinned, EXECUTE revoked.
--   3. process_account_deletions: CREATE OR REPLACE. The body is 0096's, byte
--      for byte, plus ONLY these assignments, each in the SAME UPDATE as the
--      literal it marks (so they commit and roll back together):
--        OutingParticipants scrub      + display_name_is_left_label = true
--        GroupEpochs a / b name slots  + member_a/b_name_is_left_label = true
--        FK-violation tombstone        + is_tombstone = true
--      Header and grants as 0096 (SECURITY DEFINER, search_path = public,
--      pg_temp, OWNER postgres, EXECUTE only postgres + service_role). Any
--      later migration that redefines this function must keep the four
--      assignments, and its rollback must restore THIS body.
--   4. Backfill (idempotent). Only what account deletion is known to have
--      written; everything else stays false:
--        Profiles: literal name AND no auth.users row.
--        GroupEpochs slot: literal name AND the slot's member has no
--          auth.users row (read auth.users directly, 0088's invariant, not the
--          is_tombstone set a statement above).
--        OutingParticipants: literal name AND profile_id IS NULL AND
--          claim_token_hash IS NULL AND claimed_at IS NOT NULL — the shape only
--          the deletion scrub (0083+) leaves; joinOuting guests always carry a
--          claim_token_hash, releaseOutingSlot clears claimed_at.
--      Known gaps (accepted): an outing slot scrubbed before 0083 (claimed_at
--      NULL) looks like a manually added guest and stays false; dev's #1619
--      test writes on live accounts stay false. Both show the literal as
--      written. Prod read-only counts on 2026-10-17 were 0 for every class, so
--      on prod the backfill changes 0 rows.
--
-- ORDER (hard): after 0098 (journal order), and on prod BEFORE the code that
-- reads the markers. lib/db/schema.ts lists the new columns, and
-- `db.select().from(groupEpochs)` names every column: code first fails every
-- dashboard request with "column does not exist". Old code on the new schema
-- is fine (it ignores the columns; the functions keep writing the literal).
-- Apply window: OUTSIDE 16:00-17:30 UTC (deletion cron 16:30) and not at
-- 15:00 UTC (sweep-orphan-ledgers).
--
-- Pre-check on prod (stop if it does not match): the live deletion body is
-- 0096's.
--   SELECT md5(prosrc) FROM pg_proc
--    WHERE oid = 'public.process_account_deletions()'::regprocedure;
--     → c50c4c1d2f495112c7e7b6df72234014
-- Post-check (read the catalog and the data, not tool output):
--   SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.process_account_deletions()'::regprocedure;
--     → 64f8d93a584a6c29ca01fd2ea0cc10ed (this file's body)
--   SELECT p.oid::regprocedure, p.prosecdef, p.proconfig,
--          has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_x,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_x
--     FROM pg_proc p WHERE p.oid IN ('public.process_account_deletions()'::regprocedure,
--                                    'public.snapshot_epoch_member_names()'::regprocedure);
--     → (t, {search_path=public, pg_temp}, f, f) and (f, {search_path=public, pg_temp}, f, f)
--   Marker counts, equal to the pre-flight estimate (prod 2026-10-17: all 0):
--   SELECT (SELECT count(*) FROM "Profiles" WHERE is_tombstone) AS tombstones,
--          (SELECT count(*) FROM "GroupEpochs" WHERE member_a_name_is_left_label)
--        + (SELECT count(*) FROM "GroupEpochs" WHERE member_b_name_is_left_label) AS chapter_slots,
--          (SELECT count(*) FROM "OutingParticipants" WHERE display_name_is_left_label) AS outing_slots;
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE, the backfill only
-- sets markers that are still false (a second run changes 0 rows).
-- Rollback: scripts/rollback/0099_left_label_marker.down.sql — revert the
-- code FIRST, then run it. It restores both functions (0096 / 0088 bodies,
-- headers and grants) and only then drops the four columns. The other order
-- breaks the trigger on every chapter close and makes every deletion WARN and
-- stall (the #1377 shape).

ALTER TABLE "GroupEpochs" ADD COLUMN IF NOT EXISTS "member_a_name_is_left_label" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "GroupEpochs" ADD COLUMN IF NOT EXISTS "member_b_name_is_left_label" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "OutingParticipants" ADD COLUMN IF NOT EXISTS "display_name_is_left_label" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "Profiles" ADD COLUMN IF NOT EXISTS "is_tombstone" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

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
  -- Never overwrite: a slot that already holds a name keeps it (and its
  -- marker). #1782: a slot filled here takes the profile's tombstone flag as
  -- its marker; no Profiles row leaves it false.
  IF NEW.member_a_name IS NULL THEN
    SELECT p.display_name INTO NEW.member_a_name
      FROM "Profiles" p WHERE p.id = NEW.member_a_id;
    NEW.member_a_name_is_left_label := COALESCE(
      (SELECT p.is_tombstone FROM "Profiles" p WHERE p.id = NEW.member_a_id), false);
  END IF;
  IF NEW.member_b_id IS NOT NULL AND NEW.member_b_name IS NULL THEN
    SELECT p.display_name INTO NEW.member_b_name
      FROM "Profiles" p WHERE p.id = NEW.member_b_id;
    NEW.member_b_name_is_left_label := COALESCE(
      (SELECT p.is_tombstone FROM "Profiles" p WHERE p.id = NEW.member_b_id), false);
  END IF;
  RETURN NEW;
END;
$fn$;
--> statement-breakpoint

REVOKE EXECUTE ON FUNCTION public.snapshot_epoch_member_names() FROM PUBLIC, anon, authenticated;
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
        SET profile_id = NULL, display_name = '已離開的夥伴', display_name_is_left_label = true,
            claim_token_hash = NULL, claimed_at = COALESCE(claimed_at, now())
        WHERE profile_id = v_uid;
      -- #1604: the user's name, frozen on every chapter they were in
      -- (0088), becomes 「已離開的夥伴」 in every group: their current one, one
      -- they left long ago, and a chapter their partner closed during the
      -- grace period. After the retry loop, so a rolled-back attempt cannot
      -- undo it; inside this user's block, so a failure undoes it with the rest.
      UPDATE "GroupEpochs" SET member_a_name = '已離開的夥伴', member_a_name_is_left_label = true WHERE member_a_id = v_uid;
      UPDATE "GroupEpochs" SET member_b_name = '已離開的夥伴', member_b_name_is_left_label = true WHERE member_b_id = v_uid;

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
        SET display_name = '已離開的夥伴', is_tombstone = true, avatar_url = NULL, deletion_requested_at = NULL
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

-- ─── backfill (idempotent; deletion-written shapes only) ───────────────────
UPDATE "Profiles" p
SET is_tombstone = true
WHERE p.display_name = '已離開的夥伴'
  AND NOT p.is_tombstone
  AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.id);
--> statement-breakpoint
UPDATE "GroupEpochs" e
SET member_a_name_is_left_label = true
WHERE e.member_a_name = '已離開的夥伴'
  AND NOT e.member_a_name_is_left_label
  AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = e.member_a_id);
--> statement-breakpoint
UPDATE "GroupEpochs" e
SET member_b_name_is_left_label = true
WHERE e.member_b_id IS NOT NULL
  AND e.member_b_name = '已離開的夥伴'
  AND NOT e.member_b_name_is_left_label
  AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = e.member_b_id);
--> statement-breakpoint
UPDATE "OutingParticipants" p
SET display_name_is_left_label = true
WHERE p.display_name = '已離開的夥伴'
  AND NOT p.display_name_is_left_label
  AND p.profile_id IS NULL
  AND p.claim_token_hash IS NULL
  AND p.claimed_at IS NOT NULL;
