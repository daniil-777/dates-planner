/**
 * Statement of Us — the yearly report.
 *
 * `generateStatement` (docs/API.md §3.9) aggregates a calendar year of postings and hands
 * the facts to whichever LLM provider is configured; the row it stores is Markdown. This
 * page is the reader for that document: an object-page header with the year and the two
 * actions, an anchor bar built from the statement's own `##` headings, and the report
 * itself on a sheet that prints as clean A4 (`statement.css`).
 *
 * The Markdown is parsed by `statement/markdown.ts` into a typed tree and rendered as React
 * elements by `statement/MarkdownView.tsx`. Model output never becomes HTML on the way in.
 */
import { useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { Button, MessageStrip, Option, Select, Text, Title } from '@ui5/webcomponents-react'
import '@ui5/webcomponents-icons/dist/print.js'
import '@ui5/webcomponents-icons/dist/refresh.js'
import '@ui5/webcomponents-icons/dist/document-text.js'
import { useGenerateStatement, useHealth, usePeople, useStatements } from '@/api/hooks'
import type { Person, Statement } from '@/api/types'
import { formatDateTime } from '@/theme'
import { EmptyState } from '@/components/EmptyState'
import { ErrorState } from '@/components/ErrorState'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { GenerationProgress } from './statement/GenerationProgress'
import { MarkdownView } from './statement/MarkdownView'
import { outline, parseMarkdown, slug } from './statement/markdown'
import './statement/statement.css'

/** How far back the year selector offers to look, in addition to any year already stored. */
const YEARS_OFFERED = 5

/** How the `Statement.engine` value reads to a human. */
const ENGINE_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  'openai-compatible': 'OpenAI-compatible endpoint',
  'sap-ai-core': 'SAP generative AI hub',
  template: 'deterministic template',
}

export function StatementPage(): ReactElement {
  const statements = useStatements()
  const people = usePeople()
  const health = useHealth()
  const generate = useGenerateStatement()

  const [chosenYear, setChosenYear] = useState<number | null>(null)

  // While this page is mounted the print stylesheet applies; every other screen prints
  // the way the browser would print it anyway.
  useEffect(() => {
    document.body.classList.add('twm-printing-statement')
    return () => document.body.classList.remove('twm-printing-statement')
  }, [])

  const rows = useMemo(() => statements.data ?? [], [statements.data])
  const years = useMemo(() => offeredYears(rows), [rows])
  const year = chosenYear ?? years[0] ?? new Date().getFullYear()
  const statement = rows.find(row => row.year === year) ?? null

  const household = householdName(people.data)
  const busy = generate.isPending
  const generatingYear = busy ? year : null

  const onGenerate = (): void => {
    generate.reset()
    generate.mutate(year)
  }

  return (
    <div className="twm-statement">
      <header className="twm-statement-header twm-noprint">
        <div className="twm-statement-titleblock">
          <Title level="H3">Statement of Us</Title>
          <span className="twm-statement-subtitle">
            FY{year} · joint venture “{household}”
          </span>
        </div>

        <div className="twm-statement-actions">
          <Select
            accessibleName="Financial year"
            value={String(year)}
            onChange={event => {
              const value = event.detail.selectedOption.value ?? ''
              const parsed = Number.parseInt(value, 10)
              if (!Number.isNaN(parsed)) setChosenYear(parsed)
            }}
          >
            {years.map(candidate => (
              <Option key={candidate} value={String(candidate)}>
                {`FY${candidate}`}
              </Option>
            ))}
          </Select>

          <Button
            design="Emphasized"
            icon={statement ? 'refresh' : 'document-text'}
            disabled={busy}
            onClick={onGenerate}
          >
            {busy ? 'Generating…' : statement ? 'Regenerate' : 'Generate'}
          </Button>

          <Button
            design="Transparent"
            icon="print"
            disabled={statement === null}
            onClick={() => window.print()}
          >
            Print
          </Button>

          <span className="twm-statement-spacer" />
        </div>

        {generate.isError ? (
          <MessageStrip design="Negative" onClose={() => generate.reset()}>
            {`FY${year} could not be generated: ${messageOf(generate.error)}`}
          </MessageStrip>
        ) : null}
      </header>

      <main className="twm-statement-body">
        {busy && generatingYear !== null ? (
          <GenerationProgress year={generatingYear} provider={health.data?.llm} />
        ) : null}

        {statements.isPending ? (
          <div className="twm-sheet">
            <LoadingSkeleton rows={8} />
          </div>
        ) : statements.isError ? (
          <ErrorState error={statements.error} onRetry={() => void statements.refetch()} />
        ) : statement ? (
          <StatementSheet statement={statement} household={household} />
        ) : busy ? null : (
          <EmptyState
            icon="document-text"
            title={`No statement for FY${year} yet`}
            description={
              'Generating one reads every confirmed posting of the year, works out the trips, ' +
              'the date nights and the quarters, and writes it up. It takes up to half a minute.'
            }
            action={
              <Button design="Emphasized" icon="document-text" onClick={onGenerate}>
                Generate FY{year}
              </Button>
            }
          />
        )}
      </main>
    </div>
  )
}

interface SheetProps {
  statement: Statement
  household: string
}

function StatementSheet({ statement, household }: SheetProps): ReactElement {
  const sections = useMemo(
    () => outline(parseMarkdown(statement.contentMarkdown)),
    [statement.contentMarkdown],
  )

  return (
    <>
      {sections.length > 1 ? (
        <nav className="twm-statement-anchors twm-noprint" aria-label="Sections">
          {sections.map(section => (
            <Button
              key={section}
              design="Transparent"
              onClick={() => {
                const target = document.getElementById(slug(section))
                target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }}
            >
              {section}
            </Button>
          ))}
        </nav>
      ) : null}

      <article className="twm-sheet">
        <div className="twm-print-only twm-print-masthead">
          <strong>Two-Way Match</strong> · Statement of Us · FY{statement.year} · {household}
        </div>

        <MarkdownView source={statement.contentMarkdown} />

        <p className="twm-statement-footer">
          Prepared for {household} · Two-Way Match · unaudited, wholly reliable
        </p>
      </article>

      <div className="twm-statement-meta">
        <Text>{`Generated ${formatDateTime(statement.generatedAt)}`}</Text>
        <Text>{`Engine: ${engineLabel(statement.engine)}`}</Text>
        <Text>{`Document ${statement.ID.slice(0, 8).toUpperCase()}`}</Text>
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ *
 *  Helpers
 * ------------------------------------------------------------------ */

/** Every year that has a statement, plus the last few, newest first. */
function offeredYears(rows: Statement[]): number[] {
  const thisYear = new Date().getFullYear()
  const years = new Set<number>(rows.map(row => row.year))
  for (let offset = 0; offset < YEARS_OFFERED; offset += 1) years.add(thisYear - offset)
  return [...years].sort((a, b) => b - a)
}

/**
 * Everybody on the ledger, as one readable phrase: `Ada`, `Ada & Grace`,
 * `Ada, Grace & Noemi`, and past four names `Ada, Grace & 3 others`.
 *
 * The names come from the `People` rows rather than from anywhere convenient, and there is
 * no fixed number of them — a household is however many people it is (CONTRACTS.md §10).
 */
function householdName(people: Person[] | undefined): string {
  const names = (people ?? []).map(person => person.name.trim()).filter(name => name !== '')
  if (names.length === 0) return 'the household'
  if (names.length === 1) return names[0]
  if (names.length > 4) return `${names.slice(0, 2).join(', ')} & ${names.length - 2} others`
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`
}

function engineLabel(engine: string): string {
  return ENGINE_LABELS[engine] ?? engine
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message
  return 'the server did not say why'
}

export default StatementPage
