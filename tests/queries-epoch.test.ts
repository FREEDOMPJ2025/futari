import { describe, it, expect, beforeEach, vi } from 'vitest'
import './_mocks/supabase'
import { mockDb, queueDbResult, resetDbMocks } from './_mocks/db'

// next/headers cookies() — controlled per test via the helper below.
const cookieStore = new Map<string, string>()
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    get: (key: string) => {
      const value = cookieStore.get(key)
      return value === undefined ? undefined : { value }
    },
    set: vi.fn(),
    delete: vi.fn(),
  })),
}))

function setCookie(key: string, value: string | null) {
  if (value === null) cookieStore.delete(key)
  else cookieStore.set(key, value)
}

import {
  getEpochMembers,
  listEpochsForViewer,
  resolveViewerEpochContext,
  PAST_EPOCH_COOKIE,
} from '@/lib/db/queries/epoch'

const VIEWER = 'user-leaver'
const STAYER = 'user-stayer'
const OTHER = 'user-other'

// Pin ids are real uuid shapes: since #1699 the resolver ignores a cookie that
// is not uuid-shaped without querying, so a fixture like 'ep-x-1' would no
// longer reach the pin path at all.
const EP_Y_1 = '0e5b8a5c-1d1a-4c3e-9a51-000000000001'
const EP_NOT_MINE = '0e5b8a5c-1d1a-4c3e-9a51-000000000002'
const EP_DELETED = '0e5b8a5c-1d1a-4c3e-9a51-000000000003'
const EP_X_1 = '0e5b8a5c-1d1a-4c3e-9a51-000000000004'
const EP_X_OPEN = '0e5b8a5c-1d1a-4c3e-9a51-000000000005'

function epochRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'epoch-1',
    groupId: 'grp-1',
    startedAt: new Date('2026-01-01T00:00:00Z'),
    endedAt: null,
    memberAId: VIEWER,
    memberBId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    memberANameIsLeftLabel: false,
    memberBNameIsLeftLabel: false,
    ...overrides,
  }
}

function profileRow(id: string, displayName: string, isTombstone = false) {
  return { id, displayName, isTombstone }
}

/** #1782 — a name slot as the queries return it. */
const nm = (name: string | null, isLeftLabel = false) => ({ name, isLeftLabel })

function groupRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'grp-1',
    name: '我們家',
    memberA: VIEWER,
    memberB: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    defaultSplitRatioA: null,
    pendingSwapProposedBy: null,
    pendingSwapExpiresAt: null,
    currentEpochStartedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
}

beforeEach(() => {
  resetDbMocks()
  cookieStore.clear()
})

describe('listEpochsForViewer', () => {
  it('returns chapters across multiple groups, newest first, with partner names inlined', async () => {
    // Scenario: leaver was on X (duo with stayer), left for solo Y, then
    // re-joined X. They should see X's prior duo, Y's prior solo, plus X's
    // current re-joined duo — all rows where they were a member.
    // Closed chapters carry the names frozen at their close (0088); only the
    // open chapter reads live names (#1604 part 2 / #1612).
    const xDuoOld = epochRow({
      id: 'ep-x-1', groupId: 'grp-x',
      memberAId: STAYER, memberBId: VIEWER,
      startedAt: new Date('2025-01-01T00:00:00Z'),
      endedAt: new Date('2025-06-01T00:00:00Z'),
      memberAName: 'Stayer', memberBName: 'Leaver',
    })
    const ySolo = epochRow({
      id: 'ep-y-1', groupId: 'grp-y',
      memberAId: VIEWER, memberBId: null,
      startedAt: new Date('2025-06-01T00:00:00Z'),
      endedAt: new Date('2025-12-01T00:00:00Z'),
      memberAName: 'Leaver', memberBName: null,
    })
    const xDuoNow = epochRow({
      id: 'ep-x-3', groupId: 'grp-x',
      memberAId: STAYER, memberBId: VIEWER,
      startedAt: new Date('2025-12-01T00:00:00Z'),
      endedAt: null,
    })

    // 1) main epochs SELECT (already ordered DESC startedAt in real SQL)
    queueDbResult([xDuoNow, ySolo, xDuoOld])
    // 2) profiles SELECT (the open chapter's two people only)
    queueDbResult([profileRow(VIEWER, 'Leaver'), profileRow(STAYER, 'Stayer')])

    const rows = await listEpochsForViewer(VIEWER)

    expect(rows.map((r) => r.id)).toEqual(['ep-x-3', 'ep-y-1', 'ep-x-1'])
    expect(rows[0]).toMatchObject({
      groupId: 'grp-x',
      memberAName: nm('Stayer'),
      memberBName: nm('Leaver'),
    })
    expect(rows[1]).toMatchObject({
      groupId: 'grp-y',
      memberAName: nm('Leaver'),
      memberBName: nm(null),
    })
    expect(rows[2]).toMatchObject({
      groupId: 'grp-x',
      memberAName: nm('Stayer'),
      memberBName: nm('Leaver'),
    })
  })

  it('returns [] without hitting profiles when the viewer has no chapters', async () => {
    queueDbResult([])

    const rows = await listEpochsForViewer('nobody')
    expect(rows).toEqual([])
    // Only the one epochs SELECT — no profiles lookup.
    expect(mockDb.select).toHaveBeenCalledTimes(1)
  })

  it('does not surface a stayer chapter the viewer was never on', async () => {
    // Acceptance: 「Member A (the stayer) does NOT see Y's epoch in their
    // past-times (they were never in Y)」. The query's WHERE clause is the
    // mechanism — verified here by passing no Y-row in the queued result for
    // the stayer's call.
    const xDuoOld = epochRow({
      id: 'ep-x-1', groupId: 'grp-x',
      memberAId: STAYER, memberBId: VIEWER,
      startedAt: new Date('2025-01-01T00:00:00Z'),
      endedAt: new Date('2025-06-01T00:00:00Z'),
    })
    const xSoloAfter = epochRow({
      id: 'ep-x-2', groupId: 'grp-x',
      memberAId: STAYER, memberBId: null,
      startedAt: new Date('2025-06-01T00:00:00Z'),
      endedAt: new Date('2025-12-01T00:00:00Z'),
    })
    const xDuoNow = epochRow({
      id: 'ep-x-3', groupId: 'grp-x',
      memberAId: STAYER, memberBId: VIEWER,
      startedAt: new Date('2025-12-01T00:00:00Z'),
      endedAt: null,
    })

    queueDbResult([xDuoNow, xSoloAfter, xDuoOld])
    queueDbResult([profileRow(STAYER, 'Stayer'), profileRow(VIEWER, 'Leaver')])

    const rows = await listEpochsForViewer(STAYER)

    expect(rows.map((r) => r.groupId)).toEqual(['grp-x', 'grp-x', 'grp-x'])
    expect(rows.find((r) => r.id === 'ep-y-1')).toBeUndefined()
  })
})

describe('resolveViewerEpochContext', () => {
  it('without a pin: returns active group + current open epoch window', async () => {
    // 1) getActiveGroupForUser SELECT
    queueDbResult([groupRow()])
    // 2) open-epoch SELECT
    const openEpoch = epochRow({ id: 'ep-current', endedAt: null })
    queueDbResult([openEpoch])

    const context = await resolveViewerEpochContext(VIEWER)
    expect(context).not.toBeNull()
    expect(context!.group.id).toBe('grp-1')
    expect(context!.window).toMatchObject({
      epochId: 'ep-current',
      isPast: false,
      endedAt: null,
    })
  })

  it('with a pin pointing to the viewer’s past chapter on a different group: swaps to that group + window', async () => {
    // This is the crux of #141: the viewer pins to Y's solo (group Y, not
    // active group X). resolveViewerEpochContext must return group Y, not X.
    // Y is the solo ledger they had before accepting an invite into X:
    // acceptInvite leaves them as Y's member_a and only closes Y's epoch, so
    // they are still a current member of Y and the pin is accepted (#1603).
    setCookie(PAST_EPOCH_COOKIE, EP_Y_1)

    const yEpoch = epochRow({
      id: EP_Y_1, groupId: 'grp-y',
      memberAId: VIEWER, memberBId: null,
      startedAt: new Date('2025-06-01T00:00:00Z'),
      endedAt: new Date('2025-12-01T00:00:00Z'),
    })
    const yGroup = groupRow({ id: 'grp-y', name: '我的家計簿', memberA: VIEWER, memberB: null })

    // 1) pin SELECT (epochs by id)
    queueDbResult([yEpoch])
    // 2) group SELECT (by epoch.groupId)
    queueDbResult([yGroup])

    const context = await resolveViewerEpochContext(VIEWER)
    expect(context).not.toBeNull()
    expect(context!.group.id).toBe('grp-y')
    expect(context!.window).toMatchObject({
      epochId: EP_Y_1,
      isPast: true,
    })
    expect(context!.window.endedAt).toEqual(new Date('2025-12-01T00:00:00Z'))
  })

  it('with a pin pointing to a chapter the viewer was NOT a member of: falls back to active group', async () => {
    // Stale / hostile cookie pointing at someone else's epoch must not leak
    // their chapter into this viewer's context.
    setCookie(PAST_EPOCH_COOKIE, EP_NOT_MINE)

    const otherEpoch = epochRow({
      id: EP_NOT_MINE, groupId: 'grp-other',
      memberAId: OTHER, memberBId: null,
    })
    // 1) pin SELECT → returns the epoch but membership check rejects it
    queueDbResult([otherEpoch])
    // 2) getActiveGroupForUser SELECT
    queueDbResult([groupRow()])
    // 3) open-epoch SELECT
    queueDbResult([epochRow({ id: 'ep-current', endedAt: null })])

    const context = await resolveViewerEpochContext(VIEWER)
    expect(context).not.toBeNull()
    expect(context!.group.id).toBe('grp-1')
    expect(context!.window.isPast).toBe(false)
  })

  it('with a pin pointing to a non-existent epoch: falls back to active group', async () => {
    setCookie(PAST_EPOCH_COOKIE, EP_DELETED)

    // 1) pin SELECT → no rows
    queueDbResult([])
    // 2) getActiveGroupForUser SELECT
    queueDbResult([groupRow()])
    // 3) open-epoch SELECT
    queueDbResult([epochRow({ id: 'ep-current', endedAt: null })])

    const context = await resolveViewerEpochContext(VIEWER)
    expect(context).not.toBeNull()
    expect(context!.group.id).toBe('grp-1')
  })

  // #1612 — a pin counts if the viewer is named on the chapter, its group
  // exists, and the viewer is still a member of it OR the chapter is closed.
  // A former member (left or removed) therefore opens a CLOSED chapter of the
  // ledger they left, read-only, flagged `isFormerMemberView`; the layout
  // renders that from their own profile and the chapter row (the #1603 loop
  // came from the layout refusing such a group, which it no longer does).
  describe('former members (#1603 → #1612)', () => {
    const leftChapter = () => epochRow({
      id: EP_X_1, groupId: 'grp-x',
      memberAId: STAYER, memberBId: VIEWER,
      startedAt: new Date('2025-01-01T00:00:00Z'),
      endedAt: new Date('2025-06-01T00:00:00Z'),
    })

    it('a leaver pinned to a closed chapter of the ledger they left gets that chapter, as a former member', async () => {
      setCookie(PAST_EPOCH_COOKIE, EP_X_1)
      // 1) pin SELECT → the leaver is named on the chapter…
      queueDbResult([leftChapter()])
      // 2) group SELECT → …X's row today names only the stayer
      queueDbResult([groupRow({ id: 'grp-x', memberA: STAYER, memberB: null })])

      const context = await resolveViewerEpochContext(VIEWER)
      expect(context!.group.id).toBe('grp-x')
      expect(context!.window).toMatchObject({ epochId: EP_X_1, isPast: true })
      expect(context!.isFormerMemberView).toBe(true)
      // No active-group fallback was needed.
      expect(mockDb.select).toHaveBeenCalledTimes(2)
    })

    it('the same when the left ledger has a new partner in it', async () => {
      setCookie(PAST_EPOCH_COOKIE, EP_X_1)
      queueDbResult([leftChapter()])
      queueDbResult([groupRow({ id: 'grp-x', memberA: STAYER, memberB: OTHER })])

      const context = await resolveViewerEpochContext(VIEWER)
      expect(context!.group.id).toBe('grp-x')
      expect(context!.isFormerMemberView).toBe(true)
    })

    it('a removed person with no group of their own also gets the closed chapter (not null)', async () => {
      setCookie(PAST_EPOCH_COOKIE, EP_X_1)
      queueDbResult([leftChapter()])
      queueDbResult([groupRow({ id: 'grp-x', memberA: STAYER, memberB: null })])

      const context = await resolveViewerEpochContext(VIEWER)
      expect(context!.group.id).toBe('grp-x')
      expect(context!.isFormerMemberView).toBe(true)
    })

    it('an OPEN chapter of a ledger the viewer is not in falls through to their own ledger', async () => {
      setCookie(PAST_EPOCH_COOKIE, EP_X_OPEN)
      queueDbResult([epochRow({ id: EP_X_OPEN, groupId: 'grp-x', memberAId: STAYER, memberBId: VIEWER, endedAt: null })])
      queueDbResult([groupRow({ id: 'grp-x', memberA: STAYER, memberB: OTHER })])
      queueDbResult([groupRow({ id: 'grp-solo', memberA: VIEWER, memberB: null })])
      queueDbResult([epochRow({ id: 'ep-solo', groupId: 'grp-solo', endedAt: null })])

      const context = await resolveViewerEpochContext(VIEWER)
      expect(context!.group.id).toBe('grp-solo')
      expect(context!.window).toMatchObject({ epochId: 'ep-solo', isPast: false })
      expect(context!.isFormerMemberView).toBe(false)
    })

    it('an open chapter of a ledger the viewer is not in, with no ledger of their own → null', async () => {
      setCookie(PAST_EPOCH_COOKIE, EP_X_OPEN)
      queueDbResult([epochRow({ id: EP_X_OPEN, groupId: 'grp-x', memberAId: STAYER, memberBId: VIEWER, endedAt: null })])
      queueDbResult([groupRow({ id: 'grp-x', memberA: STAYER, memberB: null })])
      queueDbResult([])

      expect(await resolveViewerEpochContext(VIEWER)).toBeNull()
    })

    it('a closed chapter whose group no longer exists falls through', async () => {
      setCookie(PAST_EPOCH_COOKIE, EP_X_1)
      queueDbResult([leftChapter()])
      queueDbResult([]) // group deleted
      queueDbResult([groupRow({ id: 'grp-solo', memberA: VIEWER, memberB: null })])
      queueDbResult([epochRow({ id: 'ep-solo', groupId: 'grp-solo', endedAt: null })])

      const context = await resolveViewerEpochContext(VIEWER)
      expect(context!.group.id).toBe('grp-solo')
      expect(context!.isFormerMemberView).toBe(false)
    })

    it('a stayer pinned to an old chapter of their current group resolves to the pin, not as a former member', async () => {
      setCookie(PAST_EPOCH_COOKIE, EP_X_1)
      queueDbResult([leftChapter()])
      // X today: the stayer and a new partner
      queueDbResult([groupRow({ id: 'grp-x', memberA: STAYER, memberB: OTHER })])

      const context = await resolveViewerEpochContext(STAYER)
      expect(context!.group.id).toBe('grp-x')
      expect(context!.window).toMatchObject({ epochId: EP_X_1, isPast: true })
      expect(context!.isFormerMemberView).toBe(false)
    })
  })

  // #1699 — the cookie is client-held. A value that is not uuid-shaped used to
  // reach `eq(groupEpochs.id, …)`, Postgres refused the cast (22P02), and since
  // the dashboard layout calls this resolver every page 500'd until the cookie
  // was cleared. It is now treated as no pin, before any query.
  describe('a pin that is not uuid-shaped (#1699)', () => {
    it.each([
      ['not-a-uuid', 'not-a-uuid'],
      ['empty', ''],
      ['over-long', `${EP_X_1}${'0'.repeat(4096)}`],
      ['uuid with trailing junk', `${EP_X_1}'--`],
    ])('%s → the active group, and the pin is never queried', async (_label, raw) => {
      setCookie(PAST_EPOCH_COOKIE, raw)
      // Only the no-pin path's two SELECTs are queued. A pin SELECT would
      // consume the group row here and the assertions below would fail.
      queueDbResult([groupRow()])
      queueDbResult([epochRow({ id: 'ep-current', endedAt: null })])

      const context = await resolveViewerEpochContext(VIEWER)
      expect(context!.group.id).toBe('grp-1')
      expect(context!.window).toMatchObject({ epochId: 'ep-current', isPast: false })
      expect(context!.isFormerMemberView).toBe(false)
      expect(mockDb.select).toHaveBeenCalledTimes(2)
    })

    it('an uppercase uuid is still a pin', async () => {
      setCookie(PAST_EPOCH_COOKIE, EP_Y_1.toUpperCase())
      queueDbResult([epochRow({
        id: EP_Y_1, groupId: 'grp-y',
        memberAId: VIEWER, memberBId: null,
        startedAt: new Date('2025-06-01T00:00:00Z'),
        endedAt: new Date('2025-12-01T00:00:00Z'),
      })])
      queueDbResult([groupRow({ id: 'grp-y', memberA: VIEWER, memberB: null })])

      const context = await resolveViewerEpochContext(VIEWER)
      expect(context!.group.id).toBe('grp-y')
      expect(context!.window).toMatchObject({ epochId: EP_Y_1, isPast: true })
      expect(mockDb.select).toHaveBeenCalledTimes(2)
    })
  })

  it('returns null when the viewer has neither a pin nor any group', async () => {
    // 1) getActiveGroupForUser SELECT → no rows
    queueDbResult([])

    const context = await resolveViewerEpochContext(VIEWER)
    expect(context).toBeNull()
  })
})

// ─── #1604 part 2: a closed chapter shows the names frozen at its close ─────
// Failure this guards: nothing errors; a chapter that is over keeps picking up
// whatever name the other person chose later.
describe('chapter names (#1604 part 2)', () => {
  const closedWith = (a: string | null, b: string | null) => epochRow({
    id: 'ep-closed', groupId: 'grp-1',
    memberAId: STAYER, memberBId: VIEWER,
    startedAt: new Date('2025-01-01T00:00:00Z'),
    endedAt: new Date('2025-06-01T00:00:00Z'),
    memberAName: a, memberBName: b,
  })

  it('getEpochMembers: a closed chapter returns its snapshot and reads no live profile', async () => {
    queueDbResult([closedWith('Stayer at close', 'Leaver at close')])
    const m = await getEpochMembers('ep-closed')
    expect(m).toEqual({
      memberAId: STAYER, memberBId: VIEWER,
      memberAName: nm('Stayer at close'), memberBName: nm('Leaver at close'),
    })
    // Only the GroupEpochs read: the live (later) names are never consulted.
    expect(mockDb.select).toHaveBeenCalledTimes(1)
  })

  // #1612 — a closed chapter never reads a live name, even for a NULL
  // snapshot slot: the name is null and the surface shows 「對方」. (A former
  // member opening the chapter would otherwise get the stayer's current name.)
  it('getEpochMembers: a NULL snapshot slot of a closed chapter is null and reads no Profiles', async () => {
    queueDbResult([closedWith(null, null)])
    queueDbResult([profileRow(STAYER, 'Stayer live'), profileRow(VIEWER, 'Leaver live')])
    const m = await getEpochMembers('ep-closed')
    expect(m).toMatchObject({ memberAName: nm(null), memberBName: nm(null) })
    expect(mockDb.select).toHaveBeenCalledTimes(1)
  })

  it('listEpochsForViewer: closed chapters with NULL snapshots read no Profiles', async () => {
    queueDbResult([closedWith(null, 'Leaver at close')])
    queueDbResult([profileRow(STAYER, 'Stayer live')])
    const rows = await listEpochsForViewer(VIEWER)
    expect(rows[0]).toMatchObject({ memberAName: nm(null), memberBName: nm('Leaver at close') })
    expect(mockDb.select).toHaveBeenCalledTimes(1)
  })

  it('getEpochMembers: an open chapter uses live names even if a column holds a value', async () => {
    queueDbResult([epochRow({ id: 'ep-open', memberAId: STAYER, memberBId: VIEWER, endedAt: null, memberAName: 'stale', memberBName: null })])
    queueDbResult([profileRow(STAYER, 'Stayer live'), profileRow(VIEWER, 'Leaver live')])
    const m = await getEpochMembers('ep-open')
    expect(m).toMatchObject({ memberAName: nm('Stayer live'), memberBName: nm('Leaver live') })
  })

  it('listEpochsForViewer: closed rows carry their snapshot, the open row the live name', async () => {
    const open = epochRow({
      id: 'ep-open', groupId: 'grp-1', memberAId: STAYER, memberBId: null,
      startedAt: new Date('2025-06-01T00:00:00Z'), endedAt: null, memberAName: null, memberBName: null,
    })
    queueDbResult([open, closedWith('Stayer at close', '已離開的夥伴')])
    queueDbResult([profileRow(STAYER, 'Stayer renamed')])
    const rows = await listEpochsForViewer(STAYER)
    // #1782 — the literal without its marker is a name like any other.
    expect(rows.find((r) => r.id === 'ep-closed')).toMatchObject({
      memberAName: nm('Stayer at close'), memberBName: nm('已離開的夥伴', false),
    })
    expect(rows.find((r) => r.id === 'ep-open')).toMatchObject({ memberAName: nm('Stayer renamed'), memberBName: nm(null) })
  })

  it('listEpochsForViewer: only closed chapters with snapshots → no Profiles read', async () => {
    queueDbResult([closedWith('Stayer at close', 'Leaver at close')])
    const rows = await listEpochsForViewer(STAYER)
    expect(rows[0]).toMatchObject({ memberAName: nm('Stayer at close'), memberBName: nm('Leaver at close') })
    expect(mockDb.select).toHaveBeenCalledTimes(1)
  })

  // #1782 — the marker, not the text, is what comes back as the left label.
  it('getEpochMembers: a marked closed slot is the left label; an unmarked literal is not', async () => {
    queueDbResult([{
      ...closedWith('已離開的夥伴', '已離開的夥伴'),
      memberANameIsLeftLabel: true, memberBNameIsLeftLabel: false,
    }])
    const m = await getEpochMembers('ep-closed')
    expect(m).toEqual({
      memberAId: STAYER, memberBId: VIEWER,
      memberAName: nm('已離開的夥伴', true), memberBName: nm('已離開的夥伴', false),
    })
  })

  it('getEpochMembers: an open chapter takes the marker from the live profile (tombstone)', async () => {
    queueDbResult([epochRow({ id: 'ep-open', memberAId: STAYER, memberBId: VIEWER, endedAt: null })])
    queueDbResult([profileRow(STAYER, '已離開的夥伴', true), profileRow(VIEWER, '已離開的夥伴', false)])
    const m = await getEpochMembers('ep-open')
    expect(m).toMatchObject({ memberAName: nm('已離開的夥伴', true), memberBName: nm('已離開的夥伴', false) })
  })
})
