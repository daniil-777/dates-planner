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
 * | Chat | `#D20A0A` | Health |
 * | How it works | `#A45D00` | Cafes |
 *
 * | Between us | `#B02A6F` | **not from that palette** — see below |
 *
 * `Between us` is the one exception, and it is a deliberate one: the ten category colours
 * were all spoken for by the time it arrived, and this tile is not a spending category
 * with a colour waiting for it. The rose is picked to sit beside Gifts' magenta without
 * reading as it. If an eleventh category is ever added, it does not get this hue.
 *
 * A tile's accent is passed to CSS as `--home-accent` and used for the icon, the rule
 * across the top and the hover border — never for text, which stays on the theme's own
 * colours so contrast survives sap_horizon_dark.
 */

export type HomeTileId =
  | 'scan'
  | 'mood'
  | 'intimacy'
  | 'tonight'
  | 'games'
  | 'ledger'
  | 'events'
  | 'calendar'
  | 'memories'
  | 'statement'
  | 'settings'
  | 'chat'
  | 'howItWorks'

/**
 * The four things this app is for.
 *
 * Twelve tiles is past the point where a flat grid is read: people stop scanning it and
 * start hunting through it. Chunking fixes that — but only when the grouping matches a model
 * the reader already has, otherwise it is twelve tiles plus four labels to learn.
 *
 * So the groups are not invented here. They are the app's own account of itself, the same
 * four `docs/PRODUCT.md` uses to describe what it does: the money, the time spent together,
 * each other, and the machinery. Anybody who has used the app for a week already has this
 * model, whether or not they could name it.
 */
export const HOME_SECTIONS = [
  { id: 'money', heading: 'The money' },
  { id: 'together', heading: 'Time together' },
  { id: 'us', heading: 'Each other' },
  { id: 'app', heading: 'The app' },
] as const

export type HomeSectionId = (typeof HOME_SECTIONS)[number]['id']

export interface HomeTileSpec {
  id: HomeTileId
  /** Which of the four it belongs under. */
  section: HomeSectionId
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
    section: 'money',
    to: '/scan',
    label: 'Scan',
    icon: 'camera',
    accent: '#E76500',
    hint: 'Photograph a receipt',
  },
  {
    id: 'ledger',
    section: 'money',
    to: '/ledger',
    label: 'Expenses',
    icon: 'money-bills',
    accent: '#0070F2',
    hint: 'Postings and payment runs',
  },
  {
    id: 'statement',
    section: 'money',
    to: '/statement',
    label: 'Statement',
    icon: 'newspaper',
    accent: '#256F3A',
    hint: 'The Statement of Us',
  },
  {
    /*
     * One tile for the whole commons, not three.
     *
     * Places and Ideas are ways of answering the question this tile asks rather than separate
     * questions, and they are one tap away inside it. Three tiles would also have taken the
     * launcher to fourteen, which is a wall rather than a menu: a grid meant to be read at a
     * glance stops being read past about a dozen and starts being hunted through.
     *
     * The accent is the second documented exception to the ten category colours, after
     * "Between us" — they were all spoken for. Amber ties the tile to the stars the commons
     * is built on.
     */
    id: 'tonight',
    section: 'together',
    to: '/tonight',
    label: 'Tonight',
    icon: 'lightbulb',
    accent: '#F5A623',
    hint: 'Three evenings that worked',
  },
  {
    id: 'calendar',
    section: 'together',
    to: '/calendar',
    label: 'Calendar',
    icon: 'appointment-2',
    accent: '#7858FF',
    hint: 'The month, and what is on it',
  },
  {
    id: 'events',
    section: 'together',
    to: '/events',
    label: 'Events',
    icon: 'travel-itinerary',
    accent: '#049F9A',
    hint: 'Trips, dinners, parties',
  },
  {
    id: 'memories',
    section: 'together',
    to: '/memories',
    label: 'Memories',
    icon: 'heart',
    accent: '#F31DED',
    hint: 'The timeline',
  },
  {
    /*
     * The third documented exception to the ten category colours, after "Between us" and
     * "Tonight". Gold, because the game it holds is a performance and gold is the colour it
     * is performed in — the only place in this app that reaches outside the Fiori palette on
     * purpose rather than for want of a free hue.
     */
    id: 'games',
    section: 'us',
    to: '/games',
    label: 'Games',
    icon: 'sys-help',
    accent: '#C9A227',
    hint: 'Play something at the table',
  },
  {
    id: 'chat',
    section: 'us',
    to: '/chat',
    label: 'Chat',
    icon: 'discussion',
    accent: '#D20A0A',
    hint: 'Say something',
  },
  {
    id: 'mood',
    section: 'us',
    to: '/mood',
    label: 'Mood',
    icon: 'da',
    accent: '#C87200',
    hint: 'How are you doing today?',
  },
  {
    id: 'intimacy',
    section: 'us',
    to: '/intimacy',
    label: 'Between us',
    icon: 'private',
    accent: '#B02A6F',
    hint: 'Where you like being touched',
  },
  {
    id: 'settings',
    section: 'app',
    to: '/settings',
    label: 'Settings',
    icon: 'action-settings',
    accent: '#5B738B',
    hint: 'People, model, data',
  },
  {
    id: 'howItWorks',
    section: 'app',
    to: '/how-it-works',
    label: 'How it works',
    icon: 'learning-assistant',
    accent: '#A45D00',
    hint: 'The model, explained',
  },
]
