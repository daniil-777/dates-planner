import type {
  Category,
  Expense,
  Memory,
  MemoryKind,
  MomentCode,
  Person,
  ScanResult,
} from '../../api/types'
import { DEFAULT_CURRENCY, MOMENT_CODES } from './constants'
import { parseAmount, round2 } from './review'
import type { DraftForm, ScoredLabel } from './types'

function asMoment(value: string | null): MomentCode | null {
  return MOMENT_CODES.find(code => code === value) ?? null
}

/** `20:15:00` and `20:15` both arrive; the picker wants `HH:mm`. */
export function toDisplayTime(value: string | null): string {
  if (!value) return ''
  const match = /^(\d{1,2}):(\d{2})/.exec(value)
  if (!match) return ''
  return `${match[1].padStart(2, '0')}:${match[2]}`
}

/** CDS `Time` wants seconds. */
export function toStoredTime(value: string): string | null {
  const display = toDisplayTime(value)
  return display === '' ? null : `${display}:00`
}

export function todayIso(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = `${now.getMonth() + 1}`.padStart(2, '0')
  const d = `${now.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function nowTime(now: Date = new Date()): string {
  return `${`${now.getHours()}`.padStart(2, '0')}:${`${now.getMinutes()}`.padStart(2, '0')}`
}

/** A blank posting, for the manual-entry fallback. */
export function emptyForm(defaultPayerId: string | null, now: Date = new Date()): DraftForm {
  return {
    merchant: '',
    date: todayIso(now),
    time: nowTime(now),
    amount: '',
    currency: DEFAULT_CURRENCY,
    place: '',
    category: null,
    moment: null,
    paidById: defaultPayerId,
    eventId: null,
    note: '',
    saveMemory: false,
    memoryTitle: '',
    memoryNote: '',
  }
}

/** The scanned draft, dressed as editable form state. */
export function formFromDraft(draft: ScanResult, defaultPayerId: string | null): DraftForm {
  const amount = Number(draft.amount)
  return {
    merchant: draft.merchantRaw ?? '',
    date: draft.date ?? '',
    time: toDisplayTime(draft.time),
    amount: Number.isFinite(amount) && amount > 0 ? amount.toFixed(2) : '',
    currency: draft.currency || DEFAULT_CURRENCY,
    place: draft.place ?? '',
    category: draft.category_code,
    moment: asMoment(draft.moment),
    paidById: draft.paidBy_ID ?? defaultPayerId,
    eventId: draft.event_ID,
    note: draft.note ?? '',
    saveMemory: false,
    memoryTitle: draft.merchantRaw ?? '',
    memoryNote: '',
  }
}

/** What the human edited, as an OData PATCH body. */
export function patchFromForm(form: DraftForm): Partial<Expense> {
  return {
    merchantRaw: form.merchant.trim(),
    date: form.date,
    time: toStoredTime(form.time),
    amount: round2(parseAmount(form.amount)),
    currency: form.currency,
    category_code: form.category,
    moment: form.moment,
    paidBy_ID: form.paidById,
    event_ID: form.eventId,
    note: form.note.trim() === '' ? null : form.note.trim(),
    place: form.place.trim() === '' ? null : form.place.trim(),
  }
}

/** Manual entry: the same body, plus the bits only a create can set. */
export function createBodyFromForm(form: DraftForm): Partial<Expense> {
  return { ...patchFromForm(form), status: 'draft', source: 'manual' }
}

const MEMORY_KIND_BY_MOMENT: Record<MomentCode, MemoryKind> = {
  everyday: 'other',
  date_night: 'date_night',
  trip: 'trip',
  gift: 'gift',
}

export function memoryKindFor(moment: MomentCode | null): MemoryKind {
  return moment ? MEMORY_KIND_BY_MOMENT[moment] : 'other'
}

export function memoryFromForm(form: DraftForm, expenseId: string): Partial<Memory> {
  const title = form.memoryTitle.trim() || form.merchant.trim() || 'Untitled memory'
  return {
    expense_ID: expenseId,
    title,
    note: form.memoryNote.trim() === '' ? null : form.memoryNote.trim(),
    occurredOn: form.date,
    kind: memoryKindFor(form.moment),
    pinned: false,
    place: form.place.trim() === '' ? null : form.place.trim(),
  }
}

export interface RankedCategory {
  category: Category
  /** Model probability, when the model had an opinion about this code. */
  p: number | null
}

/**
 * Chips sorted by model probability, best first, then everything else by the
 * sort order from the Categories code list. A human still sees all ten.
 */
export function rankCategories(
  categories: Category[],
  top: ScoredLabel[] | undefined,
  predicted: string | null,
  predictedConfidence: number | null,
): RankedCategory[] {
  const byCode = new Map(categories.map(c => [c.code, c]))
  const scored: RankedCategory[] = []
  const used = new Set<string>()

  const scores: ScoredLabel[] =
    top && top.length > 0
      ? [...top].sort((a, b) => b.p - a.p)
      : predicted
        ? [{ label: predicted, p: predictedConfidence ?? 0 }]
        : []

  for (const entry of scores) {
    const category = byCode.get(entry.label)
    if (!category || used.has(category.code)) continue
    used.add(category.code)
    scored.push({ category, p: entry.p })
  }

  const rest = categories
    .filter(c => !used.has(c.code))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code))
    .map(category => ({ category, p: null }))

  return [...scored, ...rest]
}

/** Moments in model order too, so the likeliest reads first. */
export function rankMoments(
  top: ScoredLabel[] | undefined,
  predicted: MomentCode | null,
): MomentCode[] {
  const ordered: MomentCode[] = []
  const push = (code: MomentCode | null) => {
    if (code && !ordered.includes(code)) ordered.push(code)
  }
  if (top && top.length > 0) {
    for (const entry of [...top].sort((a, b) => b.p - a.p)) push(asMoment(entry.label))
  } else {
    push(predicted)
  }
  for (const code of MOMENT_CODES) push(code)
  return ordered
}

export function momentConfidence(
  top: ScoredLabel[] | undefined,
  code: MomentCode,
  predicted: MomentCode | null,
  predictedConfidence: number | null,
): number | null {
  const hit = top?.find(entry => entry.label === code)
  if (hit) return hit.p
  if (code === predicted) return predictedConfidence
  return null
}

/**
 * Who to pre-select as payer when nothing else says.
 *
 * The first seeded person, whoever that is. The household may have two people or ten
 * (CONTRACTS.md §10), so this is a default and never an assumption.
 */
export function defaultPayer(people: Person[]): string | null {
  return people[0]?.ID ?? null
}
