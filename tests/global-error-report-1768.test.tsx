/**
 * #1768 — app/global-error.tsx reports to Sentry with area/route/digest tags,
 * and the route tag never carries an invite / outing bearer token.
 *
 * Failure looks like: Sentry events from the root error page either have no
 * route at all (can't tell which page broke), or carry `/invite/<live token>`
 * in a tag the beforeSend scrub does not touch (it only rewrites URL-named
 * keys). Nothing else breaks, so only these tests notice.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor, cleanup } from '@testing-library/react'

const capture = vi.hoisted(() => vi.fn())
vi.mock('@/lib/observability/sentryClient', () => ({ captureException: capture }))

import GlobalError from '@/app/global-error'
import { reportClientError } from '@/lib/observability/reportClientError'

const TOKEN_43 = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde'
const UUID = '123e4567-e89b-12d3-a456-426614174000'

beforeEach(() => {
  capture.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  window.history.replaceState(null, '', '/')
})

describe('global-error reports with a masked route', () => {
  it.each([
    ['/invite/abc123?next=/x#frag', '/invite/:token', 'abc123'],
    [`/en/outing/${TOKEN_43}?ref=share#top`, '/en/outing/:token', TOKEN_43],
    [`/en/outing/r/${UUID}`, '/en/outing/r/:id', UUID],
  ])('%s → %s', async (url, expected, secret) => {
    window.history.replaceState(null, '', url)
    const err = Object.assign(new Error('boom'), { digest: 'd1' })
    render(<GlobalError error={err} reset={() => {}} />)
    await waitFor(() => expect(capture).toHaveBeenCalledTimes(1))
    expect(capture).toHaveBeenCalledWith(err, {
      tags: { area: 'global-error', route: expected, digest: 'd1' },
    })
    const serialized = JSON.stringify(capture.mock.calls[0][1])
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain('?')
    expect(serialized).not.toContain('#')
  })

  it('omits digest when the error has none', async () => {
    window.history.replaceState(null, '', '/records')
    const err = new Error('boom')
    render(<GlobalError error={err} reset={() => {}} />)
    await waitFor(() => expect(capture).toHaveBeenCalledTimes(1))
    expect(capture.mock.calls[0][1]).toEqual({ tags: { area: 'global-error', route: '/records' } })
  })
})

describe('reportClientError route hardening', () => {
  it('masks a raw token path passed as route', async () => {
    reportClientError(new Error('x'), { area: 'route-error', route: '/invite/x' })
    await waitFor(() => expect(capture).toHaveBeenCalledTimes(1))
    expect(capture.mock.calls[0][1]).toEqual({ tags: { area: 'route-error', route: '/invite/:token' } })
  })

  it.each(['records', 'settings', 'review'])('passes non-path route %s through unchanged', async (route) => {
    reportClientError(new Error('x'), { area: 'route-error', route })
    await waitFor(() => expect(capture).toHaveBeenCalledTimes(1))
    expect(capture.mock.calls[0][1]).toEqual({ tags: { area: 'route-error', route } })
  })
})
