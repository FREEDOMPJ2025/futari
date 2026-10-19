'use client'

import { useEffect } from 'react'
import { reportClientError } from '@/lib/observability/reportClientError'
import { ErrorPage } from '@/app/(dashboard)/_components/ErrorPage'

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error(error)
    reportClientError(error, { area: 'route-error', route: 'assets', digest: error.digest })
  }, [error])

  return <ErrorPage page="assets" reset={reset} digest={error.digest} />
}
