import type { CSSProperties } from 'react'
import { Avatar } from '@ui5/webcomponents-react'
import type { Person } from '../api/types'

export interface PersonAvatarProps {
  person: Person
  size?: 'S' | 'M' | 'L'
  selected?: boolean
  /** Renders as a button and gives it a pointer; the caller still owns the click. */
  interactive?: boolean
  onClick?: () => void
  className?: string
  /** Set by `@ui5/webcomponents-react` when this is handed to a slot such as ShellBar's. */
  slot?: string
}

/**
 * A person's initials in their own colour.
 *
 * `Person.colour` is data (CONTRACTS.md §10) and FRONTEND-CONTRACT §7 says it wins, so the
 * colour is applied as an inline style rather than through UI5's `colorScheme` palette — an
 * inline style on the custom element outranks the `:host([color-scheme])` rules inside the
 * shadow root, which is exactly the override we want here. There is no fixed roster and no
 * fixed hue: the app draws however many people there are, each in the colour they were given.
 */

/** UI5's avatar sizes run XS…XL; ours are the three this app actually uses. */
const UI5_SIZE: Record<'S' | 'M' | 'L', 'XS' | 'S' | 'M'> = { S: 'XS', M: 'S', L: 'M' }

const FALLBACK_COLOUR = '#0070F2'

/** WCAG-ish luminance so initials stay readable on a colour someone picked by hand. */
function readableForeground(background: string): string {
  const hex = background.trim().replace('#', '')
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map(character => character + character)
          .join('')
      : hex
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return '#ffffff'

  const channels = [0, 2, 4].map(offset => {
    const value = parseInt(full.slice(offset, offset + 2), 16) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  const luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
  return luminance > 0.55 ? '#12252f' : '#ffffff'
}

/** Initials from the only name a person has: `Ada Lovelace` → `AL`, `Noemi` → `NO`. */
function initialsOf(person: Person): string {
  const words = (person.name ?? '').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase()
}

export function PersonAvatar({
  person,
  size = 'M',
  selected = false,
  interactive = false,
  onClick,
  className,
  slot,
}: PersonAvatarProps) {
  const background = person.colour || FALLBACK_COLOUR
  // `--twm-avatar-color` is read by index.css so the selected ring matches the person.
  const style = {
    backgroundColor: background,
    color: readableForeground(background),
    '--twm-avatar-color': background,
  } as CSSProperties
  const classes = ['twm-avatar']
  if (selected) classes.push('twm-avatar--selected')
  if (className) classes.push(className)

  return (
    <Avatar
      slot={slot}
      className={classes.join(' ')}
      size={UI5_SIZE[size]}
      initials={initialsOf(person)}
      shape="Circle"
      interactive={interactive}
      accessibleName={person.name}
      onClick={onClick ? () => onClick() : undefined}
      style={style}
      data-testid="person-avatar"
      data-person={person.ID}
    />
  )
}

export default PersonAvatar
