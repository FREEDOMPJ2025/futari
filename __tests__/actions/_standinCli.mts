// ─── CLI around _supabaseStandIn.ts: make / drop a Supabase stand-in DB ─────
//
// The local-DB integration suites in __tests__/actions/ need a MIGRATED
// database with the Supabase pieces (auth schema, roles, SQL functions, RLS,
// triggers). `drizzle-kit push` gives none of that. Use this instead.
//
// Recipe (local throwaway Postgres only; the helpers refuse non-local URLs):
//   PORT=<a free port>
//   docker run -d --name pg-<n> -e POSTGRES_PASSWORD=pg -p 127.0.0.1:$PORT:5432 postgres:17
//   ADMIN=postgres://postgres:pg@127.0.0.1:$PORT/postgres
//   URL=$(npx tsx __tests__/actions/_standinCli.mts create $ADMIN)      # prints only the URL
//   DATABASE_URL=$URL npx vitest run __tests__/actions/<file>.test.ts
//   npx tsx __tests__/actions/_standinCli.mts drop $ADMIN $URL
//   docker rm -f pg-<n>
//
// `create <adminUrl> [through]` migrates up to `through` (a 4-digit prefix,
// e.g. 0079); default is the last entry of drizzle/meta/_journal.json.
//
// What failure looks like if you use `drizzle-kit push` instead:
//   `relation "auth.users" does not exist`, and after faking that,
//   `function profile_is_live does not exist` (no SQL functions / RLS /
//   triggers from the hand-written migrations).
//
// Must stay .mts: a .ts script with top-level await failed under tsx
// (2026-10-17). The namespace import below is deliberate: tsx may expose the
// CJS-style named exports under `default`.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as ns from './_supabaseStandIn.ts'

const wrapped = ns as typeof ns & { default?: typeof ns }
const mod = typeof wrapped.createStandInDb === 'function' ? wrapped : (wrapped.default as typeof ns)

const [cmd, a, b] = process.argv.slice(2)

if (cmd === 'create' && a) {
  let through = b
  if (!through) {
    const journal = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../drizzle/meta/_journal.json'), 'utf8'))
    through = String(journal.entries[journal.entries.length - 1].tag).slice(0, 4)
  }
  process.stdout.write((await mod.createStandInDb(a, through)) + '\n')
} else if (cmd === 'drop' && a && b) {
  await mod.dropStandInDb(a, b)
} else {
  console.error('usage: _standinCli.mts create <adminUrl> [through] | drop <adminUrl> <standinUrl>')
  process.exit(2)
}
process.exit(0)
