import type { ShortcutArt } from '@/lib/i18n/locales/zh-TW'
import { Reveal } from '../../outing/_components/Reveal'
import { fs } from './feature-shortcuts-css'

function Toggle({ on }: { on: boolean }) {
  return <span className={`${fs.toggle}${on ? ` ${fs.toggleOn}` : ''}`} />
}

function Row({ hot, children }: { hot?: boolean; children: React.ReactNode }) {
  return <p className={`${fs.cardRow}${hot ? ` ${fs.hot}` : ''}`}>{children}</p>
}

/**
 * A diagram of one setup step (#1921): labels and where to tap, not a picture of
 * the iPhone. Screenshots would need one set per language and iOS version and
 * would drift from the instructions; these labels come from the step's own
 * `body`, which a test holds them to. `aria-hidden` because the body says all
 * of it. Only the outline of a marked row moves, so a card is never empty.
 */
export function ShortcutArtCard({ art }: { art: ShortcutArt }) {
  return (
    <Reveal className={fs.reveal}>
      <div className={`${fs.card} text-sm`} aria-hidden="true">
        {art.kind === 'wallet' && (
          <>
            <p className={`${fs.cardPath} text-xs`}>{art.path}</p>
            <p className={fs.cardTitle}>{art.heading}</p>
            <Row hot>{art.option}</Row>
            {art.toggles.map((label, i) => (
              <Row key={label} hot>
                {label}
                {/* The automation's own switch is on, its notification off. */}
                <Toggle on={i === 0} />
              </Row>
            ))}
          </>
        )}
        {art.kind === 'action' && (
          <>
            <p className={`${fs.cardTitle} ${fs.search}`}>
              <svg className={fs.searchIcon} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                <circle cx="6" cy="6" r="4.25" />
                <path d="M9.25 9.25 12.5 12.5" strokeLinecap="round" />
              </svg>
              {art.search}
            </p>
            <Row hot>{art.action}</Row>
          </>
        )}
        {art.kind === 'fields' && (
          <>
            <Row hot>{art.amount}</Row>
            <Row hot>{art.note}</Row>
            <Row>
              {art.category}
              <span className={fs.dashed} />
            </Row>
          </>
        )}
        {art.kind === 'notify' &&
          art.rows.map((row, i) => (
            <Row key={row} hot={i === art.hot}>
              {row}
            </Row>
          ))}
      </div>
    </Reveal>
  )
}
