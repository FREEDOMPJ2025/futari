-- ROLLBACK for drizzle/0100_recurring_push_cron_secret_key.sql — MANUAL ONLY, NEVER RUN AUTOMATICALLY.
-- Not a drizzle migration: drizzle-kit only runs files listed in drizzle/meta/_journal.json.
--
-- ORDER (hard; ops-runbook.md「呼叫者驗證」→「回滾（照順序）」):
--   1. Redeploy the function from the commit before #1834 (a detached
--      worktree; its config.toml has verify_jwt = true and the claim check).
--   2. Read back verify_jwt = true (Management API). Only then:
--   3. Run this file.
-- Failure look of the other order (this file while the #1834 function is still
-- live): that function ignores Authorization and needs the apikey header this
-- file drops, so the next 16:10 UTC run gets 401, the function logs
-- `[auth] reject reason=no_apikey`, nobody gets a push.
--
-- What it does: restores 0056's header shape — `Authorization: Bearer <Vault
-- oikos_service_role_key>`, no apikey — with the same schedule. The URL stays
-- on Vault oikos_project_url (NOT 0056's literal prod URL), so running this on
-- dev does not point dev's cron back at prod. Every value is still read from
-- Vault when the job runs; nothing secret is written into cron.job.command.
--
-- On dev the Vault oikos_service_role_key is an sb_ key, not a legacy JWT
-- (measured 2026-10-23), so on dev the pre-#1834 function answers this job with
-- 401 reason=not_jwt. Expected on dev only; prod's is the legacy JWT.
--
-- Run: psql "$DATABASE_URL_DIRECT" -1 -v ON_ERROR_STOP=1 -f scripts/rollback/0100_recurring_push_cron_secret_key.down.sql
-- Apply window: not between 16:05 and 16:15 UTC.
-- Post-check (structure only; never select decrypted values):
--   SELECT schedule, command ~ 'oikos_project_url' AS url_from_vault,
--          command ~ 'oikos_cron_secret_key' AS has_apikey
--   FROM cron.job WHERE jobname = 'notify-recurring-push';
--   → '10 16 * * *' | t | f

DO $$
DECLARE
  v_url text;
BEGIN
  SELECT decrypted_secret INTO v_url
  FROM vault.decrypted_secrets WHERE name = 'oikos_project_url' LIMIT 1;
  IF v_url IS NULL OR v_url !~ '^https://[a-z0-9]{20}\.supabase\.co$' THEN
    RAISE EXCEPTION '0100 down: Vault secret oikos_project_url is missing or not https://<20-char ref>.supabase.co';
  END IF;
END $$;

DO $$
BEGIN
  PERFORM cron.unschedule('notify-recurring-push');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule('notify-recurring-push', '10 16 * * *', $$
  SELECT net.http_post(
    url := (
      SELECT decrypted_secret
      FROM vault.decrypted_secrets
      WHERE name = 'oikos_project_url'
      LIMIT 1
    ) || '/functions/v1/send-recurring-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        SELECT decrypted_secret
        FROM vault.decrypted_secrets
        WHERE name = 'oikos_service_role_key'
        LIMIT 1
      )
    ),
    body := '{}'::jsonb
  );
$$);
