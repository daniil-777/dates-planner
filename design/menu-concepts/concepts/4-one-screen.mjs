/**
 * 4 — One Screen.
 *
 * Diagnosis, taken literally: the launcher is 1,619px tall on an 844px phone. Everything else
 * is downstream of that. A menu you scroll is a menu you hunt through, and the four section
 * headings that were added to make sixteen tiles scannable cost four more rows of the height
 * that made them unscannable.
 *
 * The rule here is strict: **nothing below the fold, on a 390×844 phone, bottom bar included.**
 * Everything else follows from paying for it.
 *
 * What it buys the space with is the observation that started all of this — twelve of the
 * sixteen tiles have no live figure, so twelve of the sixteen are paying tile rent for a
 * static word. Those become a 4-across icon strip, which is how many fit at a 44px target on
 * a 390px screen. The four with real data keep a full card, and are the only things on the
 * screen set in figure type.
 *
 * The section headings go. They were a fix for a scanning problem that a screen this size
 * does not have — the eye takes one pass, and four labels would be four more things in it.
 * The grouping survives as order and as the hairline between the halves.
 */
import { icon, TILES } from '../kit.mjs'

export const id = '4-one-screen'
export const n = 4
export const name = 'One Screen'
export const thesis =
  'One rule, strictly kept: nothing below the fold on a 390×844 phone, bottom bar included. Paid for by the observation behind all of this — twelve of the sixteen tiles have no live figure, so twelve of them stop paying tile rent for a static word.'

export const css = `
.wrap{padding:14px 14px 0;max-width:520px;margin:0 auto}
.top{display:flex;align-items:center;justify-content:space-between;margin-bottom:11px}
.top h1{font-size:19px;font-weight:600;letter-spacing:-.02em;margin:0}
.top .av{width:27px;height:27px;border-radius:50%;background:var(--brand);color:#fff;
  display:grid;place-items:center;font-size:10.5px;font-weight:600}

.now{display:flex;align-items:center;gap:10px;padding:11px 13px;border-radius:var(--twm-radius-m);
  background:#0e2537;color:#fff;text-decoration:none;margin-bottom:11px}
.now .dot{width:7px;height:7px;border-radius:50%;background:#5ac8fa;flex:0 0 auto}
.now b{font-size:13.5px;font-weight:550}
.now i{font-style:normal;font-size:11px;opacity:.7;display:block;margin-top:1px}
.now .r{margin-left:auto;font-size:12.5px;font-weight:600;white-space:nowrap}

/* The four that have something to say. Two columns, because at four across a real figure
   does not fit and the whole point of these four is that the figure fits. */
.live{display:grid;grid-template-columns:1fr 1fr;gap:9px}
.card{position:relative;display:flex;flex-direction:column;padding:12px 13px 11px;
  border-radius:var(--twm-radius-m);background:var(--surface);border:1px solid var(--line);
  text-decoration:none;color:inherit;overflow:hidden;min-height:84px}
.card::before{content:'';position:absolute;top:0;left:0;right:0;height:2.5px;background:var(--a)}
.card .h{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:10.5px;
  letter-spacing:.08em;text-transform:uppercase;font-weight:600}
.card .h .ic{width:14px;height:14px;color:var(--a)}
.card .v{font-size:21px;font-weight:600;letter-spacing:-.025em;margin-top:auto;line-height:1.1}
.card .u{font-size:11px;color:var(--muted);margin-top:1px}

.split{display:flex;align-items:center;gap:9px;margin:16px 0 11px}
.split i{flex:1;height:1px;background:var(--line)}
.split span{font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;color:#8ea0b2;font-weight:600}

/* Four across is what a 44px target allows on 390px once the gutters are paid for. These are
   links, and they are drawn as links: a glyph and a word, nothing pretending to be data. */
.strip{display:grid;grid-template-columns:repeat(4,1fr);gap:4px 2px}
.q{display:flex;flex-direction:column;align-items:center;gap:5px;padding:9px 2px 8px;
  text-decoration:none;color:inherit;border-radius:var(--twm-radius-s);min-height:64px}
.q .chip{width:38px;height:38px;border-radius:11px;display:grid;place-items:center;
  background:color-mix(in srgb,var(--a) 12%,transparent);color:var(--a)}
.q .ic{width:19px;height:19px}
.q span{font-size:10.5px;line-height:1.2;text-align:center;color:#3d5061;letter-spacing:-.005em}
`

const card = t => `<a class="card" href="#" style="--a:${t.accent}">
  <span class="h">${icon(t.icon)}${t.label}</span>
  <span class="v">${t.value}</span><span class="u">${t.unit ?? ''}</span></a>`

const quick = t => `<a class="q" href="#" style="--a:${t.accent}">
  <span class="chip">${icon(t.icon)}</span><span>${t.label}</span></a>`

export const body = () => {
  const t = Object.fromEntries(TILES.map(x => [x.id, x]))
  // Not `calendar`: the banner above already IS the next calendar entry, and a card
  // repeating "in 43 days · Weekend in Vals" underneath it is the same sentence twice.
  // Scan's draft count is live, useful, and shown nowhere else on the screen.
  const live = ['ledger', 'scan', 'events', 'memories']
  const rest = ['calendar', 'chat', 'tonight', 'mood', 'games', 'dance', 'reflect', 'intimacy',
                'wallet', 'statement', 'settings', 'howItWorks']
  return `<div class="wrap">
    <div class="top"><h1>Two-Way Match</h1><span class="av">PA</span></div>
    <a class="now" href="#"><span class="dot"></span>
      <span><b>Weekend in Vals</b><i>Event · Vals · through 18 Oct</i></span>
      <span class="r">in 43 days</span></a>
    <div class="live">${live.map(k => card(t[k])).join('')}</div>
    <div class="split"><i></i><span>Everything</span><i></i></div>
    <div class="strip">${rest.map(k => quick(t[k])).join('')}</div>
  </div>`
}
