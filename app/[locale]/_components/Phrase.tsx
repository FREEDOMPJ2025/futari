import { Fragment } from 'react'
import { splitPhrases, phraseTextHtml } from '@/lib/i18n/phrase'

/**
 * Heading text with `<wbr>` at phrase boundaries, so Safari / the iOS shell
 * break between phrases instead of inside a word (#1522 follow-up). The `.ph`
 * rule (word-break: keep-all) lives in app/[locale]/layout.tsx.
 * Latin-only text, i.e. all of English, is returned untouched: no wrapper, no
 * extra HTML.
 * `body` is for body and row text (#1528 F2): zh only. Text with kana (ja) is
 * returned untouched, since Chromium's `auto-phrase` already segments ja.
 */
export function Phrase({ text, body }: { text: string; body?: boolean }) {
  if (body) {
    // One string, not one element per phrase: see phraseTextHtml for why.
    const html = phraseTextHtml(text, true)
    return html ? <span className="ph" dangerouslySetInnerHTML={{ __html: html }} /> : <>{text}</>
  }
  const parts = splitPhrases(text)
  if (!parts) return <>{text}</>
  return (
    <span className="ph">
      {parts.map((p, i) => (
        <Fragment key={i}>
          {i > 0 && <wbr />}
          {p}
        </Fragment>
      ))}
    </span>
  )
}
