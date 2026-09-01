/**
 * First launch.
 *
 * Four screens: who is on this ledger, then Document #1, then the offer to import a bank
 * statement. The middle one is the reason this wizard exists at all — every other step is
 * a form, and that one is not. It is the ledger's first posting, `documentNumber = 1`,
 * read-only except for its note (CONTRACTS.md §10), revealed a line at a time in a room
 * with the lights down, with one input underneath in case there is something to add.
 *
 * The roster step defaults to the two seeded rows and does not stop there: however many
 * people pay for things in this house, they are all named here, and any of them can be
 * added later in Settings. Nothing about the app assumes a particular number of them.
 *
 * The flag that gates all of it is `twm.onboarded` in `localStorage` (`onboarding.ts`).
 * Nothing here writes it — `SettingsPage` does, when the wizard reports that it is done —
 * so a reload half way through starts the introduction again rather than losing it.
 */
import { useEffect, useMemo, useState } from 'react'
import { Button, Input, Label, MessageStrip, Text, Title } from '@ui5/webcomponents-react'
import '@ui5/webcomponents-icons/dist/arrow-right.js'
import '@ui5/webcomponents-icons/dist/upload.js'
import '@ui5/webcomponents-icons/dist/add.js'
import '@ui5/webcomponents-icons/dist/decline.js'
import {
  useCreatePerson,
  useExpenses,
  usePeople,
  useUpdateExpense,
  useUpdatePerson,
} from '@/api/hooks'
import type { Expense, Person } from '@/api/types'
import { MoneyText } from '@/components/MoneyText'
import { PersonAvatar } from '@/components/PersonAvatar'
import { formatDate } from '@/theme'
import {
  ColourSwatches,
  PERSON_COLOURS,
  draftOf,
  validateDraft,
  type PersonDraft,
} from './PeopleSettings'

export interface OnboardingWizardProps {
  open: boolean
  /** `import` means "take me to the bank import"; `done` means "leave me on Settings". */
  onFinish: (next: 'import' | 'done') => void
}

type Step = 0 | 1 | 2 | 3

const STEP_COUNT = 4

/** How many blank rows a completely empty ledger opens with. Two, and not because of a rule. */
const DEFAULT_PEOPLE = 2

/** A row the user typed but the server has not seen yet. */
interface NewRow {
  key: string
  name: string
  colour: string
}

function blankRow(key: number, taken: readonly string[]): NewRow {
  const used = new Set(taken.map(colour => colour.toUpperCase()))
  const colour =
    PERSON_COLOURS.find(candidate => !used.has(candidate)) ??
    PERSON_COLOURS[key % PERSON_COLOURS.length]
  return { key: `new-${key}`, name: '', colour }
}

/** When the reader has asked for less motion, the reveal is simply already there. */
function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

export function OnboardingWizard({ open, onFinish }: OnboardingWizardProps) {
  const people = usePeople()
  const expenses = useExpenses()
  const updatePerson = useUpdatePerson()
  const createPerson = useCreatePerson()

  const [step, setStep] = useState<Step>(0)
  const [drafts, setDrafts] = useState<Record<string, PersonDraft>>({})
  const [additions, setAdditions] = useState<NewRow[]>([])
  // Keys have to outlive the rows around them: adding, removing and adding again must not
  // hand React a key it has seen before.
  const [rowSeq, setRowSeq] = useState(0)
  const [seeded, setSeeded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const rows = useMemo(
    () => [...(people.data ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [people.data],
  )

  // A ledger that arrived with nobody on it still has to ask. Two blank rows is where the
  // asking starts; the "Add another" button is where it stops being two.
  useEffect(() => {
    if (seeded || people.isPending) return
    setSeeded(true)
    if (rows.length === 0) {
      setAdditions(
        Array.from({ length: DEFAULT_PEOPLE }, (_, index) =>
          blankRow(index, PERSON_COLOURS.slice(0, index)),
        ),
      )
      setRowSeq(DEFAULT_PEOPLE)
    }
  }, [seeded, people.isPending, rows.length])

  const documentOne = useMemo(
    () => (expenses.data ?? []).find(expense => expense.documentNumber === 1) ?? null,
    [expenses.data],
  )

  if (!open) return null

  const draftFor = (person: Person): PersonDraft => drafts[person.ID] ?? draftOf(person)
  const filledAdditions = additions.filter(row => row.name.trim() !== '')

  const problem =
    [
      ...rows.map(draftFor),
      ...filledAdditions.map(row => ({ name: row.name, colour: row.colour, email: '' })),
    ]
      .map(validateDraft)
      .find(message => message !== null) ?? null

  const takenColours = [
    ...rows.map(person => draftFor(person).colour),
    ...additions.map(row => row.colour),
  ]

  const savePeople = async (): Promise<void> => {
    setSaving(true)
    setSaveError(null)
    try {
      for (const person of rows) {
        const draft = draftFor(person)
        await updatePerson.mutateAsync({
          id: person.ID,
          patch: {
            name: draft.name.trim(),
            colour: draft.colour,
            email: draft.email.trim(),
          },
        })
      }
      for (const row of filledAdditions) {
        await createPerson.mutateAsync({
          name: row.name.trim(),
          colour: row.colour,
          isDefault: rows.length === 0,
        })
      }
      setAdditions([])
      setStep(2)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'the server would not take that')
    } finally {
      setSaving(false)
    }
  }

  const nobodyToName = rows.length === 0 && filledAdditions.length === 0

  return (
    <div
      className="twm-onboarding"
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to Two-Way Match"
    >
      <Button className="twm-onboarding-skip" design="Transparent" onClick={() => onFinish('done')}>
        Skip
      </Button>

      <div className="twm-onboarding-inner">
        <div className="twm-onboarding-steps" aria-hidden="true">
          {Array.from({ length: STEP_COUNT }, (_, index) => (
            <span key={index} data-active={index <= step} />
          ))}
        </div>

        {step === 0 ? (
          <>
            <span className="twm-onboarding-eyebrow">Company code 001 · Joint venture</span>
            <Title level="H1">Two-Way Match</Title>
            <Text>
              A ledger for a household. It reads receipts, guesses the category, argues politely
              when it is wrong, closes the month when you tell it to, and remembers where you were
              when you spent it.
            </Text>
            <Text>
              Three short steps: who is on it, the first document, and — if you have one — a bank
              statement to import.
            </Text>
            <div className="twm-actions">
              <Button design="Emphasized" icon="arrow-right" onClick={() => setStep(1)}>
                Open the books
              </Button>
            </div>
          </>
        ) : null}

        {step === 1 ? (
          <>
            <span className="twm-onboarding-eyebrow">Step 1 of 3 · Master data</span>
            <Title level="H2">Who is on this ledger?</Title>
            <Text>
              Two rows are seeded so the app works immediately. Rename them, give them colours, and
              add anyone else who pays for things around here — a flatmate, a sister, the friend who
              is coming on the trip. There is no upper limit and nothing to square up: a posting
              only ever records who paid.
            </Text>

            {people.isPending ? <Text>Loading the roster…</Text> : null}
            {people.isError ? (
              <MessageStrip design="Negative">
                The people could not be read, so there is nothing to rename yet. Skip for now —
                Settings can do this later, once the service answers.
              </MessageStrip>
            ) : null}

            {rows.map((person, index) => {
              const draft = draftFor(person)
              const preview: Person = { ...person, name: draft.name, colour: draft.colour }
              return (
                <div className="twm-onboarding-person" key={person.ID}>
                  <div className="twm-person-row">
                    <PersonAvatar person={preview} size="L" />
                    <div className="twm-person-fields">
                      <div className="twm-field">
                        <Label for={`ob-${person.ID}`}>{`Person ${index + 1}`}</Label>
                        <Input
                          id={`ob-${person.ID}`}
                          value={draft.name}
                          placeholder="First name is plenty"
                          onInput={event =>
                            setDrafts({
                              ...drafts,
                              [person.ID]: { ...draft, name: event.target.value },
                            })
                          }
                        />
                      </div>
                      <ColourSwatches
                        label={`Colour for ${draft.name || 'this person'}`}
                        value={draft.colour}
                        onSelect={colour =>
                          setDrafts({ ...drafts, [person.ID]: { ...draft, colour } })
                        }
                      />
                    </div>
                  </div>
                </div>
              )
            })}

            {additions.map((row, index) => (
              <div className="twm-onboarding-person" key={row.key}>
                <div className="twm-person-row">
                  <PersonAvatar
                    person={{ ID: row.key, name: row.name, colour: row.colour, isDefault: false }}
                    size="L"
                  />
                  <div className="twm-person-fields">
                    <div className="twm-field">
                      <Label for={`ob-${row.key}`}>{`Person ${rows.length + index + 1}`}</Label>
                      <Input
                        id={`ob-${row.key}`}
                        value={row.name}
                        placeholder="First name is plenty"
                        onInput={event =>
                          setAdditions(
                            additions.map(candidate =>
                              candidate.key === row.key
                                ? { ...candidate, name: event.target.value }
                                : candidate,
                            ),
                          )
                        }
                      />
                    </div>
                    <ColourSwatches
                      label={`Colour for ${row.name || 'the new person'}`}
                      value={row.colour}
                      onSelect={colour =>
                        setAdditions(
                          additions.map(candidate =>
                            candidate.key === row.key ? { ...candidate, colour } : candidate,
                          ),
                        )
                      }
                    />
                    <div className="twm-actions">
                      <Button
                        design="Transparent"
                        icon="decline"
                        onClick={() =>
                          setAdditions(additions.filter(candidate => candidate.key !== row.key))
                        }
                      >
                        Remove this row
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            ))}

            <div className="twm-actions">
              <Button
                design="Transparent"
                icon="add"
                onClick={() => {
                  setAdditions([...additions, blankRow(rowSeq, takenColours)])
                  setRowSeq(rowSeq + 1)
                }}
              >
                Add another person
              </Button>
            </div>

            {problem === null ? null : <MessageStrip design="Critical">{problem}</MessageStrip>}
            {saveError === null ? null : (
              <MessageStrip design="Negative">{`Could not save: ${saveError}`}</MessageStrip>
            )}

            <div className="twm-actions">
              <Button
                design="Emphasized"
                icon="arrow-right"
                disabled={saving || problem !== null || nobodyToName}
                onClick={() => void savePeople()}
              >
                {saving ? 'Saving…' : 'Save and continue'}
              </Button>
              <Button design="Transparent" onClick={() => setStep(0)}>
                Back
              </Button>
            </div>
          </>
        ) : null}

        {step === 2 ? (
          <DocumentOneReveal expense={documentOne} onContinue={() => setStep(3)} />
        ) : null}

        {step === 3 ? (
          <>
            <span className="twm-onboarding-eyebrow">Step 3 of 3 · What came before</span>
            <Title level="H2">Bring in what already happened?</Title>
            <Text>
              If your bank can export a CSV, the importer maps its columns onto expenses and
              classifies every row on the way in. They land as drafts, so nothing is posted until
              somebody says so.
            </Text>
            <div className="twm-actions">
              <Button design="Emphasized" icon="upload" onClick={() => onFinish('import')}>
                Import a CSV
              </Button>
              <Button design="Transparent" onClick={() => onFinish('done')}>
                Not now — start with a receipt
              </Button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  Document #1
 * ------------------------------------------------------------------ */

interface RevealProps {
  expense: Expense | null
  onContinue: () => void
}

const REVEAL_DELAYS = [300, 1000, 1800, 2600, 3300]

function DocumentOneReveal({ expense, onContinue }: RevealProps) {
  const updateExpense = useUpdateExpense()
  const [shown, setShown] = useState(0)
  const [addition, setAddition] = useState('')

  useEffect(() => {
    if (prefersReducedMotion()) {
      setShown(REVEAL_DELAYS.length)
      return
    }
    const timers = REVEAL_DELAYS.map((delay, index) =>
      window.setTimeout(() => setShown(index + 1), delay),
    )
    return () => timers.forEach(timer => window.clearTimeout(timer))
  }, [])

  const appendNote = (): void => {
    if (expense === null || addition.trim() === '') return
    const existing = expense.note?.trim() ?? ''
    const note = existing === '' ? addition.trim() : `${existing} ${addition.trim()}`
    updateExpense.mutate({ id: expense.ID, patch: { note } }, { onSuccess: () => setAddition('') })
  }

  return (
    <>
      <span className="twm-onboarding-eyebrow">Step 2 of 3 · The first posting</span>

      <div className="twm-reveal">
        <div className="twm-reveal-line" data-shown={shown >= 1}>
          <span className="twm-reveal-stamp">Posted · never reversed</span>
        </div>

        <h2 className="twm-reveal-number twm-reveal-line" data-shown={shown >= 2}>
          Document&nbsp;#1
        </h2>

        {expense === null ? (
          <div className="twm-reveal-line" data-shown={shown >= 3}>
            <p className="twm-reveal-note">
              Not posted yet. The first expense you book by hand and number 1 becomes this document
              — the one the ledger keeps at the top forever.
            </p>
          </div>
        ) : (
          <>
            <div className="twm-reveal-meta twm-reveal-line" data-shown={shown >= 3}>
              <span>{formatDate(expense.date)}</span>
              {expense.place === null ? null : <span>{expense.place}</span>}
              <span>{expense.merchantRaw}</span>
            </div>

            <p className="twm-reveal-note twm-reveal-line" data-shown={shown >= 4}>
              {expense.note ?? 'Everything since has been a follow-up posting.'}
            </p>

            <div className="twm-reveal-amount twm-reveal-line" data-shown={shown >= 5}>
              <MoneyText amount={expense.amount} currency={expense.currency} />
              <span className="twm-reveal-caption">
                Amount posted. The value was never in the amount.
              </span>
            </div>
          </>
        )}
      </div>

      {expense === null ? null : (
        <div className="twm-field">
          <Label for="doc1-note">Add a line to the note</Label>
          <div className="twm-actions">
            <Input
              id="doc1-note"
              style={{ flex: '1 1 14rem' }}
              value={addition}
              placeholder="Optional. It is the only field this document allows."
              onInput={event => setAddition(event.target.value)}
            />
            <Button
              design="Transparent"
              disabled={addition.trim() === '' || updateExpense.isPending}
              onClick={appendNote}
            >
              {updateExpense.isPending ? 'Saving…' : 'Add'}
            </Button>
          </div>
          {updateExpense.isError ? (
            <MessageStrip design="Negative">
              The note was not saved. Document #1 is read-only except for exactly this field, so it
              is worth trying again.
            </MessageStrip>
          ) : null}
        </div>
      )}

      <div className="twm-actions">
        <Button design="Emphasized" icon="arrow-right" onClick={onContinue}>
          Continue
        </Button>
      </div>
    </>
  )
}

export default OnboardingWizard
