import type { CSSProperties, ReactNode } from 'react'
import { Icon } from '@ui5/webcomponents-react'
import { Link } from 'react-router-dom'
import { MoneyText } from '@/components/MoneyText'
import type { FigureState } from './figures'
import type { HomeTileSpec } from './tiles'

export interface HomeTileProps {
  spec: HomeTileSpec
  figure: FigureState
}

/**
 * The figure, in whichever of its three states it arrived in.
 *
 * `unavailable` renders **nothing** on purpose: FRONTEND-CONTRACT §8 asks for the tile with
 * its label and no number rather than an error, and the figure row keeps its height from
 * the stylesheet so a failed request does not make the grid jump.
 */
function figureContent(figure: FigureState): ReactNode {
  if (figure.status === 'loading') {
    return (
      <span
        className="twm-skeleton__block home-tile__shimmer"
        data-testid="home-tile-shimmer"
        aria-hidden="true"
      />
    )
  }
  if (figure.status === 'unavailable') return null

  if (figure.figure.kind === 'money') {
    return (
      <MoneyText
        amount={figure.figure.amount}
        currency={figure.figure.currency}
        size="L"
        className="home-tile__money"
      />
    )
  }

  const classes = ['home-tile__value']
  if (figure.figure.emphasis === 'phrase') classes.push('home-tile__value--phrase')
  return <span className={classes.join(' ')}>{figure.figure.value}</span>
}

/**
 * One tile of the launcher.
 *
 * A whole-tile `Link`, so the target is the 130-odd px square rather than a word inside it,
 * and so keyboard focus lands once per destination. The accent arrives as a CSS custom
 * property and colours the rule, the icon and the hover border — never the text.
 */
export function HomeTile({ spec, figure }: HomeTileProps) {
  const caption =
    figure.status === 'ready' && figure.figure.caption !== null ? figure.figure.caption : spec.hint

  return (
    <li className="home-grid__cell">
      <Link
        to={spec.to}
        className="home-tile"
        style={{ '--home-accent': spec.accent } as CSSProperties}
        data-testid={`home-tile-${spec.id}`}
        aria-busy={figure.status === 'loading' ? true : undefined}
      >
        <span className="home-tile__icon" aria-hidden="true">
          <Icon name={spec.icon} className="home-tile__glyph" />
        </span>
        <span className="home-tile__label">{spec.label}</span>
        <span className="home-tile__figure">{figureContent(figure)}</span>
        <span className="home-tile__hint">{caption}</span>
      </Link>
    </li>
  )
}

export default HomeTile
