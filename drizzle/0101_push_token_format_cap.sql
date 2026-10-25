-- 0101: PushTokens — token format per platform, at most 10 rows per person,
-- updated_at that moves (#1827).
-- plan: #1827 S2 (security review F-A, F-B, F-C, F-D, F-I)
--
-- Why: 0054 left `token` as any text of any length, and nothing limited how
-- many rows one signed-in user could upsert for themselves (RLS only pins
-- user_id to the caller and, since 0087, group_id to a ledger they are in).
-- One account could store thousands of junk or megabyte-long "tokens"; the
-- nightly send-recurring-push read them all and tried each one, crowding out
-- every other ledger's push. Failure looks like: nothing errors in the app;
-- the 16:10 UTC run gets slow or times out and real users stop getting
-- 「有待確認的定期收支」. (The sender's own caps are #1827 S1.)
--
-- What this migration does, in one transaction (drizzle's migrator):
--   1. DELETEs the rows that fail the format below. They are not real device
--      tokens; a real one registers again the next time its app opens the
--      dashboard (PushTokenRegistrar), same reasoning as 0087. Prod had 0 such
--      rows on 2026-10-25 (41 rows, all 64-char uppercase hex APNs, 0 FCM).
--   2. Adds CHECK push_tokens_token_format, fully validated (not NOT VALID:
--      leaveGroup / acceptInvite UPDATE these rows, and an unvalidated old row
--      would make those UPDATEs fail with 23514 — review F-C):
--        apns: hex either case (Capacitor emits UPPERCASE), 64..512, even length
--        fcm:  [A-Za-z0-9_:-], 20..512
--      PostgreSQL regex bounds stop at 255, so lengths are char_length
--      predicates. The numbers live in lib/pushTokenFormat.ts; the guard test
--      tests/push-token-format-1827.test.ts fails when this file disagrees, or
--      when a max is above the sign-out limit (actions/auth.ts
--      MAX_PUSH_TOKEN_LENGTH, 512 today; #1831 raises it to 4096).
--      A bad client upsert now gets 23514 back as `{ error }`; the client
--      reports only error.code (lib/pushNotifications.ts, #1827 S3).
--   3. BEFORE UPDATE trigger: updated_at = now(). It never changed before
--      (prod: 0 rows with updated_at <> created_at), so "oldest" meant "first
--      registered", not "least recently seen". The client's upsert re-registers
--      on every dashboard open (ON CONFLICT DO UPDATE), which now refreshes it.
--   4. AFTER INSERT trigger: at most 10 rows per user_id; the least recently
--      registered beyond 10 are deleted, never the row just inserted. AFTER
--      INSERT, not BEFORE: a BEFORE INSERT trigger also fires on the upsert's
--      ON CONFLICT DO UPDATE path, so a person at the cap re-registering an
--      existing device would be refused. An AFTER INSERT row trigger fires
--      only for rows actually inserted. It evicts instead of refusing so a
--      person who reinstalled many times is never locked out of push.
--      Concurrency: a transaction-scoped advisory lock per user_id; the
--      DELETE runs after the lock, so under READ COMMITTED it sees the other
--      transaction's committed row (two connections inserting at once still
--      end at <= 10). SECURITY DEFINER (owner postgres): `authenticated` has
--      no DELETE on PushTokens (0080) and gets none here. search_path = ''
--      and every name schema-qualified.
--   Both functions: REVOKE ALL FROM PUBLIC, anon, authenticated, service_role
--   (0080 / 0096 convention). Supabase's default ACL grants EXECUTE on every
--   new public function to anon and authenticated; left in place they show up
--   as extra lines in the #1518 allowlist test. Trigger firing does not check
--   EXECUTE, so the triggers still run for every role.
--
-- Not here: rows of a person already above 10 are trimmed on their next
-- insert, not now (prod max was 2). No new GRANT, no new column; the 0080
-- allowlist (`PushTokens|authenticated|T:SELECT,INSERT,UPDATE`) is unchanged.
--
-- Run after 0100 (journal order), and on prod only after #1834's cutover is
-- done (ops-runbook 「PushTokens 格式與筆數上限（0101）」).
-- Idempotent: the DELETE finds nothing the second time; DROP ... IF EXISTS
-- before every ADD / CREATE.
-- Rollback: scripts/rollback/0101_push_token_format_cap.down.sql (drops the
-- constraint, triggers and functions; deleted or evicted rows are not
-- restored — they re-register).

DELETE FROM "PushTokens"
 WHERE NOT (
   (platform = 'apns' AND token ~ '^[0-9A-Fa-f]+$' AND char_length(token) BETWEEN 64 AND 512 AND char_length(token) % 2 = 0)
   OR (platform = 'fcm' AND token ~ '^[A-Za-z0-9_:-]+$' AND char_length(token) BETWEEN 20 AND 512)
 );
--> statement-breakpoint
ALTER TABLE "PushTokens" DROP CONSTRAINT IF EXISTS push_tokens_token_format;
--> statement-breakpoint
ALTER TABLE "PushTokens" ADD CONSTRAINT push_tokens_token_format CHECK (
  (platform = 'apns' AND token ~ '^[0-9A-Fa-f]+$' AND char_length(token) BETWEEN 64 AND 512 AND char_length(token) % 2 = 0)
  OR (platform = 'fcm' AND token ~ '^[A-Za-z0-9_:-]+$' AND char_length(token) BETWEEN 20 AND 512)
);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.push_tokens_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END;
$fn$;
--> statement-breakpoint
ALTER FUNCTION public.push_tokens_touch_updated_at() OWNER TO postgres;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.push_tokens_touch_updated_at() FROM PUBLIC, anon, authenticated, service_role;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "PushTokens_touch_updated_at" ON "PushTokens";
--> statement-breakpoint
CREATE TRIGGER "PushTokens_touch_updated_at"
  BEFORE UPDATE ON "PushTokens"
  FOR EACH ROW EXECUTE FUNCTION public.push_tokens_touch_updated_at();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.push_tokens_enforce_cap()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_cap constant integer := 10;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('PushTokens.cap:' || NEW.user_id::text, 0)
  );
  DELETE FROM public."PushTokens" t
   WHERE t.user_id = NEW.user_id
     AND t.id IN (
       SELECT k.id FROM public."PushTokens" k
        WHERE k.user_id = NEW.user_id
        ORDER BY (k.id = NEW.id) DESC, k.updated_at DESC, k.created_at DESC, k.id DESC
        OFFSET v_cap
     );
  RETURN NULL;
END;
$fn$;
--> statement-breakpoint
ALTER FUNCTION public.push_tokens_enforce_cap() OWNER TO postgres;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.push_tokens_enforce_cap() FROM PUBLIC, anon, authenticated, service_role;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "PushTokens_enforce_cap" ON "PushTokens";
--> statement-breakpoint
CREATE TRIGGER "PushTokens_enforce_cap"
  AFTER INSERT ON "PushTokens"
  FOR EACH ROW EXECUTE FUNCTION public.push_tokens_enforce_cap();
