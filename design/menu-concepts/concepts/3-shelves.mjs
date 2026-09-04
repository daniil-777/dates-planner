/**
 * 3 — Shelves.
 *
 * Diagnosis: the richness is worth keeping — the live figures, the accents, the sense that
 * something is going on in there — and it is the vertical stacking that costs 1,619px, not
 * the richness itself. Four sections stacked vertically is four scroll-lengths; four sections
 * scrolled sideways is one screen.
 *
 * The known objection is real and worth writing down: horizontal shelves hide their tail, and
 * people miss what is off-screen to the right. Two things are done about it here — every
 * shelf is cut so the next card is visibly clipped at the edge rather than ending flush, which
 * is the only reliable affordance for "there is more"; and no shelf holds more than six, so
 * nothing is ever more than one flick away.
 *
 * It is the most alive of the five and the least defensible on pure usability grounds. Both
 * of those are true at once.
 */
import { icon, TILES, SECTIONS } from '../kit.mjs'

export const id = '3-shelves'
export const n = 3
export const name = 'Shelves'
export const thesis =
  'Keep the richness, lose the scroll: the four sections run sideways instead of stacking. One screen instead of two. Every shelf clips its next card at the edge, because that is the only affordance people reliably read as “there is more”.'

export const css = `
.wrap{padding:16px 0 0;max-width:640px;margin:0 auto}
.pad{padding:0 16px}
.top{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:14px}
.top h1{font-size:21px;font-weight:600;letter-spacing:-.02em;margin:0}
.top span{font-size:12px;color:var(--muted)}

.now{display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:var(--twm-radius-m);
  background:#0e2537;color:#fff;text-decoration:none;margin-bottom:20px}
.now .dot{width:8px;height:8px;border-radius:50%;background:#5ac8fa;flex:0 0 auto}
.now b{font-size:14px;font-weight:550}
.now i{font-style:normal;font-size:11.5px;opacity:.72;display:block;margin-top:1px}
.now .r{margin-left:auto;font-size:13px;font-weight:600;white-space:nowrap}

.shelf{margin-bottom:20px}
.shelf h2{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);
  margin:0 0 9px;font-weight:600;padding:0 16px}
/* The clip is the affordance: 26px of right padding against a 148px card means the next one
   is always cut, never flush. A shelf that ends exactly at the edge reads as finished. */
.track{display:flex;gap:10px;overflow-x:auto;padding:2px 26px 4px 16px;
  scroll-snap-type:x proximity;scrollbar-width:none}
.track::-webkit-scrollbar{display:none}
.tile{
  flex:0 0 148px;scroll-snap-align:start;position:relative;
  display:flex;flex-direction:column;gap:2px;min-height:126px;padding:13px;
  border-radius:var(--twm-radius-m);background:var(--surface);border:1px solid var(--line);
  text-decoration:none;color:inherit;overflow:hidden;
}
.tile::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:var(--a)}
.tile .chip{width:32px;height:32px;border-radius:9px;display:grid;place-items:center;
  background:color-mix(in srgb,var(--a) 13%,transparent);color:var(--a);margin-bottom:7px}
.tile .ic{width:18px;height:18px}
.tile b{font-size:13.5px;font-weight:600;letter-spacing:-.005em}
/* Only a live figure gets figure-sized type. A static word set at 22px is the thing this
   whole exercise is arguing against, so it is set as what it is: a caption. */
.tile .v{font-size:19px;font-weight:600;letter-spacing:-.02em;margin-top:auto;line-height:1.15}
.tile .v.s{font-size:12.5px;font-weight:400;color:var(--muted);letter-spacing:0}
.tile .u{font-size:11px;color:var(--muted)}
`

const tile = t => {
  const live = t.live && t.value
  return `<a class="tile" href="#" style="--a:${t.accent}">
    <span class="chip">${icon(t.icon)}</span>
    <b>${t.label}</b>
    <span class="v${live ? '' : ' s'}">${live ? t.value : t.hint}</span>
    ${live && t.unit ? `<span class="u">${t.unit}</span>` : ''}
  </a>`
}

export const body = () => `<div class="wrap">
  <div class="pad">
    <div class="top"><h1>Two-Way Match</h1><span>September 2026 · Partner A</span></div>
    <a class="now" href="#"><span class="dot"></span>
      <span><b>Weekend in Vals</b><i>Event · Vals · through 18 Oct</i></span>
      <span class="r">in 43 days</span></a>
  </div>
  ${SECTIONS.map(s => `<div class="shelf">
    <h2>${s.heading}</h2>
    <div class="track">${TILES.filter(t => t.s === s.id).map(tile).join('')}</div>
  </div>`).join('')}
</div>`
