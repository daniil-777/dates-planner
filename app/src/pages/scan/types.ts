import type { MomentCode, ScanResult, ScoredLabel } from '../../api/types'

/** Where a queued image is in the pipeline. Drives the busy card copy. */
export type ScanPhase =
  'queued' | 'preparing' | 'uploading' | 'extracting' | 'classifying' | 'done' | 'error'

export interface ScanQueueItem {
  /** Client-side id; the server id lives on `result.ID`. */
  id: string
  fileName: string
  /** Object URL of the original pick, used for the thumbnail strip. */
  previewUrl: string
  /** Bytes actually uploaded, once the downscale has run. */
  uploadBytes: number | null
  phase: ScanPhase
  /** 0..100, monotonic within an attempt. */
  progress: number
  result: ScanResult | null
  error: string | null
  /** True once the draft has been posted or discarded. */
  handled: boolean
}

/** Everything the confirm card edits, as strings where the input owns the text. */
export interface DraftForm {
  merchant: string
  /** ISO `YYYY-MM-DD`, '' when unknown. */
  date: string
  /** `HH:mm`, '' when the receipt had no time. */
  time: string
  /** Raw text so a half-typed '12.' does not fight the user. */
  amount: string
  currency: string
  place: string
  category: string | null
  moment: MomentCode | null
  paidById: string | null
  /** `Events.ID` the posting belongs to, or null for ordinary everyday spending. */
  eventId: string | null
  note: string
  saveMemory: boolean
  memoryTitle: string
  memoryNote: string
}

/** A picked-but-not-yet-uploaded memory photo. */
export interface PickedPhoto {
  blob: Blob
  fileName: string
  previewUrl: string
}

/** What the confirm card was opened with. */
export type ConfirmOrigin = 'scan' | 'manual'

export interface PostedInfo {
  documentNumber: number | null
  merchant: string
  amount: number
  currency: string
  expenseId: string
  memorySaved: boolean
  /** Non-fatal problems worth showing without blocking the posting. */
  warnings: string[]
}

export type { MomentCode, ScanResult, ScoredLabel }
