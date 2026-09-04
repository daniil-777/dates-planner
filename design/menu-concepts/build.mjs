/**
 * Renders the five launcher concepts to self-contained HTML.
 *
 * Self-contained on purpose: every output inlines its tokens, icons and data, so a file can
 * be opened from a Finder window or mailed to somebody with no server and no build step.
 */
import { readdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { TOKENS, icon } from "./kit.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))

const page = c => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${c.name} — launcher concept</title>
<style>
  :root{${TOKENS}}
  *{box-sizing:border-box}
  html,body{margin:0}
  body{
    background:var(--canvas); color:var(--ink);
    font:400 15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI","72",Inter,Arial,sans-serif;
    -webkit-font-smoothing:antialiased;
  }
  .ic{width:22px;height:22px;flex:0 0 auto}
  /* The thesis banner is scaffolding for the review, not part of the design. It is styled to
     read as an annotation so nobody mistakes it for a header the app would ship. */
  .thesis{
    padding:14px 18px;background:#101a24;color:#fff;
    font-size:12.5px;line-height:1.5;letter-spacing:.01em;
  }
  .thesis b{display:block;font-size:13.5px;letter-spacing:.04em;text-transform:uppercase;margin-bottom:4px;color:#8fd0ff}
  .screen{min-height:844px;padding:0 0 84px}
  /* The bottom bar, present in every concept because it is present in the app and it costs
     56px of the screen every one of these is arguing about. */
  .bar{
    position:fixed;left:0;right:0;bottom:0;height:56px;display:flex;
    background:rgba(255,255,255,.92);backdrop-filter:blur(12px);
    border-top:1px solid var(--line);
  }
  .bar a{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;
    gap:2px;font-size:10px;color:var(--muted);text-decoration:none}
  .bar a.on{color:var(--brand)}
  .bar .ic{width:19px;height:19px}
${c.css}
</style></head>
<body>
<div class="thesis"><b>${c.n}. ${c.name}</b>${c.thesis}</div>
<div class="screen">${c.body()}</div>
<nav class="bar">
  <a href="#">${icon('camera')}Scan</a>
  <a href="#">${icon('bills')}Expenses</a>
  <a href="#">${icon('case')}Events</a>
  <a href="#">${icon('heart')}Memories</a>
  <a href="#" class="on">${icon('dice')}More</a>
</nav>
</body></html>`

const files = readdirSync(join(HERE, 'concepts')).filter(f => f.endsWith('.mjs')).sort()
for (const f of files) {
  const c = await import(join(HERE, 'concepts', f))
  writeFileSync(join(HERE, `${c.id}.html`), page(c))
  console.log('wrote', `${c.id}.html`)
}
