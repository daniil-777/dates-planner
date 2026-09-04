# The launcher — an audit, and five ways out

Five concepts for the home screen, in `png/`. Each is a working HTML page in this folder,
built from the app's own tokens (`app/src/index.css`) and its own accents
(`app/src/pages/home/tiles.ts`), so what you see is what the app can actually render.

```
node build.mjs      # concepts/*.mjs → *.html
open index.html     # all five, side by side
```

---

## What is wrong with the one we have

Measured on a 390×844 phone, against the real database.

**It is 1,489px tall.** That is 1.76 screens for a menu. A launcher you scroll is a launcher
you hunt through rather than scan, and the four section headings that were added to make
sixteen tiles scannable cost four more rows of the height that made them unscannable.

**Twelve of the sixteen tiles have no live figure, and are typeset as though they do.**
This is the deep one. The grid's whole design idea is the live figure — the month's total,
the days until the trip, the number of drafts waiting. Four tiles have one. The other twelve
carry a static string set in the same 22px semibold: `Points`. `Three`. `Play`. `Four`.
`Write`. `Check in`. `Say something`. Typography that means "here is a number" is being spent
on words that are not numbers and never change. The format has quietly degraded into
decoration, and it takes the four real figures down with it — `CHF 120.00` is the only
number on the screen and it is impossible to pick out.

Worse, two of them are not true. Tonight says **Three** — "three evenings that worked" —
above a Places table with zero rows in it. Dance says **Four**. Neither is read from
anything.

**Nothing is ranked.** Scan and Chat are opened daily; *How it works* is read once, ever.
They are the same size, the same weight, the same distance from the thumb.

**The one time-sensitive thing on the screen is at the bottom.** Next Up — the only element
that answers "is there anything I need to do" — sits under all 1,489px.

**Sixteen accents, six of them invented.** `tiles.ts` documents each exception honestly
("the ten category colours were all spoken for"), which is six confessions that the system
stopped holding at tile eleven.

**A visible duplicate.** The Chat tile's figure and its hint are both `Say something`.

### One thing the audit found that outlives these mockups

The ten category accents in `CONTRACTS.md` §1.1 were chosen as **accents on white** — a 3px
rule, a glyph, a hover border — and several cannot carry text as a **fill** in either
direction:

| accent | | on white | on ink | verdict |
|---|---|---|---|---|
| Scan | `#E76500` | 3.36:1 | 4.18:1 | **fails both** |
| Memories | `#F31DED` | 3.38:1 | 4.15:1 | **fails both** |
| Mood | `#C87200` | 3.58:1 | 3.92:1 | **fails both** |
| Events | `#049F9A` | 3.27:1 | 4.30:1 | **fails both** |
| Tonight | `#F5A623` | 2.03:1 | 6.92:1 | ink only |

Any future design that fills a surface with an accent — a card, a sheet, a banner — walks
into a WCAG 1.4.3 failure unless it checks. `kit.mjs` carries the rule these concepts use:
prefer ink, else white, and darken the hue only when neither passes. Exactly those four need
darkening; the other twelve keep the colour the app ships — the amber and the gold are
saved by ink, which is the case a white-text-on-brand-colour habit would have missed. Worth lifting into the app
whether or not any of these launchers is ever built.

---

## The five

| | concept | thesis | height | vs today |
|---|---|---|---|---|
| 1 | **The Briefing** | Answer "anything I need to do?" before "what is in this app?" | 856px | −43% |
| 2 | **Two Speeds** | Four thumb-sized daily verbs; the other twelve as a dense index | 985px | −34% |
| 3 | **Shelves** | Keep the richness, run the sections sideways | 845px | −43% |
| 4 | **One Screen** | Nothing below the fold. Full stop. | **569px** | **−62%** |
| 5 | **The Cockpit** | Tell the SAP joke at full volume | 848px | −43% |

All five drop the fake figures. That is the one move they agree on, and it is the one that
matters most.

**1 — The Briefing.** Next Up becomes a hero at the top instead of a footnote at the bottom.
Three live figures as a hairline strip, two daily verbs, and the remaining ten as a plain
list. Rows rather than tiles below the fold: a list is read in one pass down the left edge,
where a grid costs a fixation per cell.

**2 — Two Speeds.** Ranked by use rather than by category. Four large filled targets, twelve
quiet rows. The ranking is hard-coded on purpose — personalising a launcher by tap count
moves the grid under somebody who had just learned where things were.

**3 — Shelves.** The richest-looking, and the one with a real objection against it:
horizontal shelves hide their tail. Mitigated by clipping the next card at every shelf's
edge — the only affordance people reliably read as "there is more" — and by capping a shelf
at six. Alive, and the least defensible on pure usability grounds. Both at once.

**4 — One Screen.** The literal answer, and the recommendation. Four live cards, twelve icons
in a 4-across strip, no section headings. 569px: everything visible at once with 200px to
spare, which is room for the app to grow to twenty destinations without a rethink.

**5 — The Cockpit.** The app already says "payment run" and "clearing document", then opens
on a soft consumer grid. This is the joke at full volume: KPI header, Fiori tile matrix,
a transaction code under every tile. `ZDANCE`. Two rules keep it kind — the codes are
decoration and never the label, and **"Between us" is not in the matrix**. A dense shared
grid is exactly the surface CONTRACTS.md §13.4 keeps that chapter off; it lives behind the
person menu, and giving it a transaction code would be the joke's only unkind line.

---

## Recommendation

**Ship 4, steal the header from 1, keep 5 as a theme.**

Concept 4 is the only one that actually fits, and fitting is the whole problem. Its 4-across
strip is also the only layout with room for the next four chapters this app grows.

It should take the Briefing's dark Next Up banner — 4 already has a compact version, and 1's
is better — because the strongest single finding in the audit is that the time-sensitive
element is buried.

The Cockpit deserves to exist as a **density setting**, not a rewrite: same data, same
routes, a different skin. It is the most on-brand thing in this folder and it would be a
waste to throw it away for being impractical as a default.

Independent of any of that: fix the Chat tile's duplicated string, delete `Three` from
Tonight and `Four` from Dance, and move the contrast rule from `kit.mjs` into the app.
