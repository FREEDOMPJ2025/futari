import { LandingCtaLink } from '../../_landing/LandingCtaLink'
import { Phrase } from '../../_components/Phrase'
import { Ember } from '../../_components/Ember'
import { s } from '../../_components/brand-inner'

/**
 * Standalone sign-up CTA for /migrate/<source> (#1011).
 *
 * These pages are search landing pages, not migration tools — the real importer
 * lives in post-login settings and the on-page upload widget is a bonus. Until
 * this block existed the page carried no `landing_cta_clicked` emitter at all:
 * the only on-page CTA (`MigrateCta`) is gated behind a successful CSV parse,
 * so a visitor who had no CSV to give had to bounce back to the home page to
 * find an ask. Hairline row on the content rail, same shape as the
 * differentiators above it — not a card (#1528). Mounted between the "why Futari" differentiators and the
 * migration walkthrough so the ask lands before the screenshot instructions.
 */
export function MigratePrimaryCta({
  title,
  body,
  button,
  signInHref,
  source,
}: {
  title: string
  body: string
  button: string
  /** Locale-aware /sign-in href; `LandingCtaLink` appends `?from=<source>`. */
  signInHref: string
  source: string
}) {
  return (
    <section className={s.band}>
      <h2 className={`${s.h2} m-0 text-xl md:text-title font-medium`}><Phrase text={title} /></h2>
      <div className={s.rows}>
        <div className={`${s.row} border-b border-hairline`}>
          <Ember />
          <div className="flex flex-col gap-5 md:flex-row md:items-center md:justify-between md:gap-8">
            <p className="m-0 text-sm md:text-base leading-[1.7] text-ink-2"><Phrase body text={body} /></p>
            <LandingCtaLink
              href={signInHref}
              fromParam={source}
              ctaLocation="migrate_primary"
              target="sign_in"
              className="fc-edge shrink-0 self-start md:self-auto inline-flex items-center justify-center h-12 px-6 rounded-xl text-[var(--on-fill)] text-base font-medium"
              style={{ background: 'var(--btn-primary-bg)', letterSpacing: '1.2px', textDecoration: 'none' }}
            >
              {button}
            </LandingCtaLink>
          </div>
        </div>
      </div>
    </section>
  )
}
