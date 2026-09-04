/**
 * 2 — Two Speeds.
 *
 * Diagnosis: sixteen destinations are given identical billing, but they are not used
 * anything like identically. Scan and Chat are opened daily; "How it works" is read once,
 * ever. A launcher that cannot tell those apart makes you re-read the whole grid every time.
 *
 * So the screen has two speeds. Four large targets for the four things done without thinking
 * — thumb-sized, bottom-weighted, reachable one-handed — and everything else as a dense,
 * legible index that is there when you want it and silent when you do not.
 *
 * The ranking is stated rather than learned. Personalising a launcher by tap count sounds
 * better than it is: the grid moves under somebody who had just learned where things were,
 * and the tile you used most last month is rarely the one you want now.
 */
import { icon, TILES, SECTIONS } from '../kit.mjs'

export const id = '2-two-speeds'
export const n = 2
export const name = 'Two Speeds'
export const thesis =
  'Sixteen destinations, four of them used daily and one of them read once ever — so stop giving them the same billing. Four thumb-sized targets for the daily verbs, a dense index for the rest. Ranked by use, not by category.'

export const css = `
.wrap{padding:16px 16px 0;max-width:520px;margin:0 auto}
.top{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
.top h1{font-size:21px;font-weight:600;letter-spacing:-.02em;margin:0}
.top .who{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--muted)}
.top .av{width:26px;height:26px;border-radius:50%;background:var(--brand);color:#fff;
  display:grid;place-items:center;font-size:10.5px;font-weight:600;letter-spacing:.02em}

/* The four verbs. Square-ish and large because these are hit with a thumb, in a hurry,
   often one-handed — and because size is the only ranking signal that survives being
   glanced at. */
.fast{display:grid;grid-template-columns:1fr 1fr;gap:11px}
.big{
  position:relative;display:flex;flex-direction:column;justify-content:space-between;
  min-height:112px;padding:14px;border-radius:var(--twm-radius-l);text-decoration:none;
  color:var(--on);background:var(--a);overflow:hidden;isolation:isolate;
}
/* One soft highlight, so a flat fill reads as a surface rather than a swatch. Tinted from
   the text colour, so the amber tile — the one card here that carries ink rather than white
   — is lit rather than washed out. */
.big::after{content:'';position:absolute;inset:0;z-index:-1;
  background:radial-gradient(120% 90% at 15% 0%,color-mix(in srgb,var(--on) 20%,transparent),transparent 62%)}
.big .ic{width:26px;height:26px;opacity:.95}
.big b{font-size:16.5px;font-weight:600;letter-spacing:-.01em}
.big i{font-style:normal;display:block;font-size:11.5px;opacity:.76;margin-top:2px;font-weight:400}

.rule{display:flex;align-items:baseline;gap:10px;margin:22px 0 8px}
.rule h2{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin:0;font-weight:600}
.rule i{flex:1;height:1px;background:var(--line);transform:translateY(-3px)}
.rule em{font-style:normal;font-size:11px;color:var(--muted)}

.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--twm-radius-m);overflow:hidden}
.grp{padding:9px 14px 3px;font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;
  color:var(--muted);font-weight:600;background:#fafbfc;border-top:1px solid var(--line)}
.grp:first-child{border-top:0}
.row{display:flex;align-items:center;gap:11px;padding:10px 14px;text-decoration:none;color:inherit;
  min-height:var(--twm-touch)}
.row+.row{border-top:1px solid #eef1f4}
.row .ic{width:19px;height:19px;color:var(--a)}
.row b{font-weight:500;font-size:14.5px}
.row .v{margin-left:auto;font-size:13px;font-weight:550;color:var(--ink)}
.row .v.q{font-weight:400;color:var(--muted);font-size:12.5px}
.row .go{color:#c2ccd6;font-size:15px;line-height:1;margin-left:9px}
`

const big = t => `<a class="big" href="#" style="--a:${t.fill};--on:${t.on}">${icon(t.icon)}
  <span><b>${t.label}</b><i>${t.hint}</i></span></a>`

const row = t => `<a class="row" href="#" style="--a:${t.accent}">${icon(t.icon)}<b>${t.label}</b>
  <span class="v${t.live && t.value ? '' : ' q'}">${t.live && t.value ? t.value : ''}</span>
  <span class="go">›</span></a>`

export const body = () => {
  const t = Object.fromEntries(TILES.map(x => [x.id, x]))
  const fast = ['scan', 'chat', 'ledger', 'tonight']
  const rest = SECTIONS.map(s => ({
    heading: s.heading,
    items: TILES.filter(x => x.s === s.id && !fast.includes(x.id)),
  })).filter(g => g.items.length)

  return `<div class="wrap">
    <div class="top">
      <h1>Two-Way Match</h1>
      <span class="who"><span class="av">PA</span>September 2026</span>
    </div>

    <div class="fast">${fast.map(k => big(t[k])).join('')}</div>

    <div class="rule"><h2>Everything else</h2><i></i><em>12</em></div>
    <div class="card">
      ${rest.map(g => `<div class="grp">${g.heading}</div>${g.items.map(row).join('')}`).join('')}
    </div>
  </div>`
}
