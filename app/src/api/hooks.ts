/**
 * TanStack Query bindings — FRONTEND-CONTRACT §4.
 *
 * Query keys are arrays whose first element is the entity name, so a broad
 * `invalidateQueries({ queryKey: ['expenses'] })` catches both the list variants and the
 * per-id detail queries. Every mutation invalidates the keys its write can move: posting an
 * expense changes the ledger *and* the period's totals *and*, if it sits on an event, that
 * event's totals; a period close changes the clearing documents and the postings it stamped.
 *
 * Mutation variables accept both the terse form and the object form
 * (`mutate(id)` and `mutate({ id })`) on purpose — the pages call these constantly and the
 * ergonomics of a one-argument mutation should not depend on remembering which shape this
 * file chose.
 */

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { api } from './client'
import type {
  CalendarEntry,
  Category,
  Event,
  EventPatch,
  EventPhoto,
  EventTotals,
  Expense,
  ExpenseQuery,
  Health,
  Memory,
  MonthlyTotal,
  NewEvent,
  NewEventPhoto,
  NewReminder,
  PeriodTotals,
  Person,
  Reminder,
  ScanResult,
  Settlement,
  Statement,
  Mood,
  MoodSuggestion,
} from './types'

/** First element of every query key. Exported so a page can invalidate deliberately. */
export const queryKeys = {
  expenses: ['expenses'] as const,
  expenseList: (opts: ExpenseQuery) => ['expenses', 'list', opts] as const,
  expense: (id: string) => ['expenses', 'detail', id] as const,
  duplicates: (id: string) => ['expenses', 'duplicates', id] as const,
  categories: ['categories'] as const,
  people: ['people'] as const,
  events: ['events'] as const,
  event: (id: string) => ['events', 'detail', id] as const,
  eventTotals: (id: string) => ['eventTotals', id] as const,
  memories: ['memories'] as const,
  moods: ['moods'] as const,
  settlements: ['settlements'] as const,
  statements: ['statements'] as const,
  reminders: ['reminders'] as const,
  calendar: ['calendar'] as const,
  upcoming: (from: string, to: string) => ['calendar', 'upcoming', from, to] as const,
  periodTotals: (period: string) => ['periodTotals', period] as const,
  monthlyTotals: (from: string, to: string) => ['monthlyTotals', from, to] as const,
  health: ['health'] as const,
}

/** Master data barely changes; re-fetching it on every mount is noise. */
const MASTER_DATA_STALE_TIME = 10 * 60 * 1000

/** The keys any change to a posting can move: the list, and every sum computed over it. */
const POSTING_KEYS = ['expenses', 'periodTotals', 'eventTotals'] as const

/**
 * The keys any change to an *event* can move. The calendar is in here because an event's
 * dates are what put it on a day; `reminders` is in here because a reminder is only ever
 * as real as the event it hangs off — deleting the event takes its nudges with it.
 */
const EVENT_KEYS = ['events', 'eventTotals', 'calendar', 'reminders'] as const

function invalidate(client: QueryClient, keys: readonly string[]): void {
  for (const key of keys) void client.invalidateQueries({ queryKey: [key] })
}

/* ------------------------------------------------------------------ *
 *  Queries
 * ------------------------------------------------------------------ */

export function useExpenses(opts: ExpenseQuery = {}) {
  return useQuery<Expense[]>({
    queryKey: queryKeys.expenseList(opts),
    queryFn: () => api.listExpenses(opts),
    placeholderData: keepPreviousData,
  })
}

export function useExpense(id: string | undefined) {
  return useQuery<Expense>({
    queryKey: queryKeys.expense(id ?? ''),
    queryFn: () => api.getExpense(id ?? ''),
    enabled: Boolean(id),
  })
}

export function useDuplicates(id: string | undefined) {
  return useQuery<Expense[]>({
    queryKey: queryKeys.duplicates(id ?? ''),
    queryFn: () => api.duplicates(id ?? ''),
    enabled: Boolean(id),
  })
}

export function useCategories() {
  return useQuery<Category[]>({
    queryKey: queryKeys.categories,
    queryFn: () => api.listCategories(),
    staleTime: MASTER_DATA_STALE_TIME,
  })
}

export function usePeople() {
  return useQuery<Person[]>({
    queryKey: queryKeys.people,
    queryFn: () => api.listPeople(),
    staleTime: MASTER_DATA_STALE_TIME,
  })
}

export function useEvents() {
  return useQuery<Event[]>({
    queryKey: queryKeys.events,
    queryFn: () => api.listEvents(),
  })
}

export function useEvent(id: string | undefined) {
  return useQuery<Event>({
    queryKey: queryKeys.event(id ?? ''),
    queryFn: () => api.getEvent(id ?? ''),
    enabled: Boolean(id),
  })
}

export function useEventTotals(id: string | undefined) {
  return useQuery<EventTotals>({
    queryKey: queryKeys.eventTotals(id ?? ''),
    queryFn: () => api.eventTotals(id ?? ''),
    enabled: Boolean(id),
  })
}

/**
 * The calendar's window, inclusive of both days (`YYYY-MM-DD`). One read covers the whole
 * month grid: events sit on their start day carrying `endsOn`, reminders on the day they
 * fire. `keepPreviousData` is what stops the grid blanking while a month is paged.
 */
export function useUpcoming(from: string | undefined, to: string | undefined) {
  return useQuery<CalendarEntry[]>({
    queryKey: queryKeys.upcoming(from ?? '', to ?? ''),
    queryFn: () => api.upcoming(from ?? '', to ?? ''),
    enabled: Boolean(from) && Boolean(to),
    placeholderData: keepPreviousData,
  })
}

/** Every reminder, soonest first, the ones already ticked off at the back. */
export function useReminders() {
  return useQuery<Reminder[]>({
    queryKey: queryKeys.reminders,
    queryFn: () => api.listReminders(),
  })
}

export function useMoods() {
  return useQuery<Mood[]>({
    queryKey: queryKeys.moods,
    queryFn: () => api.listMoods(),
  })
}

export function useCreateMood() {
  const client = useQueryClient()
  return useMutation<Mood, unknown, Parameters<typeof api.createMood>[0]>({
    mutationFn: body => api.createMood(body),
    onSuccess: () => invalidate(client, ['moods']),
  })
}

/**
 * The camera-to-suggestion round trip. Deliberately NOT a create: the answer is a
 * suggestion the person confirms (or overrules) before `useCreateMood` writes anything,
 * and the photograph itself never reaches the database.
 */
export function useDetectMood() {
  return useMutation<MoodSuggestion, unknown, Blob>({
    mutationFn: file => api.detectMood(file),
  })
}

export function useMemories() {
  return useQuery<Memory[]>({
    queryKey: queryKeys.memories,
    queryFn: () => api.listMemories(),
  })
}

export function useSettlements() {
  return useQuery<Settlement[]>({
    queryKey: queryKeys.settlements,
    queryFn: () => api.listSettlements(),
  })
}

export function useStatements() {
  return useQuery<Statement[]>({
    queryKey: queryKeys.statements,
    queryFn: () => api.listStatements(),
  })
}

/** What one month totalled, per person: a sum and a proportion beside it. */
export function usePeriodTotals(period: string | undefined) {
  return useQuery<PeriodTotals>({
    queryKey: queryKeys.periodTotals(period ?? ''),
    queryFn: () => api.periodTotals(period ?? ''),
    enabled: Boolean(period),
    placeholderData: keepPreviousData,
  })
}

export function useMonthlyTotals(from: string, to: string) {
  return useQuery<MonthlyTotal[]>({
    queryKey: queryKeys.monthlyTotals(from, to),
    queryFn: () => api.monthlyTotals(from, to),
    enabled: Boolean(from) && Boolean(to),
    placeholderData: keepPreviousData,
  })
}

export function useHealth() {
  return useQuery<Health>({
    queryKey: queryKeys.health,
    queryFn: () => api.health(),
    staleTime: 30 * 1000,
    retry: false,
  })
}

/* ------------------------------------------------------------------ *
 *  Mutation argument shapes
 * ------------------------------------------------------------------ */

export type IdVariables = string | { id: string }

function idOf(variables: IdVariables): string {
  return typeof variables === 'string' ? variables : variables.id
}

export type ConfirmExpenseVariables =
  string | { id: string; predictedCategory?: string; predictedMoment?: string }

export type ScanReceiptVariables = Blob | { file: Blob; fileName: string }

export type RunSettlementVariables = string | { period: string }

export type GenerateStatementVariables = number | { year: number }

export interface UpdateExpenseVariables {
  id: string
  patch: Partial<Expense>
}

export interface UpdateMemoryVariables {
  id: string
  patch: Partial<Memory>
}

export interface UpdatePersonVariables {
  id: string
  patch: Partial<Person>
}

export interface UpdateEventVariables {
  id: string
  patch: EventPatch
}

function scanArgs(variables: ScanReceiptVariables): { file: Blob; fileName: string } {
  if (variables instanceof Blob) {
    const named = variables as File
    const fileName = typeof named.name === 'string' && named.name ? named.name : 'receipt.jpg'
    return { file: variables, fileName }
  }
  return { file: variables.file, fileName: variables.fileName || 'receipt.jpg' }
}

/* ------------------------------------------------------------------ *
 *  Mutations
 * ------------------------------------------------------------------ */

/** Posts a draft. Writes a `Corrections` row when the human overruled the model. */
export function useConfirmExpense() {
  const client = useQueryClient()
  return useMutation<Expense, unknown, ConfirmExpenseVariables>({
    mutationFn: variables => {
      if (typeof variables === 'string') return api.confirmExpense(variables)
      return api.confirmExpense(
        variables.id,
        variables.predictedCategory ?? '',
        variables.predictedMoment ?? '',
      )
    },
    onSuccess: () => invalidate(client, [...POSTING_KEYS, 'settlements']),
  })
}

/** Photo in, draft expense out. The longest happy path in the app. */
export function useScanReceipt() {
  const client = useQueryClient()
  return useMutation<ScanResult, unknown, ScanReceiptVariables>({
    mutationFn: variables => {
      const { file, fileName } = scanArgs(variables)
      return api.scanReceipt(file, fileName)
    },
    onSuccess: () => invalidate(client, ['expenses']),
  })
}

/** Re-runs both classifier heads over one row and stores the verdict. */
export function useClassify() {
  const client = useQueryClient()
  return useMutation<Expense, unknown, IdVariables>({
    mutationFn: variables => api.classify(idOf(variables)),
    onSuccess: () => invalidate(client, ['expenses']),
  })
}

export function useCreateExpense() {
  const client = useQueryClient()
  return useMutation<Expense, unknown, Partial<Expense>>({
    mutationFn: body => api.createExpense(body),
    onSuccess: () => invalidate(client, POSTING_KEYS),
  })
}

export function useUpdateExpense() {
  const client = useQueryClient()
  return useMutation<Expense, unknown, UpdateExpenseVariables>({
    mutationFn: ({ id, patch }) => api.updateExpense(id, patch),
    onSuccess: () => invalidate(client, POSTING_KEYS),
  })
}

export function useDeleteExpense() {
  const client = useQueryClient()
  return useMutation<void, unknown, IdVariables>({
    mutationFn: variables => api.deleteExpense(idOf(variables)),
    onSuccess: () => invalidate(client, [...POSTING_KEYS, 'memories']),
  })
}

/** The monthly period close. Stamps every covered posting with its clearing document. */
export function useRunSettlement() {
  const client = useQueryClient()
  return useMutation<Settlement, unknown, RunSettlementVariables>({
    mutationFn: variables =>
      api.runSettlement(typeof variables === 'string' ? variables : variables.period),
    onSuccess: () => invalidate(client, ['settlements', ...POSTING_KEYS]),
  })
}

/** The month is done. */
export function useMarkSettled() {
  const client = useQueryClient()
  return useMutation<Settlement, unknown, IdVariables>({
    mutationFn: variables => api.markSettled(idOf(variables)),
    onSuccess: () => invalidate(client, ['settlements']),
  })
}

/** Writes the yearly Statement of Us. Can take half a minute against a real LLM. */
export function useGenerateStatement() {
  const client = useQueryClient()
  return useMutation<Statement, unknown, GenerateStatementVariables>({
    mutationFn: variables =>
      api.generateStatement(typeof variables === 'number' ? variables : variables.year),
    onSuccess: () => invalidate(client, ['statements']),
  })
}

export function useCreateMemory() {
  const client = useQueryClient()
  return useMutation<Memory, unknown, Partial<Memory>>({
    mutationFn: body => api.createMemory(body),
    onSuccess: () => invalidate(client, ['memories']),
  })
}

export function useUpdateMemory() {
  const client = useQueryClient()
  return useMutation<Memory, unknown, UpdateMemoryVariables>({
    mutationFn: ({ id, patch }) => api.updateMemory(id, patch),
    onSuccess: () => invalidate(client, ['memories']),
  })
}

export function useDeleteMemory() {
  const client = useQueryClient()
  return useMutation<void, unknown, IdVariables>({
    mutationFn: variables => api.deleteMemory(idOf(variables)),
    onSuccess: () => invalidate(client, ['memories']),
  })
}

/** Adds somebody to the roster — a flatmate, a guest, whoever paid for the pizza. */
export function useCreatePerson() {
  const client = useQueryClient()
  return useMutation<Person, unknown, Partial<Person>>({
    mutationFn: body => api.createPerson(body),
    onSuccess: () => invalidate(client, ['people']),
  })
}

/** Onboarding: replace the seeded placeholder names with the real ones. */
export function useUpdatePerson() {
  const client = useQueryClient()
  return useMutation<Person, unknown, UpdatePersonVariables>({
    mutationFn: ({ id, patch }) => api.updatePerson(id, patch),
    // A renamed or recoloured person shows up inside every total, not just the roster.
    onSuccess: () => invalidate(client, ['people', 'events', 'periodTotals', 'eventTotals']),
  })
}

/** Rejected by the service while the person still has postings. */
export function useDeletePerson() {
  const client = useQueryClient()
  return useMutation<void, unknown, IdVariables>({
    mutationFn: variables => api.deletePerson(idOf(variables)),
    onSuccess: () => invalidate(client, ['people', 'events', 'periodTotals', 'eventTotals']),
  })
}

export function useCreateEvent() {
  const client = useQueryClient()
  return useMutation<Event, unknown, NewEvent>({
    mutationFn: body => api.createEvent(body),
    onSuccess: () => invalidate(client, EVENT_KEYS),
  })
}

export function useUpdateEvent() {
  const client = useQueryClient()
  return useMutation<Event, unknown, UpdateEventVariables>({
    mutationFn: ({ id, patch }) => api.updateEvent(id, patch),
    onSuccess: () => invalidate(client, EVENT_KEYS),
  })
}

/** Deleting an event detaches its postings; the ledger keeps every one of them. */
export function useDeleteEvent() {
  const client = useQueryClient()
  return useMutation<void, unknown, IdVariables>({
    mutationFn: variables => api.deleteEvent(idOf(variables)),
    onSuccess: () => invalidate(client, [...EVENT_KEYS, 'expenses']),
  })
}

/* ------------------------------------------------------------------ *
 *  Photos, reminders, surprises — CONTRACTS §11
 * ------------------------------------------------------------------ */

/**
 * One picture onto one event. Only `['events']` moves: a photo changes what the event
 * detail shows and nothing about a date, a total, or a day in the grid.
 */
export function useAddEventPhoto() {
  const client = useQueryClient()
  return useMutation<EventPhoto, unknown, NewEventPhoto>({
    mutationFn: input => api.addEventPhoto(input),
    onSuccess: () => invalidate(client, ['events']),
  })
}

/** Takes the picture off the event. Variables are the `EventPhotos.ID`, not the event's. */
export function useDeleteEventPhoto() {
  const client = useQueryClient()
  return useMutation<void, unknown, IdVariables>({
    mutationFn: variables => api.deleteEventPhoto(idOf(variables)),
    onSuccess: () => invalidate(client, ['events']),
  })
}

/**
 * Lifts a secret. Every viewer's calendar gains a day the moment this lands, so the
 * calendar keys go with the event keys — but not `reminders`, which never depended on
 * whether the event was visible.
 */
export function useRevealSurprise() {
  const client = useQueryClient()
  return useMutation<Event, unknown, IdVariables>({
    mutationFn: variables => api.revealSurprise(idOf(variables)),
    onSuccess: () => invalidate(client, ['events', 'eventTotals', 'calendar']),
  })
}

/** A nudge `leadDays` before the event starts; it shows up on the grid on its due day. */
export function useCreateReminder() {
  const client = useQueryClient()
  return useMutation<Reminder, unknown, NewReminder>({
    mutationFn: input => api.createReminder(input),
    onSuccess: () => invalidate(client, ['reminders', 'calendar']),
  })
}

/** Ticks one off. It stays in the list, at the back, rather than vanishing. */
export function useCompleteReminder() {
  const client = useQueryClient()
  return useMutation<Reminder, unknown, IdVariables>({
    mutationFn: variables => api.completeReminder(idOf(variables)),
    onSuccess: () => invalidate(client, ['reminders', 'calendar']),
  })
}
