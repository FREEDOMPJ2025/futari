'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { Translations } from '@/lib/i18n/locales/zh-TW'
import { enterPastEpoch, exitPastEpoch } from '@/actions/epoch-view'
import { formatDateShort } from '@/lib/format-date'
import { SubpageHeader } from '@/app/(dashboard)/_components/SubpageHeader'
import { unwrapAction } from '@/lib/action-errors'

export interface EpochListEntry {
  id: string
  /** ISO timestamp string. */
  startedAt: string
  /** ISO timestamp string, or null when this is the open chapter. */
  endedAt: string | null
  memberAId: string
  memberBId: string | null
  memberAName: string | null
  memberBName: string | null
}

interface Props {
  epochs: EpochListEntry[]
  pinnedEpochId: string | null
  viewerId: string
  locale: string
  t: Translations['pastTimes']
  backLabel: string
  /** #1612 — shown for a chapter's other person when the chapter recorded no
   *  name for them (「對方」). Never a live name. */
  neutralPartnerLabel: string
  /** #1612 — where the back button goes when there is no dashboard to go
   *  back to (the standalone list under /onboarding). Default: history back. */
  backHref?: string
}

export function PastTimesList({
  epochs,
  pinnedEpochId,
  viewerId,
  locale,
  t,
  backLabel,
  neutralPartnerLabel,
  backHref,
}: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const handleEnter = (epochId: string) => {
    startTransition(async () => {
      unwrapAction(await enterPastEpoch(epochId))
      router.push('/dashboard')
    })
  }

  const handleExit = () => {
    startTransition(async () => {
      unwrapAction(await exitPastEpoch())
      router.push('/dashboard')
    })
  }

  const fmt = (iso: string) => formatDateShort(iso, locale, { withYear: true })

  // Resolve "the partner during this chapter" from the viewer's POV. The chapter
  // could be solo (one of memberAId/memberBId is null) or duo. Whichever side
  // isn't the viewer becomes the "partner" label.
  // #1612 — a duo chapter whose row recorded no name for the other person
  // shows the neutral label, not 「一個人」: the chapter was not solo.
  const partnerName = (e: EpochListEntry): string | null => {
    if (e.memberAId === viewerId) return e.memberBId ? (e.memberBName ?? neutralPartnerLabel) : null
    if (e.memberBId === viewerId) return e.memberAName ?? neutralPartnerLabel
    // Viewer wasn't part of this chapter (shouldn't happen: listEpochsForViewer
    // only lists chapters the viewer is named on — but guard regardless).
    return null
  }

  return (
    <>
      <SubpageHeader
        title={t.title}
        backLabel={backLabel}
        onBack={backHref ? () => router.push(backHref) : undefined}
      />

      <div className="px-5 pt-6 pb-3">
        <p className="text-sm" style={{ color: 'var(--ink-3)' }}>{t.intro}</p>
        {/* #1190 — the read-only stance, said once where every pinned visit
            starts (this page is the only way into a past chapter). Product
            philosophy, not a limit: epoch-readonly-design.md. */}
        <p className="text-sm mt-2 text-ink-3">{t.readOnlyNote}</p>
      </div>

      {epochs.length === 0 ? (
        <p className="px-5 mt-6 text-sm" style={{ color: 'var(--ink-3)' }}>{t.empty}</p>
      ) : (
        <ul className="px-4 mt-2 flex flex-col gap-3">
          {epochs.map((e) => {
            const isCurrent = e.endedAt === null
            const isPinned = pinnedEpochId === e.id
            const partner = partnerName(e)
            const subline = isCurrent
              ? (partner
                  ? t.currentChapter.replace('{partner}', partner)
                  : t.currentChapterSolo)
              : t.chapterRange
                  .replace('{start}', fmt(e.startedAt))
                  .replace('{end}', e.endedAt ? fmt(e.endedAt) : '')
            const partnerLine = isCurrent
              ? null
              : (partner ? t.withPartner.replace('{partner}', partner) : t.soloLabel)
            return (
              <li
                key={e.id}
                className="rounded-card px-5 py-4 flex flex-col gap-3"
                style={{ background: 'var(--surface)', border: '1px solid var(--hairline)' }}
              >
                <div>
                  <div className="text-sm font-medium" style={{ color: 'var(--ink)' }}>{subline}</div>
                  {partnerLine && (
                    <div className="text-xs mt-1" style={{ color: 'var(--ink-3)' }}>{partnerLine}</div>
                  )}
                </div>
                {isCurrent ? (
                  isPinned ? null : (
                    pinnedEpochId !== null ? (
                      <button
                        type="button"
                        onClick={handleExit}
                        disabled={pending}
                        className="self-start text-sm cursor-pointer disabled:opacity-50"
                        style={{ background: 'transparent', color: 'var(--ink-2)' }}
                      >
                        {t.bannerExitCta}
                      </button>
                    ) : null
                  )
                ) : (
                  <button
                    type="button"
                    onClick={() => handleEnter(e.id)}
                    disabled={pending || isPinned}
                    className="self-start h-10 px-4 rounded-xl text-sm font-medium cursor-pointer disabled:opacity-50"
                    style={{ background: 'var(--btn-primary-bg)', color: 'var(--btn-primary-text)' }}
                  >
                    {isPinned ? t.bannerHeading
                        .replace('{start}', fmt(e.startedAt))
                        .replace('{end}', e.endedAt ? fmt(e.endedAt) : '')
                      : t.enterCta}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}
