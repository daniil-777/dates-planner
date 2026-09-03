/**
 * Chips — what a place is like, in one tap.
 *
 * Chips carry most of the useful information in the commons, and they do it because they are
 * cheap to give: nobody writes a paragraph about a café, and everybody will press "Quiet".
 * They are also the only part of a rating that can be filtered, translated, and guaranteed
 * free of anything about a person — a chip cannot contain a name.
 *
 * `TagChips` displays; `TagPicker` collects. The picker enforces the six-chip limit by
 * *disabling* the rest rather than refusing a seventh press, because a control that silently
 * ignores you is a control you assume is broken.
 */
import '@ui5/webcomponents-icons/dist/accept.js'

import { MAX_TAGS_PER_RATING, TAG_GROUPS, TAG_LABEL, type PlaceTag } from './vocabulary'

export function TagChips({
  tags,
  limit = 4,
}: {
  tags: readonly PlaceTag[]
  limit?: number
}): React.ReactElement | null {
  if (tags.length === 0) return null
  const shown = tags.slice(0, limit)
  return (
    <ul className="chips" aria-label="What people said">
      {shown.map(tag => (
        <li className="chips__chip" key={tag}>
          {TAG_LABEL[tag] ?? tag}
        </li>
      ))}
      {tags.length > shown.length && (
        <li className="chips__chip chips__chip--more">+{tags.length - shown.length}</li>
      )}
    </ul>
  )
}

export interface TagPickerProps {
  value: readonly PlaceTag[]
  onChange: (tags: PlaceTag[]) => void
}

export function TagPicker({ value, onChange }: TagPickerProps): React.ReactElement {
  const full = value.length >= MAX_TAGS_PER_RATING

  const toggle = (tag: PlaceTag): void => {
    onChange(value.includes(tag) ? value.filter(one => one !== tag) : [...value, tag])
  }

  return (
    <div className="tag-picker">
      {TAG_GROUPS.map(group => (
        <fieldset className="tag-picker__group" key={group.heading}>
          <legend className="tag-picker__legend">{group.heading}</legend>
          <div className="tag-picker__chips">
            {group.tags.map(tag => {
              const on = value.includes(tag)
              return (
                <button
                  type="button"
                  key={tag}
                  aria-pressed={on}
                  // Disabled rather than refused: a control that ignores a press reads as
                  // broken, and the count above says why it is off.
                  disabled={!on && full}
                  className={`tag-picker__chip${on ? ' tag-picker__chip--on' : ''}`}
                  onClick={() => toggle(tag)}
                >
                  {TAG_LABEL[tag]}
                </button>
              )
            })}
          </div>
        </fieldset>
      ))}
      <p className="tag-picker__count">
        {value.length} of {MAX_TAGS_PER_RATING}
        {full ? ' — that is plenty' : ''}
      </p>
    </div>
  )
}
