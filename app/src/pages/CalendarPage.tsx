/**
 * The calendar — FRONTEND-CONTRACT §9.
 *
 * One month, one read. `upcoming(from, to)` is asked for the whole grid window — the
 * leading and trailing days included, so the last week of February is not blank while
 * March is on screen — and everything below is derived from that single answer. A day
 * cell never fetches anything.
 *
 * Three things this page is careful about:
 *
 *  - **Multi-day events.** The service sends an event once, on the day it starts,
 *    carrying `endsOn`; `bucketEntries` is what puts a four-day trip on four days.
 *  - **Surprises.** A surprise created by somebody else never arrives here at all — the
 *    service filters it out (CONTRACTS §11.3). One created by the person looking arrives
 *    with `onlyYou`, and gets a badge. There is nothing to hide client-side, and this
 *    page deliberately does not try: a filter here would be a second, weaker copy of a
 *    rule that has to hold on the server anyway.
 *  - **The money is not here.** A calendar shows days, not sums. Nothing on this page
 *    adds anything up, and nothing on it is owed to anybody.
 */

import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Button,
  SegmentedButton,
  SegmentedButtonItem,
  Title,
  Toast,
} from '@ui5/webcomponents-react'
import { useNavigate } from 'react-router-dom'
import { describeError } from '@/api/client'
import {
  useCompleteReminder,
  useCreateReminder,
  useEvents,
  useReminders,
  useUpcoming,
} from '@/api/hooks'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { EmptyState } from '@/components/EmptyState'
import { ErrorState } from '@/components/ErrorState'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { currentPeriod, formatPeriod, shiftPeriod } from '@/theme'
import './calendar/icons'
import './calendar/calendar.css'
import { DayList } from './calendar/DayList'
import { DayPanel } from './calendar/DayPanel'
import { MonthGrid } from './calendar/MonthGrid'
import { NextUpStrip } from './calendar/NextUpStrip'
import { MAX_LEAD_DAYS, ReminderDialog, type ReminderDraft } from './calendar/ReminderDialog'
import type { DayEntry } from './calendar/entries'
import { bucketEntries, bucketsInOrder, pickNextReminder, reminderTitle } from './calendar/entries'
import { diffInDays, todayIso } from './memories/dates'
import { monthGrid, periodOfDate, sameDayInPeriod } from './calendar/grid'
import { deleteReminder } from './calendar/reminders'
import { readView, writeView, type CalendarView } from './calendar/view'

export function CalendarPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const today = todayIso()

  const [period, setPeriod] = useState<string>(() => currentPeriod())
  const [focusedDate, setFocusedDate] = useState<string>(today)
  /*
   * There is always a chosen day, and it starts as today.
   *
   * It used to start as `null`, because selecting a day opened a modal and opening one on
   * arrival would have been rude. The day now lives under the grid instead, so `null` would
   * mean six hundred pixels of nothing under a month — and "what is on today" is the question
   * somebody opening a calendar is most often asking anyway.
   */
  const [selectedDate, setSelectedDate] = useState<string>(today)
  const [view, setView] = useState<CalendarView>(() => readView())

  const [draft, setDraft] = useState<ReminderDraft | null>(null)
  const [draftError, setDraftError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<DayEntry | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const cells = useMemo(() => monthGrid(period, today), [period, today])
  const from = cells.length > 0 ? cells[0].date : ''
  const to = cells.length > 0 ? cells[cells.length - 1].date : ''

  const upcomingQuery = useUpcoming(from, to)
  const remindersQuery = useReminders()
  const eventsQuery = useEvents()

  const createReminder = useCreateReminder()
  const completeReminder = useCompleteReminder()

  const removeReminder = useMutation<void, unknown, string>({
    mutationFn: id => deleteReminder(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['reminders'] })
      void queryClient.invalidateQueries({ queryKey: ['calendar'] })
    },
  })

  const entries = useMemo(() => upcomingQuery.data ?? [], [upcomingQuery.data])
  const byDay = useMemo(() => bucketEntries(entries, from, to), [entries, from, to])

  // The list is the month itself: a card headed "1 March" under a "February 2026" title
  // would be a puzzle. The grid keeps its leading and trailing days, where the greyed-out
  // number says plainly which month they belong to.
  const buckets = useMemo(
    () => bucketsInOrder(byDay).filter(bucket => periodOfDate(bucket.date) === period),
    [byDay, period],
  )

  const reminders = useMemo(() => remindersQuery.data ?? [], [remindersQuery.data])
  const next = useMemo(() => pickNextReminder(reminders, today), [reminders, today])
  const events = useMemo(() => eventsQuery.data ?? [], [eventsQuery.data])

  // Keyboard navigation walks off the end of a month; the month follows the focused day.
  useEffect(() => {
    const focusedPeriod = periodOfDate(focusedDate)
    if (focusedPeriod && focusedPeriod !== period) setPeriod(focusedPeriod)
  }, [focusedDate, period])

  const goToPeriod = (target: string): void => {
    setPeriod(target)
    // The same day of the month, clamped — so paging from 31 January lands on 28 February
    // rather than on nothing. The chosen day follows the focus, or the panel below would be
    // describing a day that is no longer on screen.
    const landing = sameDayInPeriod(target, focusedDate)
    setFocusedDate(landing)
    setSelectedDate(landing)
  }

  const chooseView = (chosen: CalendarView): void => {
    setView(chosen)
    writeView(chosen)
  }

  const openEvent = (eventId: string): void => {
    // Nothing to close any more: the day lives under the grid rather than over it, so it
    // stays chosen and is still chosen on the way back.
    navigate(`/events/${eventId}`)
  }

  const openReminderDialog = (date: string | null): void => {
    const day = date ?? focusedDate
    // A reminder made from a day should land *on* that day, so the lead time is the gap
    // to the soonest event that has not started yet.
    const ahead = events
      .filter(event => event.startsOn >= day)
      .sort((a, b) => a.startsOn.localeCompare(b.startsOn) || a.name.localeCompare(b.name))
    const chosen = ahead[0] ?? events[0] ?? null
    const gap = chosen ? diffInDays(day, chosen.startsOn) : 1

    setDraftError(null)
    setDraft({
      eventId: chosen ? chosen.ID : '',
      leadDays: Math.max(0, Math.min(gap, MAX_LEAD_DAYS)),
      note: '',
    })
  }

  /**
   * "Remind me about this one", from the event's own row. The lead time starts at a day
   * before it begins, which is the reminder somebody actually wants when they tap a
   * trip; the dialog is still open in front of them to change it.
   */
  const remindAbout = (item: DayEntry): void => {
    const eventId = item.entry.eventId
    if (!eventId) return
    setDraftError(null)
    setDraft({ eventId, leadDays: 1, note: '' })
  }

  const saveReminder = async (values: ReminderDraft): Promise<void> => {
    setDraftError(null)
    try {
      const created = await createReminder.mutateAsync({
        eventId: values.eventId,
        leadDays: values.leadDays,
        note: values.note === '' ? null : values.note,
      })
      setDraft(null)
      setToast(`Reminder set for ${reminderTitle(created)}.`)
    } catch (error) {
      setDraftError(describeError(error))
    }
  }

  const markDone = async (id: string): Promise<void> => {
    setBusyId(id)
    try {
      await completeReminder.mutateAsync(id)
      setToast('Reminder ticked off.')
    } catch (error) {
      setToast(describeError(error))
    } finally {
      setBusyId(null)
    }
  }

  const confirmDelete = async (): Promise<void> => {
    if (!pendingDelete) return
    const id = pendingDelete.entry.ID
    setBusyId(id)
    try {
      await removeReminder.mutateAsync(id)
      setToast('Reminder deleted. The event and its postings are untouched.')
    } catch (error) {
      setToast(describeError(error))
    } finally {
      setBusyId(null)
      setPendingDelete(null)
    }
  }

  const dayItems = byDay.get(selectedDate) ?? []
  const monthCount = buckets.reduce((total, bucket) => total + bucket.items.length, 0)

  return (
    <div className="cal" data-testid="calendar-page">
      <div className="cal__bar">
        <div className="cal__heading">
          {/* The month leads, not the word "Calendar" — the nav already said which page this
              is, and the month is the thing that changes and that somebody is looking for. */}
          <Title level="H4">{formatPeriod(period)}</Title>
          <span className="cal__sub">
            {monthCount === 0
              ? 'Nothing scheduled'
              : `${monthCount} ${monthCount === 1 ? 'entry' : 'entries'}`}
          </span>
        </div>

        <div className="cal__nav">
          <Button
            design="Transparent"
            icon="slim-arrow-left"
            accessibleName="Previous month"
            tooltip="Previous month"
            onClick={() => goToPeriod(shiftPeriod(period, -1))}
          />
          <Button
            design="Transparent"
            onClick={() => {
              setPeriod(currentPeriod())
              setFocusedDate(today)
            }}
          >
            Today
          </Button>
          <Button
            design="Transparent"
            icon="slim-arrow-right"
            accessibleName="Next month"
            tooltip="Next month"
            onClick={() => goToPeriod(shiftPeriod(period, 1))}
          />
        </div>

        <div className="cal__tools">
          <SegmentedButton accessibleName="View">
            <SegmentedButtonItem
              icon="grid"
              selected={view === 'grid'}
              accessibleName="Month view"
              onClick={() => chooseView('grid')}
            >
              Month
            </SegmentedButtonItem>
            <SegmentedButtonItem
              icon="list"
              selected={view === 'list'}
              accessibleName="List view"
              onClick={() => chooseView('list')}
            >
              List
            </SegmentedButtonItem>
          </SegmentedButton>
          {/* Transparent, not a filled block. A calendar's header is chrome, and a solid
              accent square in it competes with the one thing on the page that should be
              loud — which is today. */}
          <Button
            design="Transparent"
            icon="add"
            accessibleName="New reminder"
            tooltip="New reminder"
            onClick={() => openReminderDialog(null)}
          />
        </div>
      </div>

      {upcomingQuery.isError ? (
        <ErrorState error={upcomingQuery.error} onRetry={() => void upcomingQuery.refetch()} />
      ) : upcomingQuery.isPending ? (
        <LoadingSkeleton rows={6} variant="card" />
      ) : view === 'grid' ? (
        <>
          <MonthGrid
            period={period}
            cells={cells}
            byDay={byDay}
            focusedDate={focusedDate}
            selectedDate={selectedDate}
            onFocusDate={setFocusedDate}
            onOpenDate={setSelectedDate}
          />
          <DayPanel
            date={selectedDate}
            items={dayItems}
            busyId={busyId}
            onOpenEvent={openEvent}
            onCompleteReminder={id => void markDone(id)}
            onDeleteReminder={setPendingDelete}
            onRemindAbout={remindAbout}
            onAddReminder={date => openReminderDialog(date)}
          />
        </>
      ) : buckets.length === 0 ? (
        <EmptyState
          icon="calendar"
          title={`Nothing in ${formatPeriod(period)}`}
          description="Events and their reminders land here. Create an event, then pin a nudge to it a few days before it starts."
          action={
            <Button design="Emphasized" icon="add" onClick={() => openReminderDialog(null)}>
              New reminder
            </Button>
          }
        />
      ) : (
        <DayList
          buckets={buckets}
          today={today}
          busyId={busyId}
          onOpenEvent={openEvent}
          onCompleteReminder={id => void markDone(id)}
          onDeleteReminder={setPendingDelete}
          onRemindAbout={remindAbout}
          onAddReminder={date => openReminderDialog(date)}
        />
      )}

      {/*
        Below the month, not above it.

        It was the first thing on the page, and a 270-pixel card pushed the grid most of the
        way off a phone screen — on a page whose subject is the month. The home launcher
        already carries a next-up strip, so this is the second copy rather than the only one,
        and it reads better as a footnote to the month than as a headline over it.
      */}
      <NextUpStrip
        next={next}
        reminders={reminders}
        busyId={busyId}
        onOpenEvent={openEvent}
        onComplete={id => void markDone(id)}
        onCreate={() => openReminderDialog(null)}
      />

      {draft === null ? null : (
        <ReminderDialog
          events={events}
          initial={draft}
          saving={createReminder.isPending}
          error={draftError}
          onCancel={() => {
            setDraft(null)
            setDraftError(null)
          }}
          onSave={values => void saveReminder(values)}
        />
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this reminder?"
        destructive
        confirmText="Delete"
        busy={busyId !== null}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => void confirmDelete()}
      >
        {pendingDelete
          ? `“${pendingDelete.entry.title}” will be removed. The event it points at, and every posting on it, stay exactly as they are.`
          : ''}
      </ConfirmDialog>

      <Toast open={toast !== null} duration={3500} onClose={() => setToast(null)}>
        {toast ?? ''}
      </Toast>
    </div>
  )
}

export default CalendarPage
