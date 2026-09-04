/**
 * Moving between the three commons views.
 *
 * The launcher has one tile for all of this, because Places and Ideas are ways of answering
 * the question Tonight asks rather than three separate questions — so the switch between them
 * lives here, at the top of each, instead of taking three squares in a grid that is meant to
 * be read at a glance.
 *
 * Real links rather than buttons with an `onClick`: each view is a URL somebody can be sent,
 * bookmark or come back to, and a middle-click should open one in a tab. Deciding a thing is
 * "in-page navigation" is not a reason to stop it being navigation.
 */
import { NavLink } from 'react-router-dom'

import { useI18n } from '@/i18n'

const VIEWS: ReadonlyArray<{ to: string; key: string; label: string }> = [
  { to: '/tonight', key: 'commons.tonight', label: 'Tonight' },
  { to: '/places', key: 'commons.places', label: 'Places' },
  { to: '/ideas', key: 'commons.ideas', label: 'Ideas' },
]

export function CommonsNav(): React.ReactElement {
  const { t } = useI18n()
  return (
    <nav className="commons-nav" aria-label={t('commons.nav', 'The commons')}>
      {VIEWS.map(view => (
        <NavLink
          key={view.to}
          to={view.to}
          end
          className={({ isActive }) =>
            `commons-nav__link${isActive ? ' commons-nav__link--on' : ''}`
          }
        >
          {t(view.key, view.label)}
        </NavLink>
      ))}
    </nav>
  )
}
