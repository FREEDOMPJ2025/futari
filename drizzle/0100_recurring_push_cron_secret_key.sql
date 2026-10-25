-- 0100: notify-recurring-push authenticates with the named secret key `cron`
-- (#1834). Replaces 0056's job body.
--
-- Why: the cron sends `Authorization: Bearer <legacy service_role JWT>`
-- (Vault oikos_service_role_key). Supabase retires the legacy JWT keys by the
-- end of 2026; from that day the gateway refuses it. Failure would look like:
-- the 16:10 UTC run gets 401 in net._http_response, the function logs no
-- `[auth]` line, nobody gets a push, nothing else errors.
--
-- What changes (schedule unchanged, '10 16 * * *'):
--   1. Adds `apikey: <Vault oikos_cron_secret_key>` — the project's secret key
--      named `cron` (`sb_secret_…`). The new function (verify_jwt = false)
--      accepts only that key, on that header (callerAuth.ts).
--   2. Keeps `Authorization: Bearer <Vault oikos_service_role_key>` for the
--      transition: the function deployed before #1834 (verify_jwt = true, claim
--      check) still needs it, so there is no 401 window whichever of migration
--      and deploy lands first. A later migration (#1834 S5) drops it, before
--      the legacy keys are disabled.
--   3. The URL comes from Vault oikos_project_url, no longer a literal: 0056
--      hard-coded prod's URL, so dev's cron called prod with dev's key.
-- Every value is read from Vault when the job RUNS, never formatted into the
-- command here: cron.job.command is readable by futari_backup (0081) and lands
-- in every backup manifest, so a key written into it would leak there.
--
-- Prerequisites (owner, one-time, per project — see ops-runbook.md
-- 「呼叫者驗證」): the dashboard secret key `cron`, and the Vault entries
-- oikos_cron_secret_key (that key) and oikos_project_url
-- (`https://<ref>.supabase.co`, the project's own). oikos_service_role_key
-- already exists (0056).
--
-- The precondition below RAISEs (the migration fails, nothing is rescheduled)
-- when an entry is missing or malformed, so a missing secret never becomes a
-- NULL url / header at 16:10. Messages name the entry, never its value. It
-- skips itself when vault.decrypted_secrets does not exist (the test stand-in,
-- __tests__/actions/_supabaseStandIn.ts, has no Vault).
--
-- Rollback: scripts/rollback/0100_recurring_push_cron_secret_key.down.sql, in
-- the order the runbook gives (function first, then this).

DO $$
DECLARE
  v_url text;
  v_key text;
  v_has_bearer boolean;
BEGIN
  IF to_regclass('vault.decrypted_secrets') IS NULL THEN
    RAISE NOTICE '0100: vault.decrypted_secrets does not exist (not a Supabase project); Vault precondition skipped';
    RETURN;
  END IF;

  SELECT decrypted_secret INTO v_url
  FROM vault.decrypted_secrets WHERE name = 'oikos_project_url' LIMIT 1;
  IF v_url IS NULL OR v_url !~ '^https://[a-z0-9]{20}\.supabase\.co$' THEN
    RAISE EXCEPTION '0100: Vault secret oikos_project_url is missing or not https://<20-char ref>.supabase.co (no trailing slash)';
  END IF;

  SELECT decrypted_secret INTO v_key
  FROM vault.decrypted_secrets WHERE name = 'oikos_cron_secret_key' LIMIT 1;
  IF v_key IS NULL OR left(v_key, 10) <> 'sb_secret_' OR length(v_key) <= 10 OR v_key ~ '\s' THEN
    RAISE EXCEPTION '0100: Vault secret oikos_cron_secret_key is missing, not an sb_secret_ key, or contains whitespace';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM vault.decrypted_secrets
    WHERE name = 'oikos_service_role_key' AND decrypted_secret IS NOT NULL AND decrypted_secret <> ''
  ) INTO v_has_bearer;
  IF NOT v_has_bearer THEN
    RAISE EXCEPTION '0100: Vault secret oikos_service_role_key is missing (0056 prerequisite; still sent during the transition)';
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
      ),
      'apikey', (
        SELECT decrypted_secret
        FROM vault.decrypted_secrets
        WHERE name = 'oikos_cron_secret_key'
        LIMIT 1
      )
    ),
    body := '{}'::jsonb
  );
$$);
