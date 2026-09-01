/**
 * Document #1.
 *
 * `Expenses.documentNumber = 1` is the first date: the row the whole ledger is
 * a follow-up to. It is read-only everywhere except its note (CONTRACTS §10),
 * so this is the one screen that can change it — and the one screen in the app
 * that is allowed to be sentimental about a posting.
 *
 * The conceit is a till receipt: monospace, torn edges, a total that is
 * usually 0.00, and a thank-you line lifted from every Swiss restaurant slip.
 * The note is set in a serif, centred, because it is the only part anybody
 * came here to read.
 */

import { useEffect, useMemo, useState } from 'react'
import { Bar, Button, Dialog, MessageStrip, TextArea, Title } from '@ui5/webcomponents-react'
import { MoneyText } from '@/components/MoneyText'
import type { Expense, Person } from '@/api/types'
import { formatLongDate } from './dates'

export interface DocumentOneRevealProps {
  open: boolean
  expense: Expense | null
  people: readonly Person[]
  saving: boolean
  error: string | null
  onClose: () => void
  /** Resolves `true` when the note was posted; the slip leaves edit mode then. */
  onSaveNote: (note: string) => Promise<boolean>
}

/** Deterministic bars from the document's own key — the same every time. */
function barcodeHeights(seed: string): number[] {
  const hex = seed.replace(/[^0-9a-f]/gi, '')
  const source = hex.length > 0 ? hex : '2024061500'
  return Array.from({ length: 44 }, (_, index) => {
    const digit = parseInt(source[index % source.length], 16)
    return 8 + ((Number.isNaN(digit) ? index : digit) % 6) * 5
  })
}

export function DocumentOneReveal({
  open,
  expense,
  people,
  saving,
  error,
  onClose,
  onSaveNote,
}: DocumentOneRevealProps) {
  const [editing, setEditing] = useState(false)
  const [noteDraft, setNoteDraft] = useState('')

  useEffect(() => {
    if (!open) return
    setEditing(false)
    setNoteDraft(expense?.note ?? '')
  }, [open, expense?.note])

  const bars = useMemo(() => barcodeHeights(expense?.ID ?? ''), [expense?.ID])

  if (!expense) return null

  const payer = people.find(person => person.ID === expense.paidBy_ID)
  const place = expense.place ?? 'the place where it started'
  const heading = `Document 1 · ${formatLongDate(expense.date)} · ${place}`

  return (
    <Dialog
      open={open}
      stretch
      onClose={onClose}
      header={
        <Bar
          startContent={<Title level="H5">Document #1</Title>}
          endContent={
            <Button
              design="Transparent"
              icon="decline"
              accessibleName="Close"
              tooltip="Close"
              onClick={onClose}
            />
          }
        />
      }
      footer={
        <Bar
          design="Footer"
          endContent={
            editing ? (
              <>
                <Button design="Transparent" disabled={saving} onClick={() => setEditing(false)}>
                  Cancel
                </Button>
                <Button
                  design="Emphasized"
                  disabled={saving}
                  onClick={() => {
                    void onSaveNote(noteDraft).then(saved => {
                      if (saved) setEditing(false)
                    })
                  }}
                >
                  {saving ? 'Posting…' : 'Save note'}
                </Button>
              </>
            ) : (
              <>
                <Button design="Transparent" icon="edit" onClick={() => setEditing(true)}>
                  Edit note
                </Button>
                <Button design="Emphasized" onClick={onClose}>
                  Close
                </Button>
              </>
            )
          }
        />
      }
    >
      <div className="tw-reveal">
        <article className="tw-receipt" aria-label={heading}>
          <div className="tw-receipt__stack">
            <div>
              <span className="tw-receipt__heart" aria-hidden="true">
                ♥
              </span>
              <div className="tw-receipt__mark">Two-Way Match</div>
            </div>

            <div className="tw-receipt__doc">{heading}</div>

            <hr className="tw-receipt__rule" />

            {error ? <MessageStrip design="Negative">{error}</MessageStrip> : null}

            {editing ? (
              <TextArea
                value={noteDraft}
                rows={8}
                growing
                growingMaxRows={16}
                placeholder="The sentence worth keeping"
                onInput={event => setNoteDraft(event.target.value ?? '')}
              />
            ) : (
              <p className="tw-receipt__note">
                {expense.note?.trim()
                  ? expense.note
                  : 'No note yet. This is the row everything else is a follow-up to — it deserves one.'}
              </p>
            )}

            <div>
              <hr className="tw-receipt__rule" />
              <div className="tw-receipt__row">
                <span>Position 001</span>
                <span>First date</span>
              </div>
              <div className="tw-receipt__row">
                <span>Posted by</span>
                <span>{payer?.name ?? '—'}</span>
              </div>
              <div className="tw-receipt__row">
                <span>Status</span>
                <span>{expense.status === 'confirmed' ? 'Posted' : 'Draft'}</span>
              </div>
              <div className="tw-receipt__row tw-receipt__row--total">
                <span>Total</span>
                <MoneyText amount={expense.amount} currency={expense.currency} bold />
              </div>
            </div>

            <div>
              <div className="tw-receipt__barcode" aria-hidden="true">
                {bars.map((height, index) => (
                  <span key={`${index}-${height}`} style={{ height: `${height}px` }} />
                ))}
              </div>
              <div className="tw-receipt__foot">Thank you for your continued business</div>
            </div>
          </div>
        </article>
      </div>
    </Dialog>
  )
}

export default DocumentOneReveal
