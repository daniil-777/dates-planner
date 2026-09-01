/**
 * The launcher's destinations — FRONTEND-CONTRACT §8.
 *
 * This is deliberately *not* `NAV_ITEMS` from the shell. The bottom bar is a set of six
 * equal-weight destinations that has to survive on a 360 px phone; the grid is the first
 * screen anybody sees, and it carries a live figure, a hint and an accent per tile. Keeping
 * them apart means the shell can reorder its bar without repainting the home screen.
 *
 * **The accents are not new hues.** Every one is lifted verbatim from the palette
 * CONTRACTS.md §1.1 fixes for the categories, which is the same palette the seeded people
 * are coloured from. Seven tiles, seven of the ten colours, no two alike:
 *
 * | tile | hex | where it comes from |
 * |---|---|---|
 * | Scan | `#E76500` | Dining |
 * | Ledger | `#0070F2` | Groceries — and the brand colour |
 * | Events | `#049F9A` | Travel |
 * | Calendar | `#7858FF` | Transport |
 * | Memories | `#F31DED` | Gifts |
 * | Statement | `#256F3A` | Subscriptions |
 * | Settings | `#5B738B` | Home |
 * | How it works | `#A45D00` | Cafes |
 *
 * A tile's accent is passed to CSS as `--home-accent` and used for the icon, the rule
 * across the top and the hover border — never for text, which stays on the theme's own
 * colours so contrast survives sap_horizon_dark.
 */

export type HomeTileId =
  | 'scan' | 'mood' | 'ledger' | 'events' | 'calendar' | 'memories' | 'statement' | 'settings'
  | 'howItWorks'

export interface HomeTileSpec {
  id: HomeTileId
  /** Route this tile launches. */
  to: string
  label: string
  /** A registered SAP icon — see `./icons`. */
  icon: string
  /** Hex from the palette of CONTRACTS.md §1.1. */
  accent: string
  /** What the tile is for. Shown whenever its live figure has no caption of its own. */
  hint: string
}

/**
 * Reading order: the two things done daily first, then the three that hold the year,
 * then the two that are consulted rather than used.
 */
export const HOME_TILES: readonly HomeTileSpec[] = [
  {
    id: 'scan',
    to: '/scan',
    label: 'Scan',
    icon: 'camera',
    accent: '#E76500',
    hint: 'Photograph a receipt',
  },
  {
    id: 'mood',
    to: '/mood',
    label: 'Mood',
    icon: 'da',
    accent: '#C87200',
    hint: 'How are you doing today?',
  },
  {
    id: 'ledger',
    to: '/ledger',
    label: 'Expenses',
    icon: 'money-bills',
    accent: '#0070F2',
    hint: 'Postings and payment runs',
  },
  {
    id: 'events',
    to: '/events',
    label: 'Events',
    icon: 'travel-itinerary',
    accent: '#049F9A',
    hint: 'Trips, dinners, parties',
  },
  {
    id: 'calendar',
    to: '/calendar',
    label: 'Calendar',
    icon: 'appointment-2',
    accent: '#7858FF',
    hint: 'The month, and what is on it',
  },
  {
    id: 'memories',
    to: '/memories',
    label: 'Memories',
    icon: 'heart',
    accent: '#F31DED',
    hint: 'The timeline',
  },
  {
    id: 'statement',
    to: '/statement',
    label: 'Statement',
    icon: 'newspaper',
    accent: '#256F3A',
    hint: 'The Statement of Us',
  },
  {
    id: 'settings',
    to: '/settings',
    label: 'Settings',
    icon: 'action-settings',
    accent: '#5B738B',
    hint: 'People, model, data',
  },
  {
    id: 'howItWorks',
    to: '/how-it-works',
    label: 'How it works',
    icon: 'learning-assistant',
    accent: '#A45D00',
    hint: 'The model, explained',
  },
]
