/**
 * The people this ledger is kept for.
 *
 * `People` is master data (CONTRACTS.md §10): two rows are seeded so the app works out of
 * the box, and any number can be added afterwards — a flatmate, the friend who came to
 * Lisbon, the sister who was at the dinner. A person carries a name, a colour and an
 * optional email, and nothing else: there is no short name, no A and B, and nothing to
 * square up, because this app keeps no debt.
 *
 * Removing somebody is the only operation the server can refuse. It refuses when they have
 * postings, and it is right to — an expense without a payer is a hole in the ledger — so
 * the refusal is shown as a sentence rather than as a status code.
 */
import { useState } from 'react'
import { Button, Input, Label, MessageStrip } from '@ui5/webcomponents-react'
import '@ui5/webcomponents-icons/dist/save.js'
import '@ui5/webcomponents-icons/dist/delete.js'
import '@ui5/webcomponents-icons/dist/add.js'
import { isApiError, describeError } from '@/api/client'
import { useCreatePerson, useDeletePerson, useUpdatePerson } from '@/api/hooks'
import type { Person } from '@/api/types'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { PersonAvatar } from '@/components/PersonAvatar'

/** The Horizon qualitative palette. Every person gets one; the UI never hardcodes a hue. */
export const PERSON_COLOURS = [
  '#0070F2',
  '#F31DED',
  '#049F9A',
  '#E76500',
  '#7858FF',
  '#256F3A',
  '#D20A0A',
  '#5B738B',
  '#C87200',
  '#A45D00',
] as const

export interface PersonDraft {
  name: string
  colour: string
  email: string
}

export function draftOf(person: Person): PersonDraft {
  return {
    name: person.name ?? '',
    colour: person.colour || PERSON_COLOURS[0],
    email: person.email ?? '',
  }
}

/** The first problem with a draft, or `null` when it is postable. */
export function validateDraft(draft: PersonDraft): string | null {
  if (draft.name.trim() === '') return 'A name, please — it goes on the statement.'
  if (draft.name.trim().length > 60) return 'That name is longer than any statement column.'
  if (draft.email !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email.trim())) {
    return 'That email address will not reach anybody.'
  }
  return null
}

/** The first palette colour nobody is using yet, so a new row never arrives as a twin. */
export function nextColour(people: readonly Person[]): string {
  const taken = new Set(people.map(person => (person.colour || '').toUpperCase()))
  return PERSON_COLOURS.find(colour => !taken.has(colour)) ?? PERSON_COLOURS[0]
}

function changed(draft: PersonDraft, person: Person): boolean {
  const original = draftOf(person)
  return (
    draft.name !== original.name ||
    draft.colour !== original.colour ||
    draft.email !== original.email
  )
}

/** What to say when the server will not let somebody go. */
function removalMessage(error: unknown, name: string): string {
  if (isApiError(error) && (error.status === 400 || error.status === 403 || error.status === 409)) {
    return (
      `${name} has postings in the ledger, so the row stays. Every expense keeps the person ` +
      'who paid it; move or delete those postings first and try again.'
    )
  }
  return `${name} could not be removed: ${describeError(error)}`
}

export interface ColourSwatchesProps {
  value: string
  onSelect: (colour: string) => void
  label: string
}

export function ColourSwatches({ value, onSelect, label }: ColourSwatchesProps) {
  return (
    <div className="twm-swatches" role="group" aria-label={label}>
      {PERSON_COLOURS.map(colour => (
        <button
          key={colour}
          type="button"
          className="twm-swatch"
          style={{ backgroundColor: colour }}
          aria-label={colour}
          aria-pressed={value.toUpperCase() === colour}
          onClick={() => onSelect(colour)}
        />
      ))}
    </div>
  )
}

export interface PersonEditorProps {
  person: Person
  /** False for the last person standing: a ledger with nobody to pay for anything is not one. */
  removable: boolean
}

export function PersonEditor({ person, removable }: PersonEditorProps) {
  const update = useUpdatePerson()
  const remove = useDeletePerson()
  // `null` means "showing the server's row". Anything else is unsaved typing, which is
  // never thrown away by a refetch — the form falls back to the row only once it is saved
  // or discarded.
  const [edited, setEdited] = useState<PersonDraft | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [removalError, setRemovalError] = useState<string | null>(null)

  const draft = edited ?? draftOf(person)
  const dirty = edited !== null && changed(edited, person)
  const setDraft = (next: PersonDraft): void => setEdited(next)

  const problem = validateDraft(draft)
  const preview: Person = { ...person, name: draft.name, colour: draft.colour }

  const save = (): void => {
    if (problem !== null || !dirty) return
    update.mutate(
      {
        id: person.ID,
        patch: {
          name: draft.name.trim(),
          colour: draft.colour,
          email: draft.email.trim(),
        },
      },
      { onSuccess: () => setEdited(null) },
    )
  }

  const confirmRemoval = (): void => {
    setRemovalError(null)
    remove.mutate(person.ID, {
      onSuccess: () => setConfirming(false),
      onError: error => {
        setConfirming(false)
        setRemovalError(removalMessage(error, person.name || 'That person'))
      },
    })
  }

  const fieldId = `person-${person.ID}`

  return (
    <div className="twm-person-row">
      <PersonAvatar person={preview} size="L" />

      <div className="twm-person-fields">
        <div className="twm-field-row">
          <div className="twm-field">
            <Label for={`${fieldId}-name`}>Name</Label>
            <Input
              id={`${fieldId}-name`}
              value={draft.name}
              placeholder="The name on the statement"
              onInput={event => setDraft({ ...draft, name: event.target.value })}
            />
          </div>

          <div className="twm-field">
            <Label for={`${fieldId}-email`}>Email</Label>
            <Input
              id={`${fieldId}-email`}
              value={draft.email}
              type="Email"
              placeholder="Used as the login in production"
              onInput={event => setDraft({ ...draft, email: event.target.value })}
            />
          </div>
        </div>

        <div className="twm-field">
          <Label>Colour</Label>
          <ColourSwatches
            label={`Colour for ${draft.name || 'this person'}`}
            value={draft.colour}
            onSelect={colour => setDraft({ ...draft, colour })}
          />
        </div>

        {problem === null ? null : <MessageStrip design="Critical">{problem}</MessageStrip>}

        {update.isError ? (
          <MessageStrip design="Negative">
            {`Could not save: ${describeError(update.error)}`}
          </MessageStrip>
        ) : null}

        {removalError === null ? null : (
          <MessageStrip design="Information" onClose={() => setRemovalError(null)}>
            {removalError}
          </MessageStrip>
        )}

        <div className="twm-actions">
          <Button
            design="Emphasized"
            icon="save"
            disabled={!dirty || problem !== null || update.isPending}
            onClick={save}
          >
            {update.isPending ? 'Saving…' : 'Save'}
          </Button>
          {dirty ? (
            <Button design="Transparent" onClick={() => setEdited(null)}>
              Discard
            </Button>
          ) : update.isSuccess ? (
            <span className="twm-card-subtitle">Saved.</span>
          ) : null}
          {removable ? (
            <Button
              design="Transparent"
              icon="delete"
              disabled={remove.isPending}
              onClick={() => setConfirming(true)}
            >
              {remove.isPending ? 'Removing…' : 'Remove'}
            </Button>
          ) : null}
        </div>
      </div>

      <ConfirmDialog
        open={confirming}
        title={`Remove ${person.name || 'this person'}?`}
        destructive
        busy={remove.isPending}
        confirmText="Remove"
        onCancel={() => setConfirming(false)}
        onConfirm={confirmRemoval}
      >
        <p>
          They stop appearing as a payer, on events and in the totals. Anyone who has already paid
          for something cannot be removed — the ledger says so, not this dialog.
        </p>
      </ConfirmDialog>
    </div>
  )
}

export interface AddPersonProps {
  /** Everybody already on the roster, so the new row gets a colour nobody is using. */
  people: readonly Person[]
}

export function AddPerson({ people }: AddPersonProps) {
  const create = useCreatePerson()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<PersonDraft>(() => ({
    name: '',
    colour: nextColour(people),
    email: '',
  }))

  const problem = validateDraft(draft)

  const start = (): void => {
    setDraft({ name: '', colour: nextColour(people), email: '' })
    create.reset()
    setOpen(true)
  }

  const add = (): void => {
    if (problem !== null) return
    create.mutate(
      {
        name: draft.name.trim(),
        colour: draft.colour,
        email: draft.email.trim() === '' ? undefined : draft.email.trim(),
        isDefault: false,
      },
      { onSuccess: () => setOpen(false) },
    )
  }

  if (!open) {
    return (
      <div className="twm-actions">
        <Button design="Transparent" icon="add" onClick={start}>
          Add someone
        </Button>
        {create.isSuccess ? (
          <span className="twm-card-subtitle">{`${create.data.name} is on the roster.`}</span>
        ) : null}
      </div>
    )
  }

  return (
    <div className="twm-person-row">
      <PersonAvatar
        person={{ ID: 'new', name: draft.name, colour: draft.colour, isDefault: false }}
        size="L"
      />

      <div className="twm-person-fields">
        <div className="twm-field-row">
          <div className="twm-field">
            <Label for="person-new-name">Name</Label>
            <Input
              id="person-new-name"
              value={draft.name}
              placeholder="First name is plenty"
              onInput={event => setDraft({ ...draft, name: event.target.value })}
            />
          </div>

          <div className="twm-field">
            <Label for="person-new-email">Email</Label>
            <Input
              id="person-new-email"
              value={draft.email}
              type="Email"
              placeholder="Optional"
              onInput={event => setDraft({ ...draft, email: event.target.value })}
            />
          </div>
        </div>

        <div className="twm-field">
          <Label>Colour</Label>
          <ColourSwatches
            label="Colour for the new person"
            value={draft.colour}
            onSelect={colour => setDraft({ ...draft, colour })}
          />
        </div>

        {create.isError ? (
          <MessageStrip design="Negative">
            {`Could not add them: ${describeError(create.error)}`}
          </MessageStrip>
        ) : null}

        <div className="twm-actions">
          <Button
            design="Emphasized"
            icon="add"
            disabled={problem !== null || create.isPending}
            onClick={add}
          >
            {create.isPending ? 'Adding…' : 'Add to the roster'}
          </Button>
          <Button design="Transparent" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          {problem === null ? null : <span className="twm-card-subtitle">{problem}</span>}
        </div>
      </div>
    </div>
  )
}

export default PersonEditor
