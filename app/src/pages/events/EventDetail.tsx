import { useMemo, useState } from 'react'
import { Button, Icon, Text, Title, Toast } from '@ui5/webcomponents-react'
import { useNavigate } from 'react-router-dom'
import { describeError } from '@/api/client'
import {
  useCategories,
  useDeleteEvent,
  useEvent,
  useEventTotals,
  useExpenses,
  usePeople,
  useRevealSurprise,
  useUpdateEvent,
} from '@/api/hooks'
import type { EventPatch } from '@/api/types'
import { useActivePerson } from '@/components/AppShell'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { EmptyState } from '@/components/EmptyState'
import { ErrorState } from '@/components/ErrorState'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { MoneyText } from '@/components/MoneyText'
import { PersonAvatar } from '@/components/PersonAvatar'
import { formatMoney } from '@/theme'
import './icons'
import './events.css'
import { EventEditor, type EventFormValues } from './EventEditor'
import { EventExpenseList } from './EventExpenseList'
import { PaidBreakdown } from './PaidBreakdown'
import { PhotoGallery } from './PhotoGallery'
import { SurpriseBadge } from './SurpriseBadge'
import { formatDateRange, spanLabel } from './dates'
import { byId, currencyOf, participantLabel, postingsLabel } from './summary'
import { isOwnSecret, resolveViewer } from './surprise'

export interface EventDetailProps {
  id: string
}

/**
 * One event: what it was, who was on it, what was posted to it, what that came to, and —
 * once it is over — the photographs.
 *
 * The page is deliberately one-directional. It reports. `eventTotals()` hands back a total, a
 * count and a per-person breakdown of who paid; the page draws those and stops. There is no
 * second column reconciling anybody against anybody, because there is nothing to reconcile —
 * an expense records who paid it, and that is the end of the story (CONTRACTS.md §9).
 *
 * The two additions from CONTRACTS §11 sit either side of that. The gallery is the reason the
 * feature exists: a finished trip with no pictures gets an invitation naming the place, not
 * an empty state. And a surprise the *viewer* created is marked "Only you can see this" with
 * a Reveal beside it — a surprise anybody else created never reaches this component at all,
 * because `LedgerService` filtered it out of the read, which is the only place such a rule
 * can be enforced honestly.
 */
export function EventDetail({ id }: EventDetailProps) {
  const navigate = useNavigate()
  const eventQuery = useEvent(id)
  const totalsQuery = useEventTotals(id)
  const expensesQuery = useExpenses({ event: id })
  const peopleQuery = usePeople()
  const categoriesQuery = useCategories()
  const { person: activePerson } = useActivePerson()

  const updateEvent = useUpdateEvent()
  const deleteEvent = useDeleteEvent()
  const revealSurprise = useRevealSurprise()

  const [editorOpen, setEditorOpen] = useState(false)
  const [editorError, setEditorError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [revealOpen, setRevealOpen] = useState(false)
  const [revealing, setRevealing] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const event = eventQuery.data
  const totals = totalsQuery.data
  const expenses = useMemo(() => expensesQuery.data ?? [], [expensesQuery.data])
  const roster = useMemo(() => peopleQuery.data ?? [], [peopleQuery.data])
  const people = useMemo(() => byId(roster), [roster])
  const categories = useMemo(
    () => new Map((categoriesQuery.data ?? []).map(category => [category.code, category])),
    [categoriesQuery.data],
  )
  const currency = currencyOf(expenses)
  const viewer = resolveViewer(activePerson, roster)

  const handleSave = async (values: EventFormValues) => {
    if (!event) return
    setSaving(true)
    setEditorError(null)
    const patch: EventPatch = {
      name: values.name,
      startsOn: values.startsOn,
      endsOn: values.endsOn,
      place: values.place === '' ? null : values.place,
      note: values.note === '' ? null : values.note,
      participantIds: values.participantIds,
      isSurprise: values.isSurprise,
    }
    // Turning an ordinary event into a surprise hides it from everybody except `createdBy`.
    // Whoever just ticked that switch has to *be* `createdBy`, or the next read would hide
    // the event from the very person planning it — the server fails closed on an unattributed
    // surprise, and rightly so. `revealedAt` is never patched; that is `revealSurprise`'s job.
    if (values.isSurprise && event.isSurprise !== true && viewer) {
      patch.createdBy_ID = viewer.ID
    }
    try {
      await updateEvent.mutateAsync({ id, patch })
      setEditorOpen(false)
      setToast('Event updated.')
    } catch (error) {
      setEditorError(describeError(error))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    setDeleting(true)
    try {
      await deleteEvent.mutateAsync(id)
      navigate('/events', { replace: true })
    } catch (error) {
      setToast(describeError(error))
    } finally {
      setDeleting(false)
      setDeleteOpen(false)
    }
  }

  const handleReveal = async () => {
    setRevealing(true)
    try {
      await revealSurprise.mutateAsync(id)
      setToast('Out of the bag. Everybody can see it now.')
    } catch (error) {
      setToast(describeError(error))
    } finally {
      setRevealing(false)
      setRevealOpen(false)
    }
  }

  if (eventQuery.isPending) return <LoadingSkeleton rows={5} />
  if (eventQuery.isError || !event) {
    return <ErrorState error={eventQuery.error} onRetry={() => void eventQuery.refetch()} />
  }

  const participants = event.participants ?? []
  const when = formatDateRange(event.startsOn, event.endsOn)
  const mySecret = isOwnSecret(event, viewer)

  return (
    <div className="ev-detail" data-testid="event-detail">
      <div className="ev-detail__bar">
        <Button
          design="Transparent"
          icon="nav-back"
          accessibleName="Back to events"
          onClick={() => navigate('/events')}
        >
          Events
        </Button>
        <span className="ev-detail__bar-spacer" />
        {mySecret ? (
          <Button
            design="Attention"
            icon="show"
            data-testid="reveal-surprise"
            onClick={() => setRevealOpen(true)}
          >
            Reveal
          </Button>
        ) : null}
        <Button design="Transparent" icon="edit" onClick={() => setEditorOpen(true)}>
          Edit
        </Button>
        <Button design="Transparent" icon="delete" onClick={() => setDeleteOpen(true)}>
          Delete
        </Button>
      </div>

      <div className="ev-detail__title">
        <div className="ev-detail__name">
          <Title level="H4">{event.name}</Title>
          {mySecret ? <SurpriseBadge /> : null}
        </div>
        <span className="ev-detail__meta">
          <Icon name="calendar" aria-hidden="true" />
          <span>{when}</span>
          <span aria-hidden="true">·</span>
          <span>{spanLabel(event.startsOn, event.endsOn)}</span>
          {event.place ? (
            <>
              <span aria-hidden="true">·</span>
              <Icon name="map-3" aria-hidden="true" />
              <span>{event.place}</span>
            </>
          ) : null}
        </span>
      </div>

      {mySecret ? (
        <p className="ev-secret" data-testid="surprise-note">
          You are the only person this event exists for until you reveal it, or until{' '}
          {formatDateRange(event.startsOn, null)} arrives. What it costs is another matter: every
          receipt booked to it counts towards the month exactly as usual, because a month that
          quietly came up short would be the loudest clue there is.
        </p>
      ) : null}

      {participants.length === 0 ? (
        <Text className="ev-detail__meta">
          Nobody is on this event yet. Add participants and the roster fills in.
        </Text>
      ) : (
        <div className="ev-people" role="list" aria-label={participantLabel(participants)}>
          {participants.map(person => (
            <span className="ev-people__person" role="listitem" key={person.ID}>
              <PersonAvatar person={person} size="S" />
              <span className="ev-people__name">{person.name}</span>
            </span>
          ))}
        </div>
      )}

      {event.note ? <p className="ev-detail__note">{event.note}</p> : null}

      <section className="ev-panel" aria-label="What this event came to">
        <span className="ev-panel__title">Posted to this event</span>

        {totalsQuery.isPending ? (
          <LoadingSkeleton rows={1} variant="text" />
        ) : totalsQuery.isError || !totals ? (
          <ErrorState error={totalsQuery.error} onRetry={() => void totalsQuery.refetch()} />
        ) : (
          <>
            <div className="ev-total">
              <span className="ev-total__value" data-testid="event-total">
                <MoneyText amount={totals.grandTotal} currency={currency} bold />
              </span>
              <span className="ev-total__count">
                {postingsLabel(totals.count)} ·{' '}
                {totals.participantCount === 1
                  ? '1 participant'
                  : `${totals.participantCount} participants`}
              </span>
            </div>

            {totals.participantCount > 0 ? (
              <div className="ev-perhead" data-testid="per-head">
                <Icon name="hint" aria-hidden="true" />
                <span className="ev-perhead__body">
                  <span className="ev-perhead__value">
                    {formatMoney(totals.perHead, currency)} each
                  </span>
                  <span className="ev-perhead__hint">
                    The total spread across {totals.participantCount}{' '}
                    {totals.participantCount === 1 ? 'participant' : 'participants'} — an average,
                    shown for scale. Nothing on this page is a bill.
                  </span>
                </span>
              </div>
            ) : null}
          </>
        )}
      </section>

      <PhotoGallery event={event} onRefresh={() => void eventQuery.refetch()} />

      <section className="ev-panel" aria-label="Who paid what">
        <span className="ev-panel__title">Who paid what</span>
        {totalsQuery.isPending ? (
          <LoadingSkeleton rows={2} />
        ) : totals && totals.byPerson.length > 0 ? (
          <PaidBreakdown totals={totals.byPerson} people={people} currency={currency} />
        ) : (
          <Text>Nothing has been posted to this event, by anybody, yet.</Text>
        )}
      </section>

      <section className="ev-panel" aria-label="Postings">
        <span className="ev-panel__title">Postings</span>
        {expensesQuery.isPending ? (
          <LoadingSkeleton rows={3} />
        ) : expensesQuery.isError ? (
          <ErrorState error={expensesQuery.error} onRetry={() => void expensesQuery.refetch()} />
        ) : expenses.length === 0 ? (
          <EmptyState
            icon="receipt"
            title="Nothing booked on this event yet"
            description="Scan a receipt or open a posting in the ledger and put it on this event."
            action={
              <Button design="Emphasized" onClick={() => navigate('/scan')}>
                Scan a receipt
              </Button>
            }
          />
        ) : (
          <EventExpenseList expenses={expenses} categories={categories} people={people} />
        )}
      </section>

      <EventEditor
        open={editorOpen}
        draft={{
          eventID: event.ID,
          name: event.name,
          startsOn: event.startsOn,
          endsOn: event.endsOn,
          place: event.place ?? '',
          note: event.note ?? '',
          participantIds: participants.map(person => person.ID),
          isSurprise: event.isSurprise === true,
          revealedAt: event.revealedAt ?? null,
        }}
        people={roster}
        saving={saving}
        error={editorError}
        onCancel={() => {
          setEditorOpen(false)
          setEditorError(null)
        }}
        onSave={values => void handleSave(values)}
      />

      <ConfirmDialog
        open={revealOpen}
        title={`Reveal “${event.name}”?`}
        busy={revealing}
        confirmText="Reveal it"
        onCancel={() => setRevealOpen(false)}
        onConfirm={() => void handleReveal()}
      >
        <Text>
          Everybody sees it from this moment on — the dates, the place, the postings and the
          photographs. There is no putting it back.
        </Text>
      </ConfirmDialog>

      <ConfirmDialog
        open={deleteOpen}
        title={`Delete “${event.name}”?`}
        destructive
        busy={deleting}
        confirmText="Delete event"
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => void handleDelete()}
      >
        <Text>
          {expenses.length === 0
            ? 'The event goes; nothing else changes.'
            : `The ${postingsLabel(expenses.length).toLowerCase()} booked on it stay in the ledger — they are detached from the event, not deleted. Their total of ${formatMoney(
                expenses.reduce((sum, expense) => sum + expense.amount, 0),
                currency,
              )} simply goes back to being ordinary spending.`}
        </Text>
      </ConfirmDialog>

      <Toast open={toast !== null} duration={3500} onClose={() => setToast(null)}>
        {toast ?? ''}
      </Toast>
    </div>
  )
}

export default EventDetail
