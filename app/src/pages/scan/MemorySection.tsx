import { useCallback, useRef, type ChangeEvent } from 'react'
import {
  Button,
  Input,
  Label,
  Switch,
  Text,
  TextArea,
  type InputPropTypes,
  type SwitchPropTypes,
  type TextAreaPropTypes,
} from '@ui5/webcomponents-react'
import '@ui5/webcomponents-icons/dist/add.js'
import '@ui5/webcomponents-icons/dist/delete.js'
import { MomentBadge } from '../../components/MomentBadge'
import { MEMORY_KIND_LABELS } from '../../theme'
import { isImageFile } from './imageProcessing'
import { memoryKindFor } from './form'
import type { DraftForm, PickedPhoto } from './types'

interface MemorySectionProps {
  form: DraftForm
  onChange: (patch: Partial<DraftForm>) => void
  photo: PickedPhoto | null
  onPhotoPick: (file: File) => void
  onPhotoClear: () => void
}

/**
 * The other half of the app: an expense is a document, a memory is why it
 * happened. Pre-filled from the receipt so saying yes costs one tap.
 */
export function MemorySection({
  form,
  onChange,
  photo,
  onPhotoPick,
  onPhotoClear,
}: MemorySectionProps) {
  const photoInput = useRef<HTMLInputElement>(null)

  const handlePhoto = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const picked = Array.from(event.target.files ?? []).filter(isImageFile)[0]
      event.target.value = ''
      if (picked) onPhotoPick(picked)
    },
    [onPhotoPick],
  )

  const handleToggle: SwitchPropTypes['onChange'] = event => {
    const on = event.target.checked
    onChange({
      saveMemory: on,
      memoryTitle: on && form.memoryTitle.trim() === '' ? form.merchant : form.memoryTitle,
    })
  }

  const handleTitle: InputPropTypes['onInput'] = event => {
    onChange({ memoryTitle: event.target.value })
  }

  const handleNote: TextAreaPropTypes['onInput'] = event => {
    onChange({ memoryNote: event.target.value })
  }

  return (
    <div className="scan-memory" data-testid="scan-memory">
      <div className="scan-memory-row">
        <Label for="scan-memory-switch">Also save as a memory</Label>
        <Switch
          id="scan-memory-switch"
          checked={form.saveMemory}
          accessibleName="Also save as a memory"
          onChange={handleToggle}
        />
      </div>

      {form.saveMemory ? (
        <>
          <Input
            id="scan-memory-title"
            value={form.memoryTitle}
            placeholder="What to call it"
            accessibleName="Memory title"
            onInput={handleTitle}
          />
          <TextArea
            id="scan-memory-note"
            value={form.memoryNote}
            rows={2}
            placeholder="Anything worth remembering"
            accessibleName="Memory note"
            onInput={handleNote}
          />
          <div className="scan-memory-row">
            <Text className="scan-hint">Filed under {form.date || 'the expense date'} as </Text>
            <MomentBadge moment={form.moment ?? 'everyday'} />
          </div>
          <Text className="scan-hint">
            Memory kind: {MEMORY_KIND_LABELS[memoryKindFor(form.moment)]}
          </Text>

          <input
            ref={photoInput}
            className="scan-hidden-input"
            type="file"
            accept="image/*"
            tabIndex={-1}
            aria-hidden="true"
            data-testid="scan-memory-photo-input"
            onChange={handlePhoto}
          />
          <div className="scan-memory-photo">
            {photo ? (
              <>
                <img className="scan-memory-thumb" src={photo.previewUrl} alt={photo.fileName} />
                <Button
                  design="Transparent"
                  icon="delete"
                  accessibleName="Remove the memory photo"
                  onClick={onPhotoClear}
                >
                  Remove photo
                </Button>
              </>
            ) : (
              <Button
                design="Transparent"
                icon="add"
                accessibleName="Add a photo to this memory"
                onClick={() => photoInput.current?.click()}
              >
                Add a photo
              </Button>
            )}
          </div>
        </>
      ) : null}
    </div>
  )
}
