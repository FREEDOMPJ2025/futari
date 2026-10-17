/**
 * #1767 — failures that used to be console.error only now open Sentry Issues.
 *
 * Failure looks like: the user sees an error page / a failed import / a device
 * without push, and Sentry Issues stays empty (the console.error only reaches
 * Logs). Nothing else breaks, so only these tests notice a dropped capture.
 * Expected action failures ({ ok:false, code }) must NOT be reported.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'

const capture = vi.hoisted(() => vi.fn())
vi.mock('@/lib/observability/sentryClient', () => ({ captureException: capture }))
vi.mock('@/app/(dashboard)/_components/ErrorPage', () => ({ ErrorPage: () => null }))

import DashboardError from '@/app/(dashboard)/dashboard/error'
import RecordsError from '@/app/(dashboard)/records/error'
import TripsError from '@/app/(dashboard)/trips/error'
import AssetsError from '@/app/(dashboard)/assets/error'
import SettingsError from '@/app/(dashboard)/settings/error'
import ReviewError from '@/app/(dashboard)/review/[month]/error'
import { reportClientError } from '@/lib/observability/reportClientError'

beforeEach(() => {
  capture.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('route error boundaries', () => {
  const cases: Array<[string, typeof DashboardError]> = [
    ['dashboard', DashboardError],
    ['records', RecordsError],
    ['trips', TripsError],
    ['assets', AssetsError],
    ['settings', SettingsError],
    ['review', ReviewError],
  ]
  it.each(cases)('%s reports with area/route/digest', async (route, Comp) => {
    const err = Object.assign(new Error('boom'), { digest: 'abc123' })
    render(<Comp error={err} reset={() => {}} />)
    await waitFor(() => expect(capture).toHaveBeenCalledTimes(1))
    expect(capture).toHaveBeenCalledWith(err, {
      tags: { area: 'route-error', route, digest: 'abc123' },
    })
  })
})

describe('reportClientError', () => {
  it('drops undefined tags and never throws when capture rejects', async () => {
    capture.mockImplementation(() => { throw new Error('sdk down') })
    expect(() => reportClientError(new Error('x'), { area: 'push', op: 'register' })).not.toThrow()
    await waitFor(() => expect(capture).toHaveBeenCalled())
    expect(capture.mock.calls[0][1]).toEqual({ tags: { area: 'push', op: 'register' } })
  })
})

describe('push registration', () => {
  it('registrar reports a rejected registerPushToken', async () => {
    vi.resetModules()
    const boom = new Error('register blew up')
    vi.doMock('@/lib/pushNotifications', () => ({ registerPushToken: () => Promise.reject(boom) }))
    vi.doMock('@capacitor/push-notifications', () => ({ PushNotifications: { removeAllListeners: vi.fn() } }))
    vi.doMock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false } }))
    const { PushTokenRegistrar } = await import('@/app/(dashboard)/_components/PushTokenRegistrar')
    render(<PushTokenRegistrar userId="u" groupId="g" />)
    await waitFor(() => expect(capture).toHaveBeenCalledTimes(1))
    expect(capture).toHaveBeenCalledWith(boom, { tags: { area: 'push', op: 'register' } })
  })

  it('registrationError event is reported once with op=registration_event', async () => {
    vi.resetModules()
    vi.doUnmock('@/lib/pushNotifications')
    const listeners: Record<string, (e: unknown) => void> = {}
    vi.doMock('@capacitor/push-notifications', () => ({
      PushNotifications: {
        requestPermissions: async () => ({ receive: 'granted' }),
        register: async () => {},
        addListener: (n: string, cb: (e: unknown) => void) => { listeners[n] = cb },
      },
    }))
    vi.doMock('@capacitor/core', () => ({
      Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' },
    }))
    vi.doMock('@/lib/supabase/client', () => ({ createClient: () => ({}) }))
    vi.doMock('@/lib/pushTokenStorage', () => ({ storePushToken: vi.fn() }))
    const { registerPushToken } = await import('@/lib/pushNotifications')
    await registerPushToken('u', 'g')
    listeners.registrationError({ error: 'no aps entitlement' })
    await waitFor(() => expect(capture).toHaveBeenCalledTimes(1))
    expect(capture.mock.calls[0][1]).toEqual({ tags: { area: 'push', op: 'registration_event' } })
    expect((capture.mock.calls[0][0] as Error).message).toContain('no aps entitlement')
  })
})
