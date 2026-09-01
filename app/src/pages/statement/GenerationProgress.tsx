/**
 * The waiting room for `generateStatement`.
 *
 * The call aggregates a whole year and then spends an LLM round trip on it: roughly half a
 * minute against Anthropic, sub-second against the deterministic template provider
 * (docs/API.md §3.9). A spinner alone would be a lie by omission for the long case, so this
 * names the stage it is plausibly in, counts the seconds out loud, and says which provider
 * is doing the writing before the answer comes back.
 *
 * The stages are time-based rather than reported by the server — the action is a single
 * round trip with no progress channel — so they are worded as what the backend is doing,
 * never as a percentage anyone should trust. The bar stops at 95% for the same reason.
 */
import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { Icon, ProgressIndicator, Text, Title } from '@ui5/webcomponents-react'
import '@ui5/webcomponents-icons/dist/sys-enter-2.js'
import '@ui5/webcomponents-icons/dist/pending.js'

export interface GenerationProgressProps {
  year: number
  /** The LLM provider `/health` reported, e.g. 'template' or 'anthropic'. */
  provider?: string
}

interface Stage {
  /** Seconds after which this stage is assumed to have started. */
  at: number
  label: string
}

const STAGES: Stage[] = [
  { at: 0, label: 'Selecting confirmed postings' },
  { at: 3, label: 'Aggregating totals, trips and date nights' },
  { at: 7, label: 'Drafting the narrative' },
  { at: 20, label: 'Formatting the statement' },
]

/** The pessimistic case: a real LLM writing six sections. */
const EXPECTED_SECONDS = 32

export function GenerationProgress({ year, provider }: GenerationProgressProps): ReactElement {
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    const started = Date.now()
    const timer = window.setInterval(() => {
      setElapsed(Math.round((Date.now() - started) / 1000))
    }, 250)
    return () => window.clearInterval(timer)
  }, [])

  const percent = Math.min(95, Math.round((elapsed / EXPECTED_SECONDS) * 100))
  const currentIndex = STAGES.reduce(
    (found, stage, index) => (elapsed >= stage.at ? index : found),
    0,
  )

  return (
    <section className="twm-progress twm-noprint" aria-live="polite" aria-busy="true">
      <Title level="H4">Generating the statement for FY{year}</Title>
      <ProgressIndicator
        value={percent}
        valueState="Information"
        displayValue={`${elapsed}s`}
        accessibleName="Statement generation progress"
      />
      <div>
        {STAGES.map((stage, index) => {
          const done = index < currentIndex
          const active = index === currentIndex
          return (
            <div className="twm-progress-stage" data-done={done} key={stage.label}>
              <Icon name={done ? 'sys-enter-2' : 'pending'} />
              <span style={{ fontWeight: active ? 700 : 400 }}>{stage.label}</span>
            </div>
          )
        })}
      </div>
      <Text className="twm-progress-elapsed">
        {provider === undefined || provider === ''
          ? 'One aggregation pass and one write-up. This is the slowest call in the app.'
          : `Provider: ${provider}. One aggregation pass and one write-up — the slowest call in the app.`}
      </Text>
    </section>
  )
}

export default GenerationProgress
