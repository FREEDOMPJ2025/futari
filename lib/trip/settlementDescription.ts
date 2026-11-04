import type { Translations } from '@/lib/i18n/locales/zh-TW'

export function buildTripSettlementDescription(t: Translations, tripName: string): string {
  const name = tripName.trim()
  return name
    ? t.compactRow.tripSettledRecord.replace('{name}', () => name)
    : t.compactRow.tripSettledRecordUnnamed
}
