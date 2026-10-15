import { cookies } from 'next/headers'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { groupEpochs, oikosGroups, outingParticipants, outings } from '@/lib/db/schema'
import { createClient } from '@/lib/supabase/server'
import { PAST_EPOCH_COOKIE } from '@/lib/db/queries/epoch'
import { actionError } from '@/lib/action-errors'
import { hashToken, isWellFormedToken } from '@/lib/outing/tokens'
import { isUuid } from '@/lib/outing/validate'

/**
 * Who is acting on an outing (#1558). spec: group-outing-design.md
 * 「匿名存取 & 授權」; rules: PLAN-1558 rev 2 「Actor & read rules」.
 *
 * Precedence, first match wins:
 *   1. member              logged in AND member_a / member_b of the outing's
 *                          own group row (not the viewer's active group) AND
 *                          named on the outing's own chapter (its GroupEpochs
 *                          row, #1682). Both, never either alone: a partner
 *                          who joined after that chapter closed is not its
 *                          member, and someone named on the chapter who has
 *                          since left is not a member of the ledger any more.
 *   2. session participant logged in AND bound (profile_id) to an active slot
 *                          of this outing.
 *   3. cookie participant  cookie `oc_<outingId>` whose token hash matches an
 *                          active slot of THIS outing (outing not deleted)
 *                          whose profile_id is NULL or the current user.
 *                          Ignored when the session already has a slot here
 *                          (rule 2 matched first).
 * Anything else → `outing_not_found`: an outing the caller cannot see is
 * indistinguishable from one that does not exist. A ledger member who is not
 * named on the outing's chapter falls through to rules 2–3 exactly like a
 * friend: a former partner keeps reading the outings they were bound to, and
 * a later partner gets nothing (no redirect into the dashboard either).
 * Failure #1682 closed (no error anywhere): the later partner followed the
 * old share link, was forwarded to /outings/<id> as a "member", and read,
 * renamed, deleted or ended the earlier chapter's outing.
 *
 * Members are admins; participants are not. Admin-only actions refuse a
 * participant with `outing_admin_only`.
 *
 * The group id always comes from the outing row, never from the client and
 * never from `getViewerWriteContext` (that resolves the viewer's OWN ledger,
 * which for a friend is a different group or none).
 *
 * Failure looks like (if a caller resolves the actor outside the write
 * transaction): nothing errors; a slot released or deactivated between the
 * check and the write still writes once. Resolve with the `tx` that then
 * writes, after locking the outing row.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Conn = Tx | typeof db
type GroupLock = 'share' | 'no key update'

export type OutingActor =
  | {
      kind: 'member'
      userId: string
      /** This member's participant row in the outing, if any. */
      participantId: string | null
      /** The viewer is pinned to a past chapter (futari_past_epoch). */
      pinnedPast: boolean
      /**
       * Which past chapter of this ledger the viewer is pinned to, or null.
       * endOuting (#1682, D2(a)) accepts a pin to exactly the outing's own
       * chapter; every other writer refuses any pin.
       */
      pinnedEpochId: string | null
    }
  | {
      kind: 'participant'
      via: 'session' | 'cookie'
      userId: string | null
      participantId: string
    }

export interface OutingRow {
  id: string
  groupId: string
  epochId: string
  status: 'active' | 'settling' | 'ended' | 'archived'
  name: string
  currency: string
}

/** Cookie that carries a claimed slot's token for one outing. */
export function claimCookieName(outingId: string): string {
  return `oc_${outingId}`
}

const YEAR_S = 365 * 24 * 60 * 60
const ENDED_S = 30 * 24 * 60 * 60

/**
 * Options for the claim cookie. One year while the outing is active; an ended
 * outing's cookie is re-set with 30 days so it prunes itself (S3 re-sets it on
 * read). httpOnly + SameSite=Lax: never readable by page script, not sent on
 * cross-site POSTs.
 */
export function claimCookieOptions(status: OutingRow['status']) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: status === 'active' ? YEAR_S : ENDED_S,
  }
}

/** The signed-in user's id, or null. Never throws for "not signed in". */
export async function getSessionUserId(): Promise<string | null> {
  const supabase = await createClient()
  const { data } = await supabase.auth.getUser()
  return data?.user?.id ?? null
}

/** The well-formed claim token for this outing from the cookie jar, or null. */
export async function readClaimToken(outingId: string): Promise<string | null> {
  const jar = await cookies()
  const raw = jar.get(claimCookieName(outingId))?.value
  return isWellFormedToken(raw) ? raw : null
}

/** The ended chapter of `groupId` the viewer has pinned, or null. */
async function pinnedPastEpoch(conn: Conn, userId: string, groupId: string): Promise<string | null> {
  const jar = await cookies()
  const pinId = jar.get(PAST_EPOCH_COOKIE)?.value
  if (!pinId || !isUuid(pinId)) return null
  const [pinned] = await conn
    .select({ groupId: groupEpochs.groupId, endedAt: groupEpochs.endedAt, a: groupEpochs.memberAId, b: groupEpochs.memberBId })
    .from(groupEpochs)
    .where(eq(groupEpochs.id, pinId))
    .limit(1)
  // Same defence as resolveViewerEpochContext: a pin the viewer was not on
  // is ignored rather than trusted. Its second condition (#1603: the viewer
  // is still member_a / member_b of the pinned group) holds here by
  // construction — the only caller, resolveActor, reaches this after finding
  // the viewer on `groupId`'s row, and the pin only counts when it is on that
  // same group. A former member never gets here: they are not 'member'.
  if (!pinned || (pinned.a !== userId && pinned.b !== userId)) return null
  return pinned.groupId === groupId && pinned.endedAt !== null ? pinId : null
}

/**
 * Load a live (not deleted) outing, optionally locking it. Throws
 * `outing_not_found` for a malformed id or a missing / deleted outing.
 */
export async function loadOuting(
  conn: Conn,
  outingId: unknown,
  lock?: 'share' | 'update',
): Promise<OutingRow> {
  if (!isUuid(outingId)) throw actionError('outing_not_found')
  const q = conn
    .select({
      id: outings.id,
      groupId: outings.groupId,
      epochId: outings.epochId,
      status: outings.status,
      name: outings.name,
      currency: outings.currency,
    })
    .from(outings)
    .where(and(eq(outings.id, outingId), isNull(outings.deletedAt)))
  const [row] = lock ? await q.for(lock) : await q.limit(1)
  if (!row) throw actionError('outing_not_found')
  return row
}

export interface ActorInputs {
  userId: string | null
  claimToken: string | null
}

/** Session user + claim cookie for `outingId`, read from the request. */
export async function requestActorInputs(outingId: string): Promise<ActorInputs> {
  const [userId, claimToken] = await Promise.all([getSessionUserId(), readClaimToken(outingId)])
  return { userId, claimToken }
}

/**
 * Resolve the actor for `outing` (already loaded, and locked when the caller
 * will write). Returns null when the caller is nobody here.
 *
 * Takes the group row with `opts.lockGroup` (after the outing lock: Outings →
 * OikosGroups, the order every outing write uses) so membership cannot change
 * under a write that relies on it. A caller that will lock the group row
 * harder later in the same transaction (endOuting) must ask for that strength
 * here: upgrading SHARE → NO KEY UPDATE lets two concurrent callers deadlock.
 */
export async function resolveActor(
  conn: Conn,
  outing: OutingRow,
  inputs: ActorInputs,
  opts: { lockGroup: false | GroupLock },
): Promise<OutingActor | null> {
  const { userId, claimToken } = inputs

  if (userId) {
    const gq = conn
      .select({ memberA: oikosGroups.memberA, memberB: oikosGroups.memberB })
      .from(oikosGroups)
      .where(eq(oikosGroups.id, outing.groupId))
    const [group] = opts.lockGroup ? await gq.for(opts.lockGroup) : await gq.limit(1)

    const [own] = await conn
      .select({ id: outingParticipants.id, deactivatedAt: outingParticipants.deactivatedAt })
      .from(outingParticipants)
      .where(and(eq(outingParticipants.outingId, outing.id), eq(outingParticipants.profileId, userId)))
      .limit(1)

    if (group && (group.memberA === userId || group.memberB === userId)) {
      // #1682 — and named on the outing's own chapter. A plain read, after the
      // group lock (Outings → OikosGroups stays the only lock order): a
      // GroupEpochs row's pair never changes once written, and the closers
      // that end it hold the group row, which a writer here already shares.
      const [chapter] = await conn
        .select({ a: groupEpochs.memberAId, b: groupEpochs.memberBId })
        .from(groupEpochs)
        .where(and(eq(groupEpochs.id, outing.epochId), eq(groupEpochs.groupId, outing.groupId)))
        .limit(1)
      if (chapter && (chapter.a === userId || chapter.b === userId)) {
        const pinnedEpochId = await pinnedPastEpoch(conn, userId, outing.groupId)
        return {
          kind: 'member',
          userId,
          participantId: own?.id ?? null,
          pinnedPast: pinnedEpochId !== null,
          pinnedEpochId,
        }
      }
    }
    if (own && own.deactivatedAt === null) {
      return { kind: 'participant', via: 'session', userId, participantId: own.id }
    }
    // A bound-but-deactivated slot: the session has a slot here, so the
    // cookie is ignored (rule 3), and the slot itself is gone.
    if (own) return null
  }

  if (claimToken) {
    const [slot] = await conn
      .select({ id: outingParticipants.id, profileId: outingParticipants.profileId })
      .from(outingParticipants)
      .where(and(
        eq(outingParticipants.outingId, outing.id),
        eq(outingParticipants.claimTokenHash, hashToken(claimToken)),
        isNull(outingParticipants.deactivatedAt),
      ))
      .limit(1)
    if (slot && (slot.profileId === null || slot.profileId === userId)) {
      return { kind: 'participant', via: 'cookie', userId, participantId: slot.id }
    }
  }

  return null
}

/**
 * Lock the outing and resolve a writer: a member (not pinned to a past
 * chapter) or a participant. The outing must be active and in its group's
 * current chapter. Expected refusals are codes, never plain throws:
 *   unknown caller           → outing_not_found
 *   member viewing the past  → outing_viewing_past_chapter
 *   not active               → outing_not_active
 *   chapter closed           → outing_epoch_closed
 */
export async function lockForContentWrite(
  tx: Tx,
  outingId: unknown,
  inputs: ActorInputs,
  strength: 'share' | 'update' = 'share',
): Promise<{ outing: OutingRow; actor: OutingActor }> {
  const outing = await loadOuting(tx, outingId, strength)
  const actor = await resolveActor(tx, outing, inputs, { lockGroup: 'share' })
  if (!actor) throw actionError('outing_not_found')
  if (actor.kind === 'member' && actor.pinnedPast) throw actionError('outing_viewing_past_chapter')
  if (outing.status !== 'active') throw actionError('outing_not_active')
  if (outing.epochId !== await currentEpochId(tx, outing.groupId)) throw actionError('outing_epoch_closed')
  return { outing, actor }
}

/**
 * Lock the outing and require a member (admin). Participants get
 * `outing_admin_only`; anyone else `outing_not_found`. Status checks are the
 * caller's: rename and delete work on an ended outing.
 *
 * Chapter (#1682): a closed chapter is read-only, so every admin action
 * refuses an outing whose chapter has closed (`outing_epoch_closed`), and a
 * viewer pinned to any past chapter (`outing_viewing_past_chapter`, checked
 * first) — except `mode: 'end'`. Ending is the one way out for an outing left
 * active when its chapter closed (owner decision D2(a)): allowed for a member
 * of that chapter (resolveActor already requires it) who is unpinned or
 * pinned to exactly the outing's chapter. A pin to any other past chapter
 * still refuses. endOuting itself decides that a closed chapter folds nothing.
 */
export async function lockForAdmin(
  tx: Tx,
  outingId: unknown,
  inputs: ActorInputs,
  strength: 'share' | 'update' = 'update',
  groupLock: GroupLock = 'share',
  mode: 'admin' | 'end' = 'admin',
): Promise<{ outing: OutingRow; actor: Extract<OutingActor, { kind: 'member' }> }> {
  const outing = await loadOuting(tx, outingId, strength)
  const actor = await resolveActor(tx, outing, inputs, { lockGroup: groupLock })
  if (!actor) throw actionError('outing_not_found')
  if (actor.kind !== 'member') throw actionError('outing_admin_only')
  const refusal = mode === 'end'
    ? endChapterRefusal(actor, outing)
    // A pinned viewer is refused before the current chapter matters.
    : adminChapterRefusal(actor, outing, actor.pinnedPast ? null : await currentEpochId(tx, outing.groupId))
  if (refusal) throw actionError(refusal)
  return { outing, actor }
}

type MemberActor = Extract<OutingActor, { kind: 'member' }>

/**
 * The chapter half of lockForAdmin, pure (#1698): the code an admin action
 * gets from this member on this outing, or null when the chapter allows it.
 * The detail page derives which controls it shows from these same two
 * functions, so a control is on screen exactly when the server would take it.
 * Failure looks like (if the page used its own rule): no error; a button that
 * is always refused, or a missing END on the outing it was meant to close.
 */
export function adminChapterRefusal(
  actor: MemberActor,
  outing: Pick<OutingRow, 'epochId'>,
  currentEpoch: string | null,
): 'outing_viewing_past_chapter' | 'outing_epoch_closed' | null {
  if (actor.pinnedPast) return 'outing_viewing_past_chapter'
  if (outing.epochId !== currentEpoch) return 'outing_epoch_closed'
  return null
}

/** END's chapter rule (D2(a)): unpinned, or pinned to exactly the outing's chapter. */
export function endChapterRefusal(
  actor: MemberActor,
  outing: Pick<OutingRow, 'epochId'>,
): 'outing_viewing_past_chapter' | null {
  return actor.pinnedEpochId !== null && actor.pinnedEpochId !== outing.epochId
    ? 'outing_viewing_past_chapter'
    : null
}

export async function currentEpochId(conn: Conn, groupId: string): Promise<string | null> {
  const [row] = await conn
    .select({ id: groupEpochs.id })
    .from(groupEpochs)
    .where(and(eq(groupEpochs.groupId, groupId), isNull(groupEpochs.endedAt)))
    .limit(1)
  return row?.id ?? null
}

/**
 * Read-side resolution for pages (S3, dashboard): no locks, and a member
 * pinned to a past chapter can still read. Null → render the not-found /
 * invalid-link state.
 */
export async function resolveReader(outingId: unknown): Promise<{ outing: OutingRow; actor: OutingActor } | null> {
  if (!isUuid(outingId)) return null
  const [outing] = await db
    .select({
      id: outings.id,
      groupId: outings.groupId,
      epochId: outings.epochId,
      status: outings.status,
      name: outings.name,
      currency: outings.currency,
    })
    .from(outings)
    .where(and(eq(outings.id, outingId), isNull(outings.deletedAt)))
    .limit(1)
  if (!outing) return null
  const actor = await resolveActor(db, outing, await requestActorInputs(outing.id), { lockGroup: false })
  return actor ? { outing, actor } : null
}
