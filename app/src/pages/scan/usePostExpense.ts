import { useCallback, useState } from 'react'
import { api, describeError } from '../../api/client'
import {
  useConfirmExpense,
  useCreateExpense,
  useCreateMemory,
  useUpdateExpense,
} from '../../api/hooks'
import type { Expense } from '../../api/types'
import { createBodyFromForm, memoryFromForm, patchFromForm } from './form'
import { parseAmount } from './review'
import type { ConfirmOrigin, DraftForm, PickedPhoto, PostedInfo } from './types'

export interface PostRequest {
  origin: ConfirmOrigin
  /** The draft the scan created. Null for manual entry — we create the row first. */
  draftId: string | null
  form: DraftForm
  /** What the model said before the human touched the row; logged as a Correction. */
  predictedCategory: string | null
  predictedMoment: string | null
  memoryPhoto: PickedPhoto | null
  /**
   * Fired the moment the document number exists, before the memory and the
   * duplicate check — so the toast lands when the posting lands.
   */
  onConfirmed?: (expense: Expense) => void
}

export interface PostOutcome {
  posted: PostedInfo
  /** Same merchant, same money, within two days. Shown as a gentle 'Verify'. */
  duplicates: Expense[]
}

function mediaTypeOf(photo: PickedPhoto): string {
  if (photo.blob.type) return photo.blob.type
  return /\.png$/i.test(photo.fileName) ? 'image/png' : 'image/jpeg'
}

function newUuid(): string {
  const source = globalThis.crypto
  if (source && typeof source.randomUUID === 'function') return source.randomUUID()
  // RFC 4122 v4, good enough as a client-generated key for a deep insert.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, char => {
    const r = Math.floor(Math.random() * 16)
    const v = char === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/**
 * `Photos.image` is a media stream, so the bytes go up as a PUT after the row
 * exists — the same shape `Receipts.image` uses (docs/API.md §2).
 */
async function uploadPhotoBytes(photoId: string, photo: PickedPhoto): Promise<void> {
  const response = await fetch(api.photoImageUrl(photoId), {
    method: 'PUT',
    headers: { 'Content-Type': mediaTypeOf(photo) },
    body: photo.blob,
  })
  if (!response.ok) {
    throw new Error(`The photo could not be uploaded (HTTP ${response.status}).`)
  }
}

/**
 * Post a draft as a document.
 *
 * Order matters: store the human's edits, then confirm — `confirmExpense`
 * compares what the model predicted with what is finally stored, and that
 * comparison is the training signal, so the PATCH has to land first.
 */
export function usePostExpense() {
  const createExpense = useCreateExpense()
  const updateExpense = useUpdateExpense()
  const confirmExpense = useConfirmExpense()
  const createMemory = useCreateMemory()

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const createAsync = createExpense.mutateAsync
  const updateAsync = updateExpense.mutateAsync
  const confirmAsync = confirmExpense.mutateAsync
  const memoryAsync = createMemory.mutateAsync

  const post = useCallback(
    async (request: PostRequest): Promise<PostOutcome | null> => {
      setSaving(true)
      setError(null)
      const warnings: string[] = []

      try {
        const stored =
          request.origin === 'scan' && request.draftId
            ? await updateAsync({ id: request.draftId, patch: patchFromForm(request.form) })
            : await createAsync(createBodyFromForm(request.form))

        const confirmed = await confirmAsync({
          id: stored.ID,
          predictedCategory: request.predictedCategory ?? '',
          predictedMoment: request.predictedMoment ?? '',
        })

        request.onConfirmed?.(confirmed)

        let memorySaved = false
        if (request.form.saveMemory) {
          try {
            const body = memoryFromForm(request.form, confirmed.ID)
            const photoId = request.memoryPhoto ? newUuid() : null
            const memory = await memoryAsync(
              photoId && request.memoryPhoto
                ? {
                    ...body,
                    photos: [
                      {
                        ID: photoId,
                        mediaType: mediaTypeOf(request.memoryPhoto),
                        caption: body.title ?? null,
                      },
                    ],
                  }
                : body,
            )
            memorySaved = true
            if (photoId && request.memoryPhoto) {
              const target = memory.photos?.[0]?.ID ?? photoId
              try {
                await uploadPhotoBytes(target, request.memoryPhoto)
              } catch (photoError) {
                warnings.push(describeError(photoError))
              }
            }
          } catch (memoryError) {
            warnings.push(`The memory was not saved: ${describeError(memoryError)}`)
          }
        }

        let duplicates: Expense[] = []
        try {
          duplicates = await api.duplicates(confirmed.ID)
        } catch {
          // A failed duplicate check is never a reason to doubt a posted document.
          warnings.push('Could not check for duplicates just now.')
        }

        const amount = Number.isFinite(confirmed.amount)
          ? confirmed.amount
          : parseAmount(request.form.amount)

        return {
          posted: {
            documentNumber: confirmed.documentNumber,
            merchant: confirmed.merchantRaw || request.form.merchant,
            amount,
            currency: confirmed.currency || request.form.currency,
            expenseId: confirmed.ID,
            memorySaved,
            warnings,
          },
          duplicates,
        }
      } catch (postError) {
        setError(describeError(postError))
        return null
      } finally {
        setSaving(false)
      }
    },
    [confirmAsync, createAsync, memoryAsync, updateAsync],
  )

  const clearError = useCallback(() => setError(null), [])

  return { post, saving, error, clearError }
}
