-- 0095: one partner quiz per chapter, not per ledger (#1683).
-- positioning: docs/superpowers/specs/after-leaving-design.md (a chapter
-- belongs to the relationship that wrote it).
--
-- Why: 0034 made PartnerQuizSessions UNIQUE (group_id), one quiz per ledger.
-- The stayer keeps the ledger (and its id) across chapters, so after A+B ends
-- and A+C begins, the page loaded A+B's session for A and C:
--   - C saw B's answers (and A's answers to B) once it was revealed;
--   - if B had answered and A had not, the session could never reveal for
--     A+C (reveal counted today's member_b, C, against a session holding B's
--     rows) — it stuck in "waiting" forever;
--   - A+C could never get a quiz of their own (UNIQUE (group_id)).
-- Failure looks like: nothing errors. C opens the quiz and reads B's answers,
-- or A and C wait on a reveal that never comes.
--
-- What changes:
--   1. PartnerQuizSessions.epoch_id uuid NOT NULL REFERENCES "GroupEpochs",
--      UNIQUE (epoch_id). The app loads and creates the session of the viewed
--      chapter (context.window.epochId), never "the group's".
--   2. Backfill: each session goes to the GroupEpochs row of its group whose
--      window holds its created_at (started_at <= created_at, and ended_at IS
--      NULL or created_at < ended_at — the strict rule of epochClause,
--      lib/db/queries/_predicates.ts). A session older than the group's first
--      chapter goes to that first chapter (same rule as viewer_in_chapter,
--      0080). Any session matching no chapter, or more than one, aborts the
--      whole migration (RAISE) — nothing is guessed. Prod preflight
--      2026-10-14 (read-only): 2 sessions, both match exactly one chapter.
--   3. The UNIQUE constraint on exactly (group_id) is found in pg_constraint
--      (prod: PartnerQuizSessions_group_id_key) and dropped; the migration
--      aborts unless there is exactly one. No answer row is deleted.
--   Grants: a column add; table grants (revoked from anon / authenticated in
--   0080) and RLS policies are unchanged. No table, view or function is
--   created.
--
-- Idempotent (ops-runbook): the DO block first detects the migrated state —
-- epoch_id present and NOT NULL, a UNIQUE on exactly (epoch_id), no UNIQUE on
-- exactly (group_id), no NULL epoch_id — and then does nothing. Any other
-- state that is not the 0094 shape aborts (e.g. group_id unique missing while
-- epoch_id is not yet NOT NULL), rather than guessing.
--
-- ─── Release ordering (v1.7.3) ─────────────────────────────────────────────
-- Prod: 0092 → 0093 → 0094 → 0095, ALL applied BEFORE the main → release
-- merge, in TWO `drizzle-kit migrate` invocations. drizzle-kit applies every
-- pending entry in ONE transaction, so a RAISE here in a combined run would
-- roll back 0092–0094 too:
--   Run 1: from a detached worktree at 79725f5 (journal ends at 0094).
--          Expected pending list vs drizzle.__drizzle_migrations: 0092, 0093,
--          0094 (whens 1784800000000, 1784900000000, 1785000000000). Then
--          their existing post-checks.
--   Run 2: from the release commit. Expected pending list: 0095 only (when
--          1785100000000). Then the catalog post-check below.
--   Before each run, compute the pending list by the runbook's watermark step
--   (docs/superpowers/ops-runbook.md, "每次跑 prod migrate 前"); any mismatch
--   → stop.
--     node --env-file=.env.production node_modules/.bin/drizzle-kit migrate
--
-- Skew failure modes:
--   - Code deployed BEFORE this migration: every open-chapter duo
--     /review/[month] and the quiz page fail with
--     `column "epoch_id" does not exist` (the new code names the column).
--   - Between this migration and the deploy (bounded): old code inserts a
--     session without epoch_id, which NOT NULL refuses, so a duo ledger that
--     has no session yet gets a 404 on the quiz page until the deploy. Old
--     code reading an existing session keeps working (it does not name the
--     column).
--
-- If the RAISE fires under `drizzle-kit migrate`, the tool exits 1 with no
-- error text and nothing is applied; re-run this file with psql to read it:
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f drizzle/0095_partner_quiz_epoch.sql
--
-- Rollback: forward-fix only once the new code has run on prod (an A+C
-- ledger can then hold two sessions, so UNIQUE (group_id) cannot come back,
-- and old code's `limit 1` lookup would return an arbitrary session — the
-- leak would return). Before the prod deploy: revert the code, then
-- scripts/rollback/0095_partner_quiz_epoch.down.sql (it RAISEs if any ledger
-- already holds more than one session).
--
-- Check afterwards (by data, not by the tool's success message):
--   SELECT column_name, is_nullable FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'PartnerQuizSessions' AND column_name = 'epoch_id';
--   -- expected: epoch_id | NO
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid = '"PartnerQuizSessions"'::regclass AND contype IN ('u', 'f') ORDER BY 1;
--   -- expected: PartnerQuizSessions_epoch_id_fkey FOREIGN KEY (epoch_id) REFERENCES "GroupEpochs"(id),
--   --           PartnerQuizSessions_epoch_id_unique UNIQUE (epoch_id),
--   --           PartnerQuizSessions_group_id_fkey FOREIGN KEY (group_id) REFERENCES "OikosGroups"(id)
--   --           (and no UNIQUE (group_id))
--   SELECT count(*) FROM "PartnerQuizSessions" WHERE epoch_id IS NULL;  -- expected: 0

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
DO $$
DECLARE
  v_rel        regclass := '"PartnerQuizSessions"'::regclass;
  v_group_att  int2;
  v_epoch_att  int2;
  v_notnull    boolean;
  v_group_uq   name[];
  v_epoch_uq   int;
  v_nulls      bigint;
  v_unmatched  bigint;
  v_multi      bigint;
BEGIN
  -- Old code must not insert a session between the checks and the DDL.
  LOCK TABLE "PartnerQuizSessions" IN ACCESS EXCLUSIVE MODE;

  SELECT attnum INTO v_group_att FROM pg_attribute
   WHERE attrelid = v_rel AND attname = 'group_id' AND NOT attisdropped;
  SELECT attnum, attnotnull INTO v_epoch_att, v_notnull FROM pg_attribute
   WHERE attrelid = v_rel AND attname = 'epoch_id' AND NOT attisdropped;

  SELECT coalesce(array_agg(conname ORDER BY conname), '{}') INTO v_group_uq FROM pg_constraint
   WHERE conrelid = v_rel AND contype = 'u' AND conkey = ARRAY[v_group_att];
  SELECT count(*) INTO v_epoch_uq FROM pg_constraint
   WHERE conrelid = v_rel AND contype = 'u' AND v_epoch_att IS NOT NULL AND conkey = ARRAY[v_epoch_att];

  -- Already migrated: nothing to do.
  IF v_epoch_att IS NOT NULL AND v_notnull AND v_epoch_uq > 0 AND cardinality(v_group_uq) = 0 THEN
    EXECUTE 'SELECT count(*) FROM "PartnerQuizSessions" WHERE epoch_id IS NULL' INTO v_nulls;
    IF v_nulls = 0 THEN
      RAISE NOTICE '0095: PartnerQuizSessions already per chapter; nothing to do';
      RETURN;
    END IF;
  END IF;

  -- The one constraint that made a quiz per-ledger must be there, alone.
  IF cardinality(v_group_uq) <> 1 THEN
    RAISE EXCEPTION '0095: expected exactly one UNIQUE (group_id) on PartnerQuizSessions, found %: %',
      cardinality(v_group_uq), v_group_uq;
  END IF;

  ALTER TABLE "PartnerQuizSessions"
    ADD COLUMN IF NOT EXISTS "epoch_id" uuid REFERENCES "GroupEpochs"("id");

  -- Each session's chapter: the window holding created_at; before the
  -- group's first chapter → the first chapter. Counted first, so a session
  -- matching none or several aborts before anything is written.
  CREATE TEMP TABLE _pq_0095_match ON COMMIT DROP AS
    SELECT s.id AS session_id,
           count(e.id) AS n,
           (array_agg(e.id))[1] AS epoch_id
      FROM "PartnerQuizSessions" s
      LEFT JOIN "GroupEpochs" e
        ON e.group_id = s.group_id
       AND (e.ended_at IS NULL OR s.created_at < e.ended_at)
       AND (
             s.created_at >= e.started_at
          OR e.started_at = (SELECT min(f.started_at) FROM "GroupEpochs" f WHERE f.group_id = s.group_id)
           )
     WHERE s.epoch_id IS NULL
     GROUP BY s.id;

  SELECT count(*) FILTER (WHERE n = 0), count(*) FILTER (WHERE n > 1)
    INTO v_unmatched, v_multi FROM _pq_0095_match;
  IF v_unmatched > 0 OR v_multi > 0 THEN
    RAISE EXCEPTION '0095: % PartnerQuizSessions row(s) match no chapter and % match more than one; not migrating',
      v_unmatched, v_multi;
  END IF;

  UPDATE "PartnerQuizSessions" s
     SET epoch_id = m.epoch_id
    FROM _pq_0095_match m
   WHERE s.id = m.session_id;

  DROP TABLE _pq_0095_match;

  SELECT count(*) INTO v_nulls FROM "PartnerQuizSessions" WHERE epoch_id IS NULL;
  IF v_nulls > 0 THEN
    RAISE EXCEPTION '0095: % PartnerQuizSessions row(s) still have no epoch_id; not migrating', v_nulls;
  END IF;

  EXECUTE format('ALTER TABLE "PartnerQuizSessions" DROP CONSTRAINT %I', v_group_uq[1]);
  ALTER TABLE "PartnerQuizSessions" ALTER COLUMN "epoch_id" SET NOT NULL;

  SELECT attnum INTO v_epoch_att FROM pg_attribute
   WHERE attrelid = v_rel AND attname = 'epoch_id' AND NOT attisdropped;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = v_rel AND contype = 'u' AND conkey = ARRAY[v_epoch_att]
  ) THEN
    ALTER TABLE "PartnerQuizSessions"
      ADD CONSTRAINT "PartnerQuizSessions_epoch_id_unique" UNIQUE ("epoch_id");
  END IF;
END $$;
