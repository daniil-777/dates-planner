import { useEffect, useState } from 'react'
import {
  Bar,
  Button,
  DatePicker,
  Dialog,
  Input,
  MessageStrip,
  Option,
  Select,
  Tag,
  TextArea,
} from '@ui5/webcomponents-react'
import type {
  DatePickerDomRef,
  InputDomRef,
  SelectDomRef,
  Ui5CustomEvent,
} from '@ui5/webcomponents-react'
import type { DatePickerChangeEventDetail } from '@ui5/webcomponents/dist/DatePicker.js'
import type { SelectChangeEventDetail } from '@ui5/webcomponents/dist/Select.js'
import { api } from '@/api/client'
import type { Category, Event, Expense, MomentCode, Person } from '@/api/types'
import { CategoryChip } from '@/components/CategoryChip'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { EventChip } from '@/components/EventChip'
import { MomentBadge } from '@/components/MomentBadge'
import { MoneyText } from '@/components/MoneyText'
import { PersonAvatar } from '@/components/PersonAvatar'
import { MOMENT_CODES, MOMENT_LABELS, formatDate, formatTime } from '@/theme'
import './icons'
import type { LedgerMutations } from './useLedgerMutations'

interface DraftForm {
  merchantRaw: string
  amount: string
  date: string
  time: string
  category: string
  moment: string
  paidBy: string
  event: string
  place: string
  note: string
}

const NONE = '__none'

const toForm = (expense: Expense): DraftForm => ({
  merchantRaw: expense.merchantRaw,
  amount: expense.amount.toFixed(2),
  date: expense.date,
  time: formatTime(expense.time),
  category: expense.category_code ?? NONE,
  moment: expense.moment ?? NONE,
  paidBy: expense.paidBy_ID ?? NONE,
  event: expense.event_ID ?? NONE,
  place: expense.place ?? '',
  note: expense.note ?? '',
})

export interface ExpenseDetailSheetProps {
  expense: Expense | undefined
  categories: readonly Category[]
  people: readonly Person[]
  events: readonly Event[]
  mutations: LedgerMutations
  onClose: () => void
}

/** The posting sheet: receipt image, the numbers, who paid, edit and delete. */
export function ExpenseDetailSheet({
  expense,
  categories,
  people,
  events,
  mutations,
  onClose,
}: ExpenseDetailSheetProps) {
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState<DraftForm | undefined>(undefined)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [imageFailed, setImageFailed] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const expenseId = expense?.ID

  useEffect(() => {
    setEditing(false)
    setForm(undefined)
    setConfirmingDelete(false)
    setImageFailed(false)
    setError(undefined)
  }, [expenseId])

  if (!expense) return null

  const category = categories.find(entry => entry.code === expense.category_code)
  const payer = people.find(entry => entry.ID === expense.paidBy_ID)
  const linkedEvent = events.find(entry => entry.ID === expense.event_ID)
  const locked = expense.documentNumber === 1
  const current = form ?? toForm(expense)
  const amountValue = Number.parseFloat(current.amount.replace(',', '.'))
  const amountValid = Number.isFinite(amountValue) && amountValue > 0
  const timeValid = current.time === '' || /^([01]\d|2[0-3]):[0-5]\d$/.test(current.time)

  const patch = (next: Partial<DraftForm>) => setForm({ ...current, ...next })

  const buildPatch = (): Partial<Expense> => {
    const result: Partial<Expense> = {}
    if (!locked) {
      if (current.merchantRaw !== expense.merchantRaw) result.merchantRaw = current.merchantRaw
      if (Math.abs(amountValue - expense.amount) > 0.004) result.amount = amountValue
      if (current.date !== expense.date) result.date = current.date
      const time = current.time === '' ? null : current.time
      if (time !== (expense.time ? formatTime(expense.time) : null)) result.time = time
      const categoryCode = current.category === NONE ? null : current.category
      if (categoryCode !== expense.category_code) result.category_code = categoryCode
      const moment = current.moment === NONE ? null : (current.moment as MomentCode)
      if (moment !== expense.moment) result.moment = moment
      const paidBy = current.paidBy === NONE ? null : current.paidBy
      if (paidBy !== expense.paidBy_ID) result.paidBy_ID = paidBy
      const eventId = current.event === NONE ? null : current.event
      if (eventId !== expense.event_ID) result.event_ID = eventId
      const place = current.place === '' ? null : current.place
      if (place !== expense.place) result.place = place
    }
    const note = current.note === '' ? null : current.note
    if (note !== expense.note) result.note = note
    return result
  }

  const save = async () => {
    setError(undefined)
    const body = buildPatch()
    if (Object.keys(body).length === 0) {
      setEditing(false)
      return
    }
    try {
      await mutations.updateExpense(expense.ID, body)
      setEditing(false)
      setForm(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the posting.')
    }
  }

  const verify = async () => {
    setError(undefined)
    try {
      const body = buildPatch()
      if (Object.keys(body).length > 0) await mutations.updateExpense(expense.ID, body)
      await mutations.confirmExpense(
        expense.ID,
        expense.category_code ?? undefined,
        expense.moment ?? undefined,
      )
      setEditing(false)
      setForm(undefined)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not post the expense.')
    }
  }

  const remove = async () => {
    setError(undefined)
    try {
      await mutations.deleteExpense(expense.ID)
      setConfirmingDelete(false)
      onClose()
    } catch (cause) {
      setConfirmingDelete(false)
      setError(cause instanceof Error ? cause.message : 'Could not delete the posting.')
    }
  }

  const canSave = amountValid && timeValid && !mutations.savingExpense

  const footer = editing ? (
    <Bar
      design="Footer"
      startContent={
        <Button
          className="ledger-touch"
          design="Transparent"
          onClick={() => {
            setEditing(false)
            setForm(undefined)
            setError(undefined)
          }}
        >
          Cancel
        </Button>
      }
      endContent={
        <Button className="ledger-touch" design="Emphasized" disabled={!canSave} onClick={save}>
          {mutations.savingExpense ? 'Saving…' : 'Save'}
        </Button>
      }
    />
  ) : (
    <Bar
      design="Footer"
      startContent={
        <Button
          className="ledger-touch"
          design="Transparent"
          icon="delete"
          disabled={locked || mutations.savingExpense}
          onClick={() => setConfirmingDelete(true)}
        >
          Delete
        </Button>
      }
      endContent={
        <>
          {expense.status === 'draft' && (
            <Button
              className="ledger-touch"
              design="Emphasized"
              icon="sys-enter-2"
              disabled={mutations.savingExpense}
              onClick={verify}
            >
              Verify
            </Button>
          )}
          <Button className="ledger-touch" icon="edit" onClick={() => setEditing(true)}>
            Edit
          </Button>
          <Button className="ledger-touch" design="Transparent" onClick={onClose}>
            Close
          </Button>
        </>
      }
    />
  )

  return (
    <>
      <Dialog
        open
        headerText={expense.merchantRaw}
        onClose={onClose}
        accessibleName={`Posting ${expense.merchantRaw}`}
        footer={footer}
      >
        <div className="detail">
          {error && (
            <MessageStrip design="Negative" onClose={() => setError(undefined)}>
              {error}
            </MessageStrip>
          )}
          {locked && (
            <MessageStrip design="Information" hideCloseButton>
              Document #1 is read-only. The note is yours to change.
            </MessageStrip>
          )}

          {expense.receipt_ID && !imageFailed ? (
            <img
              className="detail__receipt"
              src={api.receiptImageUrl(expense.receipt_ID)}
              alt={`Receipt from ${expense.merchantRaw} on ${formatDate(expense.date)}`}
              loading="lazy"
              onError={() => setImageFailed(true)}
            />
          ) : (
            <div className="detail__receipt-missing">
              <span aria-hidden="true">🧾</span>
              <span>
                {expense.receipt_ID
                  ? 'The receipt image could not be loaded.'
                  : `No receipt image — posted ${expense.source === 'manual' ? 'by hand' : `by ${expense.source}`}.`}
              </span>
            </div>
          )}

          {editing ? (
            <div className="detail__form">
              <div className="detail__field">
                <span className="kpi__label">Merchant</span>
                <Input
                  value={current.merchantRaw}
                  disabled={locked}
                  accessibleName="Merchant"
                  onInput={(event: Ui5CustomEvent<InputDomRef>) =>
                    patch({ merchantRaw: event.target.value })
                  }
                />
              </div>

              <div className="detail__field-row">
                <div className="detail__field">
                  <span className="kpi__label">Amount</span>
                  <Input
                    type="Number"
                    value={current.amount}
                    disabled={locked}
                    accessibleName="Amount"
                    valueState={amountValid ? 'None' : 'Negative'}
                    onInput={(event: Ui5CustomEvent<InputDomRef>) =>
                      patch({ amount: event.target.value })
                    }
                  />
                </div>
                <div className="detail__field">
                  <span className="kpi__label">Time</span>
                  <Input
                    value={current.time}
                    disabled={locked}
                    placeholder="HH:MM"
                    accessibleName="Time"
                    valueState={timeValid ? 'None' : 'Negative'}
                    onInput={(event: Ui5CustomEvent<InputDomRef>) =>
                      patch({ time: event.target.value })
                    }
                  />
                </div>
              </div>

              <div className="detail__field">
                <span className="kpi__label">Date</span>
                <DatePicker
                  value={current.date}
                  formatPattern="yyyy-MM-dd"
                  disabled={locked}
                  accessibleName="Date"
                  onChange={(
                    event: Ui5CustomEvent<DatePickerDomRef, DatePickerChangeEventDetail>,
                  ) => {
                    if (event.detail.valid) patch({ date: event.detail.value })
                  }}
                />
              </div>

              <div className="detail__field">
                <span className="kpi__label">Category</span>
                <Select
                  accessibleName="Category"
                  disabled={locked}
                  onChange={(event: Ui5CustomEvent<SelectDomRef, SelectChangeEventDetail>) =>
                    patch({ category: event.detail.selectedOption.value ?? NONE })
                  }
                >
                  <Option value={NONE} selected={current.category === NONE}>
                    Uncategorised
                  </Option>
                  {categories.map(entry => (
                    <Option
                      key={entry.code}
                      value={entry.code}
                      selected={current.category === entry.code}
                    >
                      {entry.name}
                    </Option>
                  ))}
                </Select>
              </div>

              <div className="detail__field">
                <span className="kpi__label">Moment</span>
                <Select
                  accessibleName="Moment"
                  disabled={locked}
                  onChange={(event: Ui5CustomEvent<SelectDomRef, SelectChangeEventDetail>) =>
                    patch({ moment: event.detail.selectedOption.value ?? NONE })
                  }
                >
                  <Option value={NONE} selected={current.moment === NONE}>
                    No moment
                  </Option>
                  {MOMENT_CODES.map(moment => (
                    <Option key={moment} value={moment} selected={current.moment === moment}>
                      {MOMENT_LABELS[moment]}
                    </Option>
                  ))}
                </Select>
              </div>

              <div className="detail__field">
                <span className="kpi__label">Paid by</span>
                <Select
                  accessibleName="Paid by"
                  disabled={locked}
                  onChange={(event: Ui5CustomEvent<SelectDomRef, SelectChangeEventDetail>) =>
                    patch({ paidBy: event.detail.selectedOption.value ?? NONE })
                  }
                >
                  <Option value={NONE} selected={current.paidBy === NONE}>
                    Unassigned
                  </Option>
                  {people.map(person => (
                    <Option
                      key={person.ID}
                      value={person.ID}
                      selected={current.paidBy === person.ID}
                    >
                      {person.name}
                    </Option>
                  ))}
                </Select>
              </div>

              <div className="detail__field">
                <span className="kpi__label">Event</span>
                <Select
                  accessibleName="Event"
                  disabled={locked}
                  onChange={(event: Ui5CustomEvent<SelectDomRef, SelectChangeEventDetail>) =>
                    patch({ event: event.detail.selectedOption.value ?? NONE })
                  }
                >
                  <Option value={NONE} selected={current.event === NONE}>
                    No event
                  </Option>
                  {events.map(entry => (
                    <Option key={entry.ID} value={entry.ID} selected={current.event === entry.ID}>
                      {entry.name}
                    </Option>
                  ))}
                </Select>
              </div>

              <div className="detail__field">
                <span className="kpi__label">Place</span>
                <Input
                  value={current.place}
                  disabled={locked}
                  accessibleName="Place"
                  onInput={(event: Ui5CustomEvent<InputDomRef>) =>
                    patch({ place: event.target.value })
                  }
                />
              </div>

              <div className="detail__field">
                <span className="kpi__label">Note</span>
                <TextArea
                  value={current.note}
                  rows={3}
                  accessibleName="Note"
                  onInput={event => patch({ note: event.target.value })}
                />
              </div>
            </div>
          ) : (
            <dl className="detail__rows">
              <dt>Amount</dt>
              <dd>
                <MoneyText amount={expense.amount} currency={expense.currency} bold />
              </dd>

              <dt>Date</dt>
              <dd>
                {formatDate(expense.date)}
                {formatTime(expense.time) ? ` · ${formatTime(expense.time)}` : ''}
              </dd>

              <dt>Category</dt>
              <dd>
                {category ? (
                  <CategoryChip
                    category={category}
                    confidence={expense.categoryConfidence ?? undefined}
                  />
                ) : (
                  'Uncategorised'
                )}
              </dd>

              <dt>Moment</dt>
              <dd>{expense.moment ? <MomentBadge moment={expense.moment} /> : 'None'}</dd>

              <dt>Paid by</dt>
              <dd>
                {payer ? (
                  <span className="kpi__person">
                    <PersonAvatar person={payer} size="S" />
                    <span className="kpi__person-name">{payer.name}</span>
                  </span>
                ) : (
                  'Unassigned'
                )}
              </dd>

              <dt>Event</dt>
              <dd>{linkedEvent ? <EventChip event={linkedEvent} /> : 'Everyday spending'}</dd>

              {expense.place && (
                <>
                  <dt>Place</dt>
                  <dd>{expense.place}</dd>
                </>
              )}

              {expense.note && (
                <>
                  <dt>Note</dt>
                  <dd>{expense.note}</dd>
                </>
              )}

              <dt>Status</dt>
              <dd>
                <Tag design={expense.status === 'draft' ? 'Critical' : 'Positive'}>
                  {expense.status === 'draft' ? 'Needs review' : 'Posted'}
                </Tag>
              </dd>

              <dt>Document</dt>
              <dd>
                {expense.documentNumber ? `#${expense.documentNumber}` : '—'} · {expense.source}
                {expense.settlement_ID ? ' · filed' : ''}
              </dd>
            </dl>
          )}
        </div>
      </Dialog>

      <ConfirmDialog
        open={confirmingDelete}
        title="Delete posting?"
        confirmText="Delete"
        onConfirm={remove}
        onCancel={() => setConfirmingDelete(false)}
      >
        {expense.merchantRaw} · {formatDate(expense.date)}. This cannot be undone.
      </ConfirmDialog>
    </>
  )
}
