'use client'

import { useEffect } from 'react'
import { PushNotifications } from '@capacitor/push-notifications'
import { Capacitor } from '@capacitor/core'
import { registerPushToken } from '@/lib/pushNotifications'
import { reportClientError } from '@/lib/observability/reportClientError'

interface Props {
  userId: string
  groupId: string
}

export function PushTokenRegistrar({ userId, groupId }: Props) {
  useEffect(() => {
    registerPushToken(userId, groupId).catch((err) => {
      console.error(err)
      // Rejections of registerPushToken only; the native `registrationError`
      // event is reported in lib/pushNotifications.ts (different failure, so
      // the two never double-report).
      reportClientError(err, { area: 'push', op: 'register' })
    })

    return () => {
      if (Capacitor.isNativePlatform()) {
        PushNotifications.removeAllListeners()
      }
    }
  }, [userId, groupId])

  return null
}
