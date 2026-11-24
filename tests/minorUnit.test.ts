import { describe, expect, it } from 'vitest'
import { CURRENCIES, currencySymbol } from '@/lib/currency'
import {
  formatMinor,
  maxMinorAmount,
  MINOR_UNIT_PRECISION,
  minorUnitPrecision,
  parseAmountToMinor,
  toMinor,
} from '@/lib/minorUnit'

describe('minorUnitPrecision', () => {
  it('pins the stored precision for every ledger currency', () => {
    expect(MINOR_UNIT_PRECISION).toEqual({ twd: 0, jpy: 0, usd: 2, cny: 2 })
    for (const currency of CURRENCIES) {
      expect(MINOR_UNIT_PRECISION).toHaveProperty(currency)
      expect(minorUnitPrecision(currency)).toBe(MINOR_UNIT_PRECISION[currency])
    }
  })
})

describe('toMinor', () => {
  it.each([0, -1, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER])('accepts %s', (amount) => {
    expect(toMinor(amount)).toBe(amount)
  })

  it.each([0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects %s', (amount) => {
    expect(() => toMinor(amount)).toThrow(RangeError)
  })
})

describe('maxMinorAmount', () => {
  it('scales the display limit by each currency precision', () => {
    expect(maxMinorAmount('usd')).toBe(999_999_900)
    expect(maxMinorAmount('cny')).toBe(999_999_900)
    expect(maxMinorAmount('twd')).toBe(9_999_999)
    expect(maxMinorAmount('jpy')).toBe(9_999_999)
  })
})

describe('parseAmountToMinor', () => {
  it.each([
    ['１２．５０', 'usd', 1250],
    ['１，２００', 'twd', 1200],
    ['12。50', 'usd', 1250],
    ['.5', 'usd', 50],
    ['12.', 'usd', 1200],
    ['12.', 'twd', 12],
    ['1.15', 'usd', 115],
    ['0.29', 'usd', 29],
    ['1.1', 'usd', 110],
    ['0.07', 'usd', 7],
    ['1,200', 'usd', 120000],
    ['0', 'twd', 0],
    ['0.00', 'cny', 0],
    ['9999999', 'usd', 999_999_900],
    ['9999999.00', 'usd', 999_999_900],
    ['9999999', 'twd', 9_999_999],
  ] as const)('parses %s in %s as %i', (input, currency, minor) => {
    expect(parseAmountToMinor(input, currency)).toEqual({ ok: true, minor })
  })

  it.each([
    ['', 'usd', 'empty'],
    ['.', 'usd', 'invalid'],
    ['abc', 'usd', 'invalid'],
    ['1.2.3', 'usd', 'invalid'],
    ['-5', 'usd', 'invalid'],
    ['+5', 'usd', 'invalid'],
    ['1e2', 'usd', 'invalid'],
    ['1\n', 'usd', 'invalid'],
    ['.5', 'twd', 'too_many_decimals'],
    ['12.5', 'twd', 'too_many_decimals'],
    ['12.0', 'twd', 'too_many_decimals'],
    ['1.005', 'usd', 'too_many_decimals'],
    ['12.345', 'usd', 'too_many_decimals'],
    ['9999999.01', 'usd', 'too_large'],
    ['9999999.99', 'usd', 'too_large'],
    ['10000000', 'usd', 'too_large'],
    ['10000000', 'twd', 'too_large'],
    ['9'.repeat(400), 'usd', 'too_large'],
  ] as const)('rejects %j in %s with %s', (input, currency, reason) => {
    expect(parseAmountToMinor(input, currency)).toEqual({ ok: false, reason })
  })
})

describe('formatMinor', () => {
  it.each([
    [1000, 'usd', '$10.00'],
    [1000, 'twd', 'NT$1,000'],
    [1000, 'jpy', '¥1,000'],
    [1250, 'cny', 'CN¥12.50'],
    [0, 'usd', '$0.00'],
    [0, 'twd', 'NT$0'],
    [1, 'usd', '$0.01'],
    [-1250, 'usd', '-$12.50'],
    [-1000, 'twd', '-NT$1,000'],
    [123456789, 'usd', '$1,234,567.89'],
    [Number.MAX_SAFE_INTEGER, 'usd', '$90,071,992,547,409.91'],
  ] as const)('formats %i in %s as %s', (minor, currency, formatted) => {
    expect(formatMinor(toMinor(minor), currency)).toBe(formatted)
  })

  it.each(CURRENCIES)('round-trips %s through the formatted digits', (currency) => {
    const parsed = parseAmountToMinor('１，２３４', currency)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    const formatted = formatMinor(parsed.minor, currency)
    expect(parseAmountToMinor(formatted.slice(currencySymbol(currency).length), currency)).toEqual(parsed)
  })
})
