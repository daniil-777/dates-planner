import {
  Button,
  Card,
  CardHeader,
  DatePicker,
  Form,
  FormItem,
  Input,
  Label,
  MessageStrip,
  ObjectStatus,
  Option,
  Select,
  Text,
  TextArea,
  TimePicker,
  type DatePickerPropTypes,
  type InputPropTypes,
  type SelectPropTypes,
  type TextAreaPropTypes,
  type TimePickerPropTypes,
} from '@ui5/webcomponents-react'
import '@ui5/webcomponents-icons/dist/accept.js'
import '@ui5/webcomponents-icons/dist/decline.js'
import { MoneyText } from '../../components/MoneyText'
import type { Category, Event, MomentCode, Person } from '../../api/types'
import { CURRENCY_CODES } from './constants'
import { CategoryPicker } from './CategoryPicker'
import { EventPicker } from './EventPicker'
import { MemorySection } from './MemorySection'
import { MomentPicker } from './MomentPicker'
import { PaidByToggle } from './PaidByToggle'
import { parseAmount, validateForm, type ReviewField, type ReviewState } from './review'
import type { RankedCategory } from './form'
import type { ConfirmOrigin, DraftForm, PickedPhoto } from './types'

interface ConfirmCardProps {
  origin: ConfirmOrigin
  /** File name of the scanned receipt, for the card subtitle. */
  sourceLabel: string
  form: DraftForm
  onChange: (patch: Partial<DraftForm>) => void
  categories: Category[]
  rankedCategories: RankedCategory[]
  momentOrder: MomentCode[]
  momentConfidence: (code: MomentCode) => number | null
  people: Person[]
  events: Event[]
  review: ReviewState
  /** Highlighted fields the human has not settled yet. */
  openFields: ReviewField[]
  receiptPreviewUrl: string | null
  memoryPhoto: PickedPhoto | null
  onMemoryPhotoPick: (file: File) => void
  onMemoryPhotoClear: () => void
  saving: boolean
  saveError: string | null
  onSave: () => void
  onDiscard: () => void
  /** Shown when there are more receipts waiting behind this one. */
  queuedBehind: number
}

const REVIEW_LINE = 'Two-way match needed — please confirm'

function warn(open: ReviewField[], field: ReviewField): boolean {
  return open.includes(field)
}

/**
 * The confirm card. Everything the model guessed is editable, the uncertain
 * bits are flagged, and nothing is posted until a human says so.
 */
export function ConfirmCard({
  origin,
  sourceLabel,
  form,
  onChange,
  categories,
  rankedCategories,
  momentOrder,
  momentConfidence,
  people,
  events,
  review,
  openFields,
  receiptPreviewUrl,
  memoryPhoto,
  onMemoryPhotoPick,
  onMemoryPhotoClear,
  saving,
  saveError,
  onSave,
  onDiscard,
  queuedBehind,
}: ConfirmCardProps) {
  const problems = validateForm(form)
  const amount = parseAmount(form.amount)
  const selectedCategory = categories.find(c => c.code === form.category) ?? null

  const handleMerchant: InputPropTypes['onInput'] = event => {
    onChange({ merchant: event.target.value })
  }
  const handleAmount: InputPropTypes['onInput'] = event => {
    onChange({ amount: event.target.value })
  }
  const handlePlace: InputPropTypes['onInput'] = event => {
    onChange({ place: event.target.value })
  }
  const handleNote: TextAreaPropTypes['onInput'] = event => {
    onChange({ note: event.target.value })
  }
  const handleDate: DatePickerPropTypes['onChange'] = event => {
    onChange({ date: event.detail.value })
  }
  const handleTime: TimePickerPropTypes['onChange'] = event => {
    onChange({ time: event.detail.value })
  }
  const handleCurrency: SelectPropTypes['onChange'] = event => {
    const value = event.detail.selectedOption.value
    if (value) onChange({ currency: value })
  }

  // A receipt can carry a currency we do not list; never drop the scanned value.
  const currencyOptions: string[] = (CURRENCY_CODES as readonly string[]).includes(form.currency)
    ? [...CURRENCY_CODES]
    : [form.currency, ...CURRENCY_CODES]

  return (
    <Card
      className="scan-card"
      data-testid="scan-confirm-card"
      header={
        <CardHeader
          titleText={review.needsReview ? 'Needs review' : 'Confirm posting'}
          subtitleText={origin === 'manual' ? 'Manual entry — no receipt' : sourceLabel}
          additionalText={queuedBehind > 0 ? `${queuedBehind} more queued` : undefined}
        />
      }
    >
      <div className="scan-card-body">
        {review.needsReview ? (
          openFields.length > 0 ? (
            <MessageStrip design="Critical" hideCloseButton data-testid="scan-review-strip">
              {REVIEW_LINE}
            </MessageStrip>
          ) : (
            <MessageStrip design="Positive" hideCloseButton data-testid="scan-review-cleared">
              Two-way match complete — ready to post.
            </MessageStrip>
          )
        ) : null}

        {saveError ? (
          <MessageStrip design="Negative" hideCloseButton data-testid="scan-save-error">
            {saveError}
          </MessageStrip>
        ) : null}

        {receiptPreviewUrl ? (
          <img
            className="scan-busy-thumb"
            src={receiptPreviewUrl}
            alt={`Receipt for ${form.merchant || 'this posting'}`}
          />
        ) : null}

        <Form layout="S1 M1 L1 XL1" labelSpan="S12 M4 L4 XL4" accessibleName="Expense details">
          <FormItem
            labelContent={
              <Label for="scan-merchant" required>
                Merchant
              </Label>
            }
          >
            <div className="scan-field-stack">
              <Input
                id="scan-merchant"
                value={form.merchant}
                placeholder="Who was paid"
                accessibleName="Merchant"
                valueState={
                  problems.blocking.merchant
                    ? 'Negative'
                    : warn(openFields, 'merchant')
                      ? 'Critical'
                      : 'None'
                }
                onInput={handleMerchant}
              />
              {warn(openFields, 'merchant') ? (
                <ObjectStatus state="Critical" showDefaultIcon>
                  Document AI could not read the merchant
                </ObjectStatus>
              ) : null}
            </div>
          </FormItem>

          <FormItem
            labelContent={
              <Label for="scan-date" required>
                Date
              </Label>
            }
          >
            <div className="scan-field-stack">
              <DatePicker
                id="scan-date"
                value={form.date}
                formatPattern="yyyy-MM-dd"
                accessibleName="Date"
                valueState={
                  problems.blocking.date
                    ? 'Negative'
                    : warn(openFields, 'date')
                      ? 'Critical'
                      : 'None'
                }
                onChange={handleDate}
              />
              {warn(openFields, 'date') ? (
                <ObjectStatus state="Critical" showDefaultIcon>
                  No date on the receipt
                </ObjectStatus>
              ) : null}
            </div>
          </FormItem>

          <FormItem labelContent={<Label for="scan-time">Time</Label>}>
            <TimePicker
              id="scan-time"
              value={form.time}
              formatPattern="HH:mm"
              accessibleName="Time"
              onChange={handleTime}
            />
          </FormItem>

          <FormItem
            labelContent={
              <Label for="scan-amount" required>
                Amount
              </Label>
            }
          >
            <div className="scan-field-stack">
              <div className="scan-amount-row">
                <Input
                  id="scan-amount"
                  className="scan-amount-input"
                  value={form.amount}
                  type="Text"
                  inputMode="decimal"
                  placeholder="0.00"
                  accessibleName="Amount"
                  valueState={
                    problems.blocking.amount
                      ? 'Negative'
                      : warn(openFields, 'amount')
                        ? 'Critical'
                        : 'None'
                  }
                  onInput={handleAmount}
                />
                <Select
                  id="scan-currency"
                  className="scan-currency-select"
                  accessibleName="Currency"
                  onChange={handleCurrency}
                >
                  {currencyOptions.map(code => (
                    <Option key={code} value={code} selected={code === form.currency}>
                      {code}
                    </Option>
                  ))}
                </Select>
              </div>
              {warn(openFields, 'amount') ? (
                <ObjectStatus state="Critical" showDefaultIcon>
                  No total was extracted — type it from the receipt
                </ObjectStatus>
              ) : null}
              {Number.isFinite(amount) && amount > 0 ? (
                <Text className="scan-field-note">
                  Posting <MoneyText amount={amount} currency={form.currency} bold />
                </Text>
              ) : null}
            </div>
          </FormItem>

          <FormItem labelContent={<Label for="scan-place">Place</Label>}>
            <Input
              id="scan-place"
              value={form.place}
              placeholder="City or venue"
              accessibleName="Place"
              onInput={handlePlace}
            />
          </FormItem>

          <FormItem labelContent={<Label required>Category</Label>}>
            <div className="scan-field-stack">
              <CategoryPicker
                ranked={rankedCategories}
                selected={form.category}
                onSelect={code => onChange({ category: code })}
              />
              {warn(openFields, 'category') ? (
                <ObjectStatus state="Critical" showDefaultIcon>
                  Low confidence — pick the right category
                </ObjectStatus>
              ) : selectedCategory ? (
                <Text className="scan-field-note">Posting to {selectedCategory.name}</Text>
              ) : null}
            </div>
          </FormItem>

          <FormItem labelContent={<Label>Moment</Label>}>
            <div className="scan-field-stack">
              <MomentPicker
                order={momentOrder}
                selected={form.moment}
                confidence={momentConfidence}
                onSelect={code => onChange({ moment: code })}
              />
              {warn(openFields, 'moment') ? (
                <ObjectStatus state="Critical" showDefaultIcon>
                  Low confidence — confirm the moment
                </ObjectStatus>
              ) : null}
            </div>
          </FormItem>

          <FormItem labelContent={<Label required>Paid by</Label>}>
            <div className="scan-field-stack">
              <PaidByToggle
                people={people}
                selected={form.paidById}
                onSelect={id => onChange({ paidById: id })}
              />
              {problems.blocking.paidBy ? (
                <ObjectStatus state="Critical" showDefaultIcon>
                  {problems.blocking.paidBy}
                </ObjectStatus>
              ) : null}
            </div>
          </FormItem>

          <FormItem labelContent={<Label>Event</Label>}>
            <EventPicker
              events={events}
              selected={form.eventId}
              onSelect={eventId => onChange({ eventId })}
            />
          </FormItem>

          <FormItem labelContent={<Label for="scan-note">Note</Label>}>
            <TextArea
              id="scan-note"
              value={form.note}
              rows={2}
              placeholder="Anything the ledger should remember"
              accessibleName="Note"
              onInput={handleNote}
            />
          </FormItem>
        </Form>

        <MemorySection
          form={form}
          onChange={onChange}
          photo={memoryPhoto}
          onPhotoPick={onMemoryPhotoPick}
          onPhotoClear={onMemoryPhotoClear}
        />

        <div className="scan-actions">
          <Button
            className="scan-actions-grow"
            design="Emphasized"
            icon="accept"
            disabled={!problems.canSave || saving}
            accessibleName="Post this expense to the ledger"
            onClick={onSave}
          >
            {saving ? 'Posting…' : 'Post'}
          </Button>
          <Button
            design="Transparent"
            icon="decline"
            disabled={saving}
            accessibleName="Discard this draft"
            onClick={onDiscard}
          >
            Discard
          </Button>
        </div>
      </div>
    </Card>
  )
}
