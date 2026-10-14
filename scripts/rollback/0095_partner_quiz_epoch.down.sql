-- ROLLBACK for drizzle/0095_partner_quiz_epoch.sql — MANUAL ONLY, NEVER RUN AUTOMATICALLY.
-- Not a drizzle migration: drizzle-kit only runs files listed in drizzle/meta/_journal.json.
--
-- Valid ONLY before the #1683 code has run on prod. Once it has, a ledger
-- whose partner changed can hold one session per chapter, UNIQUE (group_id)
-- cannot come back, and old code's `limit 1` lookup would hand the next
-- partner an arbitrary (possibly the previous partner's) session — the leak
-- #1683 fixed. After that point: forward-fix only.
--
-- Order: revert the code first (old code does not name epoch_id), then run
-- this. Running it under new code breaks every open-chapter duo
-- /review/[month] and the quiz page (`column "epoch_id" does not exist`).
--
-- What it does:
--   1. Aborts (RAISE) if any ledger holds more than one session: re-adding
--      UNIQUE (group_id) would fail, and picking which session to delete is
--      not this script's call. No row is deleted.
--   2. Re-adds UNIQUE (group_id) as PartnerQuizSessions_group_id_key (0034's
--      name), drops epoch_id (with its FK and UNIQUE).
--   3. Removes 0095's row from drizzle.__drizzle_migrations, so the next
--      `db:migrate` re-applies 0095. Roll back any migration recorded after
--      0095 first: drizzle-kit only applies journal entries newer than the
--      newest recorded one.
--
-- Run inside one transaction:  psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f <this file>

SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  v_dupes bigint;
BEGIN
  LOCK TABLE "PartnerQuizSessions" IN ACCESS EXCLUSIVE MODE;

  SELECT count(*) INTO v_dupes FROM (
    SELECT group_id FROM "PartnerQuizSessions" GROUP BY group_id HAVING count(*) > 1
  ) d;
  IF v_dupes > 0 THEN
    RAISE EXCEPTION '0095 rollback: % ledger(s) hold more than one PartnerQuizSessions row; forward-fix only', v_dupes;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid = '"PartnerQuizSessions"'::regclass AND c.contype = 'u'
       AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute
                              WHERE attrelid = c.conrelid AND attname = 'group_id' AND NOT attisdropped)]
  ) THEN
    ALTER TABLE "PartnerQuizSessions"
      ADD CONSTRAINT "PartnerQuizSessions_group_id_key" UNIQUE ("group_id");
  END IF;

  ALTER TABLE "PartnerQuizSessions" DROP COLUMN IF EXISTS "epoch_id";
END $$;

DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1785100000000;
