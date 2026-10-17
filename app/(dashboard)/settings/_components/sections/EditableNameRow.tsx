'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import { unwrapAction, type ActionResult } from '@/lib/action-errors'

// Sheet only mounts when the user taps the row to edit — lazy-load to keep
// the settings page initial bundle small (#670 audit 6.1).
const EditTextSheet = dynamic(
  () => import('@/app/(dashboard)/_components/EditTextSheet').then(m => m.EditTextSheet),
  { ssr: false },
)

interface Props {
  /** Section row label (e.g. "帳本名稱"). */
  label: string
  /** Current value shown on the row and seeded into the edit input. */
  value: string
  /** Server action invoked with the new trimmed value. Its result is
   *  unwrapped here, so an expected failure (e.g. #1782's
   *  display_name_reserved) throws and EditTextSheet surfaces it as an inline
   *  error and keeps the sheet open. Without the unwrap the failure was
   *  silent: the sheet closed and nothing was saved. */
  onSave: (next: string) => Promise<ActionResult<unknown>>
}

export function EditableNameRow({ label, value, onSave }: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full flex items-center justify-between px-5 py-4 rounded-card text-left cursor-pointer"
        style={{ background: 'var(--surface)', border: '1px solid var(--hairline)' }}
      >
        <div className="text-sm font-medium" style={{ color: 'var(--ink)' }}>{label}</div>
        <div className="text-sm flex items-center gap-2 shrink-0" style={{ color: 'var(--ink-3)' }}>
          <span style={{ color: 'var(--ink-2)' }}>「{value}」</span>
          <span aria-hidden="true">›</span>
        </div>
      </button>
      <EditTextSheet
        open={open}
        title={label}
        initialValue={value}
        onClose={() => setOpen(false)}
        onSubmit={async (v) => {
          unwrapAction(await onSave(v))
          router.refresh()
        }}
      />
    </>
  )
}
