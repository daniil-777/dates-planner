/*
 * Entry point.
 *
 * Import order matters here. `@ui5/webcomponents-react/dist/Assets.js` registers the theme,
 * i18n and CLDR loaders for every UI5 package, which is what makes `setTheme('sap_horizon_dark')`
 * able to fetch anything at all; `AllIcons.js` registers a lazy loader for the whole
 * SAP-icons collection, which the app needs because category icons are seed data
 * (`Categories.icon`) and cannot be enumerated at build time.
 *
 * The full Assets bundle is deliberate rather than lazy. Registering only the theme loaders
 * halves the precache, but it leaves CLDR unregistered — and UI5's fallback for that is a
 * runtime `fetch` of `en.json` from the jsdelivr CDN
 * (`@ui5/webcomponents-base/dist/asset-registries/LocaleData.js`). An installable PWA that
 * cannot format a date offline, and that phones a third party to try, is not a trade worth
 * making for bundle size.
 */
import '@ui5/webcomponents-react/dist/Assets.js'
import '@ui5/webcomponents-icons/dist/AllIcons.js'
import './index.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ThemeProvider } from '@ui5/webcomponents-react'
import { setTheme } from '@ui5/webcomponents-base/dist/config/Theme.js'
import { registerSW } from 'virtual:pwa-register'
import { I18nProvider } from './i18n'
import { App } from './App'

/* ------------------------------------------------------------------ *
 *  Theme — FRONTEND-CONTRACT §7
 * ------------------------------------------------------------------ */

const LIGHT_THEME = 'sap_horizon'
const DARK_THEME = 'sap_horizon_dark'

/** Matches the `theme_color` in the PWA manifest for light, the shell header for dark. */
const STATUS_BAR_COLOR = { light: '#0070F2', dark: '#1c2228' }

/**
 * Settings can pin the theme (`src/pages/settings/themeOverride.ts` writes this key, and
 * removes it for "follow the system"). Reading it here is what makes the choice survive a
 * cold start on a page that is not Settings, and stops a sunset system flip from undoing it.
 */
const THEME_CHOICE_KEY = 'twm.theme'

function pinnedTheme(): 'light' | 'dark' | null {
  try {
    const stored = window.localStorage.getItem(THEME_CHOICE_KEY)
    return stored === 'light' || stored === 'dark' ? stored : null
  } catch {
    return null
  }
}

function applyTheme(dark: boolean): void {
  void setTheme(dark ? DARK_THEME : LIGHT_THEME)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  document.documentElement.dataset.twmTheme = dark ? 'dark' : 'light'
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', dark ? STATUS_BAR_COLOR.dark : STATUS_BAR_COLOR.light)
}

function resolveDark(systemPrefersDark: boolean): boolean {
  const pinned = pinnedTheme()
  return pinned === null ? systemPrefersDark : pinned === 'dark'
}

function watchColourScheme(): void {
  if (typeof window.matchMedia !== 'function') {
    applyTheme(resolveDark(false))
    return
  }
  const dark = window.matchMedia('(prefers-color-scheme: dark)')
  applyTheme(resolveDark(dark.matches))
  // The app is open for a whole evening; the system flips to dark at sunset and so does it,
  // unless someone has pinned a theme in Settings.
  dark.addEventListener('change', event => applyTheme(resolveDark(event.matches)))
}

watchColourScheme()

/* ------------------------------------------------------------------ *
 *  Data layer
 * ------------------------------------------------------------------ */

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A household, a handful of writes a day: half a minute of staleness is generous.
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
    mutations: {
      // Posting a document twice is worse than telling someone it failed.
      retry: 0,
    },
  },
})

/* ------------------------------------------------------------------ *
 *  Service worker
 * ------------------------------------------------------------------ */

const updateServiceWorker = registerSW({
  immediate: true,
  onNeedRefresh() {
    // `registerType: 'autoUpdate'` in vite.config.ts — take the new build straight away
    // rather than asking anybody to think about cache invalidation.
    void updateServiceWorker(true)
  },
  onOfflineReady() {
    console.info('[twm] the ledger is available offline')
  },
  onRegisterError(error: unknown) {
    console.warn('[twm] the service worker could not be registered', error)
  },
})

/* ------------------------------------------------------------------ *
 *  Mount
 * ------------------------------------------------------------------ */

const container = document.getElementById('root')
if (!container) throw new Error('index.html has no #root element to mount into')

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <BrowserRouter>
          <I18nProvider>
            <App />
          </I18nProvider>
        </BrowserRouter>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
)
