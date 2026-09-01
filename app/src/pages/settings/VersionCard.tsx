/**
 * Version — which build this phone is running, which one the server has, and the way from
 * one to the other.
 *
 * Two stamps, side by side: the one compiled into this bundle (`update/build.ts`) and the
 * one `/health` reads from `app/dist/build.json` on the server. When they differ in
 * production, the server has moved on and this device has not caught up — a check is asked
 * for straight away, and the moment the new worker is installed the shell's banner offers
 * Reload. The card says the same thing in more words, for the person who came to Settings
 * to find out *why* the phone still shows last week's screen.
 *
 * It does not reload on its own. See `vite.config.ts` on why the worker runs in `prompt` mode.
 */
import { useEffect, useRef } from 'react'
import { Button } from '@ui5/webcomponents-react'
import '@ui5/webcomponents-icons/dist/refresh.js'
import '@ui5/webcomponents-icons/dist/synchronize.js'
import '@ui5/webcomponents-icons/dist/product.js'
import { useHealth } from '@/api/hooks'
import type { BuildStamp } from '@/api/types'
import { useI18n } from '@/i18n'
import { formatDateTime, formatTime } from '@/theme'
import { BUILD, serverIsAhead } from '@/update/build'
import { updates, useAppUpdate, type UpdateStore } from '@/update/store'
import { SettingsCard } from './SettingsCard'

export interface VersionCardProps {
  /** Injectable for tests; the app uses the singleton. */
  store?: UpdateStore
  /** `import.meta.env.PROD` — the device/server comparison only means something in production. */
  production?: boolean
}

export function VersionCard({
  store = updates,
  production = import.meta.env.PROD,
}: VersionCardProps) {
  const { t } = useI18n()
  const health = useHealth()
  const state = useAppUpdate(store)

  const server = health.data?.build ?? null
  const behind = serverIsAhead(BUILD, server, production)

  // The server says there is a newer build and the worker has not noticed yet — ask it to
  // look now rather than at the next hourly tick. Once per mismatch: a check that finds
  // nothing (a CDN still serving the old worker, say) must not become a loop of checks.
  const asked = useRef(false)
  useEffect(() => {
    if (!behind) {
      asked.current = false
      return
    }
    if (asked.current || state.ready || !state.supported) return
    asked.current = true
    void store.check()
  }, [behind, state.ready, state.supported, store])

  const status = describeStatus(t, state, behind, health.isError)

  return (
    <SettingsCard
      icon="product"
      title={t('version.title', 'Version')}
      subtitle={t(
        'version.subtitle',
        'Which build this device is running, and whether the server has a newer one.',
      )}
    >
      <div className="twm-status-list">
        <div className="twm-status-line">
          <span className="twm-status-label">{t('version.device', 'This device')}</span>
          <span className="twm-mono">{describeBuild(BUILD)}</span>
        </div>
        <div className="twm-status-line">
          <span className="twm-status-label">{t('version.server', 'Server')}</span>
          <span className="twm-mono">
            {health.isPending
              ? t('version.reading', 'reading /health…')
              : health.isError
                ? t('version.serverOffline', 'not answering')
                : server === null
                  ? t('version.serverUnknown', 'not reported')
                  : describeBuild(server)}
          </span>
        </div>
        <div className="twm-status-line">
          <span className="twm-status-label">{t('version.status', 'Status')}</span>
          <span className="twm-mono">{status}</span>
        </div>
      </div>

      <div className="twm-actions">
        {state.ready ? (
          <Button
            design="Emphasized"
            icon="refresh"
            disabled={state.applying}
            onClick={() => void store.apply()}
          >
            {state.applying
              ? t('update.reloading', 'Reloading…')
              : t('version.reload', 'Reload now')}
          </Button>
        ) : null}
        <Button
          design="Transparent"
          icon="synchronize"
          disabled={state.checking || !state.supported}
          onClick={() => void store.check()}
        >
          {state.checking
            ? t('version.checking', 'Checking…')
            : t('version.check', 'Check for updates')}
        </Button>
      </div>

      {state.supported ? null : (
        <p className="twm-card-footnote">
          {t(
            'version.unsupported',
            'No service worker here — a plain reload always fetches the newest build.',
          )}
        </p>
      )}
    </SettingsCard>
  )
}

/** `v1.4.0 · 8cea17b · 1 Sep 2026, 12:47`, with the date left off when a build has none. */
export function describeBuild(build: BuildStamp): string {
  const parts = [`v${build.version}`, build.commit]
  if (build.builtAt !== '') parts.push(formatDateTime(build.builtAt))
  return parts.join(' · ')
}

type Translate = (key: string, fallback: string, values?: Record<string, string>) => string

function describeStatus(
  t: Translate,
  state: ReturnType<typeof useAppUpdate>,
  behind: boolean,
  serverUnreachable: boolean,
): string {
  if (state.ready) return t('version.ready', 'a new version is ready — reload to use it')
  if (state.installing) return t('version.downloading', 'downloading the new version…')
  if (state.checking) return t('version.checking', 'Checking…')
  if (behind) return t('version.behind', 'the server has a newer build than this device')
  if (serverUnreachable) return t('version.offline', 'server not answering — cannot compare')
  const upToDate = t('version.upToDate', 'up to date')
  if (state.checkedAt === null) return upToDate
  return `${upToDate} · ${t('version.checked', 'checked {time}', { time: formatTime(state.checkedAt) })}`
}

export default VersionCard
