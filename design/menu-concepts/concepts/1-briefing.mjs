/**
 * 1 — The Briefing.
 *
 * Diagnosis: the launcher answers "what is in this app", a question nobody asks twice. What
 * somebody opening it actually wants is "is there anything I need to do". Today that answer —
 * Next Up — is at the very bottom, under 1,600px of tiles.
 *
 * So: the top of the screen is a briefing, and the menu is what you scroll to when the
 * briefing did not have what you wanted. The four live figures are collapsed into one
 * sentence-shaped strip rather than four tiles, and the twelve destinations with no live
 * figure become a plain, calm index — because a tile that only ever says "Play" was never a
 * tile, it was a link wearing one.
 */
import { icon, TILES } from '../kit.mjs'

export const id = '1-briefing'
export const n = 1
export const name = 'The Briefing'
export const thesis =
  'Answer “is there anything I need to do?” before “what is in this app?”. One live briefing on top; the sixteen destinations become a quiet index underneath. The four tiles with real data keep their numbers — the twelve without stop pretending to have them.'

export const css = `
.wrap{padding:18px 16px 0;max-width:520px;margin:0 auto}
.hello{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:2px}
.hello h1{font-size:23px;font-weight:600;letter-spacing:-.02em;margin:0}
.hello span{font-size:12.5px;color:var(--muted)}

/* The one thing that is actually happening. Big, because it is the only thing on the screen
   that is time-sensitive; everything else is available whenever. */
.now{
  /* display:block, because this is an <a> — an inline box takes the padding and the gradient
     and paints neither, which is exactly how it failed the first time. */
  display:block;text-decoration:none;
  margin-top:14px;padding:18px;border-radius:var(--twm-radius-l);
  background:linear-gradient(135deg,#0a2a43,#123f5f);color:#fff;position:relative;overflow:hidden;
}
.now::after{content:'';position:absolute;right:-40px;top:-40px;width:160px;height:160px;
  border-radius:50%;background:rgba(255,255,255,.06)}
.now .k{font-size:11px;letter-spacing:.09em;text-transform:uppercase;opacity:.7}
.now .t{font-size:19px;font-weight:600;margin-top:6px;letter-spacing:-.01em}
.now .s{font-size:13px;opacity:.78;margin-top:3px}
.now .when{position:absolute;right:18px;bottom:16px;text-align:right}
.now .when b{display:block;font-size:17px;font-weight:600}
.now .when i{font-style:normal;font-size:11.5px;opacity:.7}

/* The live numbers, as a row of figures rather than a row of boxes. Four boxes would put
   them back on equal footing with everything else — the whole thing being fixed. */
.figs{display:grid;grid-template-columns:repeat(3,1fr);gap:2px;margin-top:12px;
  background:var(--line);border-radius:var(--twm-radius-m);overflow:hidden;border:1px solid var(--line)}
.fig{background:var(--surface);padding:13px 12px;text-decoration:none;color:inherit;display:block}
.fig b{display:block;font-size:17px;font-weight:600;letter-spacing:-.02em}
.fig span{display:block;font-size:11px;color:var(--muted);margin-top:2px}
.fig em{font-style:normal;display:block;font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;
  color:var(--muted);margin-bottom:5px}

/* Two verbs. Not four, not sixteen — the two things done daily. */
.acts{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px}
.act{display:flex;align-items:center;gap:10px;padding:14px;border-radius:var(--twm-radius-m);
  background:var(--surface);border:1px solid var(--line);text-decoration:none;color:inherit;
  font-weight:550;font-size:14.5px;min-height:var(--twm-touch)}
.act .ic{color:var(--a)}
.act .chip{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;
  background:color-mix(in srgb,var(--a) 13%,transparent)}

.rule{display:flex;align-items:center;gap:10px;margin:26px 0 10px}
.rule h2{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin:0;font-weight:600}
.rule i{flex:1;height:1px;background:var(--line)}

/* The index. Rows, not tiles: a row is scanned in one pass down the left edge, where a grid
   is scanned in a boustrophedon that costs a fixation per cell. Twelve of these fit in the
   space four tiles took. */
.idx{background:var(--surface);border:1px solid var(--line);border-radius:var(--twm-radius-m);overflow:hidden}
.row{display:flex;align-items:center;gap:12px;padding:11px 14px;text-decoration:none;color:inherit;
  border-top:1px solid var(--line);min-height:var(--twm-touch)}
.row:first-child{border-top:0}
.row .ic{color:var(--a)}
.row b{font-weight:550;font-size:14.5px}
.row span{margin-left:auto;font-size:12.5px;color:var(--muted);text-align:right}
.row .go{margin-left:0;color:#b6c0cb;font-size:16px;line-height:1}
`

const act = t => `<a class="act" href="#" style="--a:${t.accent}"><span class="chip">${icon(t.icon)}</span>${t.label}</a>`
const row = t => `<a class="row" href="#" style="--a:${t.accent}">${icon(t.icon)}<b>${t.label}</b>
  <span>${t.live && t.value ? t.value : t.hint}</span><span class="go">›</span></a>`

export const body = () => {
  const t = Object.fromEntries(TILES.map(x => [x.id, x]))
  const index = ['tonight','memories','games','dance','reflect','intimacy','wallet','statement','settings','howItWorks']
  return `<div class="wrap">
    <div class="hello">
      <h1>Good evening</h1><span>Posting as Partner A</span>
    </div>

    <a class="now" href="#">
      <div class="k">Next up</div>
      <div class="t">Weekend in Vals</div>
      <div class="s">Event · Vals · through 18 Oct</div>
      <div class="when"><b>43</b><i>days</i></div>
    </a>

    <div class="figs">
      <a class="fig" href="#"><em>September</em><b>CHF 120</b><span>2 postings</span></a>
      <a class="fig" href="#"><em>Events</em><b>2</b><span>current</span></a>
      <a class="fig" href="#"><em>Memories</em><b>10</b><span>entries</span></a>
    </div>

    <div class="acts">${act(t.scan)}${act(t.chat)}</div>

    <div class="rule"><h2>Everything else</h2><i></i></div>
    <div class="idx">${index.map(k => row(t[k])).join('')}</div>
  </div>`
}
