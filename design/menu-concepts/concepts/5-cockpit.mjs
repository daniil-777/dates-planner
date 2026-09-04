/**
 * 5 — The Cockpit.
 *
 * Diagnosis: the app's whole identity is a joke it currently tells at half volume. It wears
 * Fiori clothing, says "payment run" and "clearing document" and "Verify" — and then the
 * first screen anybody sees is a soft consumer grid with rounded tiles and a friendly hint
 * under each one. The funniest and most confident version of this app opens on something that
 * looks like it was cut from an ERP launchpad at 09:00 on a Monday.
 *
 * So: a KPI header of the sort a real cockpit carries, a dense tile matrix in the Fiori idiom,
 * and a transaction code under every tile. `ZDANCE`. `ZINTIMACY`. The joke is that the code is
 * always dead serious and the thing it launches never is.
 *
 * The two things it must not do, and does not:
 *
 *  - **the codes are decoration, never the label.** Nobody navigates by ZMEMO01. They are set
 *    small, in the muted colour, under a plain-English name that is always the larger of the
 *    two. A launcher where you must learn sixteen codes is a joke told at the user's expense.
 *  - **"Between us" is not in the matrix.** A dense grid on a shared table is exactly the
 *    surface CONTRACTS.md §13.4 keeps that chapter off, and giving it a transaction code
 *    would be the one place this joke stopped being funny. It lives behind the person menu.
 */
import { icon, TILES } from '../kit.mjs'

export const id = '5-cockpit'
export const n = 5
export const name = 'The Cockpit'
export const thesis =
  'The app wears Fiori clothing and tells the joke at half volume. This is the joke at full volume: a KPI header, a dense tile matrix, and a transaction code under every tile. Codes are decoration and never the label — and “Between us” is deliberately not in the matrix.'

export const css = `
body{background:#eaecee}
.wrap{max-width:640px;margin:0 auto}

/* The shell bar. Flat, dense, and the one place the brand blue is a ground rather than an
   accent — which is exactly what Fiori does with it. */
.shell{background:#354a5f;color:#fff;padding:9px 14px;display:flex;align-items:center;gap:10px}
.shell .logo{width:22px;height:22px;border-radius:4px;background:#0070f2;display:grid;
  place-items:center;font-size:10px;font-weight:700;letter-spacing:-.03em}
.shell b{font-size:14px;font-weight:400;letter-spacing:.01em}
.shell .sp{margin-left:auto;display:flex;align-items:center;gap:9px;font-size:11.5px;opacity:.85}
.shell .av{width:24px;height:24px;border-radius:50%;background:#5b738b;display:grid;
  place-items:center;font-size:9.5px;font-weight:600;opacity:1}

/* The KPI strip: four numbers, no boxes, hairline-separated. A cockpit states its figures
   before it offers its transactions. */
.kpis{display:grid;grid-template-columns:repeat(4,1fr);background:#fff;border-bottom:1px solid #cfd6dd}
.kpi{padding:11px 8px 10px;text-align:center;border-left:1px solid #eaeef2;text-decoration:none;color:inherit}
.kpi:first-child{border-left:0}
.kpi b{display:block;font-size:16px;font-weight:600;letter-spacing:-.02em;color:#0a2340}
.kpi span{display:block;font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;
  color:var(--muted);margin-top:3px}
.kpi b.q{font-size:13px;font-weight:500}

.strip{background:#fff;border-bottom:1px solid #cfd6dd;padding:9px 14px;display:flex;
  align-items:center;gap:9px;font-size:12px;color:#0a2340;text-decoration:none}
.strip .tag{font-size:9.5px;letter-spacing:.07em;text-transform:uppercase;color:#fff;
  background:#0070f2;padding:2px 6px;border-radius:3px;font-weight:600}
.strip .r{margin-left:auto;color:var(--muted);font-size:11.5px}

.grp{padding:16px 14px 7px;font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;
  color:#5b738b;font-weight:600}
.matrix{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;padding:0 14px}

/* The Fiori tile: square-ish, a hard 4px radius, a flat white ground, and a coloured bar
   pinned to the bottom rather than the top — which is the detail that makes it read as a
   launchpad tile instead of a card. */
.t{position:relative;background:#fff;border:1px solid #d3dae1;border-radius:4px;
  padding:9px 9px 12px;min-height:88px;display:flex;flex-direction:column;
  text-decoration:none;color:inherit;overflow:hidden}
.t::after{content:'';position:absolute;left:0;right:0;bottom:0;height:3px;background:var(--a)}
.t .ic{width:17px;height:17px;color:var(--a)}
.t .n{font-size:12.5px;font-weight:600;line-height:1.2;margin-top:6px;letter-spacing:-.01em}
.t .v{font-size:17px;font-weight:600;letter-spacing:-.025em;margin-top:auto;color:#0a2340;line-height:1.1}
.t .v.q{font-size:11px;font-weight:400;color:var(--muted);letter-spacing:0;line-height:1.3}
/* The code: monospaced, tiny, muted. Decoration — the name above it is always larger. */
.t .c{font:500 9px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.06em;
  color:#93a3b3;margin-top:4px}

.foot{padding:14px;font-size:11px;color:#7b8b9b;text-align:center}
`

/** Deadpan and plausible. The joke only works if it never winks. */
const CODE = {
  scan: 'ZRECEIPT', ledger: 'FB03', wallet: 'ZWALLET', statement: 'ZSTMT01',
  tonight: 'ZEVENING', calendar: 'ZCAL', events: 'ZTRIP', memories: 'ZMEMO01',
  games: 'ZQUIZ', dance: 'ZDANCE', chat: 'ZTHREAD', mood: 'ZMOOD',
  reflect: 'ZREFLECT', settings: 'SPRO', howItWorks: 'ZDOC',
}

const tile = t => {
  const live = t.live && t.value
  return `<a class="t" href="#" style="--a:${t.accent}">
    ${icon(t.icon)}
    <span class="n">${t.label}</span>
    <span class="v${live ? '' : ' q'}">${live ? t.value : t.hint}</span>
    <span class="c">${CODE[t.id]}</span>
  </a>`
}

export const body = () => {
  const t = Object.fromEntries(TILES.map(x => [x.id, x]))
  // Deliberately no `intimacy`. See the header — a dense shared grid is the one surface that
  // chapter must not appear on, and a transaction code for it would be the joke's only
  // genuinely unkind line.
  // Every group is a multiple of three, so no row ends in an orphan cell — a dense matrix
  // with a hole in it stops reading as a matrix.
  //
  // Wallet sits under Administration rather than Accounting, which is a joke and also just
  // correct: it is a screen of cards on file, and cards on file are master data.
  const groups = [
    ['Accounting', ['scan', 'ledger', 'statement']],
    ['Household', ['tonight', 'calendar', 'events', 'memories', 'games', 'dance']],
    ['Personal', ['chat', 'mood', 'reflect']],
    ['Administration', ['wallet', 'settings', 'howItWorks']],
  ]
  return `<div class="wrap">
    <div class="shell">
      <span class="logo">2W</span><b>Two-Way Match</b>
      <span class="sp">Sept 2026<span class="av">PA</span></span>
    </div>

    <div class="kpis">
      <a class="kpi" href="#"><b>120.00</b><span>CHF month</span></a>
      <a class="kpi" href="#"><b>0</b><span>Drafts</span></a>
      <a class="kpi" href="#"><b>2</b><span>Events</span></a>
      <a class="kpi" href="#"><b class="q">Not run</b><span>Statement</span></a>
    </div>

    <a class="strip" href="#"><span class="tag">Next</span>Weekend in Vals
      <span class="r">17 Oct · in 43 days</span></a>

    ${groups.map(([g, ids]) => `<div class="grp">${g}</div>
      <div class="matrix">${ids.map(k => tile(t[k])).join('')}</div>`).join('')}

    <div class="foot">Between us · private · from the person menu</div>
  </div>`
}
