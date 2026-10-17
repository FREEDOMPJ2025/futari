import type { ChapterIdentity } from '@/app/(dashboard)/_components/MemberContext'
import type { LocalizedChapterMembers } from '@/lib/leftPartnerLabel'

/** `getEpochMembers`' result after `localizeChapterMembers` (kept structural so this stays pure). */
export type ChapterMembers = LocalizedChapterMembers

/**
 * #1604 — the chapter identity the dashboard layout puts in MemberContext when
 * the viewer is pinned to a past chapter: the OTHER person named on that
 * chapter's GroupEpochs row, with the name `getEpochMembers` returned and no
 * avatar. Never today's group row.
 *
 * - `members` null (chapter row unreadable) → solo, no partner: fail closed
 *   rather than fall back to the live partner.
 * - A missing profile name falls back to `fallbackName` (the generic 「對方」),
 *   the same fallback CompactRow already uses. A deleted account is not this
 *   case: its slot is marked as the left label and comes through as the
 *   viewer's translation of it.
 * - #1782 — a marked slot (`member*IsLeftLabel`) gets no initial: the avatar
 *   shows the neutral system style instead of a letter (Avatar `neutral`), so
 *   the label cannot be passed off by someone who named themself the same.
 */
export function buildChapterIdentity(
  members: ChapterMembers | null,
  viewerId: string,
  fallbackName: string,
): ChapterIdentity {
  if (!members) return { partner: null, isSolo: true }
  const viewerIsChapterA = members.memberAId === viewerId
  const partnerId = viewerIsChapterA ? members.memberBId : members.memberAId
  if (!partnerId) return { partner: null, isSolo: true }
  const name = (viewerIsChapterA ? members.memberBName : members.memberAName) ?? fallbackName
  const isLeftLabel = viewerIsChapterA ? members.memberBIsLeftLabel : members.memberAIsLeftLabel
  return {
    partner: {
      id: partnerId,
      displayName: name,
      initial: isLeftLabel ? '' : (name[0] ?? '?').toUpperCase(),
      avatarUrl: null,
      isLeftLabel,
    },
    isSolo: false,
  }
}
