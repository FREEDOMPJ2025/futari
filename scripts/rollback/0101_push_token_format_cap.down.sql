-- ROLLBACK for drizzle/0101_push_token_format_cap.sql — MANUAL ONLY, NEVER RUN AUTOMATICALLY.
-- Not a drizzle migration: drizzle-kit only runs files listed in drizzle/meta/_journal.json.
--
-- What it does: drops the two triggers, their functions, and the CHECK
-- push_tokens_token_format. PushTokens goes back to 0087's shape: any token
-- text, any number of rows per person, updated_at frozen at insert time.
-- Data: rows 0101 deleted (bad format) or the cap trigger evicted are NOT
-- restored. Real devices re-register the next time their app opens the
-- dashboard.
--
-- Order: none needed with the code. Nothing in the app reads the constraint or
-- the triggers; the sender (send-recurring-push) works with or without them.
-- After this, the sender's own per-user / per-ledger / per-run caps (#1827 S1)
-- are the only limit on what one account's rows can cost the nightly run.
--
-- Run: psql "$DATABASE_URL_DIRECT" -1 -v ON_ERROR_STOP=1 -f scripts/rollback/0101_push_token_format_cap.down.sql
-- Post-check (all 0):
--   SELECT count(*) FROM pg_constraint WHERE conname = 'push_tokens_token_format';
--   SELECT count(*) FROM pg_trigger WHERE tgrelid = '"PushTokens"'::regclass AND NOT tgisinternal;
--   SELECT count(*) FROM pg_proc WHERE proname IN ('push_tokens_touch_updated_at', 'push_tokens_enforce_cap');

DROP TRIGGER IF EXISTS "PushTokens_enforce_cap" ON "PushTokens";
DROP TRIGGER IF EXISTS "PushTokens_touch_updated_at" ON "PushTokens";
DROP FUNCTION IF EXISTS public.push_tokens_enforce_cap();
DROP FUNCTION IF EXISTS public.push_tokens_touch_updated_at();
ALTER TABLE "PushTokens" DROP CONSTRAINT IF EXISTS push_tokens_token_format;
