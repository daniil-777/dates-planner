/*
 * "A new version is ready" — the one banner this app has.
 *
 * Fixed above the bottom bar on a phone and in the bottom corner on a desktop, so it never
 * pushes the content it is floating over. Reload is the primary action and the only one
 * that changes anything; "Later" hides it for this session, and the next build brings it
 * back. It does not reload on its own: that decision is the whole reason the service
 * worker runs in `prompt` mode (vite.config.ts).
 */
import { useEffect } from 'react'
import { Icon } from '@ui5/webcomponents-react'
import '@ui5/webcomponents-icons/dist/refresh.js'
import '@ui5/webcomponents-icons/dist/decline.js'
import { useI18n } from '@/i18n'
import { updates, useAppUpdate, type UpdateStore } from './store'
import './update.css'

export interface UpdateBannerProps {
  /** Injectable for tests; the app uses the singleton. */
  store?: UpdateStore
}

/** The class `update.css` keys the extra bottom padding on while the banner is up. */
export const SHOWN_CLASS = 'twm-has-update'

export function UpdateBanner({ store = updates }: UpdateBannerProps) {
  const { t } = useI18n()
  const state = useAppUpdate(store)
  const shown = state.ready && !state.dismissed

  // The banner floats over the page; the page must be able to scroll out from under it.
  useEffect(() => {
    if (!shown) return
    document.documentElement.classList.add(SHOWN_CLASS)
    return () => document.documentElement.classList.remove(SHOWN_CLASS)
  }, [shown])

  if (!shown) return null

  return (
    <div className="twm-update" role="status" aria-live="polite">
      <Icon name="refresh" className="twm-update__icon" aria-hidden="true" />
      <span className="twm-update__text">{t('update.ready', 'A new version is ready.')}</span>
      <button
        type="button"
        className="twm-update__reload"
        disabled={state.applying}
        onClick={() => void store.apply()}
      >
        {state.applying ? t('update.reloading', 'Reloading…') : t('update.reload', 'Reload')}
      </button>
      <button
        type="button"
        className="twm-update__later"
        aria-label={t('update.later', 'Later')}
        title={t('update.later', 'Later')}
        disabled={state.applying}
        onClick={store.dismiss}
      >
        <Icon name="decline" aria-hidden="true" />
      </button>
    </div>
  )
}

export default UpdateBanner
