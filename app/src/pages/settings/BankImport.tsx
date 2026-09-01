/**
 * Bank CSV import.
 *
 * Pick a file, check the columns the parser guessed, look at the preview, post. Every row
 * goes in through `POST /ledger/Expenses` with no `category_code`, which is exactly what
 * makes the backend run both classifier heads over it on the way in (docs/API.md §2) — so
 * an import arrives already sorted into categories and moments, as drafts, waiting to be
 * confirmed in the Ledger.
 *
 * The posting loop calls `api.createExpense` directly rather than `useCreateExpense`, on
 * purpose: that hook invalidates the expense list on every success, and a two-hundred-row
 * file would then refetch the ledger two hundred times. The invalidation happens once, at
 * the end, which is the same result and one request.
 */
import { useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  Button,
  Label,
  MessageStrip,
  Option,
  ProgressIndicator,
  Select,
  Switch,
  Text,
} from '@ui5/webcomponents-react'
import '@ui5/webcomponents-icons/dist/upload.js'
import '@ui5/webcomponents-icons/dist/excel-attachment.js'
import { api } from '@/api/client'
import { usePeople } from '@/api/hooks'
import type { Person } from '@/api/types'
import { MoneyText } from '@/components/MoneyText'
import { DEFAULT_CURRENCY, formatDate } from '@/theme'
import { SettingsCard } from './SettingsCard'
import {
  detectNegativeIsSpending,
  guessMapping,
  parseCsv,
  prepareRows,
  UNMAPPED,
  type ColumnMapping,
  type CsvTable,
  type DateOrder,
  type PreparedRow,
} from './csv'

/** How many rows the preview shows before it stops being a preview. */
const PREVIEW_ROWS = 8

/** Anything larger is a database export, not a bank statement, and wants a script. */
const MAX_ROWS = 5000

export interface BankImportProps {
  /** Anchor id, so onboarding can scroll straight here. */
  id?: string
}

interface ImportOutcome {
  posted: number
  skipped: number
  failures: Array<{ line: number; message: string }>
}

export function BankImport({ id }: BankImportProps) {
  const people = usePeople()
  const queryClient = useQueryClient()
  const fileInput = useRef<HTMLInputElement>(null)

  const [fileName, setFileName] = useState<string | null>(null)
  const [table, setTable] = useState<CsvTable | null>(null)
  const [mapping, setMapping] = useState<ColumnMapping | null>(null)
  const [dateOrder, setDateOrder] = useState<DateOrder>('dmy')
  const [negativeIsSpending, setNegativeIsSpending] = useState(true)
  const [defaultPayer, setDefaultPayer] = useState<string>('')
  const [parseError, setParseError] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null)

  const roster = people.data ?? []

  const resolvePayer = useMemo(() => makePayerResolver(roster), [roster])

  const rows: PreparedRow[] = useMemo(() => {
    if (table === null || mapping === null) return []
    return prepareRows(table, {
      mapping,
      dateOrder,
      negativeIsSpending,
      resolvePayer,
      defaultPayerId: defaultPayer === '' ? null : defaultPayer,
    })
  }, [table, mapping, dateOrder, negativeIsSpending, resolvePayer, defaultPayer])

  const ready = rows.filter(row => row.include)

  const reset = (): void => {
    setFileName(null)
    setTable(null)
    setMapping(null)
    setParseError(null)
    setProgress(null)
    setOutcome(null)
    if (fileInput.current) fileInput.current.value = ''
  }

  const onFile = async (file: File): Promise<void> => {
    setParseError(null)
    setOutcome(null)
    setProgress(null)
    try {
      const text = await file.text()
      const parsed = parseCsv(text)
      if (parsed.rows.length === 0) {
        setParseError('That file has a header and nothing else in it.')
        return
      }
      if (parsed.rows.length > MAX_ROWS) {
        setParseError(
          `That file has ${parsed.rows.length} rows; this importer stops at ${MAX_ROWS}. ` +
            'Break it up by year and import the parts.',
        )
        return
      }
      const guessed = guessMapping(parsed)
      setFileName(file.name)
      setTable(parsed)
      setMapping(guessed)
      setNegativeIsSpending(detectNegativeIsSpending(parsed, guessed.amount))
      if (defaultPayer === '' && roster.length > 0) setDefaultPayer(roster[0].ID)
    } catch (error) {
      setParseError(error instanceof Error ? error.message : 'that file could not be read')
    }
  }

  const runImport = async (): Promise<void> => {
    if (ready.length === 0) return
    const failures: Array<{ line: number; message: string }> = []
    let posted = 0
    setProgress({ done: 0, total: ready.length })

    for (const row of ready) {
      try {
        await api.createExpense({
          date: row.date ?? undefined,
          merchantRaw: row.merchant,
          amount: row.amount ?? undefined,
          currency: DEFAULT_CURRENCY,
          paidBy_ID: row.payerId,
          source: 'import',
        })
        posted += 1
      } catch (error) {
        failures.push({
          line: row.line,
          message: error instanceof Error ? error.message : 'refused by the server',
        })
      }
      setProgress({ done: posted + failures.length, total: ready.length })
    }

    void queryClient.invalidateQueries({ queryKey: ['expenses'] })
    setProgress(null)
    setOutcome({ posted, skipped: rows.length - ready.length, failures })
  }

  const importing = progress !== null

  return (
    <SettingsCard
      id={id}
      icon="excel-attachment"
      title="Bank statement import"
      subtitle="A CSV from the bank becomes drafts in the ledger, classified on the way in."
    >
      <input
        ref={fileInput}
        className="twm-file-input"
        type="file"
        accept=".csv,text/csv,text/plain"
        onChange={event => {
          const file = event.target.files?.[0]
          if (file) void onFile(file)
        }}
      />

      {table === null ? (
        <>
          <Text>
            Semicolons or commas, quoted fields, amounts written 1&rsquo;234.50 or 1.234,50, dates
            written 31.12.2026 or 2026-12-31 — all of it is read the same way. Nothing is posted
            until you have seen the preview and said so.
          </Text>
          <div className="twm-actions">
            <Button design="Emphasized" icon="upload" onClick={() => fileInput.current?.click()}>
              Choose a CSV file
            </Button>
          </div>
        </>
      ) : null}

      {parseError === null ? null : <MessageStrip design="Negative">{parseError}</MessageStrip>}

      {table !== null && mapping !== null ? (
        <>
          <div className="twm-import-summary">
            <span>{fileName}</span>
            <span>{`${table.rows.length} rows`}</span>
            <span>{`delimiter “${table.delimiter === '\t' ? 'tab' : table.delimiter}”`}</span>
            {table.headerless ? <span>no header row — columns are numbered</span> : null}
          </div>

          <div className="twm-field-row">
            <ColumnSelect
              label="Date"
              value={mapping.date}
              header={table.header}
              onChange={index => setMapping({ ...mapping, date: index })}
            />
            <ColumnSelect
              label="Merchant"
              value={mapping.merchant}
              header={table.header}
              onChange={index => setMapping({ ...mapping, merchant: index })}
            />
            <ColumnSelect
              label="Amount"
              value={mapping.amount}
              header={table.header}
              onChange={index => setMapping({ ...mapping, amount: index })}
            />
            <ColumnSelect
              label="Paid by"
              value={mapping.payer}
              header={table.header}
              onChange={index => setMapping({ ...mapping, payer: index })}
            />
          </div>

          <div className="twm-field-row">
            <div className="twm-field">
              <Label for="import-order">Ambiguous dates</Label>
              <Select
                id="import-order"
                value={dateOrder}
                onChange={event => {
                  const next = event.detail.selectedOption.value
                  setDateOrder(next === 'mdy' ? 'mdy' : 'dmy')
                }}
              >
                <Option value="dmy">03/04 is 3 April</Option>
                <Option value="mdy">03/04 is 4 March</Option>
              </Select>
            </div>

            <div className="twm-field">
              <Label for="import-payer">Default payer</Label>
              <Select
                id="import-payer"
                value={defaultPayer}
                onChange={event => setDefaultPayer(event.detail.selectedOption.value ?? '')}
              >
                {roster.map(person => (
                  <Option key={person.ID} value={person.ID}>
                    {person.name}
                  </Option>
                ))}
              </Select>
            </div>

            <div className="twm-field">
              <Label for="import-sign">Spending is negative</Label>
              <Switch
                id="import-sign"
                checked={negativeIsSpending}
                accessibleName="Treat negative amounts as spending"
                onChange={event => setNegativeIsSpending(event.target.checked)}
              />
            </div>
          </div>

          <PreviewTable rows={rows} people={roster} />

          <div className="twm-import-summary">
            <span>{`${ready.length} of ${rows.length} rows ready to post`}</span>
            {rows.length - ready.length > 0 ? (
              <span>{`${rows.length - ready.length} will be skipped`}</span>
            ) : null}
          </div>

          {importing ? (
            <ProgressIndicator
              value={Math.round((progress.done / Math.max(1, progress.total)) * 100)}
              valueState="Information"
              displayValue={`${progress.done} of ${progress.total}`}
              accessibleName="Import progress"
            />
          ) : null}

          <div className="twm-actions">
            <Button
              design="Emphasized"
              disabled={ready.length === 0 || importing}
              onClick={() => void runImport()}
            >
              {importing ? 'Posting…' : `Import ${ready.length} rows`}
            </Button>
            <Button design="Transparent" disabled={importing} onClick={reset}>
              Choose another file
            </Button>
          </div>

          <p className="twm-card-footnote">
            Imported rows are drafts with no category of their own — the classifier fills in the
            category and the moment as each one is created, and the Ledger asks you to confirm them.
          </p>
        </>
      ) : null}

      {outcome === null ? null : (
        <MessageStrip design={outcome.failures.length === 0 ? 'Positive' : 'Critical'}>
          {`Posted ${outcome.posted} rows as drafts` +
            (outcome.skipped > 0 ? `, skipped ${outcome.skipped}` : '') +
            (outcome.failures.length > 0
              ? `, ${outcome.failures.length} refused (line ${outcome.failures
                  .slice(0, 3)
                  .map(failure => failure.line)
                  .join(', ')}).`
              : '.')}
        </MessageStrip>
      )}
    </SettingsCard>
  )
}

/* ------------------------------------------------------------------ *
 *  Pieces
 * ------------------------------------------------------------------ */

interface ColumnSelectProps {
  label: string
  value: number
  header: string[]
  onChange: (index: number) => void
}

function ColumnSelect({ label, value, header, onChange }: ColumnSelectProps) {
  const id = `map-${label.toLowerCase().replace(/\s+/g, '-')}`
  return (
    <div className="twm-field">
      <Label for={id}>{label}</Label>
      <Select
        id={id}
        value={String(value)}
        onChange={event => {
          const parsed = Number.parseInt(event.detail.selectedOption.value ?? '', 10)
          onChange(Number.isNaN(parsed) ? UNMAPPED : parsed)
        }}
      >
        <Option value={String(UNMAPPED)}>— not mapped —</Option>
        {header.map((title, index) => (
          <Option key={`${title}-${index}`} value={String(index)}>
            {title}
          </Option>
        ))}
      </Select>
    </div>
  )
}

interface PreviewProps {
  rows: PreparedRow[]
  people: Person[]
}

function PreviewTable({ rows, people }: PreviewProps) {
  const names = new Map(people.map(person => [person.ID, person.name]))
  const shown = rows.slice(0, PREVIEW_ROWS)

  return (
    <div className="twm-table-scroll">
      <table className="twm-table">
        <thead>
          <tr>
            <th scope="col">Line</th>
            <th scope="col">Date</th>
            <th scope="col">Merchant</th>
            <th scope="col">Amount</th>
            <th scope="col">Paid by</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {shown.map(row => (
            <tr key={row.line} data-skipped={!row.include}>
              <td>{row.line}</td>
              <td>{row.date === null ? '—' : formatDate(row.date)}</td>
              <td>{row.merchant === '' ? '—' : row.merchant}</td>
              <td className="twm-num">
                {row.amount === null ? '—' : <MoneyText amount={row.amount} />}
              </td>
              <td>{row.payerId === null ? '—' : (names.get(row.payerId) ?? 'unknown')}</td>
              <td className={row.include ? undefined : 'twm-issue'}>
                {row.include ? 'ready' : row.issues.join(', ')}
              </td>
            </tr>
          ))}
          {rows.length > shown.length ? (
            <tr>
              <td colSpan={6}>{`…and ${rows.length - shown.length} more rows`}</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  )
}

/**
 * Matches a payer cell against the roster by name or email.
 *
 * Bank exports write the card holder in whatever form the bank likes, so both are tried,
 * case-insensitively, and a partial match on the first name counts — `SAM MUELLER` against
 * somebody called `Sam` is not a coincidence. An exact match always wins over a partial
 * one, which matters as soon as the household has a `Sam` and a `Samira`.
 */
export function makePayerResolver(people: Person[]): (raw: string) => string | null {
  return (raw: string) => {
    const value = raw.trim().toLowerCase()
    if (value === '') return null
    for (const person of people) {
      const candidates = [person.name, person.email ?? '']
        .filter(candidate => candidate !== '')
        .map(candidate => candidate.toLowerCase())
      if (candidates.includes(value)) return person.ID
    }
    for (const person of people) {
      const name = person.name.trim().toLowerCase()
      if (name !== '' && (value.includes(name) || name.includes(value))) return person.ID
    }
    return null
  }
}

export default BankImport
