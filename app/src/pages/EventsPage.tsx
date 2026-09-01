/**
 * Events — the trips, dinners and parties a household's spending clusters around.
 *
 * An event is a bag, not a contract. It groups a subset of the people and whichever postings
 * were booked to it, and everything it reports is a **sum**: what the event cost, how many
 * postings it holds, and how much of that total went through each person's card. Nobody is
 * reconciled against anybody. `perHead` on the detail page is an average shown for scale,
 * labelled as such, and it is the only division on the whole feature.
 *
 * `/events` is the list; `/events/:id` is one event. The page owns both, because the second
 * is the first zoomed in and the shell mounts one route for the pair (FRONTEND-CONTRACT §6).
 */

import { useMemo, useState } from 'react'
import { Button, Title, Toast } from '@ui5/webcomponents-react'
import { Navigate, Route, Routes, useParams } from 'react-router-dom'
import { describeError } from '@/api/client'
import { useCreateEvent, useEvents, useExpenses, usePeople } from '@/api/hooks'
import type { NewEvent } from '@/api/types'
import { useActivePerson } from '@/components/AppShell'
import { EmptyState } from '@/components/EmptyState'
import { ErrorState } from '@/components/ErrorState'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import './events/icons'
import './events/events.css'
import { EventCard } from './events/EventCard'
import { EventDetail } from './events/EventDetail'
import { EventEditor, blankEvent, type EventFormValues } from './events/EventEditor'
import { todayIso } from './events/dates'
import { EMPTY_ROLLUP, currencyOf, rollupByEvent, sectionEvents } from './events/summary'
import { isOwnSecret, resolveViewer } from './events/surprise'

/**
 * The list of events, with a card each.
 *
 * The totals on the cards are derived from the postings the page already holds rather than
 * from one `eventTotals()` call per row: a list of twenty events would otherwise be twenty
 * round trips to render a figure that is a sum of rows already on the client. The detail page,
 * which shows the breakdown, asks the server for the authoritative numbers.
 */
function EventsList() {
  const eventsQuery = useEvents()
  const expensesQuery = useExpenses()
  const peopleQuery = usePeople()
  const createEvent = useCreateEvent()
  const { person: activePerson } = useActivePerson()

  const [editorOpen, setEditorOpen] = useState(false)
  const [draft, setDraft] = useState<EventFormValues | null>(null)
  const [editorError, setEditorError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const events = useMemo(() => eventsQuery.data ?? [], [eventsQuery.data])
  const expenses = useMemo(() => expensesQuery.data ?? [], [expensesQuery.data])
  const roster = useMemo(() => peopleQuery.data ?? [], [peopleQuery.data])
  const rollups = useMemo(() => rollupByEvent(expenses), [expenses])
  const sections = useMemo(() => sectionEvents(events, todayIso()), [events])
  const currency = currencyOf(expenses)
  const viewer = resolveViewer(activePerson, roster)

  const openEditor = () => {
    setDraft({
      ...blankEvent(),
      // The household starts an event; guests get added by hand.
      participantIds: roster.filter(person => person.isDefault).map(person => person.ID),
    })
    setEditorError(null)
    setEditorOpen(true)
  }

  const handleCreate = async (values: EventFormValues) => {
    setSaving(true)
    setEditorError(null)
    const body: NewEvent = {
      name: values.name,
      startsOn: values.startsOn,
      endsOn: values.endsOn,
      place: values.place === '' ? null : values.place,
      note: values.note === '' ? null : values.note,
      participantIds: values.participantIds,
      isSurprise: values.isSurprise,
    }
    // Say who planned it rather than letting the server infer it. CAP's mocked user is not
    // this device's person switcher, and for a surprise the difference is the whole feature:
    // `createdBy` is the one person it is *not* hidden from, so the person who ticked the box
    // has to be named, or they would lose sight of their own plan the moment it saved.
    if (viewer) body.createdBy_ID = viewer.ID
    try {
      const created = await createEvent.mutateAsync(body)
      setEditorOpen(false)
      setDraft(null)
      setToast(
        values.isSurprise
          ? `“${created.name}” created, and only you can see it. Book postings to it from the ledger — they count towards the month like any others.`
          : `“${created.name}” created. Book postings to it from the ledger.`,
      )
    } catch (error) {
      setEditorError(describeError(error))
    } finally {
      setSaving(false)
    }
  }

  const newButton = (
    <Button design="Emphasized" icon="add" onClick={openEditor}>
      New event
    </Button>
  )

  const total = events.length

  return (
    <div className="ev" data-testid="events-page">
      <div className="ev__bar">
        <div className="ev__heading">
          <Title level="H4">Events</Title>
          <span className="ev__count">
            {total === 0
              ? 'Trips, dinners, parties'
              : `${total} ${total === 1 ? 'event' : 'events'} · ${sections.current.length} current`}
          </span>
        </div>
        {newButton}
      </div>

      {eventsQuery.isError ? (
        <ErrorState error={eventsQuery.error} onRetry={() => void eventsQuery.refetch()} />
      ) : eventsQuery.isPending ? (
        <LoadingSkeleton rows={4} variant="card" />
      ) : total === 0 ? (
        <EmptyState
          icon="calendar"
          title="No events yet"
          description="An event gathers the postings from one trip, one dinner, one weekend — and the people who were there. Create one, then book receipts to it as they come in."
          action={newButton}
        />
      ) : (
        <>
          {sections.current.length > 0 ? (
            <section className="ev__section" aria-label="Current and upcoming events">
              <h2 className="ev__section-title">Now and next</h2>
              <ul className="ev-cards">
                {sections.current.map(event => (
                  <EventCard
                    key={event.ID}
                    event={event}
                    rollup={rollups.get(event.ID) ?? EMPTY_ROLLUP}
                    currency={currency}
                    onlyYou={isOwnSecret(event, viewer)}
                  />
                ))}
              </ul>
            </section>
          ) : null}

          {sections.past.length > 0 ? (
            <section className="ev__section" aria-label="Past events">
              <h2 className="ev__section-title">Been and gone</h2>
              <ul className="ev-cards">
                {sections.past.map(event => (
                  <EventCard
                    key={event.ID}
                    event={event}
                    rollup={rollups.get(event.ID) ?? EMPTY_ROLLUP}
                    currency={currency}
                    onlyYou={isOwnSecret(event, viewer)}
                  />
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}

      <EventEditor
        open={editorOpen}
        draft={draft}
        people={roster}
        saving={saving}
        error={editorError}
        onCancel={() => {
          setEditorOpen(false)
          setDraft(null)
          setEditorError(null)
        }}
        onSave={values => void handleCreate(values)}
      />

      <Toast open={toast !== null} duration={3500} onClose={() => setToast(null)}>
        {toast ?? ''}
      </Toast>
    </div>
  )
}

/** Reads the id out of a nested `:id` route. */
function EventDetailRoute() {
  const { id } = useParams<{ id: string }>()
  if (!id) return <Navigate to="/events" replace />
  return <EventDetail id={id} />
}

/**
 * The Events destination.
 *
 * The shell mounts this at `/events/*`, so the two screens are matched here. A shell that
 * instead mounts `/events/:id` directly is handled too — the id then arrives as this
 * component's own param, and there is no descendant route to match.
 */
export function EventsPage() {
  const { id } = useParams<{ id: string }>()
  if (id) return <EventDetail id={id} />

  return (
    <Routes>
      <Route index element={<EventsList />} />
      <Route path=":id" element={<EventDetailRoute />} />
      <Route path="*" element={<Navigate to="/events" replace />} />
    </Routes>
  )
}

export default EventsPage
