/**
 * The shared kit: tokens, data and icons, imported by every concept.
 *
 * Split from the renderer because the concepts import it and the renderer imports the
 * concepts — one file would be a cycle, and a cycle with a top-level await in it does not
 * error, it hangs.
 */

/** From app/src/index.css. */
export const TOKENS = `
  --twm-space-xs:.25rem; --twm-space-s:.5rem; --twm-space-m:.75rem;
  --twm-space-l:1rem; --twm-space-xl:1.5rem; --twm-space-xxl:2rem;
  --twm-radius-s:.5rem; --twm-radius-m:.75rem; --twm-radius-l:1rem; --twm-radius-pill:999px;
  --twm-touch:44px;
  --ink:#1d2d3e; --muted:#556b82; --line:#dfe4ea;
  --surface:#fff; --canvas:#f5f6f7; --brand:#0070f2;
`

/**
 * The sixteen destinations, with the accents the app actually uses.
 *
 * `live` marks the four tiles whose figure comes from a query. The other twelve carry a
 * static string that today is typeset to look exactly like a number — which is the single
 * biggest thing these concepts are arguing about, so the data has to record the difference.
 */
export const TILES = [
  { id:'scan',      s:'money',    label:'Scan',         icon:'camera',   accent:'#E76500', live:true,  value:'None',         unit:'drafts waiting',   hint:'Photograph a receipt' },
  { id:'ledger',    s:'money',    label:'Expenses',     icon:'bills',    accent:'#0070F2', live:true,  value:'CHF 120.00',   unit:'September',hint:'Postings and payment runs' },
  { id:'wallet',    s:'money',    label:'Wallet',       icon:'wallet',   accent:'#3D4C8A', live:false, value:'Points',       unit:null,       hint:'Points, and cards on file' },
  { id:'statement', s:'money',    label:'Statement',    icon:'paper',    accent:'#256F3A', live:true,  value:'Not yet',      unit:'none generated', hint:'The Statement of Us' },
  { id:'tonight',   s:'together', label:'Tonight',      icon:'bulb',     accent:'#F5A623', live:false, value:'Three',        unit:null,       hint:'Three evenings that worked' },
  { id:'calendar',  s:'together', label:'Calendar',     icon:'calendar', accent:'#7858FF', live:true,  value:'in 43 days',   unit:'Weekend in Vals', hint:'The month, and what is on it' },
  { id:'events',    s:'together', label:'Events',       icon:'case',     accent:'#049F9A', live:true,  value:'2',            unit:'current or upcoming', hint:'Trips, dinners, parties' },
  { id:'memories',  s:'together', label:'Memories',     icon:'heart',    accent:'#F31DED', live:true,  value:'10',           unit:'entries',  hint:'The timeline' },
  { id:'games',     s:'us',       label:'Games',        icon:'dice',     accent:'#C9A227', live:false, value:'Play',         unit:null,       hint:'Play something at the table' },
  { id:'dance',     s:'us',       label:'Dance',        icon:'note',     accent:'#6C2F6B', live:false, value:'Four',         unit:null,       hint:'Learn a step, badly, together' },
  { id:'chat',      s:'us',       label:'Chat',         icon:'chat',     accent:'#D20A0A', live:false, value:'Say something',unit:null,       hint:'Say something' },
  { id:'mood',      s:'us',       label:'Mood',         icon:'face',     accent:'#C87200', live:false, value:'Check in',     unit:null,       hint:'How are you doing today?' },
  { id:'reflect',   s:'us',       label:'On your mind', icon:'pencil',   accent:'#1F6F6A', live:false, value:'Write',        unit:null,       hint:'Write it down, privately' },
  { id:'intimacy',  s:'us',       label:'Between us',   icon:'lock',     accent:'#B02A6F', live:false, value:null,           unit:null,       hint:'Where you like being touched' },
  { id:'settings',  s:'app',      label:'Settings',     icon:'gear',     accent:'#5B738B', live:true,  value:'5',            unit:'people',   hint:'People, model, data' },
  { id:'howItWorks',s:'app',      label:'How it works', icon:'book',     accent:'#A45D00', live:true,  value:'10 sections',  unit:'and a PDF',hint:'The model, explained' },
]

export const SECTIONS = [
  { id:'money',    heading:'The money' },
  { id:'together', heading:'Time together' },
  { id:'us',       heading:'Each other' },
  { id:'app',      heading:'The app' },
]

export const by = id => TILES.find(t => t.id === id)
export const inSection = s => TILES.filter(t => t.s === s)

/** 24×24 line icons, stroke-width 1.6, drawn to sit on the same optical weight. */
const P = {
  camera: '<path d="M4 8.5h2.8L8.2 6h7.6l1.4 2.5H20a1.5 1.5 0 0 1 1.5 1.5v7.5A1.5 1.5 0 0 1 20 19H4a1.5 1.5 0 0 1-1.5-1.5V10A1.5 1.5 0 0 1 4 8.5Z"/><circle cx="12" cy="13.5" r="3.4"/>',
  bills:  '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6 9.5v5M18 9.5v5"/>',
  wallet: '<rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M3 10.5h18"/><circle cx="16.8" cy="14.8" r="1.2" fill="currentColor" stroke="none"/>',
  paper:  '<path d="M4 4h12v16H4z"/><path d="M16 9h4v9a2 2 0 0 1-4 0"/><path d="M7 8h6M7 11.5h6M7 15h4"/>',
  bulb:   '<path d="M12 3a6 6 0 0 1 3.6 10.8V16h-7.2v-2.2A6 6 0 0 1 12 3Z"/><path d="M9.5 19h5M10.5 21.5h3"/>',
  calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  case:   '<rect x="2.5" y="7.5" width="19" height="12" rx="2"/><path d="M9 7.5V6a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 6v1.5M2.5 12.5h19"/>',
  heart:  '<path d="M12 20.3C6.2 16.4 3.6 13.2 3.6 10.1A4.3 4.3 0 0 1 12 8.2a4.3 4.3 0 0 1 8.4 1.9c0 3.1-2.6 6.3-8.4 10.2Z"/>',
  dice:   '<rect x="3.5" y="3.5" width="17" height="17" rx="3.5"/><circle cx="8.5" cy="8.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="15.5" cy="15.5" r="1.2" fill="currentColor" stroke="none"/>',
  note:   '<circle cx="7.5" cy="17.5" r="2.8"/><circle cx="17.5" cy="15.5" r="2.8"/><path d="M10.3 17.5V7.2l10-2v10.3"/>',
  chat:   '<path d="M4.5 5.5h15A1.5 1.5 0 0 1 21 7v8.5a1.5 1.5 0 0 1-1.5 1.5H11l-5 4v-4H4.5A1.5 1.5 0 0 1 3 15.5V7a1.5 1.5 0 0 1 1.5-1.5Z"/>',
  face:   '<circle cx="12" cy="12" r="8.7"/><circle cx="9.2" cy="10.2" r="1" fill="currentColor" stroke="none"/><circle cx="14.8" cy="10.2" r="1" fill="currentColor" stroke="none"/><path d="M8.4 14.4a4.5 4.5 0 0 0 7.2 0"/>',
  pencil: '<path d="M4 20.2 5.1 16 16.4 4.7a2.1 2.1 0 0 1 3 3L8.1 19 4 20.2Z"/><path d="M14.6 6.5l3 3"/>',
  lock:   '<rect x="4.8" y="10.5" width="14.4" height="9.5" rx="2.2"/><path d="M8.4 10.5V8a3.6 3.6 0 0 1 7.2 0v2.5"/>',
  gear:   '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.6v3M12 18.4v3M21.4 12h-3M5.6 12h-3M18.6 5.4l-2.1 2.1M7.5 16.5l-2.1 2.1M18.6 18.6l-2.1-2.1M7.5 7.5 5.4 5.4"/>',
  book:   '<path d="M4.5 4.5A1.5 1.5 0 0 1 6 3h13.5v18H6a1.5 1.5 0 0 1-1.5-1.5Z"/><path d="M4.5 17.5h15M8.5 7.5h7M8.5 11h5"/>',
}
export const icon = (name, cls = '') =>
  `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] ?? ''}</svg>`


/**
 * Text on a filled accent, chosen rather than assumed.
 *
 * The ten category accents in CONTRACTS.md §1.1 were picked to be **accents on white** — a
 * 3px rule, a glyph, a hover border. Several of them cannot carry body text as a *fill* in
 * either direction: Scan's `#E76500` measures 3.36:1 against white and 4.18:1 against the
 * app's ink, so a card filled with it fails WCAG 1.4.3 whichever colour the label is. So does
 * Memories' magenta, at 3.38 and 4.15.
 *
 * That is not a reason to abandon the palette — it is a reason to stop guessing. The rule
 * here, in order:
 *
 *  1. if the app's own ink clears 4.5:1 on the accent, use ink and leave the hue alone —
 *     this is what saves the amber, which is 6.92:1 on ink and a hopeless 2.03:1 on white;
 *  2. else if white clears it, use white;
 *  3. else mix the accent toward the app's darkest ground until white clears 4.6:1.
 *
 * Only step 3 alters a hue, and only two of the sixteen need it. Everything else keeps
 * exactly the colour the app already ships.
 */
const INK = '#1D2D3E'
const GROUND = '#0E1B28'

const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
const luminance = h => {
  const [r, g, b] = rgb(h).map(x => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
export const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
const mix = (a, b, p) =>
  '#' +
  rgb(a)
    .map((x, i) => Math.round((x * (1 - p) + rgb(b)[i] * p) * 255))
    .map(v => v.toString(16).padStart(2, '0').toUpperCase())
    .join('')

/** → `{ fill, on }`: a background and a text colour that clear 4.5:1 together. */
export const readable = accent => {
  if (contrast(accent, INK) >= 4.5) return { fill: accent, on: INK }
  if (contrast(accent, '#FFFFFF') >= 4.5) return { fill: accent, on: '#FFFFFF' }
  for (let p = 0.01; p <= 1; p += 0.01) {
    const f = mix(accent, GROUND, p)
    if (contrast(f, '#FFFFFF') >= 4.6) return { fill: f, on: '#FFFFFF' }
  }
  return { fill: GROUND, on: '#FFFFFF' }
}

for (const t of TILES) Object.assign(t, readable(t.accent))
