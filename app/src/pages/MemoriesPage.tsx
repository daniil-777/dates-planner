/**
 * Memories — the romantic layer of Two-Way Match.
 *
 * The page is a single vertical timeline over two collections that the rest of
 * the app keeps apart: `Memories`, which people write, and the `Expenses` whose
 * moment the classifier called a date night, a trip or a gift. An expense that
 * has been written up disappears into its memory and lends it its amount, so a
 * dinner shows up once, with both the bill and the story.
 *
 * Everything else on the page hangs off that timeline: the pinned section, the
 * month groups, the "new memories detected" nudge for moments nobody has
 * written up, the map of the ones that have coordinates, the anniversary
 * countdown over pinned memories and Document #1, and Document #1 itself —
 * which gets a receipt.
 */

import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react'
import {
  BusyIndicator,
  Button,
  SegmentedButton,
  SegmentedButtonItem,
  Text,
  Title,
  Toast,
} from '@ui5/webcomponents-react'
import { ConfirmDialog, EmptyState, ErrorState, LoadingSkeleton } from '@/components'
import { describeError } from '@/api/client'
import {
  useCreateMemory,
  useDeleteMemory,
  useExpenses,
  useMemories,
  usePeople,
  useUpdateExpense,
  useUpdateMemory,
} from '@/api/hooks'
import type { Expense, Memory } from '@/api/types'
import './memories/icons'
import './memories/memories.css'
import { AnniversaryCard } from './memories/AnniversaryCard'
import { DocumentOneReveal } from './memories/DocumentOneReveal'
import { MemoryEditor, type MemoryFormValues } from './memories/MemoryEditor'
import { MemoryTimeline } from './memories/MemoryTimeline'
import { NewMemoriesStrip } from './memories/NewMemoriesStrip'
import {
  computeAnniversaries,
  type Anniversary,
  type AnniversarySeed,
} from './memories/anniversaries'
import { todayIso } from './memories/dates'
import { photoRows, uploadPhotoBinary, type PreparedPhoto } from './memories/photos'
import {
  buildTimeline,
  domIdForKey,
  groupByMonth,
  locatableEntries,
  momentToKind,
  splitPinned,
  titleFromExpense,
  undocumentedExpenses,
  type TimelineEntry,
} from './memories/timeline'

/** Leaflet and its stylesheet are ~150 kB nobody needs until they tap "Map". */
const MemoryMap = lazy(async () => {
  const module = await import('./memories/MemoryMap')
  return { default: module.MemoryMap }
})

type View = 'timeline' | 'map'

function blankDraft(): MemoryFormValues {
  return {
    memoryID: null,
    expenseID: null,
    title: '',
    note: '',
    occurredOn: todayIso(),
    kind: 'date_night',
    pinned: false,
    place: '',
    lat: null,
    lon: null,
    keptPhotos: [],
  }
}

function draftFromMemory(memory: Memory): MemoryFormValues {
  return {
    memoryID: memory.ID,
    expenseID: memory.expense_ID,
    title: memory.title,
    note: memory.note ?? '',
    occurredOn: memory.occurredOn,
    kind: memory.kind,
    pinned: memory.pinned,
    place: memory.place ?? '',
    lat: memory.lat,
    lon: memory.lon,
    keptPhotos: memory.photos ?? [],
  }
}

function draftFromExpense(expense: Expense): MemoryFormValues {
  return {
    memoryID: null,
    expenseID: expense.ID,
    title: titleFromExpense(expense),
    note: expense.note ?? '',
    occurredOn: expense.date,
    kind: momentToKind(expense.moment),
    pinned: false,
    place: expense.place ?? '',
    lat: expense.lat,
    lon: expense.lon,
    keptPhotos: [],
  }
}

export function MemoriesPage() {
  const memoriesQuery = useMemories()
  const expensesQuery = useExpenses()
  const peopleQuery = usePeople()

  const createMemory = useCreateMemory()
  const updateMemory = useUpdateMemory()
  const deleteMemory = useDeleteMemory()
  const updateExpense = useUpdateExpense()

  const [view, setView] = useState<View>('timeline')
  const [editorOpen, setEditorOpen] = useState(false)
  const [draft, setDraft] = useState<MemoryFormValues | null>(null)
  const [editorError, setEditorError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<TimelineEntry | null>(null)
  const [documentOneOpen, setDocumentOneOpen] = useState(false)
  const [documentOneError, setDocumentOneError] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [busyExpenseId, setBusyExpenseId] = useState<string | null>(null)
  const [flashKey, setFlashKey] = useState<string | null>(null)
  const [pendingScroll, setPendingScroll] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const memories = useMemo(() => memoriesQuery.data ?? [], [memoriesQuery.data])
  const expenses = useMemo(() => expensesQuery.data ?? [], [expensesQuery.data])
  const people = peopleQuery.data ?? []
  const today = todayIso()

  const entries = useMemo(() => buildTimeline(memories, expenses), [memories, expenses])
  const { pinned, rest } = useMemo(() => splitPinned(entries), [entries])
  const groups = useMemo(() => groupByMonth(rest), [rest])
  const located = useMemo(() => locatableEntries(entries), [entries])

  const documentOne = useMemo(
    () => expenses.find(expense => expense.documentNumber === 1) ?? null,
    [expenses],
  )

  const undocumented = useMemo(
    () => undocumentedExpenses(memories, expenses, today),
    [memories, expenses, today],
  )

  const anniversaries = useMemo<Anniversary[]>(() => {
    const seeds: AnniversarySeed[] = []
    if (documentOne) {
      seeds.push({
        ID: documentOne.ID,
        title: 'Document #1',
        occurredOn: documentOne.date,
        source: 'document-one',
        place: documentOne.place,
      })
    }
    for (const memory of memories) {
      if (!memory.pinned) continue
      seeds.push({
        ID: memory.ID,
        title: memory.title,
        occurredOn: memory.occurredOn,
        source: 'memory',
        place: memory.place,
      })
    }
    return computeAnniversaries(seeds, today)
  }, [documentOne, memories, today])

  /* --------------------------------------------------------- navigation */

  useEffect(() => {
    if (!pendingScroll || view !== 'timeline') return
    const key = pendingScroll
    setPendingScroll(null)
    setFlashKey(key)
    const timer = window.setTimeout(() => {
      document
        .getElementById(domIdForKey(key))
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 60)
    return () => window.clearTimeout(timer)
  }, [pendingScroll, view])

  useEffect(() => {
    if (!flashKey) return
    const timer = window.setTimeout(() => setFlashKey(null), 2000)
    return () => window.clearTimeout(timer)
  }, [flashKey])

  const jumpTo = useCallback((key: string) => {
    setView('timeline')
    setPendingScroll(key)
  }, [])

  /* ------------------------------------------------------------ editing */

  const openBlankEditor = () => {
    setDraft(blankDraft())
    setEditorError(null)
    setEditorOpen(true)
  }

  const openEditorForEntry = (entry: TimelineEntry) => {
    const memory = entry.memoryID
      ? memories.find(candidate => candidate.ID === entry.memoryID)
      : undefined
    if (memory) {
      setDraft(draftFromMemory(memory))
    } else {
      const expense = expenses.find(candidate => candidate.ID === entry.expenseID)
      setDraft(expense ? draftFromExpense(expense) : blankDraft())
    }
    setEditorError(null)
    setEditorOpen(true)
  }

  const openEditorForExpense = (expense: Expense) => {
    setDraft(draftFromExpense(expense))
    setEditorError(null)
    setEditorOpen(true)
  }

  const handleSave = async (values: MemoryFormValues, addedPhotos: PreparedPhoto[]) => {
    setSaving(true)
    setEditorError(null)
    const body: Partial<Memory> = {
      title: values.title,
      note: values.note.trim() === '' ? null : values.note,
      occurredOn: values.occurredOn,
      kind: values.kind,
      pinned: values.pinned,
      place: values.place === '' ? null : values.place,
      lat: values.lat,
      lon: values.lon,
      expense_ID: values.expenseID,
    }

    // The photo composition is a deep write that replaces the whole child set,
    // so it is only sent when it actually changed. A rename or a re-pin then
    // stays a two-field PATCH instead of rewriting every Photos row.
    const original = values.memoryID
      ? (memories.find(candidate => candidate.ID === values.memoryID)?.photos ?? [])
      : []
    const photosChanged =
      addedPhotos.length > 0 ||
      values.keptPhotos.length !== original.length ||
      values.keptPhotos.some((photo, index) => photo.ID !== original[index]?.ID)
    if (photosChanged) body.photos = photoRows(values.keptPhotos, addedPhotos)

    try {
      const saved = values.memoryID
        ? await updateMemory.mutateAsync({ id: values.memoryID, patch: body })
        : await createMemory.mutateAsync(body)

      // The rows exist now, so the bytes have somewhere to land. A failed
      // upload leaves an empty photo behind rather than losing the memory.
      let failed = 0
      for (const photo of addedPhotos) {
        try {
          await uploadPhotoBinary(photo)
        } catch {
          failed += 1
        }
      }
      await memoriesQuery.refetch()

      setEditorOpen(false)
      setDraft(null)
      setFlashKey(`m-${saved.ID}`)
      setToast(
        failed > 0
          ? `Memory posted. ${failed} photo${failed === 1 ? '' : 's'} could not be uploaded.`
          : 'Memory posted.',
      )
    } catch (error) {
      setEditorError(describeError(error))
    } finally {
      setSaving(false)
    }
  }

  const handleQuickCreate = async (expense: Expense) => {
    setBusyExpenseId(expense.ID)
    try {
      const saved = await createMemory.mutateAsync({
        expense_ID: expense.ID,
        title: titleFromExpense(expense),
        note: expense.note,
        occurredOn: expense.date,
        kind: momentToKind(expense.moment),
        pinned: false,
        place: expense.place,
        lat: expense.lat,
        lon: expense.lon,
      })
      setFlashKey(`m-${saved.ID}`)
      setToast('Memory posted. Add the story whenever you like.')
    } catch (error) {
      setToast(describeError(error))
    } finally {
      setBusyExpenseId(null)
    }
  }

  const handleTogglePin = async (entry: TimelineEntry) => {
    if (!entry.memoryID) return
    setBusyKey(entry.key)
    try {
      await updateMemory.mutateAsync({ id: entry.memoryID, patch: { pinned: !entry.pinned } })
      setToast(entry.pinned ? 'Unpinned.' : 'Pinned to the top.')
    } catch (error) {
      setToast(describeError(error))
    } finally {
      setBusyKey(null)
    }
  }

  const handleDelete = async () => {
    const target = deleteTarget
    if (!target?.memoryID) return
    setBusyKey(target.key)
    try {
      await deleteMemory.mutateAsync(target.memoryID)
      setToast('Memory deleted.')
    } catch (error) {
      setToast(describeError(error))
    } finally {
      setBusyKey(null)
      setDeleteTarget(null)
    }
  }

  const handleSaveDocumentOneNote = async (note: string): Promise<boolean> => {
    if (!documentOne) return false
    setSaving(true)
    setDocumentOneError(null)
    try {
      await updateExpense.mutateAsync({ id: documentOne.ID, patch: { note } })
      setToast('Document #1 updated.')
      return true
    } catch (error) {
      setDocumentOneError(describeError(error))
      return false
    } finally {
      setSaving(false)
    }
  }

  const openAnniversary = (anniversary: Anniversary) => {
    if (anniversary.source === 'document-one') {
      setDocumentOneError(null)
      setDocumentOneOpen(true)
      return
    }
    jumpTo(`m-${anniversary.ID}`)
  }

  /* ------------------------------------------------------------ render */

  const loading = memoriesQuery.isPending || expensesQuery.isPending
  const failed = memoriesQuery.isError || expensesQuery.isError
  const error = memoriesQuery.error ?? expensesQuery.error

  return (
    <div className="tw-memories">
      <div className="tw-memories__bar">
        <div className="tw-memories__heading">
          <Title level="H4">Memories</Title>
          <span className="tw-memories__count">
            {entries.length} {entries.length === 1 ? 'entry' : 'entries'} · {located.length} on the
            map
          </span>
        </div>
        <div className="tw-memories__actions">
          <SegmentedButton accessibleName="Timeline or map">
            <SegmentedButtonItem
              icon="list"
              selected={view === 'timeline'}
              onClick={() => setView('timeline')}
            >
              Timeline
            </SegmentedButtonItem>
            <SegmentedButtonItem
              icon="map-3"
              selected={view === 'map'}
              onClick={() => setView('map')}
            >
              Map
            </SegmentedButtonItem>
          </SegmentedButton>
          <Button design="Emphasized" icon="add" onClick={openBlankEditor}>
            New
          </Button>
        </div>
      </div>

      {failed ? <ErrorState error={error} onRetry={() => void memoriesQuery.refetch()} /> : null}

      {!failed && loading ? <LoadingSkeleton rows={5} /> : null}

      {!failed && !loading ? (
        <>
          <AnniversaryCard anniversaries={anniversaries} onOpen={openAnniversary} />

          <NewMemoriesStrip
            expenses={undocumented}
            busyExpenseId={busyExpenseId}
            onQuickCreate={expense => void handleQuickCreate(expense)}
            onCompose={openEditorForExpense}
          />

          {entries.length === 0 ? (
            <EmptyState
              icon="NoEntries"
              title="No memories posted yet"
              description="Scan a dinner or write one up by hand. Anything the classifier calls a date night, a trip or a gift turns up here on its own."
              action={
                <Button design="Emphasized" icon="add" onClick={openBlankEditor}>
                  New memory
                </Button>
              }
            />
          ) : view === 'map' ? (
            <Suspense
              fallback={
                <div className="tw-map" style={{ display: 'grid', placeItems: 'center' }}>
                  <BusyIndicator active delay={0} text="Loading the map" />
                </div>
              }
            >
              <MemoryMap
                entries={located}
                unlocatedCount={entries.length - located.length}
                onSelect={jumpTo}
              />
            </Suspense>
          ) : (
            <MemoryTimeline
              pinned={pinned}
              groups={groups}
              busyKey={busyKey}
              flashKey={flashKey}
              onEdit={openEditorForEntry}
              onCompose={openEditorForEntry}
              onTogglePin={entry => void handleTogglePin(entry)}
              onDelete={setDeleteTarget}
              onOpenDocumentOne={() => {
                setDocumentOneError(null)
                setDocumentOneOpen(true)
              }}
            />
          )}
        </>
      ) : null}

      <MemoryEditor
        open={editorOpen}
        draft={draft}
        saving={saving}
        error={editorError}
        onCancel={() => {
          setEditorOpen(false)
          setDraft(null)
        }}
        onSave={(values, addedPhotos) => void handleSave(values, addedPhotos)}
      />

      <DocumentOneReveal
        open={documentOneOpen}
        expense={documentOne}
        people={people}
        saving={saving}
        error={documentOneError}
        onClose={() => setDocumentOneOpen(false)}
        onSaveNote={handleSaveDocumentOneNote}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete this memory?"
        destructive
        busy={busyKey !== null}
        confirmText="Delete"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void handleDelete()}
      >
        <Text>
          “{deleteTarget?.title}” and its photos are removed. The expense behind it, if there is
          one, stays in the ledger.
        </Text>
      </ConfirmDialog>

      <Toast open={toast !== null} duration={3500} onClose={() => setToast(null)}>
        {toast ?? ''}
      </Toast>
    </div>
  )
}

export default MemoriesPage
