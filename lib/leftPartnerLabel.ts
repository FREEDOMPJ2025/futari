/**
 * #1782 — the 「已離開的夥伴」 label, as a system marker.
 *
 * Account deletion (0096 → 0099), #1619 (hideNameInLeftLedgers) and a
 * tombstone captured when a chapter closes write the zh-TW literal into a
 * name slot AND set that slot's marker column (GroupEpochs
 * `member_*_name_is_left_label`, OutingParticipants
 * `display_name_is_left_label`, Profiles `is_tombstone`). The marker is the
 * only thing a reader decides on:
 *   - marker true  → the viewer's translation (`t.common.leftPartnerLabel`),
 *     shown in the system style (neutral avatar, secondary ink);
 *   - marker false → the name as written, even when it reads 「已離開的夥伴」
 *     (a person who chose that name keeps it, untranslated, in the normal
 *     style — the style is what tells the two apart).
 * The literal in the name column is only a fallback for code that predates
 * the marker.
 *
 * Failure looks like: nothing errors. A reader that compares the name with
 * the literal instead of reading the marker translates a name someone chose,
 * and a reader that skips the helper shows 已離開的夥伴 to an English viewer.
 *
 * What may reach a client: the translated string plus at most one
 * `isLeftLabel` boolean. `is_tombstone` itself never does (after-leaving
 * spec: nothing on screen may say an account was deleted) — deletion, #1619
 * and a tombstone all collapse into the same boolean here.
 */

/** A name slot as read from the database: the stored name and its marker. */
export interface ChapterName {
  name: string | null
  /** The slot holds the system's left label (marker column true). */
  isLeftLabel: boolean
}

/** The name to show for a slot: the viewer's label when the marker is set, the stored name otherwise. */
export function leftAwareName(slot: ChapterName, leftPartnerLabel: string): string | null {
  return slot.isLeftLabel ? leftPartnerLabel : slot.name
}

/** The two slots of a chapter as getEpochMembers / withChapterNames return them. */
export interface ChapterNameSlots {
  memberAId: string
  memberBId: string | null
  memberAName: ChapterName
  memberBName: ChapterName
}

/** A chapter's two names, translated for one viewer, with the per-slot marker kept for styling. */
export interface LocalizedChapterMembers {
  memberAId: string
  memberBId: string | null
  memberAName: string | null
  memberBName: string | null
  memberAIsLeftLabel: boolean
  memberBIsLeftLabel: boolean
}

/** Translate a chapter's two slots for the viewer's locale. */
export function localizeChapterMembers(
  chapter: ChapterNameSlots,
  leftPartnerLabel: string,
): LocalizedChapterMembers {
  return {
    memberAId: chapter.memberAId,
    memberBId: chapter.memberBId,
    memberAName: leftAwareName(chapter.memberAName, leftPartnerLabel),
    memberBName: chapter.memberBId ? leftAwareName(chapter.memberBName, leftPartnerLabel) : null,
    memberAIsLeftLabel: chapter.memberAName.isLeftLabel,
    memberBIsLeftLabel: chapter.memberBId ? chapter.memberBName.isLeftLabel : false,
  }
}
