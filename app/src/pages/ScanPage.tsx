/**
 * Scan — the front door.
 *
 * One photo goes in; a draft document comes back. `scanReceipt` (docs/API.md §3.8) does the
 * whole pipeline server-side — normalise, Document AI, map, classify, insert a draft — so
 * this page's job is the two things a server cannot do: get a good picture off the phone
 * without blowing the 10 MB limit, and put the model's guess in front of a human who can
 * overrule it.
 *
 * That overruling is the point. `confirmExpense` is called with what the model *predicted*
 * as well as what is finally stored, and the difference is written to `Corrections` — the
 * training set for the next round. A confirm card that silently posted the model's answer
 * would teach it nothing.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { useNavigate } from 'react-router-dom'
import { MessageStrip, Text, Title, Toast } from '@ui5/webcomponents-react'
import { useCategories, useDeleteExpense, useEvents, useHealth, usePeople } from '@/api/hooks'
import { useI18n } from '@/i18n'
import type { Expense, MomentCode } from '@/api/types'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { ErrorState } from '@/components/ErrorState'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { CaptureCard } from './scan/CaptureCard'
import { ConfirmCard } from './scan/ConfirmCard'
import { PostedCard } from './scan/PostedCard'
import { ScanBusyCard } from './scan/ScanBusyCard'
import { ScanQueueStrip } from './scan/ScanQueueStrip'
import {
  defaultPayer,
  emptyForm,
  formFromDraft,
  momentConfidence,
  rankCategories,
  rankMoments,
} from './scan/form'
import { prepareImage } from './scan/imageProcessing'
import { assessDraft, unresolvedFields, type ReviewField } from './scan/review'
import { useScanQueue } from './scan/useScanQueue'
import { usePostExpense } from './scan/usePostExpense'
import type { DraftForm, PickedPhoto, PostedInfo } from './scan/types'
import './scan/scan.css'

/** Sentinel for the manual-entry card, which has no queue item behind it. */
const MANUAL_KEY = 'manual'

/** Form fields that can be flagged for review, and the flag each one clears. */
const TOUCH_MAP = {
  merchant: 'merchant',
  date: 'date',
  amount: 'amount',
  category: 'category',
  moment: 'moment',
} as const satisfies Record<string, ReviewField>

const REVIEWABLE_KEYS = Object.keys(TOUCH_MAP) as Array<keyof typeof TOUCH_MAP>

export function ScanPage(): ReactElement {
  const categories = useCategories()
  const people = usePeople()
  const events = useEvents()

  // `/health` already reports which Document AI path is live, so the banner below needs no
  // new field on the scan response. Undefined while the probe is in flight, and treated as
  // "not mock" then: a strip that flashes on every page load would be noise, and the real
  // answer arrives in milliseconds.
  const health = useHealth()
  const { t } = useI18n()
  const docAiIsMock = health.data?.docai === 'mock'
  const deleteExpense = useDeleteExpense()
  const queue = useScanQueue()
  const posting = usePostExpense()
  const navigate = useNavigate()

  const [manualOpen, setManualOpen] = useState(false)
  const [form, setForm] = useState<DraftForm | null>(null)
  const [memoryPhoto, setMemoryPhoto] = useState<PickedPhoto | null>(null)
  const [posted, setPosted] = useState<PostedInfo | null>(null)
  const [duplicates, setDuplicates] = useState<Expense[]>([])
  const [toastText, setToastText] = useState('')
  const [toastOpen, setToastOpen] = useState(false)
  const [discardOpen, setDiscardOpen] = useState(false)
  const [touched, setTouched] = useState<ReadonlySet<ReviewField>>(new Set())

  const initialisedFor = useRef<string | null>(null)
  const memoryPhotoRef = useRef<PickedPhoto | null>(null)
  memoryPhotoRef.current = memoryPhoto

  const categoryRows = useMemo(() => categories.data ?? [], [categories.data])
  const peopleRows = useMemo(() => people.data ?? [], [people.data])
  const eventRows = useMemo(() => events.data ?? [], [events.data])
  const defaultPayerId = useMemo(() => defaultPayer(peopleRows), [peopleRows])

  const activeItem = queue.active
  const draft = activeItem?.result ?? null
  const activeKey = manualOpen ? MANUAL_KEY : (activeItem?.id ?? null)
  const origin = manualOpen ? 'manual' : 'scan'

  // Build the form once per draft. Re-running it when master data lands would
  // throw away whatever the human has already typed.
  useEffect(() => {
    if (activeKey === null) {
      initialisedFor.current = null
      setForm(null)
      return
    }
    if (initialisedFor.current === activeKey) return
    initialisedFor.current = activeKey
    setTouched(new Set())
    setForm(
      activeKey === MANUAL_KEY
        ? emptyForm(defaultPayerId)
        : draft
          ? formFromDraft(draft, defaultPayerId)
          : null,
    )
  }, [activeKey, draft, defaultPayerId])

  // The roster usually arrives before the first scan finishes, but not always.
  useEffect(() => {
    if (defaultPayerId === null) return
    setForm(prev => (prev && prev.paidById === null ? { ...prev, paidById: defaultPayerId } : prev))
  }, [defaultPayerId])

  const review = useMemo(() => assessDraft(draft), [draft])
  const openFields = useMemo(
    () => (form ? unresolvedFields(review, form, touched) : []),
    [review, form, touched],
  )

  const rankedCategories = useMemo(
    () =>
      rankCategories(
        categoryRows,
        draft?.categoryTop3,
        draft?.category_code ?? null,
        draft?.categoryConfidence ?? null,
      ),
    [categoryRows, draft],
  )

  const momentOrder = useMemo(() => rankMoments(draft?.momentTop3, draft?.moment ?? null), [draft])

  const momentScore = useCallback(
    (code: MomentCode) =>
      momentConfidence(
        draft?.momentTop3,
        code,
        draft?.moment ?? null,
        draft?.momentConfidence ?? null,
      ),
    [draft],
  )

  const clearMemoryPhoto = useCallback(() => {
    setMemoryPhoto(prev => {
      if (prev) URL.revokeObjectURL(prev.previewUrl)
      return null
    })
  }, [])

  const handleMemoryPhoto = useCallback((file: File) => {
    void (async () => {
      const prepared = await prepareImage(file)
      setMemoryPhoto(prev => {
        if (prev) URL.revokeObjectURL(prev.previewUrl)
        return {
          blob: prepared.blob,
          fileName: prepared.fileName,
          previewUrl: URL.createObjectURL(prepared.blob),
        }
      })
    })()
  }, [])

  // Object URLs are not garbage-collected with the component that made them.
  useEffect(
    () => () => {
      if (memoryPhotoRef.current) URL.revokeObjectURL(memoryPhotoRef.current.previewUrl)
    },
    [],
  )

  const handleChange = useCallback((patch: Partial<DraftForm>) => {
    setForm(prev => (prev ? { ...prev, ...patch } : prev))
    // Touching a flagged field is what clears its warning — see `unresolvedFields`.
    const settled = REVIEWABLE_KEYS.filter(key => key in patch).map(key => TOUCH_MAP[key])
    if (settled.length > 0) {
      setTouched(prev => {
        if (settled.every(field => prev.has(field))) return prev
        const next = new Set(prev)
        for (const field of settled) next.add(field)
        return next
      })
    }
  }, [])

  const handleFiles = useCallback(
    (files: File[]) => {
      setPosted(null)
      setDuplicates([])
      setManualOpen(false)
      queue.addFiles(files)
    },
    [queue],
  )

  const handleManual = useCallback(() => {
    setPosted(null)
    setDuplicates([])
    setManualOpen(true)
  }, [])

  const handleSave = useCallback(() => {
    if (!form) return
    void (async () => {
      const outcome = await posting.post({
        origin,
        draftId: draft?.ID ?? null,
        form,
        predictedCategory: draft?.category_code ?? null,
        predictedMoment: draft?.moment ?? null,
        memoryPhoto,
        onConfirmed: confirmed => {
          setToastText(
            confirmed.documentNumber === null
              ? 'Posted to the ledger'
              : `Posted as document #${confirmed.documentNumber}`,
          )
          setToastOpen(true)
        },
      })
      if (!outcome) return
      setPosted(outcome.posted)
      setDuplicates(outcome.duplicates)
      clearMemoryPhoto()
      if (activeItem) queue.markHandled(activeItem.id)
      setManualOpen(false)
      initialisedFor.current = null
    })()
  }, [activeItem, clearMemoryPhoto, draft, form, memoryPhoto, origin, posting, queue])

  const confirmDiscard = useCallback(() => {
    setDiscardOpen(false)
    clearMemoryPhoto()
    if (manualOpen) {
      setManualOpen(false)
      initialisedFor.current = null
      setForm(null)
      return
    }
    if (!activeItem) return
    const draftId = activeItem.result?.ID
    // The receipt row stays either way — the backend keeps the evidence.
    if (draftId) deleteExpense.mutate(draftId)
    queue.markHandled(activeItem.id)
    initialisedFor.current = null
  }, [activeItem, clearMemoryPhoto, deleteExpense, manualOpen, queue])

  const handleScanAnother = useCallback(() => {
    setPosted(null)
    setDuplicates([])
  }, [])

  const masterLoading = categories.isLoading || people.isLoading
  const masterError = categories.error ?? people.error
  const showConfirm = form !== null && activeKey !== null && posted === null
  const showBusy = !showConfirm && posted === null && queue.inFlight !== null
  const showHero = !showConfirm && !showBusy && posted === null

  return (
    <div className="scan-page">
      <Title level="H2">{t('scan.title', 'Scan')}</Title>
      <Text className="scan-hint">
        {t(
          'scan.hint',
          'Photograph a receipt. Document AI reads it, the classifier files it, you confirm it.',
        )}
      </Text>

      {/*
        Say so when nothing is actually being read.

        With no DOCAI_* credentials configured the client falls back to replaying a bundled
        fixture (CONTRACTS.md §6), and the fixture is chosen by *file name* — so a photo
        straight off a phone camera always lands on the same one, and every scan comes back
        with the same merchant and the same amount no matter what was photographed. That is
        the intended behaviour for a laptop with no BTP account. What is not acceptable is
        letting it look like a reading: an amount nobody extracted, presented the way an
        extracted one is, gets confirmed and posted, and the ledger is quietly wrong.
      */}
      {docAiIsMock ? (
        <MessageStrip design="Critical" hideCloseButton className="scan-mock-strip">
          {t(
            'scan.mock',
            'Demo extraction — no Document AI credentials are configured, so these amounts come from a bundled sample receipt and not from your photo. Check every field before posting.',
          )}
        </MessageStrip>
      ) : null}

      {masterLoading ? (
        <LoadingSkeleton rows={3} variant="card" />
      ) : masterError ? (
        <ErrorState
          error={masterError}
          onRetry={() => {
            void categories.refetch()
            void people.refetch()
          }}
        />
      ) : (
        <>
          {posted ? (
            <PostedCard
              posted={posted}
              duplicates={duplicates}
              onScanAnother={handleScanAnother}
              onOpenLedger={() => navigate('/ledger')}
            />
          ) : null}

          {showConfirm && form ? (
            <ConfirmCard
              origin={origin}
              sourceLabel={activeItem?.fileName ?? 'Receipt'}
              form={form}
              onChange={handleChange}
              categories={categoryRows}
              rankedCategories={rankedCategories}
              momentOrder={momentOrder}
              momentConfidence={momentScore}
              people={peopleRows}
              events={eventRows}
              review={review}
              openFields={openFields}
              receiptPreviewUrl={manualOpen ? null : (activeItem?.previewUrl ?? null)}
              memoryPhoto={memoryPhoto}
              onMemoryPhotoPick={handleMemoryPhoto}
              onMemoryPhotoClear={clearMemoryPhoto}
              saving={posting.saving}
              saveError={posting.error}
              onSave={handleSave}
              onDiscard={() => setDiscardOpen(true)}
              queuedBehind={queue.queuedBehind}
            />
          ) : null}

          {showBusy && queue.inFlight ? (
            <ScanBusyCard item={queue.inFlight} remaining={queue.queuedBehind} />
          ) : null}

          <ScanQueueStrip items={queue.items} onRetry={queue.retry} onRemove={queue.remove} />

          {showHero ? (
            <CaptureCard
              onFiles={handleFiles}
              onManual={handleManual}
              busy={queue.inFlight !== null}
              compact={queue.items.length > 0}
            />
          ) : (
            <CaptureCard
              onFiles={handleFiles}
              onManual={handleManual}
              busy={queue.inFlight !== null}
              compact
            />
          )}
        </>
      )}

      <ConfirmDialog
        open={discardOpen}
        title="Discard this draft?"
        confirmText="Discard"
        destructive
        onConfirm={confirmDiscard}
        onCancel={() => setDiscardOpen(false)}
      >
        The draft document is deleted. The receipt image stays on file, so the same photo can be
        scanned again.
      </ConfirmDialog>

      <Toast
        open={toastOpen}
        duration={4000}
        onClose={() => setToastOpen(false)}
        data-testid="scan-toast"
      >
        {toastText}
      </Toast>
    </div>
  )
}

export default ScanPage
