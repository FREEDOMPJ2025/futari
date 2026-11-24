import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useState } from 'react'
import { AmountInput, parseAmountInput } from '@/app/(dashboard)/_components/AmountInput'

describe('parseAmountInput (#1920 stage 0)', () => {
  it.each([
    ['12.5', 'ASCII period'],
    ['12.', 'trailing period'],
    ['.5', 'leading period'],
    ['12．5', 'fullwidth period'],
    ['12。5', 'IME ideographic period'],
    ['12｡5', 'halfwidth ideographic period'],
    ['1,200.50', 'thousands plus decimals'],
    ['12.00', 'zero fraction'],
    ['.', 'lone period'],
  ])('rejects %s (%s)', (raw) => {
    expect(parseAmountInput(raw, 7)).toBeNull()
  })

  it.each([
    ['1,200', '1200'],
    ['1,234,567', '1234567'],
    ['', ''],
    ['007', '7'],
    ['12345678', '1234567'],
    ['abc12', '12'],
  ])('parses %s to %s', (raw, expected) => {
    expect(parseAmountInput(raw, 7)).toBe(expected)
  })
})

function Harness({ initial, onChange }: { initial: string; onChange: (v: string) => void }) {
  const [v, setV] = useState(initial)
  return (
    <AmountInput
      value={v}
      onChange={(n) => {
        onChange(n)
        setV(n)
      }}
      symbol="NT$"
      ariaLabel="amount"
    />
  )
}

describe('AmountInput decimal rejection', () => {
  it.each(['12.5', '12.', '12．5', '12。5'])('keeps the previous value when %s is entered', (typed) => {
    const onChange = vi.fn()
    render(<Harness initial="12" onChange={onChange} />)
    const input = screen.getByLabelText('amount') as HTMLInputElement
    fireEvent.change(input, { target: { value: typed } })
    expect(onChange).not.toHaveBeenCalled()
    expect(input.value).toBe('12')
  })

  it('keeps the previous value on a pasted decimal', () => {
    const onChange = vi.fn()
    render(<Harness initial="" onChange={onChange} />)
    const input = screen.getByLabelText('amount') as HTMLInputElement
    fireEvent.paste(input, { clipboardData: { getData: () => '12.5' } })
    fireEvent.change(input, { target: { value: '12.5' } })
    expect(onChange).not.toHaveBeenCalled()
    expect(input.value).toBe('')
  })

  it('still accepts digits and comma-grouped input', () => {
    const onChange = vi.fn()
    render(<Harness initial="" onChange={onChange} />)
    const input = screen.getByLabelText('amount') as HTMLInputElement
    fireEvent.change(input, { target: { value: '1,200' } })
    expect(onChange).toHaveBeenLastCalledWith('1200')
    expect(input.value).toBe('1,200')
  })
})
