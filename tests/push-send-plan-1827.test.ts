/**
 * #1827 S1 — the nightly push is fair, bounded, and reads every row.
 *
 * Scenarios (each was a way one account could cost every other family their
 * push; failure looks like: nothing errors, most families silently stop
 * getting 「有待確認的定期收支」):
 *   - planSends: one attacker ledger with 1000 tokens next to 50 ordinary
 *     ledgers → every ordinary ledger is sent to, the attacker at most
 *     PER_USER_SEND_CAP; per-ledger and per-run caps hold; one device is sent
 *     once; rows with no known owner are never sent (fail closed).
 *   - runWithDeadline: 200 ms per send → the run stops starting sends at the
 *     deadline, finishes by deadline + one send, counts the rest as skipped;
 *     never more than `concurrency` at once; a throwing send does not stop
 *     the others.
 *   - keysetPages: a server that returns fewer rows than asked (PostgREST max
 *     rows) still yields every row (review F-F); a server that ignores the
 *     filter, or errors, stops the loop instead of looping or truncating
 *     silently.
 *   - index.ts wiring: paged reads, the plan, both platforms in parallel with
 *     the deadline, APNs fetch timeout, stale deletes after every pool, and a
 *     counts-only summary line.
 *
 * The modules are pure; the Deno entrypoint cannot load under vitest, so the
 * wiring is asserted on its source (like push-fcm-968.test.ts).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PushTarget } from '../supabase/functions/send-recurring-push/memberTokens.ts'
import {
  DEFAULT_SEND_CAPS,
  PER_LEDGER_SEND_CAP,
  PER_RUN_SEND_CAP,
  PER_USER_SEND_CAP,
  planSends,
  type RowOwner,
} from '../supabase/functions/send-recurring-push/sendPlan.ts'
import {
  APNS_FETCH_TIMEOUT_MS,
  RUN_DEADLINE_MS,
  SEND_CONCURRENCY,
  runWithDeadline,
} from '../supabase/functions/send-recurring-push/sendPool.ts'
import { FCM_FETCH_TIMEOUT_MS } from '../supabase/functions/send-recurring-push/fcm.ts'
import { keysetPages, chunks, type PageResponse } from '../supabase/functions/send-recurring-push/keysetPages.ts'

// ─── fixtures ────────────────────────────────────────────────────────────────

/** Builds targets and the row-owner map the way index.ts does. */
function world() {
  const targets: PushTarget[] = []
  const owners = new Map<string, RowOwner>()
  let n = 0
  const add = (groupId: string, userId: string, platform: 'apns' | 'fcm' = 'apns', token?: string) => {
    const id = `row-${++n}`
    owners.set(id, { userId, groupId })
    const t = token ?? `tok-${n}`
    const existing = targets.find((x) => x.platform === platform && x.token === t)
    if (existing) existing.ids.push(id)
    else targets.push({ platform, token: t, ids: [id] })
    return t
  }
  return { targets, owners, add }
}

const pad = (i: number) => String(i).padStart(4, '0')
const ledgerOf = (t: PushTarget, owners: Map<string, RowOwner>) => owners.get(t.ids[0])!.groupId

// ─── planSends ───────────────────────────────────────────────────────────────

describe('planSends (#1827)', () => {
  it('1 attacker × 1000 tokens + 50 ordinary ledgers: every ordinary ledger sent, attacker <= per-user cap', () => {
    const w = world()
    // The attacker's ledger sorts FIRST, the worst case for the old in-order loop.
    for (let i = 0; i < 1000; i++) w.add('g-0000-attacker', 'u-attacker')
    for (let g = 1; g <= 50; g++) {
      w.add(`g-${pad(g)}`, `u-${pad(g)}-a`)
      w.add(`g-${pad(g)}`, `u-${pad(g)}-b`)
    }

    const plan = planSends(w.targets, w.owners)
    const byLedger = new Map<string, number>()
    for (const t of plan.targets) {
      const g = ledgerOf(t, w.owners)
      byLedger.set(g, (byLedger.get(g) ?? 0) + 1)
    }

    for (let g = 1; g <= 50; g++) expect(byLedger.get(`g-${pad(g)}`)).toBe(2)
    expect(byLedger.get('g-0000-attacker')).toBe(PER_USER_SEND_CAP)
    expect(plan.skippedByCap).toBe(1000 - PER_USER_SEND_CAP)
    expect(plan.targets).toHaveLength(100 + PER_USER_SEND_CAP)

    // Round-robin: the first 51 sends are one per ledger, so a deadline that
    // cuts the run short still reaches every ledger once before any repeats.
    const firstRound = new Set(plan.targets.slice(0, 51).map((t) => ledgerOf(t, w.owners)))
    expect(firstRound.size).toBe(51)
  })

  it('per-ledger cap: two members with 15 devices each → 20 sends, 10 each', () => {
    const w = world()
    for (let i = 0; i < 15; i++) { w.add('g', 'u-a'); w.add('g', 'u-b') }
    const plan = planSends(w.targets, w.owners)
    expect(plan.targets).toHaveLength(PER_LEDGER_SEND_CAP)
    const users = plan.targets.map((t) => w.owners.get(t.ids[0])!.userId)
    expect(users.filter((u) => u === 'u-a')).toHaveLength(10)
    expect(users.filter((u) => u === 'u-b')).toHaveLength(10)
    expect(plan.skippedByCap).toBe(10)
  })

  it('inside a ledger the members alternate, so one member\'s many devices cannot starve the other', () => {
    const w = world()
    for (let i = 0; i < 5; i++) w.add('g', 'u-many')
    w.add('g', 'u-one')
    const plan = planSends(w.targets, w.owners, { ...DEFAULT_SEND_CAPS, perLedger: 2 })
    expect(plan.targets.map((t) => w.owners.get(t.ids[0])!.userId).sort()).toEqual(['u-many', 'u-one'])
  })

  it('per-run cap: 2100 single-device ledgers → 2000 sends, 100 skipped', () => {
    const w = world()
    for (let g = 0; g < PER_RUN_SEND_CAP + 100; g++) w.add(`g-${pad(g)}`, `u-${pad(g)}`)
    const plan = planSends(w.targets, w.owners)
    expect(plan.targets).toHaveLength(PER_RUN_SEND_CAP)
    expect(plan.skippedByCap).toBe(100)
  })

  it('the per-user cap spans ledgers', () => {
    const w = world()
    for (let i = 0; i < 8; i++) w.add('g-1', 'u-x')
    for (let i = 0; i < 8; i++) w.add('g-2', 'u-x')
    expect(planSends(w.targets, w.owners).targets).toHaveLength(PER_USER_SEND_CAP)
  })

  it('one device registered by both members is sent once', () => {
    const w = world()
    w.add('g', 'u-a', 'apns', 'shared')
    w.add('g', 'u-b', 'apns', 'shared')
    const plan = planSends(w.targets, w.owners)
    expect(plan.targets).toHaveLength(1)
    expect(plan.targets[0].ids).toHaveLength(2)
    expect(plan.skippedByCap).toBe(0)
  })

  it('a target with no known owner is never planned (fail closed)', () => {
    const plan = planSends([{ platform: 'apns', token: 'orphan', ids: ['unknown-row'] }], new Map())
    expect(plan.targets).toEqual([])
    expect(plan.skippedByCap).toBe(1)
  })

  it('is deterministic whatever order the rows arrive in', () => {
    const a = world(); const b = world()
    const spec: [string, string][] = []
    for (let g = 0; g < 5; g++) for (let u = 0; u < 3; u++) spec.push([`g-${g}`, `u-${g}-${u}`])
    spec.forEach(([g, u], i) => a.add(g, u, 'apns', `t-${i}`))
    ;[...spec.entries()].reverse().forEach(([i, [g, u]]) => b.add(g, u, 'apns', `t-${i}`))
    const tokens = (w: ReturnType<typeof world>) => planSends(w.targets, w.owners).targets.map((t) => t.token)
    expect(tokens(b)).toEqual(tokens(a))
  })

  it('the caps are the documented numbers', () => {
    expect([PER_USER_SEND_CAP, PER_LEDGER_SEND_CAP, PER_RUN_SEND_CAP]).toEqual([10, 20, 2000])
  })
})

// ─── runWithDeadline ─────────────────────────────────────────────────────────

describe('runWithDeadline (#1827)', () => {
  afterEach(() => { vi.useRealTimers() })

  it('200 ms per send: stops starting at the deadline, ends by deadline + one send, counts the rest skipped', async () => {
    vi.useFakeTimers()
    const t0 = Date.now()
    let inFlight = 0
    let peak = 0
    const items = Array.from({ length: 10_000 }, (_, i) => i)
    const p = runWithDeadline(items, { concurrency: SEND_CONCURRENCY, deadlineAt: t0 + RUN_DEADLINE_MS }, (i) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      return new Promise<number>((r) => setTimeout(() => { inFlight--; r(i) }, 200))
    })
    await vi.runAllTimersAsync()
    const res = await p
    const elapsed = Date.now() - t0

    expect(elapsed).toBeLessThanOrEqual(RUN_DEADLINE_MS + 200)
    expect(res.started).toBe(SEND_CONCURRENCY * (RUN_DEADLINE_MS / 200))
    expect(res.skippedByDeadline).toBe(items.length - res.started)
    expect(res.results).toHaveLength(res.started)
    expect(res.errored).toBe(0)
    expect(peak).toBe(SEND_CONCURRENCY)
  })

  it('everything completes when there is time, results in input order', async () => {
    const res = await runWithDeadline([3, 1, 2], { concurrency: 2, deadlineAt: Date.now() + 60_000 }, async (x) => x * 10)
    expect(res).toEqual({ results: [30, 10, 20], started: 3, skippedByDeadline: 0, errored: 0 })
  })

  it('a deadline already past starts nothing', async () => {
    const worker = vi.fn(async () => 1)
    const res = await runWithDeadline([1, 2, 3], { concurrency: 8, deadlineAt: Date.now() - 1 }, worker)
    expect(worker).not.toHaveBeenCalled()
    expect(res).toEqual({ results: [], started: 0, skippedByDeadline: 3, errored: 0 })
  })

  it('a throwing send is counted and does not stop the others', async () => {
    const res = await runWithDeadline([1, 2, 3, 4], { concurrency: 2, deadlineAt: Date.now() + 60_000 }, async (x) => {
      if (x === 2) throw new Error('boom')
      return x
    })
    expect(res).toEqual({ results: [1, 3, 4], started: 4, skippedByDeadline: 0, errored: 1 })
  })

  it('deadline plus one in-flight timeout stays well inside the 150 s wall-clock limit', () => {
    expect(RUN_DEADLINE_MS + Math.max(APNS_FETCH_TIMEOUT_MS, FCM_FETCH_TIMEOUT_MS)).toBeLessThanOrEqual(120_000)
  })
})

// ─── keysetPages ─────────────────────────────────────────────────────────────

/** A PostgREST stand-in: rows ordered by key, `> after`, capped at maxRows whatever was asked. */
function fakeServer<R>(rows: R[], keyOf: (r: R) => string, maxRows: number, opts: { ignoreFilter?: boolean; failAt?: number } = {}) {
  const sorted = [...rows].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0))
  let calls = 0
  return {
    calls: () => calls,
    fetch: async (after: string | null): Promise<PageResponse<R>> => {
      calls++
      if (opts.failAt !== undefined && calls === opts.failAt) return { data: null, error: { code: 'PGRST000' } }
      const from = after === null || opts.ignoreFilter ? sorted : sorted.filter((r) => keyOf(r) > after)
      return { data: from.slice(0, maxRows), error: null }
    },
  }
}

describe('keysetPages (#1827 F-F)', () => {
  it('reads every row although the server returns fewer rows than a page asks for', async () => {
    const rows = Array.from({ length: 23 }, (_, i) => ({ id: `id-${pad(i)}` }))
    const server = fakeServer(rows, (r) => r.id, 3)
    const res = await keysetPages(server.fetch, (r) => r.id)
    expect(res.errorCode).toBeNull()
    expect(res.rows.map((r) => r.id)).toEqual(rows.map((r) => r.id))
  })

  it('distinct group ids: rows sharing a key across a page boundary still give every group once', async () => {
    const rows = ['g1', 'g1', 'g1', 'g2', 'g3', 'g3', 'g4'].map((group_id) => ({ group_id }))
    const res = await keysetPages(fakeServer(rows, (r) => r.group_id, 2).fetch, (r) => r.group_id)
    expect([...new Set(res.rows.map((r) => r.group_id))]).toEqual(['g1', 'g2', 'g3', 'g4'])
  })

  it('a page error stops the loop and reports its code', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: `id-${pad(i)}` }))
    const res = await keysetPages(fakeServer(rows, (r) => r.id, 3, { failAt: 2 }).fetch, (r) => r.id)
    expect(res.errorCode).toBe('PGRST000')
    expect(res.rows).toHaveLength(3)
  })

  it('a server that ignores the `> after` filter ends with no_progress, not an endless loop', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: `id-${pad(i)}` }))
    const server = fakeServer(rows, (r) => r.id, 3, { ignoreFilter: true })
    const res = await keysetPages(server.fetch, (r) => r.id)
    expect(res.errorCode).toBe('no_progress')
    expect(server.calls()).toBe(2)
  })

  it('stops at maxPages', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: `id-${pad(i)}` }))
    const res = await keysetPages(fakeServer(rows, (r) => r.id, 1).fetch, (r) => r.id, 4)
    expect(res.errorCode).toBe('too_many_pages')
    expect(res.rows).toHaveLength(4)
  })

  it('chunks', () => {
    expect(chunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunks([], 2)).toEqual([])
  })
})

// ─── index.ts wiring ─────────────────────────────────────────────────────────

describe('send-recurring-push wiring (#1827)', () => {
  const src = readFileSync(join(process.cwd(), 'supabase/functions/send-recurring-push/index.ts'), 'utf8')
  const serve = src.slice(src.indexOf('Deno.serve('))

  it('reads both pending tables and the tokens through keysetPages, never one bare select', () => {
    expect(serve.match(/keysetPages</g)).toHaveLength(2) // dueGroups helper + tokens
    expect(serve).toContain("dueGroups('PendingExpenseOccurrences')")
    expect(serve).toContain("dueGroups('PendingIncomeOccurrences')")
    expect(serve).toMatch(/\.order\('group_id'\)\s*\.limit\(PAGE_SIZE\)/)
    expect(serve).toMatch(/\.in\('group_id', chunk\)\s*\.order\('id'\)\s*\.limit\(PAGE_SIZE\)/)
    expect(serve).toContain("q.gt('group_id', after)")
    expect(serve).toContain("q.gt('id', after)")
    expect(serve).toContain('chunks(allGroupIds, GROUP_ID_CHUNK)')
    expect(src).not.toMatch(/\.range\(/)
  })

  it('plans before sending and sends only the plan, both platforms in parallel', () => {
    const planAt = serve.indexOf('planSends(targets, owners)')
    const sendAt = serve.indexOf('await Promise.all([')
    expect(planAt).toBeGreaterThan(-1)
    expect(sendAt).toBeGreaterThan(planAt)
    expect(serve).toContain("plan.targets.filter((t) => t.platform === 'apns'), deadlineAt)")
    expect(serve).toContain("plan.targets.filter((t) => t.platform === 'fcm'), deadlineAt)")
    expect(serve).not.toMatch(/[^.]targets\.filter\(/)
  })

  it('the deadline starts after the caller check, before the reads', () => {
    const auth = serve.indexOf('checkCronApiKey(')
    const deadline = serve.indexOf('const deadlineAt = Date.now() + RUN_DEADLINE_MS')
    expect(deadline).toBeGreaterThan(auth)
    expect(deadline).toBeLessThan(serve.indexOf("dueGroups('PendingExpenseOccurrences')"))
  })

  it('both branches send through runWithDeadline and then always delete stale rows', () => {
    for (const [fn, platform] of [['sendApnsBranch', 'apns'], ['sendFcmBranch', 'fcm']] as const) {
      const start = src.indexOf(`async function ${fn}(`)
      const body = src.slice(start, src.indexOf('\n}\n', start))
      const pool = body.indexOf('await runWithDeadline(')
      expect(pool).toBeGreaterThan(-1)
      expect(body).toContain('{ concurrency: SEND_CONCURRENCY, deadlineAt }')
      expect(body.indexOf(`await deleteStaleRows(supabase, '${platform}',`)).toBeGreaterThan(pool)
      expect(body).not.toMatch(/for \(const \{ token, ids \} of targets\)/)
    }
  })

  it('APNs requests time out like FCM ones, and a throw is never a delete', () => {
    expect(src).toContain('signal: AbortSignal.timeout(APNS_FETCH_TIMEOUT_MS)')
    expect(src).toMatch(/if \(status !== null && isStaleApnsStatus\(status\)\)/)
  })

  it('logs one counts-only summary line on every 200', () => {
    const logs = src.match(/console\.log\([^\n]*\)/g) ?? []
    expect(logs).toEqual([
      'console.log(`[push] summary sent=${sent} skipped_by_cap=${skippedByCap} skipped_by_deadline=${skippedByDeadline}`)',
    ])
    expect(serve).not.toMatch(/new Response\(JSON\.stringify/)
    expect(serve.match(/return finish\(/g)!.length).toBeGreaterThanOrEqual(3)
  })

  it('query errors log only a code, never the error object', () => {
    for (const l of src.split('\n').filter((x) => /console\.(error|warn)\(/.test(x) && /query error/.test(x))) {
      expect(l).toMatch(/code=\$\{safeCode\(/)
    }
    expect(src).not.toMatch(/console\.\w+\([^)]*, (groupsErr|tokenErr|error)\)/)
  })
})
