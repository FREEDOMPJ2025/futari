// ─── #1449 — an auth.users row for a test profile ──────────────────────────
//
// acceptInvite and createGroup refuse a profile whose account is gone
// (`profile_not_found`, lockProfileRow in lib/db/queries/epoch.ts): that is
// how they tell a live user from the tombstone the account-deletion job
// leaves behind, and the only signal is the auth.users row. A fixture that
// inserts "Profiles" directly therefore has to add the auth row too, or every
// accept / createGroup it drives fails with profile_not_found. Failure looks
// like: `{ ok: false, code: 'profile_not_found' }` where the test expected
// ok: true, or an `ActionError: profile_not_found` from a seed step.
//
// Callers insert the Profiles row first, then call this. On dev the
// handle_new_user trigger (on_auth_user_created) inserts a Profiles row
// WITHOUT ON CONFLICT, so inserting the auth user while the fixture's row
// exists fails with `duplicate key ... "Profiles_pkey"` (#1596; failure looks
// like 16 red invite tests unrelated to the change under test). So, for all the users,
// in one transaction: drop the fixture's just-inserted row (nothing references
// it yet), create the auth user (the trigger re-creates the profile from
// full_name), then upsert the row so it ends up as the fixture wrote it
// whether or not the database's trigger inserts one.
//
// #1710 — the second reason a fixture needs this row. Since 0096 the
// `sweep-orphan-ledgers` cron (daily 15:00 UTC) and the tail of
// `process_account_deletions()` delete every ledger whose member_a has no
// auth.users row and whose member_b is NULL. A fixture's solo ledger (or a duo
// after one member left) whose member_a has no auth row therefore vanishes
// mid-run on the shared dev DB. Failure looks like: no error naming the sweep;
// a suite fails now and then because a row it just inserted is gone, and a
// rerun passes. So EVERY member_a of a ledger a suite commits to dev needs a
// row here, and teardown must call deleteAuthUsers (after the ledger is gone).
// Exempt: ledgers that only ever exist inside a transaction that is rolled
// back (the sweep sees committed rows only), and ledgers with member_b set
// for their whole life. A deliberately deleted / tombstone former member is
// the one person who should NOT get a row.
//
// Connection: on a local throwaway DB, DATABASE_URL (it is the superuser
// there). Anywhere else DATABASE_URL is the runtime role (futari_app), which
// cannot touch schema auth, so DATABASE_URL_DIRECT (the admin role) is used —
// the same split as accountDeletion0068.test.ts. Never DATABASE_URL_DIRECT
// against a local DATABASE_URL: .env.local fills it in with dev's.

import postgres from 'postgres'

function adminUrl(): string {
  const appUrl = process.env.DATABASE_URL ?? ''
  let local = false
  try {
    local = ['localhost', '127.0.0.1', '::1'].includes(new URL(appUrl).hostname)
  } catch {
    local = false
  }
  if (local) return appUrl
  const direct = process.env.DATABASE_URL_DIRECT
  if (!direct) throw new Error('DATABASE_URL_DIRECT not set; seeding auth.users needs the admin connection.')
  return direct
}

// One admin connection per test file, opened on first use and closed by
// postgres.js after a few idle seconds (no afterAll to forget). Opening one per
// call cost a TLS handshake to the dev pooler each time — ~0.3 s on top of the
// statements — and the suites seed in beforeEach, against a 5 s default timeout.
let admin: postgres.Sql | null = null

async function withAdmin<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  admin ??= postgres(adminUrl(), { max: 1, prepare: false, onnotice: () => {}, idle_timeout: 3 })
  return fn(admin)
}

/**
 * Give already-inserted Profiles rows their auth.users rows. Call it right
 * after inserting the Profiles and BEFORE any ledger names them as a member:
 * it deletes and re-inserts the Profiles row (see the header), which fails
 * once something references it. Only `displayName` and `avatarUrl` survive the
 * re-insert, so pass `avatarUrl` here if the fixture sets one. One transaction,
 * a fixed number of round trips however many users (the dev pooler is ~40 ms
 * away).
 */
export async function seedAuthUsers(
  users: Array<{ id: string; displayName: string; avatarUrl?: string | null }>,
): Promise<void> {
  if (users.length === 0) return
  const ids = users.map((u) => u.id)
  const names = users.map((u) => u.displayName)
  const avatars = users.map((u) => u.avatarUrl ?? null)
  await withAdmin(async (sql) => {
    await sql.begin(async (tx) => {
      await tx`DELETE FROM "Profiles" WHERE id = ANY(${ids}::uuid[])`
      await tx`
        INSERT INTO auth.users (id, raw_user_meta_data)
        SELECT u.id, jsonb_build_object('full_name', u.name)
          FROM unnest(${ids}::uuid[], ${names}::text[]) AS u(id, name)
        ON CONFLICT (id) DO NOTHING`
      await tx`
        INSERT INTO "Profiles" (id, display_name, avatar_url)
        SELECT u.id, u.name, u.avatar FROM unnest(${ids}::uuid[], ${names}::text[], ${avatars}::text[]) AS u(id, name, avatar)
        ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, avatar_url = EXCLUDED.avatar_url`
    })
  })
}

/**
 * Remove the auth.users rows {@link seedAuthUsers} added. Call it in teardown
 * after the ledgers that name them are deleted. It does not touch Profiles.
 */
export async function deleteAuthUsers(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  await withAdmin(async (sql) => {
    await sql`DELETE FROM auth.users WHERE id = ANY(${ids}::uuid[])`
  })
}
