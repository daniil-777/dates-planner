# GO-LIVE

The list to work through before you show her.

It is in the order you should actually do it: fix what is broken, put the real names in,
deploy, install it on both phones, and only then hand her the URL. Nothing below is
optional except the section that says it is.

Times are honest estimates for one evening.

---

## 1. Blockers — all four fixed

All four are done. They are kept here, struck through rather than deleted, because each one
has a test guarding it now and the next person to touch that area should know what the test
is for. `npm test` and `npm run typecheck` are clean.

### 1.1 ~~The Fiori font never loads in production~~ · FIXED

`@ui5/webcomponents` fetches its `72` font family at runtime from
`https://cdn.jsdelivr.net/npm/@sap-theming/theming-base-content@…/fonts/*.woff2`, and
helmet's CSP in `srv/server.ts` sets `font-src 'self' data:`. Every face is blocked — 38
console violations on one page load — and the app renders in the browser's fallback font.
It still works; it stops looking like SAP, which for this particular product is most of the
joke.

It does **not** happen in `npm run dev`, because there the SPA comes from Vite and only the
API calls pass through helmet. It happens the moment CAP serves `app/dist`, which is every
deployment. Reproduce it:

```bash
cd app && E2E_SAME_ORIGIN=1 npx playwright test smoke
```

**Fixed by option 1, bundling.** The 24 `72-*.woff2` faces (992 KB) are vendored into
`app/public/fonts`, and a `twm-bundle-ui5-fonts` plugin in `app/vite.config.ts` rewrites the
baked-in CDN URLs to `/fonts/` at build time. `font-src` stays `'self' data:`.

Bundling rather than widening the CSP buys one thing widening would not: the service worker
precaches the faces, so an installed PWA renders in the right font offline. Precache went
from 371 entries to 400, 17.0 MB to 18.1 MB.

Note the fonts are in `baseTheme/fonts/`, not `sap_horizon/fonts/` as this file used to
imply — the `72` family is theme-independent.

- [x] Fixed — the built bundle contains zero `cdn.jsdelivr.net` font URLs and 24 `/fonts/`
      references; `font-src 'self' data:` and `GET /fonts/72-Regular.woff2` → 200
      `font/woff2` both verified against a running server
- [x] `test.fixme` removed from the font test in `app/e2e/smoke.spec.ts`, and its assertion
      inverted: it now fails if anyone puts a CDN back into `font-src`

### 1.2 ~~Reloading the page on `/ledger` returns JSON~~ · FIXED

`/ledger` is both the client route (FRONTEND-CONTRACT §6) and the OData service path
(CONTRACTS.md §1.4). On a hard navigation the server wins: the Vite proxy in dev,
`API_PREFIXES` in `srv/server.ts` in production, and the workbox `navigateFallbackDenylist`
offline all hand `/ledger` to CAP. The browser gets
`{"@odata.context":"$metadata", …}`.

Daily use hides it — the PWA starts at `/`, the router redirects, and every later URL is
written by `pushState` — so it will be a reload, a bookmark or a shared link that finds it.
Probably hers.

**Fixed by the first option, moving the services under `/api`.** All five touchpoints
agree: `srv/ledger-service.cds` is `@(path: '/api/ledger')`, `srv/admin-service.cds` is
`/api/admin`, `API_PREFIXES` in `srv/server.ts` no longer claims `/ledger`, the Vite proxy
forwards `/api`, the workbox `navigateFallbackDenylist` matches `/^\/api/`, and
`app/src/api/client.ts` has `BASE = '/api/ledger'`.

- [x] Fixed
- [x] `test.fixme` removed from *a hard navigation to /ledger loads the app…*
- [x] `open()` simplified back to a plain `page.goto`

### 1.3 ~~`npm run build` writes 95 stray `.js` files into the source tree~~ · FIXED

`app/package.json` builds with `tsc -b --noEmit false`, and with no `outDir` that emits a
`.js` next to every `.ts`/`.tsx` under `app/src` and `app/e2e` — **and `vite.config.js` next
to `vite.config.ts`**. Vite resolves `.js` before `.ts`/`.tsx`, so the second build in a row
uses a stale compiled config and can load stale compiled modules. Playwright's default
`testMatch` collects `*.spec.js` too, so every e2e spec runs twice, the second copy failing
because the first already used up the payment run.

The fix is one flag in `app/package.json`:

```jsonc
"build": "tsc -b --noEmit && vite build"        // typecheck, emit nothing
```

- [x] Fixed — `app/package.json` builds with `tsc --noEmit && vite build`
- [x] `.gitignore` also grew belt-and-braces rules for `app/src/**/*.js`,
      `app/vite.config.js` and `app/tsconfig.tsbuildinfo`

### 1.4 ~~`package.json` still says `0.1.0`~~ · FIXED

`/health` reports `version` straight from `package.json`, and `CHANGELOG.md` describes a
1.0.0 that does not exist yet.

- [x] `version` bumped to `1.0.0` in the root `package.json`
- [x] Same in `app/package.json`
- [ ] `curl -u … /health` reports `"version": "1.0.0"` after the deploy — needs the deploy

---

## 2. Put the real names in · ~20 min

Everything personal is a placeholder, on purpose, so it is greppable. `grep -rn PLACEHOLDER`
and `docs/CONTRACTS.md` §10 have the full list.

- [ ] `db/data/twowaymatch-People.csv` — the real names and emails of everyone seeded.
      **The emails must match `AUTH_USER_A` / `AUTH_USER_B` exactly**, or the login succeeds
      and no person row is found
- [ ] Every `colour` chosen deliberately. They are the colours the whole app is built out
      of; the seeded defaults are SAP blue and SAP magenta, and more people can be added
      later from Settings
- [ ] `db/data/twowaymatch-Expenses.csv`, document #1 — the real date, the real place, the
      real amount. This is the row the Memories page reveals; it is the point of the whole
      thing
- [ ] The one sentence for her, in that row's `note`. The default —
      *"Document #1. Everything since has been a follow-up posting."* — is a placeholder,
      and she will know
- [ ] Read the seeded expenses. They are invented Zürich merchants; either replace them
      with real early spending or delete them so the ledger starts empty and honest
- [ ] `db/data/twowaymatch-Memories.csv` — at least the first one real

> If the app is already deployed when you do this, remember that a fresh
> `cds-deploy` only runs on the first boot. Edit the CSVs *before* the first deploy, or
> change the rows through Settings → Onboarding afterwards. On BTP, HDI re-applies the CSVs
> on every deploy and will overwrite runtime edits — `docs/DEPLOY_BTP.md` §5.

---

## 3. The machine · ~45 min

Follow `docs/DEPLOY.md`. The checkboxes here are the ones people skip.

- [ ] `npm run hash -- '<her password>'` and again for yours. Both hashes stored somewhere
      that is not this repository
- [ ] `fly volumes create twm_data --region fra --size 3` — **before** the first deploy
- [ ] All four `AUTH_*` set with `fly secrets set`, hashes in **single quotes** so the `$`
      signs survive the shell
- [ ] `fly secrets list` shows names only. If you can see a value, something is very wrong
- [ ] `ANTHROPIC_API_KEY` and any `DOCAI_*` set as **Fly secrets**, never in `fly.toml`,
      never as a build arg (a build arg lives in `docker history` forever)
- [ ] `fly deploy` succeeds
- [ ] `fly logs` shows `no database at /data/twm.sqlite — creating it` exactly once, then
      `server listening`
- [ ] `curl -u 'you@example.com:…' https://…/health` returns `"status": "ok"`
- [ ] In that response: `model` is a timestamp and not `null`; `docai` says what you expect;
      `llm` names a provider you configured
- [ ] Anonymous `curl https://…/health` returns **401**. If it returns 200, basic auth is
      not mounted and the ledger is public
- [ ] Custom domain added, `fly certs check` says issued, and the site loads over `https://`
- [ ] **The URL is final.** A PWA is installed against an origin; moving it after the phones
      are set up leaves two dead icons and two stale caches

### Restore, rehearsed · ~15 min

A backup you have never restored is a hope, not a backup.

- [ ] `fly ssh console -C "/bin/sh -c 'cd /app && tsx scripts/backup.ts --out /data/backups'"`
- [ ] `fly ssh sftp get …` pulls the archive down
- [ ] `tar tzf` lists `manifest.json`, `db.sqlite` and `images/`
- [ ] `npx tsx scripts/restore.ts <archive>` into a scratch copy — and you have looked at
      the result
- [ ] `FLY_API_TOKEN` and `BACKUP_PASSPHRASE` set as repository secrets
- [ ] `.github/workflows/backup.yml` triggered **by hand once** from the Actions tab, and
      its job summary shows the right row counts. It has never run; do not trust the
      schedule until it has
- [ ] The backup passphrase written down somewhere that is neither this repository nor this
      laptop

---

## 4. Both phones · ~20 min

The full checklist, with the iOS and Android differences spelled out, is `docs/DEPLOY.md`
§9. The short version:

- [ ] iPhone: opened in **Safari** (Chrome on iOS cannot install a web app), Share → Add to
      Home Screen, name reads **2WM**
- [ ] Launches with no address bar, and content clears the notch and the home indicator
- [ ] Android: Chrome offered **Install app**, and the launcher icon is round and properly
      cropped rather than a square pasted into a circle
- [ ] Camera permission granted on both, and a real receipt scanned on each
- [ ] A real expense posted from each phone, and both people can see both postings
- [ ] Airplane mode: the app still paints its shell and says plainly that it cannot reach
      the server
- [ ] Signing in is not required every single launch

---

## 5. Do it once, for real, with your own money · ~30 min

Do not hand her a demo. Use it for a week first.

- [ ] Scan five real receipts. Watch which categories the model gets wrong and correct them
      — every correction is written to `Corrections` and is training data
- [ ] One `date_night`, so the streak counter has something to count
- [ ] Put one posting on an event — a trip, a dinner — and check the event totals read the
      way you expect
- [ ] Run a real payment run on a real month. **Read the sentence out loud.** It says what
      the month totalled and who paid for what; if it ever reads as somebody owing somebody,
      stop and fix it before this becomes a habit anyone trusts
- [ ] Mark it settled and confirm the period shows as closed
- [ ] Generate the Statement of Us for the current year and read all of it. This is the
      thing she will actually read; if a sentence is wrong, or cold, or funny in the wrong
      way, that is what today is for
- [ ] Write one memory with a photograph and check it appears on the map
- [ ] Open Memories and look at document #1

---

## 6. The evening itself

- [ ] The URL is short enough to type, and you have it ready
- [ ] Her phone is charged, and it is the phone she actually uses
- [ ] You know how to get to Memories in two taps, because that is the screen this is all a
      long setup for
- [ ] You have decided whether you are explaining the SAP joke or letting her find it

---

## 7. Things you are choosing to live with

Not bugs. Decisions, listed so nobody has to rediscover them.

* **The nightly retrain cannot run in the container.** `srv/admin-service.ts` schedules a
  03:00 job that spawns `npm run ml:retrain`, which needs `ml/.venv` and scikit-learn —
  neither of which is in the image, and neither of which belongs in a 512 MB machine. After
  20 new confirmed rows the job fires, fails, logs a note, and changes nothing. Retraining
  is a laptop operation: `npm run ml:retrain`, commit `ml/model/weights.json`, `fly deploy`.
* **Images live in the database.** `db/schema.cds` stores receipts and photos as
  `LargeBinary`. It makes the backup a single file you can carry, and it means the volume is
  the only copy of the photographs. §3 is why.
* **One machine, no replica.** One household. A rolling deploy would need a second machine
  and a Fly volume attaches to exactly one, which is why `fly.toml` uses the `immediate`
  strategy: a few seconds of 502 for a handful of people who are not looking.
* **`/health` is behind authentication**, so Fly's check is a TCP check. The full reasoning
  is in `fly.toml`; do not "fix" it to an HTTP check on `/health` or Fly will restart a
  healthy machine every few minutes.
* **The BTP path is a demo.** Its free-tier HANA instance stops every night and has to be
  started by hand, and `srv/server.ts` mounts basic auth in front of the XSUAA-authenticated
  routes when `NODE_ENV=production`. Both are written up in `docs/DEPLOY_BTP.md` §0 and §6.
* **The e2e suite writes.** `app/e2e/journey.spec.ts` posts an expense and runs a payment
  run. `playwright.config.ts` therefore starts its own CAP with `--in-memory` and refuses to
  attach to a server on 4004 that it did not start. Do not set `E2E_REUSE_CAP=1` against
  anything real.

---

## 8. Afterwards

- [ ] Download one backup artifact to real storage. GitHub keeps them 90 days; that is a
      rolling window, not an archive
- [ ] After a month of real use: `npm run ml:retrain` on the accumulated corrections, then
      redeploy. The model gets noticeably better once it has seen your actual supermarket
- [ ] Read `docs/RUNBOOK.md` once, calmly, before you need it
