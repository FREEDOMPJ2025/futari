import { currencySymbol, type CurrencyCode } from '@/lib/currency'
import { MAX_AMOUNT } from '@/lib/validators'

declare const minorBrand: unique symbol
export type Minor = number & { readonly [minorBrand]: true }

export function toMinor(n: number): Minor {
  if (!Number.isSafeInteger(n)) throw new RangeError('Minor amount must be a safe integer')
  return n as Minor
}

// 有資料後不可改。更改小數位數會讓整批資料差 10^n 倍。
export const MINOR_UNIT_PRECISION: Record<CurrencyCode, 0 | 2> = {
  twd: 0,
  jpy: 0,
  usd: 2,
  cny: 2,
}

export function minorUnitPrecision(c: CurrencyCode): 0 | 2 {
  return MINOR_UNIT_PRECISION[c]
}

export function maxMinorAmount(c: CurrencyCode): Minor {
  return toMinor(MAX_AMOUNT * 10 ** minorUnitPrecision(c))
}

export function parseAmountToMinor(
  input: string,
  c: CurrencyCode,
): { ok: true; minor: Minor } | { ok: false; reason: 'empty' | 'invalid' | 'too_many_decimals' | 'too_large' } {
  if (input === '') return { ok: false, reason: 'empty' }

  const normalized = input
    .replace(/[０-９]/g, (digit) => String(digit.charCodeAt(0) - 0xff10))
    .replace(/[．。]/g, '.')
    .replace(/[,，]/g, '')

  if (!/^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/.test(normalized)) {
    return { ok: false, reason: 'invalid' }
  }

  const [whole, fraction = ''] = normalized.split('.')
  const precision = minorUnitPrecision(c)
  if (fraction.length > precision) return { ok: false, reason: 'too_many_decimals' }

  const amount = Number(whole + fraction.padEnd(precision, '0'))
  if (amount > maxMinorAmount(c)) return { ok: false, reason: 'too_large' }
  return { ok: true, minor: toMinor(amount) }
}

export function formatMinor(minor: Minor, c: CurrencyCode): string {
  const precision = minorUnitPrecision(c)
  const digits = String(Math.abs(minor)).padStart(precision + 1, '0')
  const wholeEnd = digits.length - precision
  const whole = Number(digits.slice(0, wholeEnd)).toLocaleString('en-US')
  const fraction = precision === 0 ? '' : `.${digits.slice(wholeEnd)}`
  const sign = minor < 0 ? '-' : ''
  return `${sign}${currencySymbol(c)}${whole}${fraction}`
}
