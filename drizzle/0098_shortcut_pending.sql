-- 0098: personal shortcut keys and the "pending" cards a Shortcut creates
-- (#1536).
-- plan: issue #1536 (S1). An iOS Shortcut POSTs an amount with a personal
-- key; Futari stores it as a pending card only the key's owner sees, and it
-- enters the ledger only when the owner confirms it.
--
-- ShortcutKeys: one row per minted key. Only the SHA-256 of the full key
-- (lib/shortcutKey.ts hashShortcutKey) and its last 4 characters are stored;
-- the plaintext exists once, in the response that minted it. At most one
-- unrevoked key per user (partial unique index); re-generating revokes the old
-- one and inserts the new one in one transaction.
--
-- ShortcutPendingExpenses: one row per card. No group and no resolved_tx_id
-- on purpose: confirming writes into whatever ledger/chapter is open then and
-- deletes the card in the same transaction, so nothing here can ever hold a
-- foreign key that blocks a cleanup (the #1689 shape).
--
-- Why user_id references auth.users, not "Profiles": account deletion (0096
-- process_account_deletions) always deletes auth.users, but often keeps the
-- Profiles row as a tombstone (「已離開的夥伴」) when the partner's ledger still
-- references it. A cascade from Profiles would then never fire.
-- Failure look if this is ever "normalised" to REFERENCES "Profiles": nothing
-- errors; a deleted user's key hashes and pending cards stay forever.
-- __tests__/actions/shortcutPending0098.test.ts runs the real deletion job on
-- a tombstoned user and expects 0 rows in both tables.
-- (lib/db/schema.ts declares user_id without .references(): drizzle has no
-- model of auth.users. The FK lives only here.)
--
-- Access: RLS on, no policies, and anon / authenticated lose the default
-- grants. Only the server (Drizzle as futari_app, BYPASSRLS) reads and writes
-- these. Not in the supabase_realtime publication: only the owner sees a
-- card, read when the dashboard opens.
-- Failure look if the REVOKE is dropped: nothing errors; GET
-- /rest/v1/ShortcutKeys is reachable from any signed-in browser and RLS alone
-- decides (tests/migration-grant-guard.test.ts and the live catalog test
-- __tests__/actions/dataApiGrants1518.test.ts catch it).
--
-- Cleanup: a NEW pg_cron job, cleanup-shortcut-pending, daily 19:20 UTC
-- (03:20 Asia/Taipei): outside the 15:00 and 16:00-17:30 UTC daily jobs, the
-- Sunday 03:00 UTC cleanup-soft-deleted, and the 00:00 UTC (08:00 Taipei)
-- backup. cleanup-soft-deleted is NOT touched. It removes
--   - cards older than 30 days, skipped or not (the product promise: an
--     unconfirmed card disappears after 30 days; the dashboard query also
--     filters created_at > now() - 30 days, so the UI never depends on the
--     cron having run), and
--   - keys revoked more than 30 days ago (their remaining cards get
--     key_id NULL via ON DELETE SET NULL).
-- Failure look if the job is missing or failing: nothing errors in the app;
-- cron.job has no cleanup-shortcut-pending row (or cron.job_run_details shows
-- it failing), and old cards / revoked key hashes pile up. Check:
--   SELECT jobname, schedule, command FROM cron.job
--    WHERE jobname = 'cleanup-shortcut-pending';
--
-- Idempotent: IF NOT EXISTS everywhere; cron.schedule with an existing
-- jobname replaces the command in place.
--
-- Rollback: a new migration that unschedules cleanup-shortcut-pending and
-- drops both tables (they hold only pending cards and key hashes, no ledger
-- data).

CREATE TABLE IF NOT EXISTS "ShortcutKeys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES auth.users ("id") ON DELETE CASCADE,
  "key_hash" text NOT NULL,
  "key_hint" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_used_at" timestamptz,
  "revoked_at" timestamptz,
  CONSTRAINT "ShortcutKeys_key_hash_unique" UNIQUE ("key_hash"),
  -- Only a SHA-256 hex digest fits: a bug that stores the plaintext key
  -- (fts_sk_…) fails here instead of silently keeping a usable secret.
  CONSTRAINT "ShortcutKeys_key_hash_is_sha256_hex" CHECK ("key_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "ShortcutKeys_one_active_per_user"
  ON "ShortcutKeys" ("user_id") WHERE "revoked_at" IS NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "ShortcutPendingExpenses" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES auth.users ("id") ON DELETE CASCADE,
  "key_id" uuid REFERENCES "ShortcutKeys" ("id") ON DELETE SET NULL,
  "amount" integer NOT NULL,
  "category" text,
  "description" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "skipped_at" timestamptz,
  CONSTRAINT "ShortcutPendingExpenses_amount_positive" CHECK ("amount" > 0)
);
--> statement-breakpoint

-- Per-key rate limit: rows of one key in the last hour.
CREATE INDEX IF NOT EXISTS "ShortcutPendingExpenses_key_created_idx"
  ON "ShortcutPendingExpenses" ("key_id", "created_at");
--> statement-breakpoint

-- Open cards of one user (dashboard read, open-card cap).
CREATE INDEX IF NOT EXISTS "ShortcutPendingExpenses_user_open_idx"
  ON "ShortcutPendingExpenses" ("user_id") WHERE "skipped_at" IS NULL;
--> statement-breakpoint

ALTER TABLE "ShortcutKeys" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ShortcutPendingExpenses" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

REVOKE ALL ON TABLE "ShortcutKeys", "ShortcutPendingExpenses" FROM anon, authenticated;
--> statement-breakpoint

SELECT cron.schedule('cleanup-shortcut-pending', '20 19 * * *', $$
  DELETE FROM "ShortcutPendingExpenses" WHERE created_at < NOW() - INTERVAL '30 days';
  DELETE FROM "ShortcutKeys"            WHERE revoked_at < NOW() - INTERVAL '30 days';
$$);
