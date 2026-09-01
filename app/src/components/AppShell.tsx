import '@ui5/webcomponents-icons/dist/home.js'
import '@ui5/webcomponents-icons/dist/log.js'
import '@ui5/webcomponents-icons/dist/camera.js'
import '@ui5/webcomponents-icons/dist/money-bills.js'
import '@ui5/webcomponents-icons/dist/calendar.js'
import '@ui5/webcomponents-icons/dist/appointment-2.js'
import '@ui5/webcomponents-icons/dist/heart.js'
import '@ui5/webcomponents-icons/dist/newspaper.js'
import '@ui5/webcomponents-icons/dist/action-settings.js'
import '@ui5/webcomponents-icons/dist/overflow.js'
import type { ReactNode } from 'react'
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { Icon, Popover, ShellBar, Text, Title } from '@ui5/webcomponents-react'
import type { Ui5CustomEvent } from '@ui5/webcomponents-react'
import type { Person } from '../api/types'
import { usePeople } from '../api/hooks'
import { tokens } from '../theme'
import { PersonAvatar } from './PersonAvatar'
import { useSignOut } from './useSignOut'
import { useI18n } from '@/i18n'
import { UpdateBanner } from '@/update/UpdateBanner'
import './components.css'

/**
 * FRONTEND-CONTRACT §6, in order — the first four are also the mobile bottom bar, so the
 * calendar of §9 is appended after Memories rather than inserted next to Events: the bar's
 * four slots are fixed by the contract and Memories is one of them.
 */
export const NAV_ITEMS = [
  { to: '/scan', label: 'Scan', icon: 'camera', hint: 'Photograph a receipt' },
  { to: '/ledger', label: 'Expenses', icon: 'money-bills', hint: 'Postings and payment runs' },
  { to: '/events', label: 'Events', icon: 'calendar', hint: 'Trips, dinners, parties' },
  { to: '/memories', label: 'Memories', icon: 'heart', hint: 'The timeline' },
  { to: '/calendar', label: 'Calendar', icon: 'appointment-2', hint: 'The month, day by day' },
  { to: '/statement', label: 'Statement', icon: 'newspaper', hint: 'The Statement of Us' },
  { to: '/settings', label: 'Settings', icon: 'action-settings', hint: 'People, model, data' },
] as const

/**
 * The launcher. Not a member of `NAV_ITEMS`, because it is not one destination among
 * seven — it is the screen the other seven are launched from (FRONTEND-CONTRACT §8), and
 * `startsWith('/')` would match every path if it were in the list.
 */
const HOME_ITEM = { to: '/', label: 'Home', icon: 'home', hint: 'The tile grid' }

/**
 * How many destinations fit across a phone. Seven do not: the rest live behind "More",
 * which is the fifth slot rather than an eighth cramped one (FRONTEND-CONTRACT §6).
 */
const BOTTOM_BAR_SLOTS = 4

const PRIMARY_NAV = NAV_ITEMS.slice(0, BOTTOM_BAR_SLOTS)
const OVERFLOW_NAV = NAV_ITEMS.slice(BOTTOM_BAR_SLOTS)

/** What "More" offers: the way home first, then the destinations the bar could not hold. */
const MORE_NAV = [HOME_ITEM, ...OVERFLOW_NAV]

/** The bottom bar's fifth slot needs a stable id: UI5 anchors a Popover by element or id. */
const MORE_BUTTON_ID = 'twm-more-nav'

const PRODUCT_TITLE = 'Two-Way Match'
const TAGLINE = 'Household date management'
const ACTIVE_PERSON_KEY = 'twm.activePerson'

/* ------------------------------------------------------------------ *
 *  Who is looking at the app
 * ------------------------------------------------------------------ */

export interface ActivePersonValue {
  /** The person whose avatar is in the ShellBar, or null while people are loading. */
  person: Person | null
  people: Person[]
  setActivePerson: (id: string) => void
}

const ActivePersonContext = createContext<ActivePersonValue>({
  person: null,
  people: [],
  setActivePerson: () => {},
})

/**
 * The person the shell is currently "wearing". A household shares one installation, so this
 * is a preference on the device, not an identity from the server — it just pre-fills
 * "who paid" and colours the shell.
 */
export function useActivePerson(): ActivePersonValue {
  return useContext(ActivePersonContext)
}

function readStoredPerson(): string | null {
  try {
    return window.localStorage.getItem(ACTIVE_PERSON_KEY)
  } catch {
    // Private mode, or storage disabled. A missing preference is not an error.
    return null
  }
}

function writeStoredPerson(id: string): void {
  try {
    window.localStorage.setItem(ACTIVE_PERSON_KEY, id)
  } catch {
    /* nothing to do — the choice simply will not survive a reload */
  }
}

/* ------------------------------------------------------------------ *
 *  Layout
 * ------------------------------------------------------------------ */

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia(query).matches
  })

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const list = window.matchMedia(query)
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches)
    setMatches(list.matches)
    list.addEventListener('change', onChange)
    return () => list.removeEventListener('change', onChange)
  }, [query])

  return matches
}

export interface AppShellProps {
  children?: ReactNode
}

/**
 * The Fiori launchpad this app pretends to be.
 *
 * A real ShellBar with the product title, its tagline and the person switcher, and a bottom
 * bar on a phone — where the destinations of §6 sit inside the safe area, each at least
 * 44 px tall, because this is used one-handed in a supermarket.
 *
 * **There is no side rail.** FRONTEND-CONTRACT §8 replaced it with the tile grid on `/`:
 * six words stacked down the left edge of a laptop told you nothing, cost 15rem of the
 * width the ledger wanted, and had to be maintained in parallel with the bottom bar. A
 * desktop now navigates from the grid, from the ShellBar logo — which goes home — and from
 * whatever the page it is on offers. The bottom bar stays, because a phone still needs to
 * get from the ledger to the scanner without going home first.
 */
export function AppShell({ children }: AppShellProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const isDesktop = useMediaQuery(`(min-width: ${tokens.desktopBreakpoint}px)`)

  const { data: people } = usePeople()
  const [activeId, setActiveId] = useState<string | null>(() => readStoredPerson())
  const [switcherOpen, setSwitcherOpen] = useState(false)
  // One implementation, shared with the Session card in Settings — see useSignOut.ts.
  const signingOut = useSignOut()
  const { t } = useI18n()

  /** Nav labels come from the dictionary, keyed by route; the array stays the contract. */
  const navLabel = (item: { to: string; label: string }): string => {
    const key = item.to === '/ledger' ? 'expenses' : item.to.replace('/', '')
    return t(`nav.${key}`, item.label)
  }
  const [switcherOpener, setSwitcherOpener] = useState<HTMLElement | undefined>(undefined)
  const [moreOpen, setMoreOpen] = useState(false)

  const roster = useMemo(() => people ?? [], [people])

  // A stored id that no longer exists (a person removed, a restored backup) must not leave
  // the shell with no avatar at all — fall back to the first person on the roster.
  useEffect(() => {
    if (roster.length === 0) return
    if (activeId && roster.some(person => person.ID === activeId)) return
    setActiveId(roster[0].ID)
  }, [roster, activeId])

  const setActivePerson = useCallback((id: string) => {
    setActiveId(id)
    writeStoredPerson(id)
  }, [])

  const activePerson = useMemo(
    () => roster.find(person => person.ID === activeId) ?? null,
    [roster, activeId],
  )

  const contextValue = useMemo<ActivePersonValue>(
    () => ({ person: activePerson, people: roster, setActivePerson }),
    [activePerson, roster, setActivePerson],
  )

  // `/` is matched exactly: every path starts with it, so it cannot take part in the
  // prefix search that resolves the other seven.
  const activePath: string =
    location.pathname === HOME_ITEM.to
      ? HOME_ITEM.to
      : (NAV_ITEMS.find(item => location.pathname.startsWith(item.to))?.to ?? HOME_ITEM.to)
  const overflowActive = MORE_NAV.some(item => item.to === activePath)

  const onProfileClick = (event: Ui5CustomEvent<HTMLElement, { targetRef: HTMLElement }>) => {
    setSwitcherOpener(event.detail.targetRef)
    setSwitcherOpen(true)
  }

  return (
    <ActivePersonContext.Provider value={contextValue}>
      <div className="twm-shell">
        <a className="twm-skip-link" href="#twm-main">
          Skip to content
        </a>

        <header className="twm-shellbar-wrap">
          <ShellBar
            className="twm-shellbar"
            primaryTitle={PRODUCT_TITLE}
            secondaryTitle={t('app.tagline', TAGLINE)}
            logo={<img src="/favicon.svg" alt="" />}
            onLogoClick={() => navigate(HOME_ITEM.to)}
            profile={activePerson ? <PersonAvatar person={activePerson} size="M" /> : undefined}
            onProfileClick={onProfileClick}
          />
        </header>

        <div className="twm-body">
          <main className="twm-main" id="twm-main">
            {children}
          </main>
        </div>

        <UpdateBanner />

        {isDesktop ? null : (
          <nav className="twm-bottomnav" aria-label="Main navigation">
            {PRIMARY_NAV.map(item => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  isActive
                    ? 'twm-bottomnav__item twm-bottomnav__item--active'
                    : 'twm-bottomnav__item'
                }
              >
                <Icon name={item.icon} className="twm-bottomnav__icon" />
                <span className="twm-bottomnav__label">{navLabel(item)}</span>
              </NavLink>
            ))}

            <button
              id={MORE_BUTTON_ID}
              type="button"
              className={
                overflowActive
                  ? 'twm-bottomnav__item twm-bottomnav__item--active'
                  : 'twm-bottomnav__item'
              }
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen(true)}
            >
              <Icon name="overflow" className="twm-bottomnav__icon" />
              <span className="twm-bottomnav__label">{t('nav.more', 'More')}</span>
            </button>
          </nav>
        )}

        {isDesktop ? null : (
          <Popover
            open={moreOpen}
            opener={MORE_BUTTON_ID}
            placement="Top"
            horizontalAlign="End"
            onClose={() => setMoreOpen(false)}
            className="twm-more"
          >
            <div className="twm-more__body" role="menu" aria-label="More destinations">
              {MORE_NAV.map(item => (
                <button
                  key={item.to}
                  type="button"
                  role="menuitem"
                  className={
                    activePath === item.to
                      ? 'twm-more__option twm-more__option--active'
                      : 'twm-more__option'
                  }
                  onClick={() => {
                    setMoreOpen(false)
                    navigate(item.to)
                  }}
                >
                  <Icon name={item.icon} />
                  <span>{navLabel(item)}</span>
                </button>
              ))}
            </div>
          </Popover>
        )}

        <Popover
          open={switcherOpen}
          opener={switcherOpener}
          placement="Bottom"
          horizontalAlign="End"
          onClose={() => setSwitcherOpen(false)}
          className="twm-switcher"
        >
          <div className="twm-switcher__body" style={{ maxHeight: '60vh', overflowY: 'auto' }}>
            <Title level="H6">Posting as</Title>
            <Text className="twm-switcher__hint">
              Pre-fills who paid. Everyone sees the same ledger either way.
            </Text>
            {roster.map(person => (
              <button
                key={person.ID}
                type="button"
                className={
                  person.ID === activeId
                    ? 'twm-switcher__option twm-switcher__option--active'
                    : 'twm-switcher__option'
                }
                aria-pressed={person.ID === activeId}
                onClick={() => {
                  setActivePerson(person.ID)
                  setSwitcherOpen(false)
                }}
              >
                <PersonAvatar person={person} size="S" selected={person.ID === activeId} />
                <span className="twm-switcher__names">
                  <span className="twm-switcher__name">{person.name}</span>
                  {person.email ? (
                    <span className="twm-switcher__short">{person.email}</span>
                  ) : null}
                </span>
              </button>
            ))}

            {/*
              The way out, where people look for it.

              It also lives in Settings (the Session card), but that is the fourth card down
              a long page — below the roster, the planner and the bank importer — and a
              sign-out nobody can find is a sign-out nobody uses. This is the profile menu
              every other app puts it in, one tap from any screen.

              Separated from the person switcher above it because the two do very different
              things: switching decides who a posting is attributed to, signing out ends the
              session. Landing on the wrong one would be a bad surprise in both directions.
            */}
            <div className="twm-switcher__footer">
              <button
                type="button"
                className="twm-switcher__signout"
                disabled={signingOut.busy}
                onClick={() => {
                  setSwitcherOpen(false)
                  signingOut.signOut()
                }}
              >
                <Icon name="log" aria-hidden="true" />
                <span>
                  {signingOut.busy
                    ? t('shell.signingout', 'Signing out…')
                    : t('shell.signout', 'Sign out')}
                </span>
              </button>
              {signingOut.problem === null ? null : (
                <span className="twm-switcher__signout-error">{signingOut.problem}</span>
              )}
            </div>
          </div>
        </Popover>
      </div>
    </ActivePersonContext.Provider>
  )
}

export default AppShell
