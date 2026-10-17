import { notFound, redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/supabase/server'
import { db } from '@/lib/db/client'
import { profiles } from '@/lib/db/schema'
import { inArray } from 'drizzle-orm'
import { ViewerProvider } from './_components/ViewerProvider'
import { RealtimeProvider } from './_components/RealtimeProvider'
import { OfflineLifecycle } from './_components/OfflineLifecycle'
import { ReconnectRefresh } from './_components/ReconnectRefresh'
import { PartnerActivityToast } from './_components/PartnerActivityToast'
import type { MemberContextValue } from './_components/MemberContext'
import { getTranslations, getLocale } from '@/lib/i18n/t'
import { TranslationsProvider } from '@/lib/i18n/client'
import { getEpochMembers, resolveViewerEpochContext } from '@/lib/db/queries/epoch'
import { buildChapterIdentity } from '@/lib/chapterIdentity'
import { localizeChapterMembers } from '@/lib/leftPartnerLabel'
import { hasOpenInvite } from '@/lib/db/queries/invite'
import { canAccessGuardian } from '@/lib/guardian'
import { AvatarMenuProvider, type AvatarMenuData } from './_components/AvatarMenuProvider'
import { PushTokenRegistrar } from './_components/PushTokenRegistrar'
import { getActiveGroupForUser } from '@/lib/db/queries/group'
import { AccountDeletionBanner } from './_components/AccountDeletionBanner'
import { ShellUpdateNotice } from './_components/ShellUpdateNotice'
import { ShellTopStack } from './_components/ShellTopStack'
import { TodayProvider } from './_components/TodayProvider'
import { getTodayYMD } from '@/lib/today-server'
import { PastChapterBar } from './_components/PastChapterBar'
import { ToastProvider } from '@/components/Toast'
import { QuickAddProvider } from './_components/QuickAddProvider'
import { parseCurrencyCode } from '@/lib/currency'
import { maskAvatarUrl } from '@/lib/avatar'
import { TextScale } from '@/components/TextScale'
import { TEXT_SCALE_INIT_SCRIPT } from '@/lib/textScale'

// CJK font note: Google serves Noto Sans TC as 105 unicode-range split files,
// which is why this import is worth being careful with.
//
// Self-hosted from public/fonts/ rather than next/font/google. That loader
// fetches all 105 chunks over the network at build time (concurrently, and
// `subsets` does NOT narrow the list — it only decides what gets preloaded), then
// fails the entire build if any single fetch errors. One transient blip took a
// preview deploy down on 2026-08-11 and the same dice roll applied to prod.
// (#978 — regenerate with scripts/fetch-google-fonts.mjs)
//
// Imported here and not in the root layout so the landing page stays free of the
// ~190KB of @font-face declarations. Each extra weight is a real perf cost —
// check `grep -c '@font-face' app/fonts/noto-sans-tc.css` before adding one.
// (#289 / #572)
//
// No <link rel="preload"> is emitted for these chunks, matching the old
// `preload: false`: initial CJK glyphs render immediately via the PingFang TC /
// Microsoft JhengHei / Noto Sans CJK TC fallback chain (see globals.css
// `--font-sans`), then Noto Sans TC swaps in via `display: swap`. Trades a tiny
// FOUT for ~700ms off the mobile critical path. Onboarding (`app/onboarding/`)
// still falls back to system-ui via inline styles — accepted minor regression
// for first-visit perf. (#318 / #319 / #572)
import '../fonts/noto-sans-tc.css'

// Warm TLS to Supabase before the dashboard's first realtime/auth fetch. Scoped
// to the authenticated layout (not the root) so the public landing page isn't
// charged an unused connection — the landing never talks to Supabase. React
// hoists these <link>s to <head>; preconnect ignores the path, origin only.
// (#352 / #921)
const SUPABASE_ORIGIN = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').origin
  } catch {
    return null
  }
})()

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser()
  if (!user) redirect('/sign-in')

  // Pin-aware context: when the viewer is pinned to a past epoch (possibly
  // on a different group, see #141), the group + window follow the pin.
  const context = await resolveViewerEpochContext(user.id)
  if (!context) redirect('/onboarding')
  const { group, window: epochWindow, isFormerMemberView } = context

  // #1612 — a former member looking back at a closed chapter of the ledger
  // they left: `group` is that ledger, and its current members are other
  // people. Read the viewer's own profile only; the chapter's other person
  // comes from the chapter row (getEpochMembers, frozen name, no avatar).
  // Failure this prevents: nothing errors; the leaver's payload carries the
  // stayer's current name and photo, and the new partner's.
  const memberIds = isFormerMemberView
    ? [user.id]
    : [group.memberA, group.memberB].filter((x): x is string => !!x)
  // #1546 — only the viewer's own live solo ledger can hold a link they may
  // revoke (revokeOpenInvites acts on the active group). A pinned past
  // chapter or a duo skips the query.
  const canHoldOpenInvite = !epochWindow.isPast && group.memberB === null && group.memberA === user.id
  const [profilesRows, t, locale, todayYMD, openInvite, chapterMembers] = await Promise.all([
    db.select().from(profiles).where(inArray(profiles.id, memberIds)),
    getTranslations(),
    getLocale(),
    // Today in the device's zone, so client components hydrate against the
    // same calendar day the browser will compute (#1360, lib/today.ts).
    getTodayYMD(),
    canHoldOpenInvite ? hasOpenInvite(group.id) : Promise.resolve(false),
    // #1604 — who the pinned chapter was between, names included. The epoch
    // id came from resolveViewerEpochContext, which only accepts a pin for a
    // chapter the viewer is named on (getEpochMembers' caller contract).
    epochWindow.isPast && epochWindow.epochId
      ? getEpochMembers(epochWindow.epochId)
      : Promise.resolve(null),
  ])

  const viewerProfile = profilesRows.find(p => p.id === user.id)
  // No profile row for the viewer → 404, never /sign-in (#1603). The viewer
  // IS signed in, so /sign-in sends them straight back to /dashboard and they
  // loop with no way out. resolveViewerEpochContext only returns groups the
  // viewer is in today, or (#1612) a closed chapter they are named on, whose
  // view reads only the viewer's own profile; so this should be unreachable.
  // It stays as the layout's own guard, and must not be able to loop.
  if (!viewerProfile) notFound()

  const deletionRequestedAt = viewerProfile.deletionRequestedAt ?? null

  // #1612 — never today's members of a ledger the viewer left.
  const partnerId = isFormerMemberView ? null : (group.memberA === user.id ? group.memberB : group.memberA)
  const partnerProfile = partnerId ? profilesRows.find(p => p.id === partnerId) : undefined

  // #1612 — a former member's A/B side and solo-ness come from the chapter
  // row, never from the group row today (which names the stayer and whoever
  // joined after). Known limit: a member_a/member_b swap made AFTER the leave
  // flips stored split ratios on every row, closed chapters included, so the
  // leaver's ratio display reads in the pre-swap frame; the live row is not
  // consulted because it would reveal who is in the ledger today.
  const viewerIsA = isFormerMemberView
    ? chapterMembers?.memberAId === user.id
    : group.memberA === user.id
  const chapterIdentity = epochWindow.isPast
    // #1782 — translated here, where the viewer's locale is known; a marked
    // slot reads t.common.leftPartnerLabel and carries only `isLeftLabel`.
    ? buildChapterIdentity(
        chapterMembers ? localizeChapterMembers(chapterMembers, t.common.leftPartnerLabel) : null,
        user.id,
        t.common.partner,
      )
    : null

  const value: MemberContextValue = {
    group: {
      id: group.id,
      // #1612 — the ledger's name today is the stayer's; a former member sees
      // the neutral ledger label instead.
      name: isFormerMemberView ? t.postLeave.newLedgerName : group.name,
      // The chapter's amounts are stored in the ledger's base currency. There
      // is no per-chapter currency column, so this is the one live field a
      // former-member view keeps: amounts cannot be formatted without it.
      baseCurrency: parseCurrencyCode(group.baseCurrency) ?? 'twd',
    },
    viewer: {
      id: viewerProfile.id,
      displayName: viewerProfile.displayName,
      initial: (viewerProfile.displayName[0] ?? '?').toUpperCase(),
      avatarUrl: maskAvatarUrl(viewerProfile),
      defaultSplitType: viewerProfile.defaultSplitType,
      who: 'M',
    },
    partner: partnerProfile ? {
      id: partnerProfile.id,
      displayName: partnerProfile.displayName,
      initial: (partnerProfile.displayName[0] ?? '?').toUpperCase(),
      avatarUrl: maskAvatarUrl(partnerProfile),
      defaultSplitType: partnerProfile.defaultSplitType,
      who: 'T',
    } : null,
    viewerIsA,
    // #1612 — a former member: whether THAT chapter was solo, not today's row.
    isSolo: isFormerMemberView ? (chapterIdentity?.isSolo ?? true) : !partnerProfile,
    isPast: epochWindow.isPast,
    isFormerMember: isFormerMemberView,
    // #1604 — a past chapter is labelled with ITS partner (name + initial, no
    // avatar), never today's. `partner` / `isSolo` above keep their live
    // meaning; `viewerIsA` stays on the current group row (see MemberContext)
    // except in a former-member view (#1612, above).
    chapter: chapterIdentity,
    // #1612 — the guardian flag is the ledger's live setting: off for a
    // former member.
    canAccessGuardian: isFormerMemberView ? false : canAccessGuardian(group),
    epochStartedAt: epochWindow.startedAt.toISOString(),
    epochEndedAt: epochWindow.endedAt ? epochWindow.endedAt.toISOString() : null,
  }

  const avatarMenuData: AvatarMenuData = {
    viewerEmail: user.email ?? '',
    // #1612 — the ledger's live settings are not a former member's to see.
    groupDefaultRatioA: isFormerMemberView ? null : (group.defaultSplitRatioA ?? null),
    guardianBetaEnabled: isFormerMemberView ? false : group.guardianBetaEnabled,
    currentLocale: locale,
    avatarHidden: viewerProfile.avatarHidden,
    hasOpenInvite: openInvite,
  }

  const shell = (
    <>
      {/* #1605 — the ACTIVE ledger, never a pinned past chapter's. #1617 —
          not pinned to a past chapter, `group` already IS the active
          ledger (the resolver fell through to getActiveGroupForUser), so
          only a past pin pays for the extra lookup. */}
      {await (epochWindow.isPast ? getActiveGroupForUser(user.id) : Promise.resolve(group)).then((g) => g && <PushTokenRegistrar userId={user.id} groupId={g.id} />)}
      <OfflineLifecycle />
      <ReconnectRefresh />
      <PartnerActivityToast />
      <AvatarMenuProvider data={avatarMenuData} disabled={isFormerMemberView}>
        <div className="relative max-w-md mx-auto min-h-dvh font-noto-tc" style={{ background: 'var(--bg)' }}>
          {/* Every band that pins to the top of the viewport goes in here,
              in priority order, so they stack instead of colliding (#1037).
              A page's own sticky header stays in `{children}` and pins at
              `top: var(--top-stack-h)` — see ShellTopStack for why it is
              the height that travels and not the element. */}
          <ShellTopStack>
            <ShellUpdateNotice />
            {deletionRequestedAt && (
              <AccountDeletionBanner requestedAt={new Date(deletionRequestedAt).toISOString()} />
            )}
            <PastChapterBar />
          </ShellTopStack>
          {/* Shortcut / `#add=` quick add (#1488): owns the shell URL
              listener and hands Dashboard a prefill in memory. Inside the
              dashboard group so it unmounts on sign-out. */}
          <ToastProvider>
            <QuickAddProvider>{children}</QuickAddProvider>
          </ToastProvider>
        </div>
      </AvatarMenuProvider>
    </>
  )

  return (
    <TranslationsProvider value={t} locale={locale}>
      <TodayProvider todayYMD={todayYMD}>
        {/* iOS system text size → --text-scale before first paint (#1490).
            Must stay ahead of any content. TextScale below owns re-measure
            and cleanup; see lib/textScale.ts. */}
        <script dangerouslySetInnerHTML={{ __html: TEXT_SCALE_INIT_SCRIPT }} />
        <TextScale />
        {SUPABASE_ORIGIN && (
          <>
            <link rel="preconnect" href={SUPABASE_ORIGIN} crossOrigin="anonymous" />
            <link rel="dns-prefetch" href={SUPABASE_ORIGIN} />
          </>
        )}
        <ViewerProvider value={value}>
          {/* #1612 — no Realtime channel on a ledger the viewer left: the
              chapter on screen is closed, and the channel would carry the
              stayer's present (RLS gives a non-member no frames anyway). */}
          {isFormerMemberView
            ? shell
            : <RealtimeProvider groupId={group.id}>{shell}</RealtimeProvider>}
        </ViewerProvider>
      </TodayProvider>
    </TranslationsProvider>
  )
}
