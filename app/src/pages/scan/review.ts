import type { ScanResult } from '../../api/types'
import { NEEDS_REVIEW_THRESHOLD } from './constants'
import type { DraftForm } from './types'

export type ReviewField = 'merchant' | 'date' | 'amount' | 'category' | 'moment'

export interface ReviewState {
  /** Open the confirm card in REVIEW state. */
  needsReview: boolean
  /** Fields to highlight with an ObjectStatus warning. */
  fields: ReviewField[]
}

const EMPTY: ReviewState = { needsReview: false, fields: [] }

/** True when a probability exists and sits under the threshold. */
function lowConfidence(p: number | null): boolean {
  return typeof p === 'number' && Number.isFinite(p) && p < NEEDS_REVIEW_THRESHOLD
}

/**
 * Two-way match: the model's answer against the human's.
 *
 * Mirrors the backend rule behind the virtual `needsReview` (docs/API.md §3.8) —
 * no amount, no date, no merchant to classify, or any score under
 * NEEDS_REVIEW_THRESHOLD. We recompute it client-side as well so the card still
 * highlights the right field when `needsReview` is absent from an ordinary read.
 */
export function assessDraft(draft: ScanResult | null): ReviewState {
  if (!draft) return EMPTY

  const fields = new Set<ReviewField>()

  if (!draft.merchantRaw || draft.merchantRaw.trim() === '') fields.add('merchant')
  if (!draft.date) fields.add('date')
  if (!(Number(draft.amount) > 0)) fields.add('amount')
  if (!draft.category_code || lowConfidence(draft.categoryConfidence)) fields.add('category')
  if (!draft.moment || lowConfidence(draft.momentConfidence)) fields.add('moment')

  return {
    needsReview: draft.needsReview === true || fields.size > 0,
    fields: [...fields],
  }
}

/** True when the field now holds something a posting can use. */
function hasValue(field: ReviewField, form: DraftForm): boolean {
  switch (field) {
    case 'merchant':
      return form.merchant.trim() !== ''
    case 'date':
      return form.date !== ''
    case 'amount':
      return parseAmount(form.amount) > 0
    case 'category':
      return form.category !== null
    case 'moment':
      return form.moment !== null
  }
}

/**
 * Which flagged fields are still open.
 *
 * A field the model guessed badly is *pre-filled* — 31% confident is still a
 * value — so a non-empty check would clear the warning before anybody looked at
 * it. It stays lit until the human touches it and leaves something usable
 * behind. That is the two-way match: the model's answer, matched by a person's.
 */
export function unresolvedFields(
  review: ReviewState,
  form: DraftForm,
  touched: ReadonlySet<ReviewField>,
): ReviewField[] {
  return review.fields.filter(field => !(touched.has(field) && hasValue(field, form)))
}

/**
 * Accepts what a phone keyboard actually produces: '18.40', '18,40', "1'234.50".
 * Returns NaN for anything that is not a number, so callers can block the save.
 */
export function parseAmount(raw: string): number {
  const cleaned = raw.replace(/[\s'’ ]/g, '').replace(',', '.')
  if (cleaned === '') return Number.NaN
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : Number.NaN
}

/** Round half-up to 2 decimals, the way the backend does at the end of a calculation. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

export interface FormProblems {
  /** Blocking problems, keyed by field, shown as ObjectStatus Negative. */
  blocking: Partial<Record<ReviewField | 'paidBy', string>>
  canSave: boolean
}

/** The minimum a posting needs before it can become a document. */
export function validateForm(form: DraftForm): FormProblems {
  const blocking: FormProblems['blocking'] = {}
  if (form.merchant.trim() === '') blocking.merchant = 'A merchant is required'
  if (form.date === '') blocking.date = 'A date is required'
  const amount = parseAmount(form.amount)
  if (!Number.isFinite(amount)) blocking.amount = 'Enter an amount'
  else if (amount <= 0) blocking.amount = 'Amount must be greater than 0'
  if (form.paidById === null) blocking.paidBy = 'Choose who paid'

  return { blocking, canSave: Object.keys(blocking).length === 0 }
}
