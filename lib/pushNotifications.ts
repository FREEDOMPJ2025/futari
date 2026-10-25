import { PushNotifications } from '@capacitor/push-notifications'
import { Capacitor } from '@capacitor/core'
import { createClient } from '@/lib/supabase/client'
import { storePushToken } from '@/lib/pushTokenStorage'
import { reportClientError } from '@/lib/observability/reportClientError'

export async function registerPushToken(userId: string, groupId: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) return
  if (Capacitor.getPlatform() !== 'ios') return

  const permission = await PushNotifications.requestPermissions()
  if (permission.receive !== 'granted') return

  await PushNotifications.register()

  PushNotifications.addListener('registration', async ({ value: token }) => {
    // #1605 — remembered so sign-out can remove this device's row
    // (LogoutButton → signOut action, #1617). Never throws.
    storePushToken(token)
    const supabase = createClient()
    // Since 0087 the database refuses a group_id the user is not a member of
    // (42501, only on a race: the registrar passes the active ledger); since
    // 0101 it refuses a token of the wrong shape (23514). supabase-js returns
    // either as `{ error }`. #1827 — report the code and nothing else: the
    // error's message / details can quote the failing row, token included.
    // Failure looks like (unreported): no push on this phone, no error anywhere.
    const { error } = await supabase.from('PushTokens').upsert(
      { user_id: userId, group_id: groupId, platform: 'apns', token },
      { onConflict: 'user_id,platform,token' }
    )
    if (error) {
      const code = typeof error.code === 'string' && /^[A-Za-z0-9]{1,16}$/.test(error.code) ? error.code : 'other'
      reportClientError(new Error(`push token upsert failed code=${code}`), { area: 'push', op: 'token_upsert' })
    }
  })

  PushNotifications.addListener('registrationError', (error) => {
    console.error('[push] registration error', error)
    // The plugin reports this through an event, not a rejection, so the
    // registrar's catch never sees it. Message only (APNs text, no token).
    reportClientError(new Error(`push registration error: ${error?.error ?? 'unknown'}`), {
      area: 'push',
      op: 'registration_event',
    })
  })
}
