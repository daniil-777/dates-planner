/**
 * System — what is deployed, what it looks like, and how to get the data out.
 *
 * The status lines are the honest version of an About box: which model is answering, which
 * Document AI mode is in force, which LLM wrote the last statement. `/health` supplies the
 * first half of the model line and `AdminService.modelInfo` the metrics, which need the
 * admin role — when it is not there, the line is shorter rather than wrong (`modelInfo.ts`).
 */
import { useEffect, useState } from 'react'
import { Button, MessageStrip, Text } from '@ui5/webcomponents-react'
import '@ui5/webcomponents-icons/dist/download.js'
import '@ui5/webcomponents-icons/dist/it-system.js'
import '@ui5/webcomponents-icons/dist/undo.js'
import { useHealth } from '@/api/hooks'
import { formatDate } from '@/theme'
import { SettingsCard } from './SettingsCard'
import { exportEverything } from './exportArchive'
import { describeModel, useModelInfo } from './modelInfo'
import {
  applyThemeChoice,
  readThemeChoice,
  storeThemeChoice,
  watchSystemTheme,
  type ThemeChoice,
} from './themeOverride'

const THEME_LABELS: Array<{ value: ThemeChoice; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

const DOCAI_NOTES: Record<string, string> = {
  mock: 'bundled fixtures — no BTP account needed',
  live: 'SAP Document AI on BTP',
}

const LLM_NOTES: Record<string, string> = {
  template: 'deterministic template — the statement works with no credentials at all',
  anthropic: 'Anthropic',
  'openai-compatible': 'an OpenAI-compatible endpoint',
  'sap-ai-core': 'SAP generative AI hub',
}

export interface SystemCardProps {
  onReplayOnboarding: () => void
}

export function SystemCard({ onReplayOnboarding }: SystemCardProps) {
  const health = useHealth()
  const modelInfo = useModelInfo()

  const [theme, setThemeState] = useState<ThemeChoice>(() => readThemeChoice())
  const [exporting, setExporting] = useState(false)
  const [exported, setExported] = useState<string | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)

  // Re-assert the stored choice on mount (the shell starts from the system setting), and
  // keep following the device for as long as the choice is `system`.
  useEffect(() => {
    applyThemeChoice(theme)
    return watchSystemTheme(theme)
  }, [theme])

  const chooseTheme = (choice: ThemeChoice): void => {
    setThemeState(choice)
    storeThemeChoice(choice)
    applyThemeChoice(choice)
  }

  const runExport = async (): Promise<void> => {
    setExporting(true)
    setExportError(null)
    setExported(null)
    try {
      const result = await exportEverything()
      setExported(`${result.fileName} — ${result.entries} files, ${formatBytes(result.bytes)}`)
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'the export could not be built')
    } finally {
      setExporting(false)
    }
  }

  const docai = health.data?.docai ?? 'unknown'
  const llm = health.data?.llm ?? 'unknown'

  return (
    <SettingsCard
      icon="it-system"
      title="System"
      subtitle="What is deployed behind this screen, and how to take your data with you."
    >
      <div className="twm-status-list">
        <div className="twm-status-line">
          <span className="twm-status-label">Classifier</span>
          <span className="twm-mono">
            {health.isPending
              ? 'reading /health…'
              : describeModel(health.data?.model, modelInfo.data, formatDate)}
          </span>
        </div>

        <div className="twm-status-line">
          <span className="twm-status-label">Document AI</span>
          <span className="twm-mono">
            {`${docai}${DOCAI_NOTES[docai] === undefined ? '' : ` — ${DOCAI_NOTES[docai]}`}`}
          </span>
        </div>

        <div className="twm-status-line">
          <span className="twm-status-label">Language model</span>
          <span className="twm-mono">
            {`${llm}${LLM_NOTES[llm] === undefined ? '' : ` — ${LLM_NOTES[llm]}`}`}
          </span>
        </div>

        <div className="twm-status-line">
          <span className="twm-status-label">Server</span>
          <span className="twm-mono">
            {health.isError
              ? 'not answering — the app is running on what it cached'
              : `${health.data?.status ?? 'unknown'} · v${health.data?.version ?? '0.0.0'}` +
                `${health.data?.uptime === undefined ? '' : ` · ${formatUptime(health.data.uptime)}`}`}
          </span>
        </div>
      </div>

      <div className="twm-field">
        <span className="twm-plan-figure-label">Appearance</span>
        <div className="twm-segmented" role="group" aria-label="Theme">
          {THEME_LABELS.map(option => (
            <button
              key={option.value}
              type="button"
              aria-pressed={theme === option.value}
              onClick={() => chooseTheme(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <span className="twm-card-subtitle">
          Horizon, in the shade of your choosing. “System” follows the device.
        </span>
      </div>

      <div className="twm-actions">
        <Button
          design="Transparent"
          icon="download"
          disabled={exporting}
          onClick={() => void runExport()}
        >
          {exporting ? 'Building the archive…' : 'Export everything'}
        </Button>
        <Button design="Transparent" icon="undo" onClick={onReplayOnboarding}>
          Replay the introduction
        </Button>
      </div>

      {exported === null ? null : (
        <MessageStrip design="Positive">{`Downloaded ${exported}`}</MessageStrip>
      )}
      {exportError === null ? null : (
        <MessageStrip design="Negative">{`Export failed: ${exportError}`}</MessageStrip>
      )}

      <p className="twm-card-footnote">
        The archive holds every entity as JSON, the postings and the timeline as CSV, and each
        yearly statement as Markdown. Receipt images stay on the server — they are media streams,
        and the server-side backup is the thing that carries them.
      </p>

      <Text className="twm-card-subtitle">
        One household, one ledger, no third party. Nothing on this page leaves the browser except
        the requests you can see in the network tab.
      </Text>
    </SettingsCard>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `up ${Math.round(seconds)} s`
  if (seconds < 3600) return `up ${Math.round(seconds / 60)} min`
  if (seconds < 86400) return `up ${Math.round(seconds / 3600)} h`
  return `up ${Math.round(seconds / 86400)} d`
}

export default SystemCard
