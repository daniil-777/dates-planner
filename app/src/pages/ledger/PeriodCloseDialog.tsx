import { Fragment } from 'react'
import { Bar, BusyIndicator, Button, Dialog, MessageStrip } from '@ui5/webcomponents-react'
import type { PeriodTotals, Person } from '@/api/types'
import { MoneyText } from '@/components/MoneyText'
import { formatMoney, formatPeriod } from '@/theme'
import './icons'
import { rosterTotals } from './totals'
import type { ClosePreview } from './totals'

export interface PeriodCloseDialogProps {
  open: boolean
  /** What the close will stamp, counted from the postings on screen. */
  preview: ClosePreview
  /** What the month came to and who paid it — the same figures the cards show. */
  totals: PeriodTotals
  people: readonly Person[]
  currency: string
  running: boolean
  error?: string
  onRun: () => void
  onCancel: () => void
}

/**
 * The "are you sure" for a payment run.
 *
 * A payment run closes a period (CONTRACTS.md §9): it records what the month totalled and
 * stamps every verified posting with one clearing document so the month can be marked done.
 * It moves no money and it works out nobody's position, so this dialog only ever adds up.
 */
export function PeriodCloseDialog({
  open,
  preview,
  totals,
  people,
  currency,
  running,
  error,
  onRun,
  onCancel,
}: PeriodCloseDialogProps) {
  if (!open) return null

  const label = formatPeriod(preview.period)
  const rows = rosterTotals(totals, people).filter(row => row.paid > 0)
  const nothingToClose = preview.postings === 0

  return (
    <Dialog
      open
      headerText="Period close"
      accessibleName={`Close ${label}`}
      onClose={onCancel}
      footer={
        <Bar
          design="Footer"
          startContent={
            <Button className="ledger-touch" design="Transparent" onClick={onCancel}>
              Cancel
            </Button>
          }
          endContent={
            <Button
              className="ledger-touch"
              design="Emphasized"
              icon="payment-approval"
              disabled={running || nothingToClose}
              onClick={onRun}
            >
              {running ? 'Posting…' : 'Run'}
            </Button>
          }
        />
      }
    >
      <div className="run-dialog">
        <MessageStrip design="Information" hideCloseButton>
          Records what {label} totalled and files every verified posting under one clearing
          document. No money moves.
        </MessageStrip>

        <dl className="run-dialog__rows">
          <dt>Period</dt>
          <dd data-testid="payment-run-period">
            {label} · {preview.period}
          </dd>

          <dt>Clearing document</dt>
          <dd data-testid="payment-run-document">CLR-{preview.period}</dd>

          <dt>Postings included</dt>
          <dd data-testid="payment-run-postings">{preview.postings}</dd>

          <dt>Included total</dt>
          <dd>
            <MoneyText amount={preview.postingsTotal} currency={currency} />
          </dd>

          {rows.map(row => (
            <Fragment key={row.personId}>
              <dt>Paid by {row.name}</dt>
              <dd>
                <MoneyText amount={row.paid} currency={currency} />
              </dd>
            </Fragment>
          ))}
        </dl>

        <p className="run-dialog__result" data-testid="payment-run-result">
          {label} totalled {formatMoney(totals.grandTotal, currency)} across {totals.count}{' '}
          {totals.count === 1 ? 'posting' : 'postings'}.
        </p>

        {preview.drafts > 0 && (
          <MessageStrip design="Critical" hideCloseButton>
            {preview.drafts} {preview.drafts === 1 ? 'posting' : 'postings'} still need review and
            will not be filed.
          </MessageStrip>
        )}

        {preview.alreadyClosed > 0 && (
          <MessageStrip design="Information" hideCloseButton>
            {preview.alreadyClosed} already belong to an earlier clearing document.
          </MessageStrip>
        )}

        {nothingToClose && (
          <MessageStrip design="Critical" hideCloseButton>
            Nothing left to file in {label}.
          </MessageStrip>
        )}

        {error && (
          <MessageStrip design="Negative" hideCloseButton>
            {error}
          </MessageStrip>
        )}

        {running && <BusyIndicator active delay={0} text="Posting the clearing document" />}
      </div>
    </Dialog>
  )
}
