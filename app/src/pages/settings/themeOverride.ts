/**
 * Theme override.
 *
 * `main.tsx` follows the operating system: `sap_horizon`, or `sap_horizon_dark` when the
 * device asks for dark (FRONTEND-CONTRACT §7). That is the right default and the wrong
 * answer for the person who reads the ledger in bed with the phone on light mode, so
 * Settings can pin it. The choice lives in `localStorage` and is re-applied on mount, which
 * is what makes it survive a reload without the shell needing to know about it.
 */

import { setTheme } from '@ui5/webcomponents-base/dist/config/Theme.js'

export type ThemeChoice = 'system' | 'light' | 'dark'

export const THEME_KEY = 'twm.theme'

const LIGHT = 'sap_horizon'
const DARK = 'sap_horizon_dark'

const CHOICES: readonly ThemeChoice[] = ['system', 'light', 'dark']

/** The stored choice, defaulting to following the system. */
export function readThemeChoice(): ThemeChoice {
  try {
    const stored = window.localStorage.getItem(THEME_KEY)
    return CHOICES.includes(stored as ThemeChoice) ? (stored as ThemeChoice) : 'system'
  } catch {
    return 'system'
  }
}

export function storeThemeChoice(choice: ThemeChoice): void {
  try {
    if (choice === 'system') window.localStorage.removeItem(THEME_KEY)
    else window.localStorage.setItem(THEME_KEY, choice)
  } catch {
    /* the choice still applies to this session */
  }
}

/** True when the device is currently asking for a dark UI. */
export function systemPrefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return false
  }
}

/** Applies the choice to the running app. Safe to call as often as you like. */
export function applyThemeChoice(choice: ThemeChoice): void {
  const dark = choice === 'dark' || (choice === 'system' && systemPrefersDark())
  try {
    // Fetching theme assets can fail (offline, or a test environment with no network).
    // A theme that did not switch is a cosmetic problem, never a broken page.
    void setTheme(dark ? DARK : LIGHT).catch(() => {})
  } catch {
    /* as above */
  }
  document.documentElement.dataset.twmTheme = dark ? 'dark' : 'light'
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
}

/**
 * Keeps `system` honest: while the choice is to follow the device, a change of the device
 * setting has to move the app with it. Returns the unsubscribe.
 */
export function watchSystemTheme(choice: ThemeChoice): () => void {
  if (choice !== 'system') return () => {}
  try {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const listener = (): void => applyThemeChoice('system')
    query.addEventListener('change', listener)
    return () => query.removeEventListener('change', listener)
  } catch {
    return () => {}
  }
}
